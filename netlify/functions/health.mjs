/**
 * GET /api/health
 *
 * Reports which data sources have credentials present, without ever echoing
 * a secret back. The dashboard's Setup panel renders this so a misconfigured
 * variable is obvious at a glance.
 */
import { json } from '../lib/http.mjs';
import { getServiceAccount } from '../lib/google-auth.mjs';

export default async () => {
  const google = getServiceAccount();
  const hasGoogle = Boolean(google);

  return json({
    ok: true,
    checkedAt: new Date().toISOString(),
    sources: {
      ga4: {
        configured: hasGoogle && Boolean(process.env.GA4_PROPERTY_ID),
        details: {
          googleCredentials: hasGoogle,
          propertyId: Boolean(process.env.GA4_PROPERTY_ID),
        },
      },
      gsc: {
        configured: hasGoogle && Boolean(process.env.GSC_SITE_URL),
        details: {
          googleCredentials: hasGoogle,
          siteUrl: Boolean(process.env.GSC_SITE_URL),
        },
      },
      mouseflow: {
        configured: Boolean(
          process.env.MOUSEFLOW_USERNAME && process.env.MOUSEFLOW_API_KEY
        ),
        details: {
          username: Boolean(process.env.MOUSEFLOW_USERNAME),
          apiKey: Boolean(process.env.MOUSEFLOW_API_KEY),
          region: (process.env.MOUSEFLOW_REGION || 'us').toLowerCase(),
        },
      },
    },
    // Safe to expose: identifies which service account to grant access to.
    serviceAccountEmail: google?.clientEmail || null,
  });
};

export const config = { path: '/api/health' };
