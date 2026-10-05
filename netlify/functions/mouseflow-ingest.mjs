/**
 * POST /api/mouseflow-ingest
 *
 * Receives a Mouseflow snapshot from the browser sync tool and merges it into
 * data/mouseflow/daily.json in the repository via the GitHub contents API.
 * Committing the file is what triggers a Netlify rebuild, so the dashboard
 * picks up new data without any further action.
 *
 * Days are merged, never replaced wholesale: Mouseflow retains roughly 90
 * days, so the committed history is the only place older days survive.
 * Deleting on write would quietly destroy data that cannot be re-fetched.
 *
 * Trust boundary: the browser tool runs on us.mouseflow.com, so this endpoint
 * is cross-origin and public. It is gated by a shared secret and a strict
 * origin allowlist, and it writes to exactly one path in one repository.
 */
import { timingSafeEqual } from 'node:crypto';
import { json } from '../lib/http.mjs';
import { SNAPSHOT_PATH } from '../lib/mouseflow-snapshot.mjs';

const ALLOWED_ORIGIN = 'https://us.mouseflow.com';
const REPO = 'Ralphmarino/brandwide';
const BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';

// A 90-day sync is a few hundred KB; this is a sanity ceiling, not a target.
const MAX_BODY_BYTES = 8_000_000;
const MAX_DAYS_PER_SYNC = 400;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(origin) {
  // Echo the origin only when it is the one allowed one, so the header can
  // never be reflected back to an arbitrary caller.
  const allow = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : '';
  return {
    ...(allow ? { 'Access-Control-Allow-Origin': allow } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-ingest-secret',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Constant-time comparison that does not leak length through early return. */
function secretMatches(supplied, expected) {
  if (!supplied || !expected) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    // Still burn a comparison so a wrong length is not measurably faster.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

async function githubRequest(path, options = {}) {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  if (!token) {
    throw Object.assign(new Error('GITHUB_TOKEN is not set on the deployment.'), {
      code: 'NOT_CONFIGURED',
      status: 500,
    });
  }

  const response = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'brandwide-analytics-ingest',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

/** Reads the committed snapshot, returning null when it does not exist yet. */
async function readExisting() {
  const { ok, status, payload } = await githubRequest(
    `/repos/${REPO}/contents/${SNAPSHOT_PATH}?ref=${BRANCH}`
  );

  if (status === 404) return { snapshot: null, sha: null };
  if (!ok) {
    throw Object.assign(
      new Error(`Could not read the existing snapshot (GitHub ${status}: ${payload.message || 'unknown'}).`),
      { code: 'GITHUB_READ_FAILED', status: 502 }
    );
  }

  try {
    const decoded = Buffer.from(payload.content || '', 'base64').toString('utf8');
    return { snapshot: JSON.parse(decoded), sha: payload.sha };
  } catch {
    // A corrupt file must not be silently overwritten — that would lose the
    // accumulated history this whole design exists to protect.
    throw Object.assign(
      new Error(
        'The committed snapshot exists but is not valid JSON. Refusing to overwrite it; ' +
          'fix or remove the file manually before syncing again.'
      ),
      { code: 'SNAPSHOT_CORRUPT', status: 409 }
    );
  }
}

async function writeSnapshot(snapshot, sha, summary) {
  const content = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`).toString('base64');
  return githubRequest(`/repos/${REPO}/contents/${SNAPSHOT_PATH}`, {
    method: 'PUT',
    body: JSON.stringify({
      message:
        `Mouseflow snapshot sync: ${summary.daysWritten} day(s), ` +
        `${summary.rangeFrom} to ${summary.rangeTo}`,
      content,
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
}

/** Keeps only the day fields we model, coercing each to a finite number. */
function cleanDay(value) {
  if (!value || typeof value !== 'object') return null;

  const metric = (name) => {
    const n = Number(value[name]);
    return Number.isFinite(n) ? n : 0;
  };

  const dimensions = {};
  for (const [dimension, buckets] of Object.entries(value.dimensions || {})) {
    if (!buckets || typeof buckets !== 'object') continue;
    const cleaned = {};
    for (const [bucket, count] of Object.entries(buckets)) {
      const n = Number(count);
      if (Number.isFinite(n)) cleaned[String(bucket).slice(0, 300)] = n;
    }
    if (Object.keys(cleaned).length) dimensions[String(dimension).slice(0, 60)] = cleaned;
  }

  return {
    sessionCount: metric('sessionCount'),
    visitorCount: metric('visitorCount'),
    pageviewsCount: metric('pageviewsCount'),
    visitDuration: metric('visitDuration'),
    engagementDuration: metric('engagementDuration'),
    frictionScorePerSession: metric('frictionScorePerSession'),
    ...(Object.keys(dimensions).length ? { dimensions } : {}),
  };
}

/**
 * Fields the sync tool is asked to drop before sending. Stripped again here
 * so a stale copy of the tool cannot commit personal data to a public repo.
 */
const RECORDING_BLOCKLIST = new Set([
  'ip', 'lat', 'lng', 'visitorId', 'visitorid', 'city', 'latitude', 'longitude',
]);

function cleanRecording(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (RECORDING_BLOCKLIST.has(key)) continue;
    if (entry === null || ['string', 'number', 'boolean'].includes(typeof entry)) {
      out[key] = typeof entry === 'string' ? entry.slice(0, 500) : entry;
    }
  }
  return Object.keys(out).length ? out : null;
}

export default async (req) => {
  const origin = req.headers.get('origin') || '';
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Use POST.' }, 405, cors);
  }
  if (origin !== ALLOWED_ORIGIN) {
    // Without the CORS header a browser blocks the response anyway; refusing
    // outright keeps non-browser callers from reaching the write path.
    return json(
      { error: `This endpoint only accepts requests from ${ALLOWED_ORIGIN}.` },
      403,
      cors
    );
  }

  const expected = (process.env.MOUSEFLOW_INGEST_SECRET || '').trim();
  if (!expected) {
    return json(
      { error: 'MOUSEFLOW_INGEST_SECRET is not set on the deployment.' },
      500,
      cors
    );
  }
  if (!secretMatches(req.headers.get('x-ingest-secret'), expected)) {
    return json({ error: 'Invalid or missing ingest secret.' }, 401, cors);
  }

  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return json({ error: 'Payload too large.' }, 413, cors);
    }
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Body was not valid JSON.' }, 400, cors);
  }

  const incomingDays = body?.days;
  if (!incomingDays || typeof incomingDays !== 'object' || Array.isArray(incomingDays)) {
    return json({ error: 'Expected a "days" object keyed by ISO date.' }, 400, cors);
  }

  const dayEntries = Object.entries(incomingDays).filter(([date]) => ISO_DATE.test(date));
  if (!dayEntries.length) {
    return json({ error: 'No valid ISO-dated days in the payload.' }, 400, cors);
  }
  if (dayEntries.length > MAX_DAYS_PER_SYNC) {
    return json({ error: `At most ${MAX_DAYS_PER_SYNC} days per sync.` }, 413, cors);
  }

  try {
    const { snapshot: existing, sha } = await readExisting();

    const merged = {
      websiteId: String(body.websiteId || existing?.websiteId || '').slice(0, 100) || null,
      source: 'mouseflow-snapshot-sync',
      syncedAt: new Date().toISOString(),
      days: { ...(existing?.days || {}) },
      recordings: existing?.recordings || [],
      pages: existing?.pages || [],
      syncs: Array.isArray(existing?.syncs) ? existing.syncs.slice(-49) : [],
    };

    let written = 0;
    for (const [date, value] of dayEntries) {
      const cleaned = cleanDay(value);
      if (!cleaned) continue;
      // A later sync wins for a given day, since Mouseflow backfills late
      // sessions — but days outside this payload are left untouched.
      merged.days[date] = cleaned;
      written += 1;
    }

    if (Array.isArray(body.recordings)) {
      const cleaned = body.recordings.map(cleanRecording).filter(Boolean).slice(0, 50);
      if (cleaned.length) merged.recordings = cleaned;
    }
    if (Array.isArray(body.pages)) {
      const cleaned = body.pages.map(cleanRecording).filter(Boolean).slice(0, 25);
      if (cleaned.length) merged.pages = cleaned;
    }

    const dates = Object.keys(merged.days).sort();
    const summary = {
      daysWritten: written,
      rangeFrom: dates[0],
      rangeTo: dates[dates.length - 1],
    };
    merged.syncs.push({
      at: merged.syncedAt,
      daysWritten: written,
      from: dayEntries.map(([d]) => d).sort()[0],
      to: dayEntries.map(([d]) => d).sort().pop(),
    });

    let result = await writeSnapshot(merged, sha, summary);

    // Another sync landing between our read and write invalidates the sha.
    // Re-read and retry once rather than failing a sync the user has to redo.
    if (result.status === 409) {
      const retry = await readExisting();
      const remerged = { ...merged, days: { ...(retry.snapshot?.days || {}), ...merged.days } };
      result = await writeSnapshot(remerged, retry.sha, summary);
    }

    if (!result.ok) {
      return json(
        {
          error: `GitHub rejected the write (${result.status}: ${result.payload?.message || 'unknown'}).`,
        },
        502,
        cors
      );
    }

    return json(
      {
        ok: true,
        daysWritten: written,
        daysStored: dates.length,
        earliest: summary.rangeFrom,
        latest: summary.rangeTo,
        recordings: merged.recordings.length,
        pages: merged.pages.length,
        syncedAt: merged.syncedAt,
        commit: result.payload?.commit?.sha?.slice(0, 7) || null,
        note: 'Netlify will rebuild from this commit; the dashboard updates when it finishes.',
      },
      200,
      cors
    );
  } catch (error) {
    const status = error?.status && error.status >= 400 ? error.status : 502;
    console.error(`[mouseflow-ingest] ${error?.code || 'ERROR'}: ${error?.message}`);
    return json({ error: error?.message || 'Ingest failed.', code: error?.code }, status, cors);
  }
};

export const config = { path: '/api/mouseflow-ingest' };
