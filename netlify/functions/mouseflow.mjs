/**
 * GET|POST /api/mouseflow
 *
 * Proxies the Mouseflow REST API (https://api-docs.mouseflow.com/).
 * Auth is HTTP Basic: the account email as username, an API key as password.
 * Base URL is region-specific — api-us.mouseflow.com or api-eu.mouseflow.com.
 *
 * Mouseflow's API is recording- and heatmap-oriented rather than a metrics
 * warehouse like GA4, so this returns session recordings (with friction
 * scores where present) and derives the roll-ups the dashboard shows.
 *
 * Field names are normalised defensively: the API has shipped several
 * spellings over time, so each value is read from a list of candidate keys.
 *
 * Passing `path` calls an arbitrary endpoint and returns the raw JSON, which
 * is useful for exploring endpoints this dashboard does not model yet:
 *   /api/mouseflow?path=websites/<id>/heatmaps
 */
import { errorResponse, json, readParams, safeDate, safeLimit } from '../lib/http.mjs';
import { demoMouseflow } from '../lib/demo-data.mjs';

const APP_BASE = 'https://app.mouseflow.com';

function credentials() {
  const username = (process.env.MOUSEFLOW_USERNAME || '').trim();
  const apiKey = (process.env.MOUSEFLOW_API_KEY || '').trim();
  const region = (process.env.MOUSEFLOW_REGION || 'us').trim().toLowerCase();
  if (!username || !apiKey) return null;
  return {
    username,
    apiKey,
    base: `https://api-${region === 'eu' ? 'eu' : 'us'}.mouseflow.com`,
    auth: `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}`,
  };
}

async function mouseflowFetch(creds, path, searchParams = {}) {
  const url = new URL(path.replace(/^\/+/, ''), `${creds.base}/`);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { Authorization: creds.auth, Accept: 'application/json' },
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.error ||
      `Mouseflow API returned HTTP ${response.status} for /${path}`;
    throw Object.assign(new Error(message), {
      code: response.status === 401 ? 'AUTH_FAILED' : 'MOUSEFLOW_API_ERROR',
      status: response.status,
    });
  }
  return payload;
}

/** Mouseflow wraps collections differently per endpoint; find the array. */
function toArray(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['items', 'data', 'results', 'websites', 'recordings', 'sessions']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

/** Reads the first present key from a list of candidates. */
function pick(object, keys, fallback = null) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function normaliseWebsite(site) {
  return {
    id: pick(site, ['id', 'websiteId', 'website_id', 'guid'], ''),
    name: pick(site, ['name', 'title', 'domain', 'url'], 'Unnamed site'),
    url: pick(site, ['url', 'domain', 'website'], null),
    status: pick(site, ['status', 'state'], null),
  };
}

function normaliseRecording(recording, websiteId) {
  const id = pick(recording, ['id', 'sessionId', 'session_id', 'recordingId'], '');
  const date = pick(
    recording,
    ['date', 'timestamp', 'created', 'createdOn', 'startTime', 'sessionStart'],
    null
  );
  return {
    id,
    date: date ? new Date(date).toISOString() : null,
    duration: Number(pick(recording, ['duration', 'length', 'sessionDuration'], 0)) || 0,
    pageViews:
      Number(pick(recording, ['pageViews', 'pages', 'pageCount', 'views'], 0)) || 0,
    frictionScore: Number(
      pick(recording, ['frictionScore', 'friction', 'score', 'engagementScore'], 0)
    ) || 0,
    device: pick(recording, ['device', 'deviceType', 'platform'], 'Unknown'),
    browser: pick(recording, ['browser', 'browserName'], 'Unknown'),
    country: pick(recording, ['country', 'countryName', 'geoCountry'], 'Unknown'),
    entryPage: pick(recording, ['entryPage', 'landingPage', 'uri', 'url', 'page'], '/'),
    // Prefer a link the API supplies; otherwise build the standard app URL.
    url:
      pick(recording, ['link', 'shareUrl', 'playbackUrl'], null) ||
      (websiteId && id ? `${APP_BASE}/websites/${websiteId}/recordings/${id}` : null),
  };
}

/** Counts rows by a key, returning the largest buckets first. */
function tally(rows, key, valueName) {
  const counts = new Map();
  for (const row of rows) {
    const label = row[key] || 'Unknown';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ [key]: label, [valueName]: count }))
    .sort((a, b) => b[valueName] - a[valueName]);
}

export default async (req) => {
  try {
    const params = await readParams(req);
    const startDate = safeDate(params.startDate, 28);
    const endDate = safeDate(params.endDate, 1);
    const limit = safeLimit(params.limit, 100, 500);

    const creds = credentials();
    if (!creds) return json(demoMouseflow(startDate, endDate));

    // Escape hatch: proxy any endpoint verbatim for exploration/debugging.
    if (params.path) {
      const { path, ...rest } = params;
      return json({
        source: 'mouseflow',
        configured: true,
        demo: false,
        path,
        data: await mouseflowFetch(creds, path, rest),
      });
    }

    const websites = toArray(await mouseflowFetch(creds, 'websites')).map(
      normaliseWebsite
    );

    const requestedId =
      (params.websiteId || process.env.MOUSEFLOW_WEBSITE_ID || '').trim();
    const website =
      websites.find((site) => site.id === requestedId) || websites[0] || null;

    if (!website?.id) {
      return json({
        source: 'mouseflow',
        configured: true,
        demo: false,
        websites,
        website: null,
        error:
          'Mouseflow authenticated successfully but returned no websites for ' +
          'this account. Check that the API key has access to a site.',
        totals: { recordings: 0 },
        recordings: [],
        timeseries: [],
        devices: [],
        entryPages: [],
      });
    }

    const recordingsPath = `websites/${encodeURIComponent(website.id)}/recordings`;
    let raw;
    try {
      raw = await mouseflowFetch(creds, recordingsPath, {
        from: startDate,
        to: endDate,
        limit,
      });
    } catch (error) {
      // Older/newer API revisions reject unknown filter names. Retry unfiltered
      // and narrow the window in code rather than failing the whole panel.
      if (error.status === 400 || error.status === 422) {
        raw = await mouseflowFetch(creds, recordingsPath, { limit });
      } else {
        throw error;
      }
    }

    const startMs = Date.parse(`${startDate}T00:00:00Z`);
    const endMs = Date.parse(`${endDate}T23:59:59Z`);
    const recordings = toArray(raw)
      .map((recording) => normaliseRecording(recording, website.id))
      .filter((recording) => {
        if (!recording.date) return true;
        const ms = Date.parse(recording.date);
        return ms >= startMs && ms <= endMs;
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    const byDay = new Map();
    for (const recording of recordings) {
      if (!recording.date) continue;
      const day = recording.date.slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
    }

    const withDuration = recordings.filter((r) => r.duration > 0);
    const highFriction = recordings.filter((r) => r.frictionScore >= 60).length;

    return json({
      source: 'mouseflow',
      configured: true,
      demo: false,
      range: { startDate, endDate },
      website,
      websites,
      totals: {
        recordings: recordings.length,
        avgDuration: withDuration.length
          ? Math.round(
              withDuration.reduce((t, r) => t + r.duration, 0) / withDuration.length
            )
          : 0,
        avgPageViews: recordings.length
          ? Math.round(
              (recordings.reduce((t, r) => t + r.pageViews, 0) / recordings.length) * 10
            ) / 10
          : 0,
        highFrictionShare: recordings.length ? highFriction / recordings.length : 0,
      },
      timeseries: [...byDay.entries()]
        .map(([date, count]) => ({ date, recordings: count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      recordings: recordings.slice(0, 50),
      devices: tally(recordings, 'device', 'recordings'),
      entryPages: tally(recordings, 'entryPage', 'recordings').slice(0, 10),
      heatmapUrl: `${APP_BASE}/websites/${website.id}/heatmaps`,
    });
  } catch (error) {
    return errorResponse(error, 'mouseflow');
  }
};

export const config = { path: '/api/mouseflow' };
