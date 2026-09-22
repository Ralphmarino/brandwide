/**
 * Single source of truth for "is this source configured, and if not, why?".
 *
 * The data functions and /api/health both read from here, so the setup panel
 * can never report a source as connected while the report quietly serves
 * sample data — they are now deciding from the same code.
 */
import { createPrivateKey } from 'node:crypto';
import { getServiceAccount, normalisePrivateKey } from './google-auth.mjs';

/** GA4 measurement IDs (G-XXXX) are the classic wrong value for a property ID. */
const MEASUREMENT_ID = /^(G|UA|GTM)[-_]/i;

function googleCredentials() {
  const email = (process.env.GOOGLE_CLIENT_EMAIL || '').trim();
  if (!email) {
    return { ok: false, problem: 'GOOGLE_CLIENT_EMAIL is not set.' };
  }
  if (!email.includes('@')) {
    return {
      ok: false,
      problem: `GOOGLE_CLIENT_EMAIL does not look like an email address ("${email}").`,
    };
  }
  const key = normalisePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
  if (!key.trim()) {
    return { ok: false, problem: 'GOOGLE_PRIVATE_KEY is not set.' };
  }
  // Containing "BEGIN" is not enough — a value still carrying its
  // `"private_key":` JSON label contains it and fails only at signing time.
  // Parsing the key is the definitive check, and it runs once per cold start.
  try {
    createPrivateKey(key);
  } catch {
    return {
      ok: false,
      problem:
        'GOOGLE_PRIVATE_KEY is set but could not be parsed as a private key. ' +
        'Paste only the private_key VALUE from the service-account JSON — ' +
        'starting at "-----BEGIN PRIVATE KEY-----" and ending at ' +
        '"-----END PRIVATE KEY-----\\n" — without the "private_key": label, ' +
        'the surrounding quotes, or the trailing comma. Keep the \\n escapes.',
    };
  }
  if (!getServiceAccount()) {
    return { ok: false, problem: 'Google service-account credentials are incomplete.' };
  }
  return { ok: true, problem: null, email };
}

export function ga4Config() {
  const raw = (process.env.GA4_PROPERTY_ID || '').trim();
  const credentials = googleCredentials();

  if (!raw) {
    return { ready: false, problem: 'GA4_PROPERTY_ID is not set.', propertyId: null };
  }
  if (MEASUREMENT_ID.test(raw)) {
    return {
      ready: false,
      propertyId: null,
      problem:
        `GA4_PROPERTY_ID is set to "${raw}", which is a measurement/tag ID, not ` +
        'a property ID. Use the numeric ID from GA4 Admin → Property Settings ' +
        '(for example 123456789).',
    };
  }
  if (!/^\d+$/.test(raw)) {
    return {
      ready: false,
      propertyId: null,
      problem:
        `GA4_PROPERTY_ID must be digits only, but is set to "${raw}". Use the ` +
        'numeric ID from GA4 Admin → Property Settings.',
    };
  }
  if (!credentials.ok) {
    return { ready: false, propertyId: raw, problem: credentials.problem };
  }
  return { ready: true, propertyId: raw, problem: null };
}

export function gscConfig() {
  const raw = (process.env.GSC_SITE_URL || '').trim();
  const credentials = googleCredentials();

  if (!raw) {
    return { ready: false, problem: 'GSC_SITE_URL is not set.', siteUrl: null };
  }
  // Search Console accepts exactly two property shapes.
  const isDomain = raw.startsWith('sc-domain:');
  const isPrefix = /^https?:\/\//i.test(raw);
  if (!isDomain && !isPrefix) {
    return {
      ready: false,
      siteUrl: null,
      problem:
        `GSC_SITE_URL is set to "${raw}", which matches neither Search Console ` +
        'property format. Use "sc-domain:brandwide.com" for a domain property, ' +
        'or the full URL including protocol for a URL-prefix property.',
    };
  }
  if (!credentials.ok) {
    return { ready: false, siteUrl: raw, problem: credentials.problem };
  }
  return {
    ready: true,
    siteUrl: raw,
    problem: null,
    // A URL-prefix property without a trailing slash is a frequent 404 cause.
    warning:
      isPrefix && !raw.endsWith('/')
        ? `GSC_SITE_URL has no trailing slash. Search Console usually lists ` +
          `URL-prefix properties as "${raw}/" — if you get a 404, add it.`
        : null,
  };
}

export function mouseflowConfig() {
  const username = (process.env.MOUSEFLOW_USERNAME || '').trim();
  const apiKey = (process.env.MOUSEFLOW_API_KEY || '').trim();
  const region = (process.env.MOUSEFLOW_REGION || 'us').trim().toLowerCase();

  if (!username || !apiKey) {
    return {
      ready: false,
      problem:
        'MOUSEFLOW_USERNAME and MOUSEFLOW_API_KEY must both be set.',
    };
  }
  if (region !== 'us' && region !== 'eu') {
    return {
      ready: false,
      problem: `MOUSEFLOW_REGION must be "us" or "eu", but is set to "${region}".`,
    };
  }
  return { ready: true, problem: null, username, apiKey, region };
}

export { googleCredentials };
