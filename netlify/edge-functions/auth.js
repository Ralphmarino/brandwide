/**
 * Optional HTTP basic-auth gate for the whole dashboard.
 *
 * Entirely opt-in: with DASHBOARD_USER / DASHBOARD_PASSWORD unset the request
 * passes straight through, so the site never locks itself out by default.
 * Netlify's own site password protection is an alternative if you'd rather
 * not manage credentials here.
 */
export default async (request, context) => {
  const user = Netlify.env.get('DASHBOARD_USER');
  const password = Netlify.env.get('DASHBOARD_PASSWORD');

  if (!user || !password) return context.next();

  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = '';
    }
    // Split on the first colon only — passwords may contain colons.
    const separator = decoded.indexOf(':');
    if (separator !== -1) {
      const suppliedUser = decoded.slice(0, separator);
      const suppliedPassword = decoded.slice(separator + 1);
      if (suppliedUser === user && suppliedPassword === password) {
        return context.next();
      }
    }
  }

  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Brandwide Analytics", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
};

export const config = { path: '/*' };
