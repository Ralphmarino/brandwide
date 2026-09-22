/* Date-range maths and the fetch layer for the three data sources. */

const ONE_DAY = 86_400_000;

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(count) {
  return new Date(Date.now() - count * ONE_DAY);
}

/**
 * Named presets.
 *
 * `lag` shifts the window back a couple of days for sources that are not
 * real-time. Search Console typically finalises data 2-3 days behind, so
 * without this the last bars of every chart look like a cliff.
 */
export const PRESETS = {
  '7d': { label: 'Last 7 days', days: 7 },
  '28d': { label: 'Last 28 days', days: 28 },
  '90d': { label: 'Last 90 days', days: 90 },
  '180d': { label: 'Last 6 months', days: 180 },
  '365d': { label: 'Last 12 months', days: 365 },
  mtd: { label: 'Month to date', mtd: true },
  custom: { label: 'Custom range…', custom: true },
};

/** Resolves a preset key into concrete start/end dates plus a prior period. */
export function resolveRange(preset, customStart, customEnd, lagDays = 1) {
  let start;
  let end;

  if (preset === 'custom' && customStart && customEnd) {
    start = new Date(`${customStart}T00:00:00Z`);
    end = new Date(`${customEnd}T00:00:00Z`);
  } else if (preset === 'mtd') {
    end = daysAgo(lagDays);
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  } else {
    const { days } = PRESETS[preset] || PRESETS['28d'];
    end = daysAgo(lagDays);
    start = new Date(end.getTime() - (days - 1) * ONE_DAY);
  }

  if (start > end) [start, end] = [end, start];

  // The comparison window is the same length, ending the day before `start`.
  const span = Math.max(1, Math.round((end - start) / ONE_DAY) + 1);
  const compareEnd = new Date(start.getTime() - ONE_DAY);
  const compareStart = new Date(compareEnd.getTime() - (span - 1) * ONE_DAY);

  return {
    startDate: toIso(start),
    endDate: toIso(end),
    compareStartDate: toIso(compareStart),
    compareEndDate: toIso(compareEnd),
    days: span,
  };
}

class ApiError extends Error {
  constructor(message, { code, status, source } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.source = source;
  }
}

async function request(path, params, signal) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(
      'Could not reach the dashboard API. Check your network connection.',
      { code: 'NETWORK_ERROR' }
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      `The API returned an unreadable response (HTTP ${response.status}).`,
      { code: 'BAD_RESPONSE', status: response.status }
    );
  }

  if (!response.ok) {
    throw new ApiError(payload?.error || `Request failed (HTTP ${response.status}).`, {
      code: payload?.code,
      status: response.status,
      source: payload?.source,
    });
  }
  return payload;
}

export const fetchGa4 = (range, signal) =>
  request('/api/ga4', { ...range, limit: 10 }, signal);

export const fetchGsc = (range, signal) =>
  request('/api/gsc', { ...range, limit: 25 }, signal);

export const fetchMouseflow = (range, signal) =>
  request('/api/mouseflow', { ...range, limit: 200 }, signal);

export const fetchHealth = (signal) => request('/api/health', {}, signal);

/**
 * Rank-tracking data, compiled from AWR Cloud exports at build time.
 * A 404 means no export has been committed yet, which is a normal empty
 * state rather than an error.
 */
export async function fetchRankings(signal) {
  const response = await fetch('/data/rankings.json', {
    headers: { Accept: 'application/json' },
    cache: 'no-cache',
    signal,
  });
  if (response.status === 404) return { snapshotCount: 0, snapshots: [], history: [] };
  if (!response.ok) {
    throw new ApiError(`Could not load ranking data (HTTP ${response.status}).`, {
      code: 'RANKINGS_UNAVAILABLE',
      status: response.status,
    });
  }
  return response.json();
}

/** Runs the live on-page audit for a single URL. */
export async function fetchPageAudit(url, context, signal) {
  const response = await fetch('/api/page-audit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ url, context }),
    signal,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(payload?.error || `Audit failed (HTTP ${response.status}).`, {
      code: payload?.code,
      status: response.status,
    });
  }
  return payload;
}
