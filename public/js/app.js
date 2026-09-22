/*
 * Brandwide Analytics — application shell.
 *
 * Loads the three data sources in parallel, keeps the last successful payload
 * so a failure in one panel never blanks the others, and re-renders the active
 * view on tab switch rather than redrawing everything on every change.
 */
import {
  resolveRange, fetchGa4, fetchGsc, fetchMouseflow, fetchHealth, fetchRankings,
} from './api.js';
import { applyChartDefaults, lineChart, barChart, donutChart, destroyAll, PALETTE } from './charts.js';
import {
  num, compact, axisNum, percent, decimal, duration, shortDate, longDate, dateTime,
  delta, positionDelta, tidyPath, countryName, titleCase, downloadCsv,
} from './format.js';

const VIEW_META = {
  overview: { title: 'Overview', subtitle: 'Traffic, search and on-site behaviour at a glance' },
  acquisition: { title: 'Acquisition', subtitle: 'How visitors find brandwide.com' },
  search: { title: 'Search Console', subtitle: 'Organic visibility, queries and landing pages' },
  rankings: { title: 'Rankings', subtitle: 'True tracked positions and AI Overview presence, from AWR Cloud' },
  behavior: { title: 'Behaviour', subtitle: 'Session recordings and on-page friction from Mouseflow' },
  setup: { title: 'Data sources', subtitle: 'Connection status and setup instructions' },
};

const state = {
  view: 'overview',
  preset: '28d',
  customStart: '',
  customEnd: '',
  range: null,
  ga4: null,
  gsc: null,
  mouseflow: null,
  errors: {},
  trendMetric: 'users',
  rankings: null,
  loading: false,
  inflight: null,
};

const $ = (selector) => document.querySelector(selector);
const $id = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- helpers */

/** Renders a table from column definitions; keeps every panel consistent. */
function renderTable(tableId, columns, rows, emptyMessage = 'No data for this period.') {
  const table = $id(tableId);
  if (!table) return;

  if (!rows?.length) {
    table.innerHTML = `<tbody><tr><td class="empty">${emptyMessage}</td></tr></tbody>`;
    return;
  }

  const head = columns
    .map((column) => `<th class="${column.align === 'right' ? 'num' : ''}">${column.label}</th>`)
    .join('');

  const body = rows
    .map((row) => {
      const cells = columns
        .map((column) => {
          const content = column.render(row);
          return `<td class="${column.align === 'right' ? 'num' : ''}">${content}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
}

/** A proportion bar sized against the largest value in the column. */
function barCell(value, max, formatted) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return `
    <div style="display:flex;align-items:center;gap:9px;justify-content:flex-end">
      <span>${formatted}</span>
      <span class="bar" style="width:64px"><span class="bar__fill" style="width:${width}%"></span></span>
    </div>`;
}

function deltaBadge(current, previous, options = {}) {
  // Rank metrics move in places, not percentages.
  const result = options.asPositions
    ? positionDelta(current, previous)
    : delta(current, previous, options);
  if (result.change === null) {
    return `<span class="delta delta--flat">—</span>`;
  }
  const caret = result.direction === 'up' ? '▲' : result.direction === 'down' ? '▼' : '■';
  return `<span class="delta delta--${result.direction}"><span class="delta__caret">${caret}</span>${result.label}</span>`;
}

function kpiCard({ label, value, current, previous, inverse, compareText, noCompare, asPositions }) {
  // Some sources (Mouseflow) have no prior-period figure to compare against;
  // there the footer carries a plain descriptor instead of an empty badge.
  const badge = noCompare ? '' : deltaBadge(current, previous, { inverse, asPositions });
  return `
    <article class="kpi">
      <div class="kpi__label">${label}</div>
      <div class="kpi__value">${value}</div>
      <div class="kpi__foot">
        ${badge}
        <span class="kpi__compare">${compareText || 'vs prev. period'}</span>
      </div>
    </article>`;
}

function skeletonKpis(container, count) {
  const element = $id(container);
  if (!element) return;
  element.innerHTML = Array.from({ length: count })
    .map(
      () => `
      <article class="kpi">
        <div class="kpi__label skeleton">Loading</div>
        <div class="kpi__value skeleton">0,000</div>
        <div class="kpi__foot"><span class="delta delta--flat skeleton">0%</span></div>
      </article>`
    )
    .join('');
}

function renderErrors(containerId, sources) {
  const container = $id(containerId);
  if (!container) return;

  const messages = sources
    .filter((source) => state.errors[source])
    .map(
      (source) => `
      <div class="error-box">
        <strong>${titleCase(source === 'ga4' ? 'Google Analytics' : source === 'gsc' ? 'Search Console' : source)} could not be loaded</strong>
        ${state.errors[source]}
      </div>`
    );

  container.innerHTML = messages.join('');
}

/* ------------------------------------------------------------ status pills */

function setPill(id, payload, error) {
  const pill = $id(id);
  if (!pill) return;

  const name = pill.textContent.trim();
  pill.className = 'pill';

  if (error) {
    pill.classList.add('pill--error');
    pill.innerHTML = `<span class="pill__dot"></span> ${name} · error`;
  } else if (payload?.demo) {
    pill.classList.add('pill--demo');
    pill.innerHTML = `<span class="pill__dot"></span> ${name} · sample data`;
    // The reason the source fell back is the thing worth surfacing.
    if (payload.demoReason) pill.title = payload.demoReason;
  } else if (payload) {
    pill.classList.add('pill--live');
    pill.innerHTML = `<span class="pill__dot"></span> ${name} · live`;
  } else {
    pill.innerHTML = `<span class="pill__dot"></span> ${name}`;
  }
}

function refreshStatusStrip() {
  setPill('status-ga4', state.ga4, state.errors.ga4);
  setPill('status-gsc', state.gsc, state.errors.gsc);
  setPill('status-mouseflow', state.mouseflow, state.errors.mouseflow);

  const note = $id('range-note');
  if (note && state.range) {
    const { startDate, endDate, compareStartDate, compareEndDate } = state.range;
    note.textContent =
      `${longDate(startDate)} – ${longDate(endDate)}  ·  compared with ` +
      `${longDate(compareStartDate)} – ${longDate(compareEndDate)}`;
  }

  const stamp = $id('build-stamp');
  if (stamp) {
    stamp.textContent = `Last refreshed ${new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })}`;
  }
}

/* --------------------------------------------------------------- Overview */

function renderOverview() {
  renderErrors('overview-errors', ['ga4', 'gsc']);

  const ga4 = state.ga4;
  if (ga4) {
    const totals = ga4.totals || {};
    const previous = ga4.previousTotals || {};
    $id('overview-kpis').innerHTML = [
      kpiCard({ label: 'Users', value: num(totals.users), current: totals.users, previous: previous.users }),
      kpiCard({ label: 'New users', value: num(totals.newUsers), current: totals.newUsers, previous: previous.newUsers }),
      kpiCard({ label: 'Sessions', value: num(totals.sessions), current: totals.sessions, previous: previous.sessions }),
      kpiCard({ label: 'Page views', value: num(totals.pageViews), current: totals.pageViews, previous: previous.pageViews }),
      kpiCard({ label: 'Engagement rate', value: percent(totals.engagementRate), current: totals.engagementRate, previous: previous.engagementRate }),
      kpiCard({ label: 'Avg. session', value: duration(totals.avgEngagementDuration), current: totals.avgEngagementDuration, previous: previous.avgEngagementDuration }),
    ].join('');

    renderTrendChart();

    const pages = ga4.topPages || [];
    const maxViews = Math.max(...pages.map((page) => page.views), 0);
    renderTable(
      'table-top-pages',
      [
        {
          label: 'Page',
          render: (row) =>
            `<div class="cell-primary" title="${row.path}">${tidyPath(row.path)}</div>
             <div class="cell-secondary">${row.title || ''}</div>`,
        },
        { label: 'Views', align: 'right', render: (row) => barCell(row.views, maxViews, num(row.views)) },
        { label: 'Avg. time', align: 'right', render: (row) => duration(row.avgEngagementDuration) },
      ],
      pages
    );
  } else if (!state.errors.ga4) {
    skeletonKpis('overview-kpis', 6);
  } else {
    $id('overview-kpis').innerHTML = '';
  }

  const gsc = state.gsc;
  if (gsc) {
    const totals = gsc.totals || {};
    const previous = gsc.previousTotals || {};
    $id('overview-search-kpis').innerHTML = [
      kpiCard({ label: 'Clicks', value: num(totals.clicks), current: totals.clicks, previous: previous.clicks }),
      kpiCard({ label: 'Impressions', value: compact(totals.impressions), current: totals.impressions, previous: previous.impressions }),
      kpiCard({ label: 'Average CTR', value: percent(totals.ctr, 2), current: totals.ctr, previous: previous.ctr }),
      kpiCard({ label: 'Average position', value: decimal(totals.position), current: totals.position, previous: previous.position, inverse: true }),
    ].join('');

    const labels = (gsc.timeseries || []).map((point) => shortDate(point.date));
    lineChart('chart-gsc-clicks-mini', labels, [
      { label: 'Clicks', data: (gsc.timeseries || []).map((point) => point.clicks) },
    ], { valueFormatter: (value, isAxis) => (isAxis ? axisNum(value) : num(value)) });

    lineChart('chart-gsc-impressions-mini', labels, [
      { label: 'Impressions', data: (gsc.timeseries || []).map((point) => point.impressions), color: PALETTE[1] },
    ], { valueFormatter: (value, isAxis) => (isAxis ? axisNum(value) : num(value)) });

    const queries = gsc.queries || [];
    const maxClicks = Math.max(...queries.map((query) => query.clicks), 0);
    renderTable(
      'table-top-queries',
      [
        { label: 'Query', render: (row) => `<div class="cell-primary" title="${row.query}">${row.query}</div>` },
        { label: 'Clicks', align: 'right', render: (row) => barCell(row.clicks, maxClicks, num(row.clicks)) },
        { label: 'CTR', align: 'right', render: (row) => percent(row.ctr, 1) },
        { label: 'Pos.', align: 'right', render: (row) => decimal(row.position) },
      ],
      queries.slice(0, 10)
    );
  } else if (!state.errors.gsc) {
    skeletonKpis('overview-search-kpis', 4);
  } else {
    $id('overview-search-kpis').innerHTML = '';
  }
}

function renderTrendChart() {
  const ga4 = state.ga4;
  if (!ga4?.timeseries?.length) return;

  const metric = state.trendMetric;
  const labels = ga4.timeseries.map((point) => shortDate(point.date));
  const values = ga4.timeseries.map((point) => point[metric] ?? 0);

  const metricLabels = {
    users: 'Users',
    sessions: 'Sessions',
    pageViews: 'Page views',
    conversions: 'Conversions',
  };

  lineChart('chart-trend', labels, [{ label: metricLabels[metric], data: values }], {
    valueFormatter: (value, isAxis) => (isAxis ? axisNum(value) : num(value)),
  });

  const subtitle = $id('trend-subtitle');
  if (subtitle && state.range) {
    subtitle.textContent = `${metricLabels[metric]} · ${longDate(state.range.startDate)} – ${longDate(state.range.endDate)}`;
  }
}

/* ------------------------------------------------------------ Acquisition */

function renderAcquisition() {
  renderErrors('acquisition-errors', ['ga4']);

  const ga4 = state.ga4;
  if (!ga4) return;

  const channels = ga4.channels || [];
  barChart(
    'chart-channels',
    channels.map((row) => row.channel),
    channels.map((row) => row.sessions),
    { valueFormatter: (value, isAxis) => (isAxis ? axisNum(value) : num(value)) }
  );

  const devices = ga4.devices || [];
  donutChart(
    'chart-devices',
    devices.map((row) => titleCase(row.device)),
    devices.map((row) => row.sessions),
    { valueFormatter: (value, isAxis) => (isAxis ? axisNum(value) : num(value)) }
  );

  const maxSessions = Math.max(...channels.map((row) => row.sessions), 0);
  renderTable(
    'table-channels',
    [
      { label: 'Channel', render: (row) => `<div class="cell-primary">${row.channel}</div>` },
      { label: 'Sessions', align: 'right', render: (row) => barCell(row.sessions, maxSessions, num(row.sessions)) },
      { label: 'Users', align: 'right', render: (row) => num(row.users) },
      { label: 'Engagement', align: 'right', render: (row) => percent(row.engagementRate) },
      { label: 'Conversions', align: 'right', render: (row) => num(row.conversions) },
    ],
    channels
  );

  const countries = ga4.countries || [];
  const maxCountry = Math.max(...countries.map((row) => row.sessions), 0);
  renderTable(
    'table-countries',
    [
      { label: 'Country', render: (row) => `<div class="cell-primary">${row.country || 'Unknown'}</div>` },
      { label: 'Sessions', align: 'right', render: (row) => barCell(row.sessions, maxCountry, num(row.sessions)) },
    ],
    countries
  );
}

/* ----------------------------------------------------------------- Search */

function renderSearch() {
  renderErrors('search-errors', ['gsc']);

  const gsc = state.gsc;
  if (!gsc) return;

  const totals = gsc.totals || {};
  const previous = gsc.previousTotals || {};
  $id('search-kpis').innerHTML = [
    kpiCard({ label: 'Total clicks', value: num(totals.clicks), current: totals.clicks, previous: previous.clicks }),
    kpiCard({ label: 'Total impressions', value: num(totals.impressions), current: totals.impressions, previous: previous.impressions }),
    kpiCard({ label: 'Average CTR', value: percent(totals.ctr, 2), current: totals.ctr, previous: previous.ctr }),
    kpiCard({
      label: 'Average position',
      value: decimal(totals.position),
      current: totals.position,
      previous: previous.position,
      inverse: true,
      compareText: 'impression-weighted — see Rankings',
    }),
  ].join('');

  const points = gsc.timeseries || [];
  const labels = points.map((point) => shortDate(point.date));

  lineChart('chart-gsc-clicks', labels, [
    { label: 'Clicks', data: points.map((point) => point.clicks) },
  ], { valueFormatter: (value, isAxis) => (isAxis ? axisNum(value) : num(value)) });

  lineChart('chart-gsc-impressions', labels, [
    { label: 'Impressions', data: points.map((point) => point.impressions), color: PALETTE[1] },
  ], { valueFormatter: (value, isAxis) => (isAxis ? axisNum(value) : num(value)) });

  lineChart('chart-gsc-ctr', labels, [
    { label: 'CTR', data: points.map((point) => Number(((point.ctr || 0) * 100).toFixed(2))), color: PALETTE[2] },
  ], { valueFormatter: (value) => `${decimal(value, 2)}%`, beginAtZero: false });

  lineChart('chart-gsc-position', labels, [
    { label: 'Position', data: points.map((point) => Number((point.position || 0).toFixed(1))), color: PALETTE[3] },
  ], { valueFormatter: (value) => decimal(value), beginAtZero: false, reverse: true });

  const queries = gsc.queries || [];
  const maxQueryClicks = Math.max(...queries.map((row) => row.clicks), 0);
  const searchColumns = (labelText, key) => [
    {
      label: labelText,
      render: (row) => {
        const value = row[key];
        const display = key === 'page' ? tidyPath(value, 58) : value;
        return `<div class="cell-primary" title="${value}">${display}</div>`;
      },
    },
    { label: 'Clicks', align: 'right', render: (row) => barCell(row.clicks, maxQueryClicks, num(row.clicks)) },
    { label: 'Impressions', align: 'right', render: (row) => num(row.impressions) },
    { label: 'CTR', align: 'right', render: (row) => percent(row.ctr, 1) },
    { label: 'Position', align: 'right', render: (row) => decimal(row.position) },
  ];

  renderTable('table-queries', searchColumns('Query', 'query'), queries);

  const pages = gsc.pages || [];
  const maxPageClicks = Math.max(...pages.map((row) => row.clicks), 0);
  renderTable(
    'table-gsc-pages',
    [
      {
        label: 'Page',
        render: (row) =>
          `<div class="cell-primary" title="${row.page}"><a href="${row.page}" target="_blank" rel="noopener noreferrer">${tidyPath(row.page, 58)}</a></div>`,
      },
      { label: 'Clicks', align: 'right', render: (row) => barCell(row.clicks, maxPageClicks, num(row.clicks)) },
      { label: 'Impressions', align: 'right', render: (row) => num(row.impressions) },
      { label: 'CTR', align: 'right', render: (row) => percent(row.ctr, 1) },
      { label: 'Position', align: 'right', render: (row) => decimal(row.position) },
    ],
    pages
  );

  renderTable(
    'table-gsc-devices',
    [
      { label: 'Device', render: (row) => `<div class="cell-primary">${titleCase(row.device)}</div>` },
      { label: 'Clicks', align: 'right', render: (row) => num(row.clicks) },
      { label: 'Impressions', align: 'right', render: (row) => num(row.impressions) },
      { label: 'CTR', align: 'right', render: (row) => percent(row.ctr, 1) },
    ],
    gsc.devices || []
  );

  renderTable(
    'table-gsc-countries',
    [
      { label: 'Country', render: (row) => `<div class="cell-primary">${countryName(row.country)}</div>` },
      { label: 'Clicks', align: 'right', render: (row) => num(row.clicks) },
      { label: 'Impressions', align: 'right', render: (row) => num(row.impressions) },
      { label: 'CTR', align: 'right', render: (row) => percent(row.ctr, 1) },
    ],
    (gsc.countries || []).slice(0, 10)
  );
}

/* --------------------------------------------------------------- Behaviour */

function frictionCell(score) {
  const band = score >= 60 ? 'high' : score >= 30 ? 'mid' : 'low';
  return `<span class="score score--${band}">${Math.round(score)}</span>`;
}

function renderBehavior() {
  renderErrors('behavior-errors', ['mouseflow']);

  const mf = state.mouseflow;
  if (!mf) return;

  if (mf.error && !mf.recordings?.length) {
    $id('behavior-errors').innerHTML += `<div class="error-box"><strong>Mouseflow</strong>${mf.error}</div>`;
  }

  const totals = mf.totals || {};
  $id('behavior-kpis').innerHTML = [
    kpiCard({ label: 'Recordings', value: num(totals.recordings), noCompare: true, compareText: 'captured in this period' }),
    kpiCard({ label: 'Avg. duration', value: duration(totals.avgDuration), noCompare: true, compareText: 'per recorded session' }),
    kpiCard({ label: 'Pages per session', value: decimal(totals.avgPageViews), noCompare: true, compareText: 'average across recordings' }),
    kpiCard({ label: 'High friction', value: percent(totals.highFrictionShare), noCompare: true, compareText: 'of sessions scoring 60+' }),
  ].join('');

  const points = mf.timeseries || [];
  lineChart(
    'chart-mf-trend',
    points.map((point) => shortDate(point.date)),
    [{ label: 'Recordings', data: points.map((point) => point.recordings) }],
    { valueFormatter: (value, isAxis) => (isAxis ? axisNum(value) : num(value)) }
  );

  const devices = mf.devices || [];
  donutChart(
    'chart-mf-devices',
    devices.map((row) => titleCase(row.device)),
    devices.map((row) => row.recordings),
    { valueFormatter: (value, isAxis) => (isAxis ? axisNum(value) : num(value)) }
  );

  const entryPages = mf.entryPages || [];
  const maxEntry = Math.max(...entryPages.map((row) => row.recordings), 0);
  renderTable(
    'table-mf-entry',
    [
      { label: 'Entry page', render: (row) => `<div class="cell-primary" title="${row.page}">${tidyPath(row.page)}</div>` },
      { label: 'Recordings', align: 'right', render: (row) => barCell(row.recordings, maxEntry, num(row.recordings)) },
    ],
    entryPages
  );

  renderTable(
    'table-mf-recordings',
    [
      {
        label: 'Session',
        render: (row) =>
          row.url
            ? `<a class="mono" href="${row.url}" target="_blank" rel="noopener noreferrer">${row.id}</a>`
            : `<span class="mono">${row.id}</span>`,
      },
      { label: 'When', render: (row) => dateTime(row.date) },
      { label: 'Entry page', render: (row) => `<span title="${row.entryPage}">${tidyPath(row.entryPage, 30)}</span>` },
      { label: 'Device', render: (row) => titleCase(row.device) },
      { label: 'Pages', align: 'right', render: (row) => num(row.pageViews) },
      { label: 'Duration', align: 'right', render: (row) => duration(row.duration) },
      { label: 'Friction', align: 'right', render: (row) => frictionCell(row.frictionScore) },
    ],
    mf.recordings || [],
    'No recordings in this period.'
  );

  const heatmapLink = $id('mf-heatmap-link');
  if (heatmapLink) {
    heatmapLink.innerHTML = mf.heatmapUrl
      ? `${mf.website?.name || 'Mouseflow'} · <a href="${mf.heatmapUrl}" target="_blank" rel="noopener noreferrer">Open heatmaps in Mouseflow</a>`
      : mf.website?.name || '';
  }
}

/* --------------------------------------------------------------- Rankings */

/** Empty state: this panel is driven by files, so say how to add one. */
function rankingsEmptyState() {
  return `
    <div class="card">
      <div class="card__head"><div>
        <h3 class="card__title">No ranking exports yet</h3>
        <p class="card__subtitle">This panel is built from AWR Cloud exports committed to the repository</p>
      </div></div>
      <div class="card__body">
        <div class="setup-step">
          <h3>1. Export from AWR Cloud</h3>
          <p>Run your ranking report and export it as <strong>CSV</strong>. Include position,
             previous position, landing page, search volume and SERP features / AI Overview
             columns if your plan offers them.</p>
        </div>
        <div class="setup-step">
          <h3>2. Name it by date</h3>
          <p>Use the date of the snapshot, for example <code>2026-09-22.csv</code>.
             The filename is what orders the history.</p>
        </div>
        <div class="setup-step">
          <h3>3. Commit it to <code>data/rankings/</code></h3>
          <p>Drag the file into that folder on GitHub and commit. Netlify rebuilds
             automatically and this panel fills in — no redeploy needed by hand.</p>
        </div>
        <p class="cell-secondary" style="margin-bottom:0">Every export you add builds
           the history further, so positions can be trended over time.</p>
      </div>
    </div>`;
}

function positionCell(position) {
  if (position === null || position === undefined) {
    return `<span class="score" style="background:var(--surface-sunken);color:var(--ink-faint)">—</span>`;
  }
  const band = position <= 3 ? 'low' : position <= 10 ? 'mid' : 'high';
  // Reuses the friction bands inverted: top positions are the good outcome.
  return `<span class="score score--${band}">${decimal(position, 0)}</span>`;
}

function changeCell(change) {
  if (change === null || change === undefined || change === 0) {
    return `<span class="delta delta--flat">—</span>`;
  }
  // Positive change means the position number fell, i.e. an improvement.
  const direction = change > 0 ? 'up' : 'down';
  const caret = change > 0 ? '▲' : '▼';
  return `<span class="delta delta--${direction}"><span class="delta__caret">${caret}</span>${Math.abs(change)}</span>`;
}

function renderRankings() {
  const container = $id('rankings-body');
  if (!container) return;

  renderErrors('rankings-errors', ['rankings']);

  const data = state.rankings;
  if (!data || !data.snapshotCount) {
    container.innerHTML = rankingsEmptyState();
    return;
  }

  const latest = data.snapshots[data.snapshots.length - 1];
  const previous = data.snapshots.length > 1 ? data.snapshots[data.snapshots.length - 2] : null;
  const totals = latest.totals;
  const before = previous?.totals || {};

  container.innerHTML = `
    <h2 class="section-title">Tracked positions · ${longDate(latest.date)}</h2>
    <div class="grid grid--kpi" id="rankings-kpis"></div>

    <div class="card" style="margin-top:14px">
      <div class="card__head"><div>
        <h3 class="card__title">Why this differs from Search Console</h3>
      </div></div>
      <div class="card__body" style="padding-top:12px">
        <p style="margin:0;color:var(--ink-muted)">
          Search Console's average position is impression-weighted across every query and
          page, so a term at #1 and one at #48 average to roughly #25, and an AI Overview
          citation counts the same as a blue link. These figures come from your AWR Cloud
          tracked keyword set, where each position is the real ranking for that term.
        </p>
      </div>
    </div>

    <h2 class="section-title">Movement over time</h2>
    <div class="grid grid--halves">
      <div class="card">
        <div class="card__head"><div><h3 class="card__title">Keywords in top 3 and top 10</h3>
          <p class="card__subtitle">Counts, not averages — unaffected by newly tracked terms</p></div></div>
        <div class="card__body"><div class="chart-wrap chart-wrap--short"><canvas id="chart-rank-bands"></canvas></div></div>
      </div>
      <div class="card">
        <div class="card__head"><div><h3 class="card__title">AI Overview appearances</h3>
          <p class="card__subtitle">Tracked keywords where you appear in the AI Overview</p></div></div>
        <div class="card__body"><div class="chart-wrap chart-wrap--short"><canvas id="chart-rank-aio"></canvas></div></div>
      </div>
    </div>

    <h2 class="section-title">Keywords</h2>
    <div class="card">
      <div class="card__head">
        <div><h3 class="card__title">Tracked keyword positions</h3>
          <p class="card__subtitle">${latest.file}${previous ? ` · change vs ${longDate(previous.date)}` : ''}</p></div>
        <div class="card__actions"><button class="btn btn--ghost btn--sm" data-export="rankings" type="button">Export CSV</button></div>
      </div>
      <div class="card__body card__body--flush"><div class="table-scroll"><table id="table-rankings"></table></div></div>
    </div>`;

  $id('rankings-kpis').innerHTML = [
    kpiCard({ label: 'In top 3', value: num(totals.top3), current: totals.top3, previous: before.top3, compareText: previous ? 'vs last export' : 'tracked keywords' }),
    kpiCard({ label: 'In top 10', value: num(totals.top10), current: totals.top10, previous: before.top10, compareText: previous ? 'vs last export' : 'tracked keywords' }),
    kpiCard({ label: 'AI Overviews', value: num(totals.aiOverviews), current: totals.aiOverviews, previous: before.aiOverviews, compareText: previous ? 'vs last export' : 'appearances' }),
    kpiCard({ label: 'Median position', value: decimal(totals.medianPosition, 1), current: totals.medianPosition, previous: before.medianPosition, asPositions: true, compareText: 'of ranked keywords' }),
    kpiCard({ label: 'Tracked', value: num(totals.trackedKeywords), noCompare: true, compareText: `${totals.rankedKeywords} ranked, ${totals.unrankedKeywords} not` }),
    kpiCard({ label: 'Improved', value: num(totals.improved), noCompare: true, compareText: `${totals.declined} declined` }),
  ].join('');

  const labels = data.history.map((point) => shortDate(point.date));
  lineChart('chart-rank-bands', labels, [
    { label: 'Top 3', data: data.history.map((point) => point.top3) },
    { label: 'Top 10', data: data.history.map((point) => point.top10), color: PALETTE[1] },
  ], { valueFormatter: (value) => num(value) });

  lineChart('chart-rank-aio', labels, [
    { label: 'AI Overviews', data: data.history.map((point) => point.aiOverviews), color: PALETTE[3] },
  ], { valueFormatter: (value) => num(value) });

  // Ranked keywords first, best position first; unranked fall to the bottom.
  const rows = [...latest.keywords].sort((a, b) => {
    if (a.position === null) return 1;
    if (b.position === null) return -1;
    return a.position - b.position;
  });

  renderTable(
    'table-rankings',
    [
      {
        label: 'Keyword',
        render: (row) => `<div class="cell-primary" title="${row.keyword}">${row.keyword}</div>
          ${row.url ? `<div class="cell-secondary">${tidyPath(row.url, 44)}</div>` : ''}`,
      },
      { label: 'Position', align: 'right', render: (row) => positionCell(row.position) },
      { label: 'Change', align: 'right', render: (row) => changeCell(row.change) },
      {
        label: 'AI Overview',
        align: 'right',
        render: (row) =>
          row.aiOverview
            ? `<span class="score score--low">Yes</span>`
            : `<span class="cell-secondary">—</span>`,
      },
      { label: 'Volume', align: 'right', render: (row) => (row.searchVolume ? num(row.searchVolume) : '—') },
      {
        label: 'SERP features',
        render: (row) =>
          row.features?.length
            ? `<span class="cell-secondary">${row.features.join(', ')}</span>`
            : `<span class="cell-secondary">—</span>`,
      },
    ],
    rows
  );
}

/* ------------------------------------------------------------------ Setup */

async function renderSetup() {
  const panel = $id('health-panel');
  if (!panel) return;

  try {
    const health = await fetchHealth();
    const rows = [
      { name: 'Google Analytics 4', key: 'ga4' },
      { name: 'Google Search Console', key: 'gsc' },
      { name: 'Mouseflow', key: 'mouseflow' },
    ];

    panel.innerHTML =
      rows
        .map((row) => {
          const source = health.sources?.[row.key] || {};
          const detail = Object.entries(source.variables || {})
            .map(([name, info]) => {
              if (!info.set) return `${name}: <strong>missing</strong>`;
              // Secrets report a length and last few characters only.
              if (info.value !== undefined) return `${name}: ${info.value}`;
              return `${name}: set (${info.length} chars, ends "${info.endsWith}")`;
            })
            .join('<br>');

          return `
            <div class="check-row">
              <span class="check-row__name">${row.name}</span>
              <span class="pill ${source.configured ? 'pill--live' : 'pill--demo'}">
                <span class="pill__dot"></span>${source.configured ? 'Connected' : 'Sample data'}
              </span>
            </div>
            ${source.problem ? `<div class="error-box"><strong>Why this is showing sample data</strong>${source.problem}</div>` : ''}
            ${source.warning ? `<div class="error-box" style="color:#a96a00;background:#fff6e5">${source.warning}</div>` : ''}
            <div class="cell-secondary" style="padding:0 0 12px 2px;line-height:1.7">${detail}</div>`;
        })
        .join('') +
      (health.serviceAccountEmail
        ? `<p class="cell-secondary" style="margin:14px 0 0">Grant this service account read access in GA4 and Search Console: <code>${health.serviceAccountEmail}</code></p>`
        : `<p class="cell-secondary" style="margin:14px 0 0">No Google service account is configured yet.</p>`);
  } catch (error) {
    panel.innerHTML = `<div class="error-box"><strong>Status check failed</strong>${error.message}</div>`;
  }
}

/* ------------------------------------------------------------------ Views */

function renderActiveView() {
  if (state.view === 'overview') renderOverview();
  else if (state.view === 'acquisition') renderAcquisition();
  else if (state.view === 'search') renderSearch();
  else if (state.view === 'rankings') renderRankings();
  else if (state.view === 'behavior') renderBehavior();
  else if (state.view === 'setup') renderSetup();
}

function switchView(view) {
  state.view = view;

  for (const tab of document.querySelectorAll('.nav__item')) {
    const selected = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }

  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.id !== `view-${view}`;
  }

  const meta = VIEW_META[view];
  if (meta) {
    $id('view-title').textContent = meta.title;
    $id('view-subtitle').textContent = meta.subtitle;
  }

  // Charts inside a hidden panel render at zero width, so draw on reveal.
  renderActiveView();
}

/* ------------------------------------------------------------------- Data */

async function loadAll() {
  if (state.inflight) state.inflight.abort();
  const controller = new AbortController();
  state.inflight = controller;
  state.loading = true;
  state.errors = {};

  // Search Console lags a couple of days; GA4 is effectively current.
  state.range = resolveRange(state.preset, state.customStart, state.customEnd, 1);
  const gscRange = resolveRange(state.preset, state.customStart, state.customEnd, 3);

  document.body.classList.add('is-loading');
  refreshStatusStrip();

  const results = await Promise.allSettled([
    fetchGa4(state.range, controller.signal),
    fetchGsc(gscRange, controller.signal),
    fetchMouseflow(state.range, controller.signal),
    // Rank data is a build-time file, so it ignores the date range.
    fetchRankings(controller.signal),
  ]);

  if (controller.signal.aborted) return;

  const [ga4Result, gscResult, mouseflowResult, rankingsResult] = results;

  if (ga4Result.status === 'fulfilled') state.ga4 = ga4Result.value;
  else if (ga4Result.reason?.name !== 'AbortError') state.errors.ga4 = ga4Result.reason?.message;

  if (gscResult.status === 'fulfilled') state.gsc = gscResult.value;
  else if (gscResult.reason?.name !== 'AbortError') state.errors.gsc = gscResult.reason?.message;

  if (mouseflowResult.status === 'fulfilled') state.mouseflow = mouseflowResult.value;
  else if (mouseflowResult.reason?.name !== 'AbortError') {
    state.errors.mouseflow = mouseflowResult.reason?.message;
  }

  if (rankingsResult.status === 'fulfilled') state.rankings = rankingsResult.value;
  else if (rankingsResult.reason?.name !== 'AbortError') {
    state.errors.rankings = rankingsResult.reason?.message;
  }

  state.loading = false;
  state.inflight = null;
  document.body.classList.remove('is-loading');

  refreshStatusStrip();
  renderActiveView();
}

/* ---------------------------------------------------------------- Exports */

const EXPORTS = {
  'ga4-pages': () => ({
    filename: 'brandwide-top-pages',
    rows: state.ga4?.topPages || [],
    columns: [
      { key: 'path', label: 'Page' },
      { key: 'title', label: 'Title' },
      { key: 'views', label: 'Views' },
      { key: 'users', label: 'Users' },
      { key: 'avgEngagementDuration', label: 'Avg engagement (s)' },
    ],
  }),
  'ga4-channels': () => ({
    filename: 'brandwide-channels',
    rows: state.ga4?.channels || [],
    columns: [
      { key: 'channel', label: 'Channel' },
      { key: 'sessions', label: 'Sessions' },
      { key: 'users', label: 'Users' },
      { key: 'engagementRate', label: 'Engagement rate' },
      { key: 'conversions', label: 'Conversions' },
    ],
  }),
  'ga4-countries': () => ({
    filename: 'brandwide-countries',
    rows: state.ga4?.countries || [],
    columns: [
      { key: 'country', label: 'Country' },
      { key: 'sessions', label: 'Sessions' },
    ],
  }),
  'gsc-queries': () => ({
    filename: 'brandwide-search-queries',
    rows: state.gsc?.queries || [],
    columns: [
      { key: 'query', label: 'Query' },
      { key: 'clicks', label: 'Clicks' },
      { key: 'impressions', label: 'Impressions' },
      { key: 'ctr', label: 'CTR' },
      { key: 'position', label: 'Position' },
    ],
  }),
  'gsc-pages': () => ({
    filename: 'brandwide-search-pages',
    rows: state.gsc?.pages || [],
    columns: [
      { key: 'page', label: 'Page' },
      { key: 'clicks', label: 'Clicks' },
      { key: 'impressions', label: 'Impressions' },
      { key: 'ctr', label: 'CTR' },
      { key: 'position', label: 'Position' },
    ],
  }),
  rankings: () => {
    const latest = state.rankings?.snapshots?.[state.rankings.snapshots.length - 1];
    return {
      filename: 'brandwide-rankings',
      rows: (latest?.keywords || []).map((row) => ({
        ...row,
        features: row.features?.join(' | ') || '',
        aiOverview: row.aiOverview ? 'Yes' : 'No',
      })),
      columns: [
        { key: 'keyword', label: 'Keyword' },
        { key: 'position', label: 'Position' },
        { key: 'previousPosition', label: 'Previous position' },
        { key: 'change', label: 'Change' },
        { key: 'aiOverview', label: 'AI Overview' },
        { key: 'searchVolume', label: 'Search volume' },
        { key: 'url', label: 'URL' },
        { key: 'features', label: 'SERP features' },
      ],
    };
  },
  'mf-entry': () => ({
    filename: 'brandwide-mouseflow-entry-pages',
    rows: state.mouseflow?.entryPages || [],
    columns: [
      { key: 'page', label: 'Entry page' },
      { key: 'recordings', label: 'Recordings' },
    ],
  }),
  'mf-recordings': () => ({
    filename: 'brandwide-mouseflow-recordings',
    rows: state.mouseflow?.recordings || [],
    columns: [
      { key: 'id', label: 'Session ID' },
      { key: 'date', label: 'Date' },
      { key: 'entryPage', label: 'Entry page' },
      { key: 'device', label: 'Device' },
      { key: 'browser', label: 'Browser' },
      { key: 'country', label: 'Country' },
      { key: 'pageViews', label: 'Page views' },
      { key: 'duration', label: 'Duration (s)' },
      { key: 'frictionScore', label: 'Friction score' },
      { key: 'url', label: 'Playback URL' },
    ],
  }),
};

/* -------------------------------------------------------------------- Init */

function bindEvents() {
  for (const tab of document.querySelectorAll('.nav__item')) {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  }

  const rangeSelect = $id('range-select');
  rangeSelect.addEventListener('change', () => {
    state.preset = rangeSelect.value;
    const isCustom = state.preset === 'custom';
    $id('custom-start-field').hidden = !isCustom;
    $id('custom-end-field').hidden = !isCustom;

    // Wait for both custom dates before firing a request.
    if (isCustom && !(state.customStart && state.customEnd)) return;
    loadAll();
  });

  for (const id of ['custom-start', 'custom-end']) {
    $id(id).addEventListener('change', () => {
      state.customStart = $id('custom-start').value;
      state.customEnd = $id('custom-end').value;
      if (state.customStart && state.customEnd) loadAll();
    });
  }

  $id('refresh-btn').addEventListener('click', () => loadAll());
  $id('print-btn').addEventListener('click', () => window.print());

  $id('trend-metric').addEventListener('change', (event) => {
    state.trendMetric = event.target.value;
    renderTrendChart();
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-export]');
    if (!button) return;
    const builder = EXPORTS[button.dataset.export];
    if (!builder) return;
    const { filename, rows, columns } = builder();
    downloadCsv(`${filename}-${state.range?.startDate}-to-${state.range?.endDate}.csv`, rows, columns);
  });

  // Chart.js is configured responsive, so it re-fits its own canvases on
  // resize — rebuilding them here would only throw away work and flicker.

  window.addEventListener('beforeunload', () => destroyAll());
}

function init() {
  applyChartDefaults();
  bindEvents();

  // Seed the custom-range inputs with the default window.
  const seed = resolveRange('28d');
  $id('custom-start').value = seed.startDate;
  $id('custom-end').value = seed.endDate;

  switchView('overview');
  loadAll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
