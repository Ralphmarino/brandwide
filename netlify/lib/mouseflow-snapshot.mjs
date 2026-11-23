/**
 * Reads and rolls up the Mouseflow snapshot captured by the browser sync tool.
 *
 * This Mouseflow plan exposes no usable public API, so figures are captured
 * from the logged-in web app's own endpoint and committed to the repository.
 * Each sync appends rather than replaces, so the history grows past
 * Mouseflow's ~90-day retention window.
 *
 * The file is a map of ISO date -> daily aggregates, which is what makes an
 * arbitrary date range answerable without re-querying Mouseflow.
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SNAPSHOT_PATH = 'data/mouseflow/daily.json';

/**
 * Netlify resolves included files relative to the task root, which has moved
 * between build images and is not always the working directory. Walking up
 * from this module's own location finds the file regardless of where the
 * process was started, which also makes the function testable locally.
 */
function candidateRoots() {
  const roots = ['', process.cwd(), '/var/task', join(process.cwd(), '..')];
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      roots.push(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* import.meta.url is unavailable in some bundles; the roots above remain */
  }
  return roots;
}

const CANDIDATE_ROOTS = candidateRoots();

export async function loadSnapshot() {
  for (const root of CANDIDATE_ROOTS) {
    try {
      const raw = await readFile(root ? join(root, SNAPSHOT_PATH) : SNAPSHOT_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.days === 'object') return parsed;
    } catch {
      /* try the next root */
    }
  }
  return null;
}

/** Inclusive list of ISO dates between two bounds. */
export function datesBetween(startDate, endDate) {
  const out = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  let guard = 0;
  while (cursor <= end && guard++ < 1200) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

const numberOf = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Aggregates a set of days.
 *
 * Durations and friction arrive as per-day averages, so they are recombined
 * weighted by that day's session count — a plain mean would let a quiet day
 * count as heavily as a busy one.
 *
 * Visitors are summed, which gives the sum of daily uniques rather than unique
 * visitors for the period: someone returning on three days counts three times.
 * The field name says so, because an unqualified "visitors" that silently
 * disagrees with Mouseflow's own period figure is the kind of number that gets
 * noticed in a meeting rather than in review.
 */
function aggregate(days, dates) {
  let sessions = 0;
  let visitorDailySum = 0;
  let pageviews = 0;
  let weightedVisit = 0;
  let weightedEngagement = 0;
  let weightedFriction = 0;
  let daysWithData = 0;

  const dimensions = {};

  for (const date of dates) {
    const day = days[date];
    if (!day) continue;
    daysWithData += 1;

    const daySessions = numberOf(day.sessionCount);
    sessions += daySessions;
    visitorDailySum += numberOf(day.visitorCount);
    pageviews += numberOf(day.pageviewsCount);

    weightedVisit += numberOf(day.visitDuration) * daySessions;
    weightedEngagement += numberOf(day.engagementDuration) * daySessions;
    weightedFriction += numberOf(day.frictionScorePerSession) * daySessions;

    for (const [dimension, buckets] of Object.entries(day.dimensions || {})) {
      dimensions[dimension] = dimensions[dimension] || {};
      for (const [bucket, count] of Object.entries(buckets || {})) {
        dimensions[dimension][bucket] =
          (dimensions[dimension][bucket] || 0) + numberOf(count);
      }
    }
  }

  const weight = sessions || 0;
  return {
    sessions,
    visitorDailySum,
    pageviews,
    daysWithData,
    avgVisitDurationMs: weight ? weightedVisit / weight : 0,
    avgEngagementDurationMs: weight ? weightedEngagement / weight : 0,
    frictionScore: weight ? weightedFriction / weight : 0,
    pagesPerSession: sessions ? pageviews / sessions : 0,
    dimensions,
  };
}

/** Sorts a bucket map into the dashboard's row shape, largest first. */
function bucketRows(buckets, keyName, valueName = 'sessions') {
  return Object.entries(buckets || {})
    .map(([label, value]) => ({ [keyName]: label, [valueName]: value }))
    .sort((a, b) => b[valueName] - a[valueName]);
}

/** Mouseflow's placeholder bucket labels read badly in a client report. */
function tidyBucket(label) {
  // Mouseflow wraps its sentinels in double underscores (__NULL__, __OTHER__).
  // Matching the bare words alone let "__OTHER__" through into the report.
  const bare = String(label ?? '').replace(/^__|__$/g, '').toUpperCase();
  if (bare === 'NULL' || bare === 'NONE' || bare === '') return 'Unknown';
  if (bare === 'OTHER') return 'Other';
  return label;
}

function tidyRows(rows, keyName) {
  return rows.map((row) => ({ ...row, [keyName]: tidyBucket(row[keyName]) }));
}

/**
 * Characters that cannot appear in a route this site actually serves. They
 * reach Mouseflow when something crawls a malformed href — the site audit
 * found hrefs holding an unresolved template placeholder, which arrive here
 * percent-encoded as paths like "/%7b<64 hex>%7d20%7b<64 hex>%7d20...".
 */
const UNROUTABLE_CHARS = /[{}<>"|\\^`\s]/;

/** Longer than any real route on the site; placeholder spam runs to ~300. */
const MAX_REASONABLE_PATH = 120;

/**
 * True when a path looks like a real page rather than a crawler following a
 * broken link.
 *
 * These are dropped from the client-facing table rather than from the stored
 * history: the snapshot keeps what Mouseflow reported, and the count of what
 * was dropped is returned so the Data sources tab can show it. Silently
 * discarding them would hide a live SEO defect; showing them in the report
 * puts a 300-character hash in front of a client.
 */
function isReportablePath(path) {
  const value = String(path || '');
  if (!value) return false;
  if (value.length > MAX_REASONABLE_PATH) return false;
  if (UNROUTABLE_CHARS.test(value)) return false;
  // Percent escapes are decoded before testing, since the characters above
  // arrive encoded. A malformed escape is itself a sign of a broken href.
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  return !UNROUTABLE_CHARS.test(decoded);
}

/**
 * Splits entry-page rows into the ones worth reporting and a summary of the
 * ones that are not.
 */
function partitionEntryPages(rows) {
  const keep = [];
  const dropped = [];
  for (const row of rows) {
    (isReportablePath(row.page) ? keep : dropped).push(row);
  }
  return {
    entryPages: keep,
    malformedEntryPages: {
      paths: dropped.length,
      sessions: dropped.reduce((total, row) => total + numberOf(row.sessions), 0),
      // Truncated: the point is to show the shape of the defect, not to paste
      // 300 characters of placeholder hash into a panel.
      examples: dropped.slice(0, 5).map((row) => ({
        page: String(row.page).slice(0, 80),
        sessions: numberOf(row.sessions),
      })),
    },
  };
}

/**
 * Builds the dashboard payload for a date range from the snapshot.
 * @param {object} snapshot parsed daily.json
 * @param {object} range { startDate, endDate, compareStartDate, compareEndDate }
 */
export function rollUp(snapshot, range) {
  const days = snapshot.days || {};
  const available = Object.keys(days).sort();
  if (!available.length) return null;

  const earliest = available[0];
  const latest = available[available.length - 1];

  const current = aggregate(days, datesBetween(range.startDate, range.endDate));
  const previous = aggregate(
    days,
    datesBetween(range.compareStartDate, range.compareEndDate)
  );

  const trend = datesBetween(range.startDate, range.endDate)
    .filter((date) => days[date])
    .map((date) => ({
      date,
      sessions: numberOf(days[date].sessionCount),
      recordings: numberOf(days[date].sessionCount),
      visitors: numberOf(days[date].visitorCount),
      frictionScore: numberOf(days[date].frictionScorePerSession),
    }));

  // Say plainly when the requested window reaches past what was captured,
  // rather than returning a smaller number with no explanation.
  const notes = [];
  if (range.startDate < earliest) {
    notes.push(
      `The snapshot starts at ${earliest}, so ${range.startDate} to ${earliest} is not covered. ` +
        'Mouseflow retains about 90 days, and anything earlier predates the first sync.'
    );
  }
  if (range.endDate > latest) {
    notes.push(
      `The snapshot runs to ${latest}, so later days are missing until the next sync.`
    );
  }
  if (!current.daysWithData) {
    notes.push('No synced days fall inside this range.');
  }

  const { entryPages, malformedEntryPages } = partitionEntryPages(
    tidyRows(bucketRows(current.dimensions.EntryPage, 'page'), 'page')
  );

  return {
    coverage: { earliest, latest, daysCaptured: available.length, notes },
    current,
    previous,
    trend,
    malformedEntryPages,
    devices: tidyRows(bucketRows(current.dimensions.DeviceType, 'device'), 'device'),
    entryPages,
    countries: tidyRows(bucketRows(current.dimensions.Country, 'country'), 'country'),
    referrers: tidyRows(bucketRows(current.dimensions.ReferrerType, 'referrer'), 'referrer'),
    browsers: tidyRows(bucketRows(current.dimensions.Browser, 'browser'), 'browser'),
  };
}
