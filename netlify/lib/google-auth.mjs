/**
 * Google service-account authentication with zero npm dependencies.
 *
 * Signs an RS256 JWT assertion with Node's built-in crypto and exchanges it
 * for an OAuth2 access token. Tokens are cached in module scope, which on
 * Netlify means they are reused for the lifetime of a warm Lambda container.
 *
 * Docs: https://developers.google.com/identity/protocols/oauth2/service-account
 */
import { createSign } from 'node:crypto';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** @type {Map<string, { token: string, expiresAt: number }>} */
const tokenCache = new Map();

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Netlify's environment-variable UI stores newlines as the two characters
 * `\` and `n`, while a pasted-in multiline value keeps real newlines. Accept
 * both, and tolerate surrounding quotes copied from the JSON key file.
 */
export function normalisePrivateKey(rawKey) {
  if (!rawKey) return '';
  let key = rawKey.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, '\n').trim() + '\n';
}

/** Reads and validates the service-account credentials from the environment. */
export function getServiceAccount() {
  const clientEmail = (process.env.GOOGLE_CLIENT_EMAIL || '').trim();
  const privateKey = normalisePrivateKey(process.env.GOOGLE_PRIVATE_KEY);

  if (!clientEmail || !privateKey.includes('BEGIN')) return null;
  return { clientEmail, privateKey };
}

/**
 * Returns a bearer access token for the given scope.
 * @param {string} scope A single Google OAuth scope URL.
 */
export async function getAccessToken(scope) {
  const account = getServiceAccount();
  if (!account) {
    throw Object.assign(
      new Error(
        'Google credentials are not configured. Set GOOGLE_CLIENT_EMAIL and ' +
          'GOOGLE_PRIVATE_KEY in your Netlify environment variables.'
      ),
      { code: 'NOT_CONFIGURED' }
    );
  }

  const cacheKey = `${account.clientEmail}:${scope}`;
  const cached = tokenCache.get(cacheKey);
  // Refresh 60s early so a token never expires mid-request.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope,
      aud: TOKEN_ENDPOINT,
      iat: now,
      exp: now + 3600,
    })
  );

  const signingInput = `${header}.${claims}`;
  let signature;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    signature = signer.sign(account.privateKey).toString('base64');
  } catch (cause) {
    throw Object.assign(
      new Error(
        'Could not sign the Google auth request — GOOGLE_PRIVATE_KEY looks ' +
          'malformed. Copy the private_key value from the service-account ' +
          'JSON exactly, keeping the \\n escape sequences intact.'
      ),
      { code: 'BAD_PRIVATE_KEY', cause }
    );
  }

  const assertion = `${signingInput}.${signature
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`;

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: JWT_BEARER, assertion }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error_description || payload.error || 'unknown error';
    throw Object.assign(
      new Error(`Google refused the service-account token request: ${detail}`),
      { code: 'AUTH_FAILED', status: response.status }
    );
  }

  const token = payload.access_token;
  tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  });
  return token;
}

/** Calls a Google REST endpoint with a service-account bearer token. */
export async function googleFetch(url, { scope, method = 'POST', body } = {}) {
  const token = await getAccessToken(scope);

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiError = payload.error || {};
    throw Object.assign(
      new Error(apiError.message || `Google API returned HTTP ${response.status}`),
      {
        code: 'GOOGLE_API_ERROR',
        status: response.status,
        reason: apiError.status || apiError.code,
      }
    );
  }
  return payload;
}
