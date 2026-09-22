/**
 * Deterministic sample data.
 *
 * Rendered whenever a data source has no credentials configured, so the
 * dashboard is fully explorable before GA4 / GSC / Mouseflow are connected.
 * Every response built here carries `demo: true` so the UI can badge it.
 */

/** Small seeded PRNG (mulberry32) — stable output for a given day + metric. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function eachDate(startDate, endDate) {
  const days = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  // Guard against an inverted or absurd range.
  let guard = 0;
  while (cursor <= end && guard++ < 800) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Builds a plausible daily series: a baseline with weekday seasonality,
 * a gentle growth trend and a little noise.
 */
function series(dates, metric, base, { weekendDip = 0.55, growth = 0.0012 } = {}) {
  return dates.map((date, i) => {
    const random = rng(hash(date + metric))();
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const seasonal = dow === 0 || dow === 6 ? weekendDip : 1;
    const trend = 1 + growth * i;
    const noise = 0.85 + random * 0.3;
    return { date, value: Math.round(base * seasonal * trend * noise) };
  });
}

const sum = (rows) => rows.reduce((total, row) => total + row.value, 0);

/** Splits a total across labelled buckets using fixed weights. */
function split(total, buckets) {
  const weightTotal = buckets.reduce((t, b) => t + b.weight, 0);
  return buckets.map((b) => ({
    ...b,
    value: Math.round((total * b.weight) / weightTotal),
  }));
}

// --- Google Analytics 4 -----------------------------------------------------

export function demoGa4(startDate, endDate, compare) {
  const dates = eachDate(startDate, endDate);
  const users = series(dates, 'users', 1180);
  const sessions = series(dates, 'sessions', 1520);
  const views = series(dates, 'views', 3950);
  const conversions = series(dates, 'conv', 34, { weekendDip: 0.4 });

  const totalUsers = sum(users);
  const totalSessions = sum(sessions);

  const totals = {
    // Active <= total, and new below both, which is the ordinary relationship.
    activeUsers: Math.round(totalUsers * 0.93),
    users: totalUsers,
    newUsers: Math.round(totalUsers * 0.62),
    sessions: totalSessions,
    pageViews: sum(views),
    conversions: sum(conversions),
    engagementRate: 0.586,
    avgEngagementDuration: 118,
  };

  // Prior period sits ~8% below so deltas read as healthy growth.
  const drift = 0.92;
  const previousTotals = {
    activeUsers: Math.round(totals.activeUsers * drift),
    users: Math.round(totals.users * drift),
    newUsers: Math.round(totals.newUsers * drift),
    sessions: Math.round(totals.sessions * drift),
    pageViews: Math.round(totals.pageViews * 0.95),
    conversions: Math.round(totals.conversions * 0.86),
    engagementRate: 0.561,
    avgEngagementDuration: 109,
  };

  return {
    source: 'ga4',
    configured: false,
    demo: true,
    range: { startDate, endDate },
    compareRange: compare || null,
    totals,
    previousTotals,
    timeseries: dates.map((date, i) => ({
      date,
      activeUsers: Math.round(users[i].value * 0.93),
      users: users[i].value,
      newUsers: Math.round(users[i].value * 0.62),
      sessions: sessions[i].value,
      pageViews: views[i].value,
      conversions: conversions[i].value,
    })),
    channels: split(totalSessions, [
      { channel: 'Organic Search', weight: 38 },
      { channel: 'Direct', weight: 24 },
      { channel: 'Paid Search', weight: 14 },
      { channel: 'Referral', weight: 9 },
      { channel: 'Organic Social', weight: 8 },
      { channel: 'Email', weight: 7 },
    ]).map((row) => ({
      channel: row.channel,
      sessions: row.value,
      users: Math.round(row.value * 0.79),
      engagementRate: 0.44 + (hash(row.channel) % 26) / 100,
      conversions: Math.round(row.value * 0.021),
    })),
    topPages: [
      { path: '/', title: 'Brandwide — All-in-one Franchise Software', weight: 26 },
      { path: '/pricing', title: 'Pricing', weight: 13 },
      { path: '/features/franchise-management', title: 'Franchise Management', weight: 11 },
      { path: '/request-demo', title: 'Request a Demo', weight: 9 },
      { path: '/features/marketing-automation', title: 'Marketing Automation', weight: 8 },
      { path: '/blog/franchise-growth-playbook', title: 'The Franchise Growth Playbook', weight: 7 },
      { path: '/features/crm', title: 'Franchise CRM', weight: 6 },
      { path: '/about', title: 'About Brandwide', weight: 5 },
      { path: '/integrations', title: 'Integrations', weight: 4 },
      { path: '/contact', title: 'Contact Sales', weight: 4 },
    ].map((page) => {
      const pageViews = Math.round((totals.pageViews * page.weight) / 100);
      return {
        path: page.path,
        title: page.title,
        views: pageViews,
        users: Math.round(pageViews * 0.61),
        avgEngagementDuration: 45 + (hash(page.path) % 150),
      };
    }),
    devices: split(totalSessions, [
      { device: 'desktop', weight: 61 },
      { device: 'mobile', weight: 34 },
      { device: 'tablet', weight: 5 },
    ]).map((row) => ({ device: row.device, sessions: row.value })),
    countries: split(totalSessions, [
      { country: 'United States', weight: 68 },
      { country: 'Canada', weight: 11 },
      { country: 'United Kingdom', weight: 7 },
      { country: 'Australia', weight: 5 },
      { country: 'India', weight: 4 },
      { country: 'Germany', weight: 3 },
    ]).map((row) => ({ country: row.country, sessions: row.value })),
  };
}

// --- Google Search Console --------------------------------------------------

export function demoGsc(startDate, endDate, compare) {
  const dates = eachDate(startDate, endDate);
  const clicks = series(dates, 'clicks', 410);
  const impressions = series(dates, 'impressions', 12400);

  const totalClicks = sum(clicks);
  const totalImpressions = sum(impressions);

  const totals = {
    clicks: totalClicks,
    impressions: totalImpressions,
    ctr: totalClicks / totalImpressions,
    position: 12.4,
  };

  const previousTotals = {
    clicks: Math.round(totalClicks * 0.89),
    impressions: Math.round(totalImpressions * 0.94),
    ctr: (totalClicks * 0.89) / (totalImpressions * 0.94),
    position: 13.8,
  };

  const queries = [
    { query: 'franchise management software', weight: 14, position: 4.2 },
    { query: 'all in one franchise software', weight: 11, position: 2.1 },
    { query: 'brandwide', weight: 10, position: 1.2 },
    { query: 'franchise crm', weight: 8, position: 7.8 },
    { query: 'franchise marketing automation', weight: 7, position: 9.4 },
    { query: 'best software for franchises', weight: 6, position: 11.2 },
    { query: 'franchise operations platform', weight: 6, position: 13.6 },
    { query: 'multi location marketing software', weight: 5, position: 15.1 },
    { query: 'franchise lead management', weight: 5, position: 8.9 },
    { query: 'franchisee portal software', weight: 4, position: 10.3 },
    { query: 'local seo for franchises', weight: 4, position: 18.7 },
    { query: 'franchise reporting dashboard', weight: 3, position: 21.4 },
  ];

  const pages = [
    { page: '/', weight: 22, position: 6.1 },
    { page: '/features/franchise-management', weight: 16, position: 8.4 },
    { page: '/pricing', weight: 12, position: 9.2 },
    { page: '/features/crm', weight: 10, position: 11.7 },
    { page: '/blog/franchise-growth-playbook', weight: 9, position: 14.3 },
    { page: '/features/marketing-automation', weight: 8, position: 12.8 },
    { page: '/request-demo', weight: 6, position: 7.5 },
    { page: '/integrations', weight: 5, position: 19.1 },
  ];

  /**
   * Rough organic CTR-by-position curve, so a query ranking 2nd shows a far
   * healthier CTR than one ranking 20th and the sample data stays credible.
   */
  const ctrForPosition = (position) => {
    const curve = 0.31 * Math.exp(-0.35 * (position - 1));
    return Math.max(0.008, curve);
  };

  const expand = (rows, key) =>
    rows.map((row) => {
      const rowClicks = Math.round((totalClicks * row.weight) / 100);
      const ctr = ctrForPosition(row.position);
      const rowImpressions = Math.max(rowClicks, Math.round(rowClicks / ctr));
      return {
        [key]: row[key],
        clicks: rowClicks,
        impressions: rowImpressions,
        ctr: rowImpressions ? rowClicks / rowImpressions : 0,
        position: row.position,
      };
    });

  return {
    source: 'gsc',
    configured: false,
    demo: true,
    range: { startDate, endDate },
    compareRange: compare || null,
    totals,
    previousTotals,
    timeseries: dates.map((date, i) => ({
      date,
      clicks: clicks[i].value,
      impressions: impressions[i].value,
      ctr: impressions[i].value ? clicks[i].value / impressions[i].value : 0,
      position: 10 + (hash(date) % 60) / 10,
    })),
    queries: expand(queries, 'query'),
    pages: expand(pages, 'page').map((row) => ({
      ...row,
      page: `https://www.brandwide.com${row.page}`,
    })),
    devices: split(totalClicks, [
      { device: 'DESKTOP', weight: 64 },
      { device: 'MOBILE', weight: 31 },
      { device: 'TABLET', weight: 5 },
    ]).map((row) => ({
      device: row.device,
      clicks: row.value,
      impressions: Math.round(row.value * 29),
      ctr: row.value / (row.value * 29),
      position: 11.2 + (hash(row.device) % 40) / 10,
    })),
    countries: split(totalClicks, [
      { country: 'usa', weight: 70 },
      { country: 'can', weight: 10 },
      { country: 'gbr', weight: 8 },
      { country: 'aus', weight: 6 },
      { country: 'ind', weight: 6 },
    ]).map((row) => ({
      country: row.country,
      clicks: row.value,
      impressions: Math.round(row.value * 31),
      ctr: row.value / (row.value * 31),
      position: 12.9,
    })),
  };
}

// --- Mouseflow --------------------------------------------------------------

export function demoMouseflow(startDate, endDate) {
  const dates = eachDate(startDate, endDate);
  const recordings = series(dates, 'recordings', 240);
  const totalRecordings = sum(recordings);

  const devices = ['Desktop', 'Mobile', 'Tablet'];
  const browsers = ['Chrome', 'Safari', 'Edge', 'Firefox'];
  const countries = ['United States', 'Canada', 'United Kingdom', 'Australia'];
  const pages = [
    '/',
    '/pricing',
    '/request-demo',
    '/features/franchise-management',
    '/features/crm',
    '/contact',
  ];

  const sample = Array.from({ length: 25 }, (_, i) => {
    const random = rng(hash(`recording-${i}-${startDate}`));
    const date = dates[Math.floor(random() * dates.length)] || endDate;
    return {
      id: `demo-${(hash(`rec${i}${startDate}`) % 0xffffff).toString(16).padStart(6, '0')}`,
      date: `${date}T${String(8 + Math.floor(random() * 12)).padStart(2, '0')}:${String(
        Math.floor(random() * 60)
      ).padStart(2, '0')}:00Z`,
      duration: 25 + Math.floor(random() * 400),
      pageViews: 1 + Math.floor(random() * 9),
      frictionScore: Math.round(random() * 100),
      device: devices[Math.floor(random() * devices.length)],
      browser: browsers[Math.floor(random() * browsers.length)],
      country: countries[Math.floor(random() * countries.length)],
      entryPage: pages[Math.floor(random() * pages.length)],
      url: null,
    };
  }).sort((a, b) => b.date.localeCompare(a.date));

  const highFriction = sample.filter((r) => r.frictionScore >= 60).length;

  return {
    source: 'mouseflow',
    configured: false,
    demo: true,
    range: { startDate, endDate },
    website: {
      id: 'demo-website-id',
      name: 'brandwide.com (sample data)',
      url: 'https://www.brandwide.com',
    },
    websites: [],
    totals: {
      recordings: totalRecordings,
      avgDuration: Math.round(
        sample.reduce((t, r) => t + r.duration, 0) / sample.length
      ),
      avgPageViews:
        Math.round(
          (sample.reduce((t, r) => t + r.pageViews, 0) / sample.length) * 10
        ) / 10,
      highFrictionShare: highFriction / sample.length,
    },
    timeseries: dates.map((date, i) => ({
      date,
      recordings: recordings[i].value,
    })),
    recordings: sample,
    devices: split(totalRecordings, [
      { device: 'Desktop', weight: 58 },
      { device: 'Mobile', weight: 37 },
      { device: 'Tablet', weight: 5 },
    ]).map((row) => ({ device: row.device, recordings: row.value })),
    entryPages: split(totalRecordings, [
      { page: '/', weight: 31 },
      { page: '/pricing', weight: 18 },
      { page: '/request-demo', weight: 14 },
      { page: '/features/franchise-management', weight: 12 },
      { page: '/features/crm', weight: 9 },
      { page: '/contact', weight: 8 },
    ]).map((row) => ({ page: row.page, recordings: row.value })),
  };
}
