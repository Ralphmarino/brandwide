/**
 * GET /api/health
 *
 * Reports whether each source is actually usable — and when it is not, the
 * specific reason. Reads the same validators the data functions use, so this
 * can never disagree with what the reports are doing.
 *
 * Never echoes a secret: it reports presence and shape only, plus the service
 * account email, which is an identifier rather than a credential.
 */
import { json } from '../lib/http.mjs';
import { getServiceAccount } from '../lib/google-auth.mjs';
import { ga4Config, gscConfig, mouseflowConfig, googleCredentials } from '../lib/config.mjs';

/** Describes a variable without revealing it. */
function describe(name, { reveal = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return { set: false };
  const value = raw.trim();
  return reveal
    ? { set: true, value }
    : { set: true, length: value.length, endsWith: value.slice(-4) };
}

export default async () => {
  const google = getServiceAccount();
  const credentials = googleCredentials();
  const ga4 = ga4Config();
  const gsc = gscConfig();
  const mouseflow = mouseflowConfig();

  const problems = [ga4.problem, gsc.problem, mouseflow.problem].filter(Boolean);

  return json({
    ok: problems.length === 0,
    checkedAt: new Date().toISOString(),
    // Confirms which deploy answered — if this is older than your last
    // "Trigger deploy", the site has not picked up new variables yet.
    deploy: {
      commit: process.env.COMMIT_REF?.slice(0, 7) || null,
      branch: process.env.BRANCH || null,
      builtAt: process.env.BUILD_ID ? null : undefined,
      context: process.env.CONTEXT || null,
    },
    sources: {
      ga4: {
        configured: ga4.ready,
        problem: ga4.problem,
        variables: {
          // Safe to reveal: it is a numeric identifier, not a secret, and
          // seeing it is the fastest way to catch a measurement ID.
          GA4_PROPERTY_ID: describe('GA4_PROPERTY_ID', { reveal: true }),
          GOOGLE_CLIENT_EMAIL: describe('GOOGLE_CLIENT_EMAIL', { reveal: true }),
          GOOGLE_PRIVATE_KEY: describe('GOOGLE_PRIVATE_KEY'),
        },
      },
      gsc: {
        configured: gsc.ready,
        problem: gsc.problem,
        warning: gsc.warning || null,
        variables: {
          GSC_SITE_URL: describe('GSC_SITE_URL', { reveal: true }),
          GOOGLE_CLIENT_EMAIL: describe('GOOGLE_CLIENT_EMAIL', { reveal: true }),
          GOOGLE_PRIVATE_KEY: describe('GOOGLE_PRIVATE_KEY'),
        },
      },
      mouseflow: {
        configured: mouseflow.ready,
        problem: mouseflow.problem,
        variables: {
          MOUSEFLOW_USERNAME: describe('MOUSEFLOW_USERNAME', { reveal: true }),
          MOUSEFLOW_API_KEY: describe('MOUSEFLOW_API_KEY'),
          MOUSEFLOW_REGION: describe('MOUSEFLOW_REGION', { reveal: true }),
          MOUSEFLOW_WEBSITE_ID: describe('MOUSEFLOW_WEBSITE_ID', { reveal: true }),
        },
      },
    },
    googleCredentials: { ok: credentials.ok, problem: credentials.problem },
    serviceAccountEmail: google?.clientEmail || null,
  });
};

export const config = { path: '/api/health' };
