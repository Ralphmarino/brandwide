/**
 * GET|POST /api/page-audit?url=...
 *
 * Fetches one page and returns its on-page SEO signals plus recommendations,
 * combined with whatever analytics context the caller supplies.
 *
 * The URL is restricted to hosts the dashboard is configured for, so this
 * cannot be used as an open proxy to fetch arbitrary pages through the site.
 */
import { errorResponse, json, readParams } from '../lib/http.mjs';
import { extractSignals } from '../lib/html.mjs';
import { buildRecommendations } from '../../shared/seo-rules.mjs';

const TIMEOUT_MS = 12_000;
const MAX_BYTES = 3_000_000;

/** Hosts this deployment is allowed to crawl, derived from its own config. */
function allowedHosts() {
  const hosts = new Set();

  const siteUrl = (process.env.GSC_SITE_URL || '').trim();
  if (siteUrl.startsWith('sc-domain:')) {
    const domain = siteUrl.slice('sc-domain:'.length).toLowerCase();
    hosts.add(domain);
    hosts.add(`www.${domain}`);
  } else if (siteUrl) {
    try {
      hosts.add(new URL(siteUrl).hostname.toLowerCase());
    } catch {
      /* ignore an unparseable configured value */
    }
  }

  // An explicit override for sites whose content lives on another hostname.
  for (const extra of (process.env.AUDIT_ALLOWED_HOSTS || '').split(',')) {
    const host = extra.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return hosts;
}

function assertAllowed(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw Object.assign(new Error('That is not a valid URL.'), {
      code: 'BAD_REQUEST', status: 400,
    });
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw Object.assign(new Error('Only http and https URLs can be audited.'), {
      code: 'BAD_REQUEST', status: 400,
    });
  }

  const hosts = allowedHosts();
  if (!hosts.size) {
    throw Object.assign(
      new Error(
        'No site is configured to audit. Set GSC_SITE_URL, or AUDIT_ALLOWED_HOSTS ' +
          'if the content lives on a different hostname.'
      ),
      { code: 'NOT_CONFIGURED' }
    );
  }

  if (!hosts.has(parsed.hostname.toLowerCase())) {
    throw Object.assign(
      new Error(
        `This dashboard can only audit ${[...hosts].join(', ')}. ` +
          `Refusing to fetch ${parsed.hostname}.`
      ),
      { code: 'FORBIDDEN_HOST', status: 403 }
    );
  }
  return parsed;
}

/** Reads a response body with a hard size ceiling. */
async function readCapped(response) {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();

  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(
    chunks.reduce((joined, chunk) => {
      const merged = new Uint8Array(joined.length + chunk.length);
      merged.set(joined);
      merged.set(chunk, joined.length);
      return merged;
    }, new Uint8Array())
  );
}

export default async (req) => {
  try {
    const params = await readParams(req);
    const target = assertAllowed(String(params.url || '').trim());

    const context =
      typeof params.context === 'string'
        ? JSON.parse(params.context)
        : params.context || {};

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;
    try {
      response = await fetch(target, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          // Identify honestly; this is the site auditing itself.
          'User-Agent': 'BrandwideAnalytics/1.0 (+page audit; self-scan)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
    } catch (error) {
      clearTimeout(timer);
      throw Object.assign(
        new Error(
          error.name === 'AbortError'
            ? `The page did not respond within ${TIMEOUT_MS / 1000} seconds.`
            : `Could not fetch the page: ${error.message}`
        ),
        { code: 'FETCH_FAILED', status: 502 }
      );
    }
    clearTimeout(timer);

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      throw Object.assign(
        new Error(`The page returned HTTP ${response.status}.`),
        { code: 'PAGE_ERROR', status: 502 }
      );
    }
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      throw Object.assign(
        new Error(`That URL returned ${contentType || 'an unknown type'}, not HTML.`),
        { code: 'NOT_HTML', status: 415 }
      );
    }

    const html = await readCapped(response);
    const signals = extractSignals(html, response.url || target.href);

    return json({
      source: 'page-audit',
      url: response.url || target.href,
      requestedUrl: target.href,
      redirected: (response.url || target.href) !== target.href,
      status: response.status,
      fetchedAt: new Date().toISOString(),
      fetchMs: Date.now() - started,
      bytes: html.length,
      signals,
      recommendations: buildRecommendations(signals, context),
    });
  } catch (error) {
    return errorResponse(error, 'page-audit');
  }
};

export const config = { path: '/api/page-audit' };
