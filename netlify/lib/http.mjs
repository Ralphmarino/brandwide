/** Shared request/response helpers for the dashboard's Netlify functions. */

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

/**
 * Turns a thrown error into a response the frontend can act on.
 * Never leaks credentials — only the API's own message is passed through.
 */
export function errorResponse(error, source) {
  const code = error?.code || 'INTERNAL_ERROR';

  // A missing configuration is an expected state, not a failure: the frontend
  // falls back to demo data and shows a "not connected" badge.
  if (code === 'NOT_CONFIGURED') {
    return json(
      { source, configured: false, demo: true, error: error.message, code },
      200
    );
  }

  const status =
    code === 'BAD_PRIVATE_KEY' || code === 'AUTH_FAILED'
      ? 401
      : error?.status && error.status >= 400 && error.status < 600
        ? error.status
        : 502;

  console.error(`[${source}] ${code}: ${error?.message}`);
  return json(
    {
      source,
      configured: true,
      error: error?.message || 'Unexpected error',
      code,
      reason: error?.reason,
    },
    status
  );
}

/** Parses a JSON body, tolerating an empty one. */
export async function readJsonBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  try {
    const text = await req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error('Request body was not valid JSON.'), {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }
}

/** Merges query-string params and JSON body into one params object. */
export async function readParams(req) {
  const url = new URL(req.url);
  const fromQuery = Object.fromEntries(url.searchParams.entries());
  const fromBody = await readJsonBody(req);
  return { ...fromQuery, ...fromBody };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a YYYY-MM-DD date, falling back to a relative default. */
export function safeDate(value, fallbackDaysAgo) {
  if (typeof value === 'string' && ISO_DATE.test(value)) return value;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - fallbackDaysAgo);
  return d.toISOString().slice(0, 10);
}

/** Clamps a row limit to something the upstream APIs will accept. */
export function safeLimit(value, fallback = 25, max = 500) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}
