/**
 * Mouseflow snapshot sync.
 *
 * Runs in the browser on us.mouseflow.com, where the logged-in session cookie
 * is already present. This Mouseflow plan's public API returns nothing usable,
 * so the figures come from the same endpoints the Mouseflow web app calls.
 *
 * Everything here is same-origin against Mouseflow, except the final POST to
 * the dashboard's ingest endpoint, which carries a shared secret.
 *
 * Loaded by the bookmarklet; safe to re-run. No dependencies.
 */
(async function brandwideMouseflowSync() {
  'use strict';

  const WEBSITE_ID = 'e4495438-587e-42d7-95f7-b371c838c0ab';
  const INGEST_URL = 'https://brandwide.netlify.app/api/mouseflow-ingest';
  const SECRET_KEY = 'brandwide.ingestSecret';
  const DAYS_BACK = 90;
  const DIMENSIONS = ['DeviceType', 'EntryPage', 'Country', 'ReferrerType', 'Browser'];
  const METRICS = [
    'SessionCount', 'VisitorCount', 'PageviewsCount',
    'VisitDuration', 'EngagementDuration', 'FrictionScorePerSession',
  ];

  /* --------------------------------------------------------------- toast */

  const toast = (() => {
    document.getElementById('bw-sync-toast')?.remove();
    const el = document.createElement('div');
    el.id = 'bw-sync-toast';
    el.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'right:18px', 'bottom:18px',
      'max-width:420px', 'padding:14px 16px', 'border-radius:10px',
      'background:#4C4C4C', 'color:#fff', 'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,.3)', 'border-left:4px solid #FB4513',
      'white-space:pre-wrap',
    ].join(';');
    document.body.appendChild(el);

    return {
      set(message, tone) {
        el.style.borderLeftColor =
          tone === 'error' ? '#C8442C' : tone === 'done' ? '#1A8754' : '#FB4513';
        el.textContent = message;
      },
      done() {
        setTimeout(() => el.remove(), 15000);
      },
    };
  })();

  function fail(message) {
    toast.set(`Mouseflow sync failed\n\n${message}`, 'error');
    toast.done();
    throw new Error(message);
  }

  /* ---------------------------------------------------------------- dates */

  const iso = (date) => date.toISOString().slice(0, 10);
  const today = new Date();
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - DAYS_BACK);
  // The endpoint treats todate as exclusive, so push it a day past today to
  // include today's partial data.
  const toExclusive = new Date(today);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);

  const FROM = iso(from);
  const TO = iso(toExclusive);

  /* ------------------------------------------------------------ mouseflow */

  async function csrfToken() {
    const response = await fetch('/api/auth/csrf-token', { credentials: 'include' });
    if (!response.ok) {
      fail(
        `Could not read a CSRF token (HTTP ${response.status}). ` +
          'Make sure you are logged in to us.mouseflow.com in this tab.'
      );
    }
    const payload = await response.json().catch(() => ({}));
    const token =
      payload.token || payload.csrfToken || payload.csrf_token || payload.value;
    if (!token) fail('The CSRF endpoint returned no token.');
    return token;
  }

  async function aggregated(token, dimension) {
    const url =
      `/api/websites/${WEBSITE_ID}/aggregated-metrics/sessions` +
      `?fromdate=${FROM}&todate=${TO}`;

    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({
        metrics: METRICS,
        timeUnits: ['day'],
        timezone: 'UTC',
        locale: 'en-US',
        // [] returns the ungrouped daily series; the second entry adds the
        // per-dimension breakdown in the same response.
        groupBy: dimension ? [[], [dimension]] : [[]],
        groupLimit: 50,
        sortBy: 'SessionCount',
        sortDirection: 'DESC',
      }),
    });

    if (!response.ok) {
      fail(
        `Mouseflow returned HTTP ${response.status} for ${dimension || 'totals'}. ` +
          (response.status === 401 || response.status === 403
            ? 'Your session may have expired — reload Mouseflow and try again.'
            : 'The internal endpoint may have changed.')
      );
    }
    return response.json();
  }

  async function getJson(path, label) {
    const response = await fetch(path, { credentials: 'include' });
    if (!response.ok) {
      // Recordings and pagelist are a bonus; a failure there should not sink
      // the whole sync, which is mostly about the daily aggregates.
      console.warn(`[brandwide] ${label} returned HTTP ${response.status}; skipping.`);
      return null;
    }
    return response.json().catch(() => null);
  }

  /* ----------------------------------------------------------- extraction */

  /** Finds the grouping whose dimension list matches what we asked for. */
  function groupingFor(timeseries, dimension) {
    const groupings = timeseries?.groupings || [];
    return groupings.find((grouping) => {
      const dims = grouping.dimensions || [];
      return dimension ? dims.length === 1 && dims[0] === dimension : dims.length === 0;
    }) || null;
  }

  /** Pulls the ungrouped daily metric arrays into a date-keyed map. */
  function readTotals(payload, days) {
    const series = payload?.timeseries?.[0];
    const dates = series?.dates || [];
    const grouping = groupingFor(series, null);
    const group = grouping?.groups?.[0];
    if (!group) return;

    const metrics = group.metrics || {};
    dates.forEach((rawDate, index) => {
      const date = String(rawDate).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      days[date] = days[date] || { dimensions: {} };
      for (const [name, values] of Object.entries(metrics)) {
        if (!Array.isArray(values)) continue;
        const value = Number(values[index]);
        days[date][name] = Number.isFinite(value) ? value : 0;
      }
    });
  }

  /** Pulls one dimension's per-day session counts into the same map. */
  function readDimension(payload, dimension, days) {
    const series = payload?.timeseries?.[0];
    const dates = series?.dates || [];
    const grouping = groupingFor(series, dimension);
    if (!grouping) return;

    for (const group of grouping.groups || []) {
      const label = Array.isArray(group.group) ? group.group.join(' / ') : String(group.group);
      const counts = group.metrics?.sessionCount;
      if (!Array.isArray(counts)) continue;

      dates.forEach((rawDate, index) => {
        const date = String(rawDate).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        const value = Number(counts[index]);
        if (!Number.isFinite(value) || value === 0) return;
        days[date] = days[date] || { dimensions: {} };
        days[date].dimensions = days[date].dimensions || {};
        days[date].dimensions[dimension] = days[date].dimensions[dimension] || {};
        days[date].dimensions[dimension][label] =
          (days[date].dimensions[dimension][label] || 0) + value;
      });
    }
  }

  /** Personal fields are dropped before anything leaves the browser. */
  const DROP = ['ip', 'lat', 'lng', 'latitude', 'longitude', 'visitorId', 'visitorid', 'city'];
  function scrub(row) {
    if (!row || typeof row !== 'object') return null;
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      if (DROP.includes(key)) continue;
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        out[key] = value;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- the sync */

  try {
    if (location.hostname !== 'us.mouseflow.com') {
      fail(`Run this on us.mouseflow.com — currently on ${location.hostname}.`);
    }

    let secret = localStorage.getItem(SECRET_KEY);
    if (!secret) {
      secret = window.prompt(
        'Brandwide ingest secret\n\nPaste the MOUSEFLOW_INGEST_SECRET value. ' +
          'It is stored in this browser only, on the Mouseflow origin.'
      );
      if (!secret) fail('No ingest secret provided.');
      localStorage.setItem(SECRET_KEY, secret.trim());
      secret = secret.trim();
    }

    toast.set('Mouseflow sync\n\nRequesting a CSRF token…');
    const token = await csrfToken();

    const days = {};
    toast.set(`Mouseflow sync\n\nPulling daily totals (${FROM} to ${TO})…`);
    readTotals(await aggregated(token, null), days);

    for (let i = 0; i < DIMENSIONS.length; i++) {
      const dimension = DIMENSIONS[i];
      toast.set(
        `Mouseflow sync\n\nPulling ${dimension} (${i + 1} of ${DIMENSIONS.length})…`
      );
      const payload = await aggregated(token, dimension);
      // The ungrouped series comes back on every request; reading it again is
      // harmless and covers the case where the totals-only call returned less.
      readTotals(payload, days);
      readDimension(payload, dimension, days);
    }

    const dayCount = Object.keys(days).length;
    if (!dayCount) fail('Mouseflow returned no daily rows. The response shape may have changed.');

    toast.set('Mouseflow sync\n\nFetching recent recordings and top pages…');
    const recordingsPayload = await getJson(
      `/api/websites/${WEBSITE_ID}/recordings?fromdate=${FROM}&todate=${TO}&limit=25`,
      'recordings'
    );
    const pagesPayload = await getJson(
      `/api/websites/${WEBSITE_ID}/pagelist?fromdate=${FROM}&todate=${TO}&limit=10`,
      'pagelist'
    );

    const asArray = (value) => {
      if (Array.isArray(value)) return value;
      for (const key of ['items', 'data', 'results', 'recordings', 'pages', 'sessions']) {
        if (Array.isArray(value?.[key])) return value[key];
      }
      return [];
    };

    const body = {
      websiteId: WEBSITE_ID,
      capturedAt: new Date().toISOString(),
      from: FROM,
      to: TO,
      days,
      recordings: asArray(recordingsPayload).map(scrub).filter(Boolean),
      pages: asArray(pagesPayload).map(scrub).filter(Boolean),
    };

    toast.set(`Mouseflow sync\n\nSending ${dayCount} days to Brandwide…`);
    const response = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-secret': secret },
      body: JSON.stringify(body),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        // A wrong secret should not be sticky, or every later run fails too.
        localStorage.removeItem(SECRET_KEY);
        fail('The ingest secret was rejected. It has been cleared — run again to re-enter it.');
      }
      fail(result.error || `The dashboard returned HTTP ${response.status}.`);
    }

    toast.set(
      'Mouseflow sync complete\n\n' +
        `${result.daysWritten} day(s) sent, ${result.daysStored} now stored ` +
        `(${result.earliest} to ${result.latest}).\n` +
        `${result.recordings} recordings, ${result.pages} pages.\n\n` +
        'Netlify is rebuilding; the Behaviour report updates when it finishes.',
      'done'
    );
    toast.done();
    console.info('[brandwide] sync result', result);
  } catch (error) {
    if (!/Mouseflow sync failed/.test(String(error?.message))) {
      toast.set(`Mouseflow sync failed\n\n${error?.message || error}`, 'error');
      toast.done();
    }
    console.error('[brandwide] sync error', error);
  }
})();
