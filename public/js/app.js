/*
 * Brandwide Analytics — application shell.
 *
 * Loads the three data sources in parallel, keeps the last successful payload
 * so a failure in one panel never blanks the others, and re-renders the active
 * view on tab switch rather than redrawing everything on every change.
 */
import {
  resolveRange, fetchGa4, fetchGsc, fetchMouseflow, fetchHealth, fetchRankings,
  fetchPageAudit, fetchCompetitors,
} from './api.js';
import { buildCtrModel } from './shared/ctr.js';
import { rankOpportunities, pathOf } from './shared/opportunity.js';
import { analyseCompetitors } from './shared/competitors.js';
import { applyChartDefaults, lineChart, barChart, donutChart, destroyAll, PALETTE } from './charts.js';
import {
  num, compact, axisNum, percent, decimal, duration, shortDate, longDate, dateTime,
  delta, positionDelta, tidyPath, countryName, titleCase, downloadCsv,
} from './format.js';

const VIEW_META = {
  overview: { title: 'Overview', subtitle: 'Traffic, search and on-site behaviour at a glance' },
  acquisition: { title: 'Acquisition', subtitle: 'How visitors find brandwide.com' },
  search: { title: 'Search Console', subtitle: 'Organic visibility, queries and landing pages' },
  competitors: { title: 'Competitors', subtitle: 'Where we meet FranchiseSoft, FranConnect and Delightree in search' },
  pages: { title: 'Page analysis', subtitle: 'Which pages to improve first, and exactly what to change' },
  rankings: { title: 'Rankings', subtitle: 'True tracked positions and AI Overview citations, from AWR Cloud' },
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
  competitors: null,
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
      positionKpi(),
    ].join('');

    const labels = (gsc.timeseries || []).map((point) => shortDate(point.date));
    lineChart('chart-gsc-clicks-mini', labels, [
      { label: 'Clicks', data: (gsc.timeseries || []).map((point) => point.clicks) },
    ], { valueFormatter: (value, isAxis) => (isAxis ? axisNum(value) : num(value)) });

    lineChart('chart-gsc-impressions-mini', labels, [
      { label: 'Impressions', data: (gsc.timeseries || []).map((point) => point.impressions), color: PALETTE[1] },
    ], { valueFormatter: (value, isAxis) => (isAxis ? axisNum(value) : num(value)) });

    const queries = gsc.queries || [];
    const tracked = trackedByKeyword();
    const maxClicks = Math.max(...queries.map((query) => query.clicks), 0);
    renderTable(
      'table-top-queries',
      [
        { label: 'Query', render: (row) => `<div class="cell-primary" title="${row.query}">${row.query}</div>` },
        { label: 'Clicks', align: 'right', render: (row) => barCell(row.clicks, maxClicks, num(row.clicks)) },
        { label: 'CTR', align: 'right', render: (row) => percent(row.ctr, 1) },
        { label: 'Position', align: 'right', render: (row) => truePositionCell(row.query, tracked) },
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
    positionKpi(),
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

  // Where AWR data exists this slot shows real tracked positions instead of
  // Search Console's impression-weighted average.
  const rankingHistory = state.rankings?.history || [];
  const positionCard = $id('chart-gsc-position')?.closest('.card');

  if (rankingHistory.length) {
    const heading = positionCard?.querySelector('.card__title');
    const subtitle = positionCard?.querySelector('.card__subtitle');
    if (heading) heading.textContent = 'Tracked keywords in top 3';
    if (subtitle) subtitle.textContent = 'From AWR tracked keywords, weekly';

    lineChart(
      'chart-gsc-position',
      rankingHistory.map((point) => shortDate(point.date)),
      [{ label: 'Top 3', data: rankingHistory.map((point) => point.top3), color: PALETTE[3] }],
      { valueFormatter: (value) => num(value) }
    );
  } else {
    const subtitle = positionCard?.querySelector('.card__subtitle');
    if (subtitle) subtitle.textContent = 'Impression-weighted average — lower is better';

    lineChart('chart-gsc-position', labels, [
      { label: 'Position', data: points.map((point) => Number((point.position || 0).toFixed(1))), color: PALETTE[3] },
    ], { valueFormatter: (value) => decimal(value), beginAtZero: false, reverse: true });
  }

  const queries = gsc.queries || [];
  const tracked = trackedByKeyword();
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
    {
      label: 'True position',
      align: 'right',
      render: (row) => truePositionCell(row[key], tracked),
    },
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

/**
 * The position scorecard for the Search Console panels.
 *
 * Search Console's average position is impression-weighted across every query
 * and page, so it is replaced by a tracked-keyword count wherever AWR data
 * exists. Without that data it falls back to the Search Console figure, plainly
 * labelled for what it is.
 */
function positionKpi() {
  const snapshots = state.rankings?.snapshots || [];
  if (!snapshots.length) {
    const totals = state.gsc?.totals || {};
    const previous = state.gsc?.previousTotals || {};
    return kpiCard({
      label: 'Avg. position (GSC)',
      value: decimal(totals.position),
      current: totals.position,
      previous: previous.position,
      inverse: true,
      compareText: 'impression-weighted average',
    });
  }

  const latest = snapshots[snapshots.length - 1].totals;
  const prior = snapshots.length > 1 ? snapshots[snapshots.length - 2].totals : {};
  return kpiCard({
    label: 'Tracked in top 3',
    value: num(latest.top3),
    current: latest.top3,
    previous: prior.top3,
    compareText: 'AWR tracked keywords',
  });
}

/**
 * Tracked positions keyed by normalised keyword, from the newest AWR snapshot.
 * Lets the Search Console tables show a real ranking in place of an average.
 */
function trackedByKeyword() {
  const latest = state.rankings?.snapshots?.[state.rankings.snapshots.length - 1];
  const index = new Map();
  for (const row of latest?.keywords || []) {
    index.set(row.keyword.trim().toLowerCase().replace(/\s+/g, ' '), row);
  }
  return index;
}

/**
 * Renders a true position for a Search Console query.
 * Falls back to "not tracked" rather than Search Console's own figure, which
 * averages across pages and across the whole date range.
 */
function truePositionCell(query, index) {
  const match = index.get(String(query || '').trim().toLowerCase().replace(/\s+/g, ' '));
  if (!match) {
    return `<span class="cell-secondary" title="Not in the AWR tracked keyword set">not tracked</span>`;
  }
  if (match.position === null) {
    return `<span class="cell-secondary" title="Tracked, but not ranking in the tracked depth">unranked</span>`;
  }
  const band = match.position <= 3 ? 'low' : match.position <= 10 ? 'mid' : 'high';
  const aio = match.aiCited
    ? ` <span class="cell-secondary" title="Cited at position ${match.aiCitationRank} in the AI Overview">AIO #${match.aiCitationRank}</span>`
    : '';
  return `<span class="score score--${band}">${decimal(match.position, 0)}</span>${aio}`;
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

  // Data-quality notices live on the Data sources tab, not here — this report
  // is shown to clients.
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
        <p style="margin:12px 0 0;color:var(--ink-muted)">
          <strong>On AI Overviews:</strong> an AI Overview appears on
          ${num(totals.aiOverviewSerps)} of ${num(totals.trackedKeywords)} tracked SERPs —
          that is the competitive backdrop, not a result. The number that matters is how
          often you are <em>cited</em> in one: ${num(totals.aiCited)} keywords, of which
          ${num(totals.aiCitedFirst)} cite you first of all sources.
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
        <div class="card__head"><div><h3 class="card__title">AI Overview citations</h3>
          <p class="card__subtitle">Keywords citing you, and those citing you first</p></div></div>
        <div class="card__body"><div class="chart-wrap chart-wrap--short"><canvas id="chart-rank-aio"></canvas></div></div>
      </div>
    </div>

    <h2 class="section-title">Keywords</h2>
    <div class="card">
      <div class="card__head">
        <div><h3 class="card__title">Tracked keyword positions</h3>
          <p class="card__subtitle">${longDate(latest.date)}${previous ? ` · change vs ${longDate(previous.date)}` : ''}</p></div>
        <div class="card__actions"><button class="btn btn--ghost btn--sm" data-export="rankings" type="button">Export CSV</button></div>
      </div>
      <div class="card__body card__body--flush"><div class="table-scroll"><table id="table-rankings"></table></div></div>
    </div>`;

  $id('rankings-kpis').innerHTML = [
    kpiCard({ label: 'In top 3', value: num(totals.top3), current: totals.top3, previous: before.top3, compareText: previous ? 'vs last export' : 'tracked keywords' }),
    kpiCard({ label: 'In top 10', value: num(totals.top10), current: totals.top10, previous: before.top10, compareText: previous ? 'vs last export' : 'tracked keywords' }),
    kpiCard({ label: 'Cited in AI Overviews', value: num(totals.aiCited), current: totals.aiCited, previous: before.aiCited, compareText: previous ? 'vs last export' : 'tracked keywords' }),
    kpiCard({ label: '#1 in AI Overview', value: num(totals.aiCitedFirst), current: totals.aiCitedFirst, previous: before.aiCitedFirst, compareText: 'cited first of all sources' }),
    kpiCard({ label: 'Median position', value: decimal(totals.medianPosition, 1), current: totals.medianPosition, previous: before.medianPosition, asPositions: true, compareText: 'of ranked keywords' }),
    kpiCard({ label: 'Tracked', value: num(totals.trackedKeywords), noCompare: true, compareText: `${totals.rankedKeywords} ranked, ${totals.unrankedKeywords} not` }),
  ].join('');

  const labels = data.history.map((point) => shortDate(point.date));
  lineChart('chart-rank-bands', labels, [
    { label: 'Top 3', data: data.history.map((point) => point.top3) },
    { label: 'Top 10', data: data.history.map((point) => point.top10), color: PALETTE[1] },
  ], { valueFormatter: (value) => num(value) });

  lineChart('chart-rank-aio', labels, [
    { label: 'Cited', data: data.history.map((point) => point.aiCited), color: PALETTE[3] },
    { label: 'Cited first', data: data.history.map((point) => point.aiCitedFirst), color: PALETTE[4] },
  ], { valueFormatter: (value) => num(value) });

  // Ranked keywords first, best position first; unranked fall to the bottom.
  const rows = [...latest.keywords].sort((a, b) => {
    // AI Overview citations first, best citation rank first, then by position.
    if (a.aiCited !== b.aiCited) return a.aiCited ? -1 : 1;
    if (a.aiCited && b.aiCited) return a.aiCitationRank - b.aiCitationRank;
    if (a.position === null) return 1;
    if (b.position === null) return -1;
    return a.position - b.position;
  });

  renderTable(
    'table-rankings',
    [
      {
        label: 'Keyword',
        render: (row) => {
          const path = row.url ? tidyPath(row.url, 44) : '';
          const label = path === '/' ? 'Home' : path;
          return `<div class="cell-primary" title="${row.keyword}">${row.keyword}</div>
            ${label ? `<div class="cell-secondary" title="${row.url}">${label}</div>` : ''}`;
        },
      },
      { label: 'Position', align: 'right', render: (row) => positionCell(row.position) },
      { label: 'Change', align: 'right', render: (row) => changeCell(row.change) },
      {
        label: 'AI Overview',
        align: 'right',
        render: (row) => {
          if (!row.aiCited) {
            // Distinguish "no AI Overview here" from "there is one, without us".
            return row.serpHasAiOverview
              ? `<span class="cell-secondary" title="An AI Overview appears for this keyword, but you are not cited">not cited</span>`
              : `<span class="cell-secondary">—</span>`;
          }
          const band = row.aiCitationRank <= 3 ? 'low' : 'mid';
          return `<span class="score score--${band}" title="Cited at position ${row.aiCitationRank} in the AI Overview">#${row.aiCitationRank}</span>` +
            (row.aiTopSource ? ` <span class="cell-secondary" title="You are the top-cited source">top</span>` : '');
        },
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

/* ------------------------------------------------------------- Competitors */

const OUTCOME_LABEL = {
  ahead: 'Ahead', behind: 'Behind', level: 'Level',
  uncontested: 'Uncontested', absent: 'Not ranking',
};

function outcomeBadge(outcome) {
  const tone = outcome === 'ahead' ? 'up' : outcome === 'behind' ? 'down' : 'flat';
  return `<span class="delta delta--${tone}">${OUTCOME_LABEL[outcome] || outcome}</span>`;
}

/** A rank cell that marks an AI Overview citation distinctly from a blue link. */
function rankCell(rank) {
  if (!rank) return '<span class="cell-secondary">—</span>';
  const isAi = rank.kind === 'ai_overview' || rank.kind === 'ai_overview_sitelink';
  const band = rank.position <= 3 ? 'low' : rank.position <= 10 ? 'mid' : 'high';
  return `<span class="score score--${band}" title="${rank.url}">${rank.position}</span>` +
    (isAi ? ' <span class="flag flag--ai" title="Cited in the AI Overview">AIO</span>' : '');
}

function renderCompetitors() {
  const container = $id('competitors-body');
  if (!container) return;

  const snapshot = state.competitors;
  const data = snapshot ? analyseCompetitors(snapshot) : null;

  if (!data) {
    container.innerHTML = `
      <div class="card"><div class="card__body">
        <div class="empty">No competitor snapshot yet. Add one to
        <code>data/competitors/</code> and it will appear here.</div>
      </div></div>`;
    return;
  }

  const { summary } = data;
  const self = data.domains.find((domain) => domain.domain === data.self);

  container.innerHTML = `
    <h2 class="section-title">Head to head · ${longDate(data.date)}</h2>
    <div class="grid grid--kpi">
      ${kpiCard({ label: 'Keywords compared', value: num(summary.keywordsCompared), noCompare: true, compareText: `${summary.contested} contested` })}
      ${kpiCard({ label: 'Winning', value: num(summary.ahead), noCompare: true, compareText: `of ${summary.contested} contested` })}
      ${kpiCard({ label: 'Losing', value: num(summary.behind), noCompare: true, compareText: 'a rival ranks higher' })}
      ${kpiCard({ label: 'Not ranking', value: num(summary.gaps), noCompare: true, compareText: `${num(summary.gapVolume)} monthly searches` })}
      ${kpiCard({ label: 'AI Overviews held', value: num(summary.myAiOverviews), noCompare: true, compareText: 'cited by Google' })}
      ${kpiCard({ label: 'AI Overviews lost', value: num(summary.aiOverviewsLost), noCompare: true, compareText: 'a rival is cited, we are not' })}
    </div>

    <h2 class="section-title">Visibility</h2>
    <div class="grid grid--halves">
      <div class="card">
        <div class="card__head"><div><h3 class="card__title">Organic traffic and keywords</h3>
          <p class="card__subtitle">Ahrefs estimates, US, ${longDate(data.date)}</p></div></div>
        <div class="card__body card__body--flush"><div class="table-scroll"><table id="table-comp-domains"></table></div></div>
      </div>
      <div class="card">
        <div class="card__head"><div><h3 class="card__title">How directly each competes</h3>
          <p class="card__subtitle">Shared keywords, and who wins them</p></div></div>
        <div class="card__body card__body--flush"><div class="table-scroll"><table id="table-comp-h2h"></table></div></div>
      </div>
    </div>

    <h2 class="section-title">Contested keywords</h2>
    <div class="card">
      <div class="card__head">
        <div><h3 class="card__title">Where we meet them</h3>
          <p class="card__subtitle">Keywords we and at least one rival both rank for</p></div>
        <div class="card__actions"><button class="btn btn--ghost btn--sm" data-export="comp-contested" type="button">Export CSV</button></div>
      </div>
      <div class="card__body card__body--flush"><div class="table-scroll"><table id="table-comp-contested"></table></div></div>
    </div>

    <h2 class="section-title">Content gaps</h2>
    <div class="card">
      <div class="card__head">
        <div><h3 class="card__title">Searches a rival owns and we do not appear for</h3>
          <p class="card__subtitle">Ranked by monthly search volume</p></div>
        <div class="card__actions"><button class="btn btn--ghost btn--sm" data-export="comp-gaps" type="button">Export CSV</button></div>
      </div>
      <div class="card__body card__body--flush"><div class="table-scroll"><table id="table-comp-gaps"></table></div></div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card__body">
        <p style="margin:0;color:var(--ink-muted)">
          ${data.source}. ${data.note || ''}
          Ahrefs counts an AI Overview citation as a ranking position, marked
          <span class="flag flag--ai">AIO</span> above, which is why a keyword can show
          position 1 without a first organic result.
        </p>
      </div>
    </div>`;

  const maxTraffic = Math.max(...data.domains.map((domain) => domain.orgTraffic || 0), 0);
  renderTable(
    'table-comp-domains',
    [
      {
        label: 'Domain',
        render: (row) => `<div class="cell-primary">${row.label}${row.self ? ' <span class="flag flag--easy">us</span>' : ''}</div>
          <div class="cell-secondary">${row.domain}</div>`,
      },
      { label: 'Organic traffic', align: 'right', render: (row) => barCell(row.orgTraffic, maxTraffic, num(row.orgTraffic)) },
      { label: 'Keywords', align: 'right', render: (row) => num(row.orgKeywords) },
      { label: 'In top 3', align: 'right', render: (row) => num(row.orgTop3) },
      { label: 'Traffic value', align: 'right', render: (row) => `$${num(row.orgValueUsd)}` },
    ],
    data.domains
  );

  renderTable(
    'table-comp-h2h',
    [
      { label: 'Competitor', render: (row) => `<div class="cell-primary">${row.label}</div>` },
      { label: 'Shared', align: 'right', render: (row) => num(row.shared) },
      {
        label: 'W / L',
        align: 'right',
        render: (row) =>
          `<span style="color:var(--positive);font-weight:700">${row.wins}</span> / <span style="color:var(--negative);font-weight:700">${row.losses}</span>`,
      },
      {
        label: 'Their own',
        align: 'right',
        render: (row) => `${num(row.exclusiveKeywords)}<div class="cell-secondary">${num(row.exclusiveVolume)} vol</div>`,
      },
    ],
    data.headToHead
  );

  const rivalColumns = data.domains
    .filter((domain) => domain.domain !== data.self)
    .map((domain) => ({
      label: domain.label,
      align: 'right',
      render: (row) => rankCell(row.rivals.find((rival) => rival.domain === domain.domain)?.rank),
    }));

  renderTable(
    'table-comp-contested',
    [
      { label: 'Keyword', render: (row) => `<div class="cell-primary">${row.keyword}</div>` },
      { label: 'Volume', align: 'right', render: (row) => num(row.volume) },
      { label: self?.label || 'Us', align: 'right', render: (row) => rankCell(row.mine) },
      ...rivalColumns,
      { label: '', align: 'right', render: (row) => outcomeBadge(row.outcome) },
    ],
    data.contested
  );

  const maxGapVolume = Math.max(...data.gaps.map((row) => row.volume || 0), 0);
  renderTable(
    'table-comp-gaps',
    [
      { label: 'Keyword', render: (row) => `<div class="cell-primary">${row.keyword}</div>` },
      { label: 'Volume', align: 'right', render: (row) => barCell(row.volume, maxGapVolume, num(row.volume)) },
      { label: 'Difficulty', align: 'right', render: (row) => (row.keywordDifficulty === null ? '—' : num(row.keywordDifficulty)) },
      {
        label: 'Who ranks',
        render: (row) =>
          row.rivals
            .map((rival) => `<span class="flag">${rival.label} #${rival.rank.position}</span>`)
            .join(''),
      },
      {
        label: 'Their page',
        render: (row) =>
          row.bestRival
            ? `<a href="${row.bestRival.rank.url}" target="_blank" rel="noopener noreferrer" class="cell-secondary">${tidyPath(row.bestRival.rank.url, 40)}</a>`
            : '—',
      },
    ],
    data.gaps.slice(0, 40)
  );
}

/* ---------------------------------------------------------- Page analysis */

const FLAG_LABELS = {
  ctr: 'CTR below par',
  striking: 'Striking distance',
  ai: 'AI Overview gap',
  deep: 'Ranking deep',
  engagement: 'Low engagement',
};

function flagBadges(page) {
  const badges = page.flags.map(
    (flag) => `<span class="flag flag--${flag}">${FLAG_LABELS[flag] || flag}</span>`
  );
  if (page.easy) badges.unshift('<span class="flag flag--easy">Quick win</span>');
  return badges.join('') || '<span class="cell-secondary">—</span>';
}

/** Builds the opportunity ranking from whatever data is currently loaded. */
function opportunityList() {
  const latest = state.rankings?.snapshots?.[state.rankings.snapshots.length - 1];
  const queries = state.gsc?.queries || [];
  const ctrModel = buildCtrModel(queries);

  return {
    ctrModel,
    pages: rankOpportunities({
      gscPages: state.gsc?.pages || [],
      gscQueries: queries,
      keywords: latest?.keywords || [],
      ga4Pages: state.ga4?.topPages || [],
      ctrModel,
    }),
  };
}

function renderPages() {
  const container = $id('pages-body');
  if (!container) return;
  renderErrors('pages-errors', ['ga4', 'gsc']);

  const { ctrModel, pages } = opportunityList();

  if (!pages.length) {
    container.innerHTML = `
      <div class="card"><div class="card__body">
        <div class="empty">No page data yet. Connect Search Console, or add a ranking
        export, and this report will populate.</div>
      </div></div>`;
    return;
  }

  const totalUpside = pages.reduce((sum, page) => sum + page.ctrGapClicks, 0);
  const quickWins = pages.filter((page) => page.easy).length;
  const aiGapPages = pages.filter((page) => page.aiGaps.length).length;

  container.innerHTML = `
    <h2 class="section-title">Where the upside is</h2>
    <div class="grid grid--kpi">
      ${kpiCard({ label: 'Pages analysed', value: num(pages.length), noCompare: true, compareText: 'with search data' })}
      ${kpiCard({ label: 'Clicks available', value: num(totalUpside), noCompare: true, compareText: 'from CTR gaps alone' })}
      ${kpiCard({ label: 'Quick wins', value: num(quickWins), noCompare: true, compareText: 'small change, real gain' })}
      ${kpiCard({ label: 'AI Overview gaps', value: num(aiGapPages), noCompare: true, compareText: 'pages not being cited' })}
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card__head"><div><h3 class="card__title">How this is calculated</h3></div></div>
      <div class="card__body">
        <p style="margin:0;color:var(--ink-muted)">
          Pages are ranked by estimated clicks available, combining three measurable gaps:
          click-through below what this site typically achieves at that position,
          keywords sitting just outside the top 3, and searches where an AI Overview
          appears without citing the page. The expected click-through rate is measured
          from this site's own Search Console data
          ${ctrModel.bucketsMeasured
            ? `(${ctrModel.bucketsMeasured} position band${ctrModel.bucketsMeasured === 1 ? '' : 's'} measured)`
            : '(using benchmark rates until more data accumulates)'}
          rather than a published industry average. These are estimates for
          prioritisation, not forecasts.
        </p>
      </div>
    </div>

    <h2 class="section-title">Priority order</h2>
    <div class="card">
      <div class="card__head">
        <div><h3 class="card__title">Pages to work on first</h3>
          <p class="card__subtitle">Select a page to run a live on-page audit</p></div>
        <div class="card__actions"><button class="btn btn--ghost btn--sm" data-export="pages" type="button">Export CSV</button></div>
      </div>
      <div class="card__body card__body--flush"><div class="table-scroll"><table id="table-pages"></table></div></div>
    </div>

    <div id="page-audit-panel"></div>`;

  const maxUpside = Math.max(...pages.map((page) => page.totalUpside), 0);

  renderTable(
    'table-pages',
    [
      {
        label: 'Page',
        render: (row) =>
          `<button class="page-row-btn" data-audit="${row.url || row.path}" title="${row.path}">${tidyPath(row.path, 44)}</button>
           <div style="margin-top:4px">${flagBadges(row)}</div>`,
      },
      {
        label: 'Clicks available',
        align: 'right',
        render: (row) => barCell(row.totalUpside, maxUpside, num(row.totalUpside)),
      },
      { label: 'Clicks', align: 'right', render: (row) => num(row.clicks) },
      { label: 'Impressions', align: 'right', render: (row) => num(row.impressions) },
      {
        label: 'CTR',
        align: 'right',
        render: (row) => {
          if (row.actualCtr === null) return '—';
          const short = row.expectedCtr && row.actualCtr < row.expectedCtr * 0.7;
          return `<span${short ? ' style="color:var(--negative);font-weight:700"' : ''}>${percent(row.actualCtr, 1)}</span>
            <div class="cell-secondary">par ${percent(row.expectedCtr, 1)}</div>`;
        },
      },
      { label: 'Position', align: 'right', render: (row) => (row.position ? decimal(row.position) : '—') },
    ],
    pages.slice(0, 25)
  );
}

/** Runs the live audit for one page and renders it beneath the table. */
async function runPageAudit(target) {
  const panel = $id('page-audit-panel');
  if (!panel) return;

  const { pages } = opportunityList();
  const page =
    pages.find((row) => row.url === target) || pages.find((row) => row.path === pathOf(target));

  panel.innerHTML = `
    <h2 class="section-title">On-page audit</h2>
    <div class="card"><div class="card__body">
      <div class="empty">Fetching ${target} and checking meta data, headings, schema and content…</div>
    </div></div>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  let audit;
  try {
    audit = await fetchPageAudit(target, page ? {
      clicks: page.clicks,
      impressions: page.impressions,
      ctr: page.actualCtr,
      position: page.position,
      expectedCtr: page.expectedCtr,
      actualCtr: page.actualCtr,
      ctrGapClicks: page.ctrGapClicks,
      keywords: page.keywords,
      strikingDistance: page.strikingDistance,
      aiGaps: page.aiGaps,
      aiCited: page.aiCited,
      views: page.views,
      engagement: page.engagement,
    } : {});
  } catch (error) {
    panel.innerHTML = `
      <h2 class="section-title">On-page audit</h2>
      <div class="error-box"><strong>Could not audit this page</strong>${error.message}</div>`;
    return;
  }

  const s = audit.signals;
  const counts = audit.recommendations.reduce((tally, rec) => {
    tally[rec.severity] = (tally[rec.severity] || 0) + 1;
    return tally;
  }, {});

  const fact = (label, value, note, tone = '') => `
    <div class="fact ${tone}">
      <div class="fact__label">${label}</div>
      <div class="fact__value">${value}</div>
      ${note ? `<div class="fact__note">${note}</div>` : ''}
    </div>`;

  const titleTone = !s.title ? 'fact--bad' : s.titleLength > 60 || s.titleLength < 30 ? 'fact--warn' : 'fact--good';
  const descTone = !s.description ? 'fact--bad' : s.descriptionLength > 160 || s.descriptionLength < 70 ? 'fact--warn' : 'fact--good';

  panel.innerHTML = `
    <h2 class="section-title">On-page audit</h2>

    <div class="card">
      <div class="card__head">
        <div><h3 class="card__title">${tidyPath(audit.url, 60)}</h3>
          <p class="card__subtitle">
            Fetched in ${audit.fetchMs} ms${audit.redirected ? ' · redirected' : ''} ·
            ${counts.critical || 0} critical, ${counts.high || 0} high,
            ${counts.medium || 0} medium, ${counts.low || 0} low
          </p></div>
        <div class="card__actions">
          <a class="btn btn--ghost btn--sm" href="${audit.url}" target="_blank" rel="noopener noreferrer">Open page</a>
        </div>
      </div>
      <div class="card__body">
        <div class="facts">
          ${fact('Title', s.title ? `${s.titleLength} chars` : 'Missing', s.title ? `“${s.title}”` : 'No &lt;title&gt; found', titleTone)}
          ${fact('Meta description', s.description ? `${s.descriptionLength} chars` : 'Missing', s.description ? `“${s.description}”` : 'None found', descTone)}
          ${fact('Word count', num(s.wordCount), s.wordCount < 300 ? 'Thin for a ranking page' : 'Reasonable depth', s.wordCount < 300 ? 'fact--warn' : '')}
          ${fact('Headings', `${s.h1.length} H1 · ${s.h2.length} H2`, s.h1[0] ? `“${s.h1[0]}”` : 'No H1', s.h1.length === 1 ? 'fact--good' : 'fact--warn')}
          ${fact('Schema', s.schema.types.length ? s.schema.types.join(', ') : 'None', s.schema.invalidBlocks ? `${s.schema.invalidBlocks} invalid block(s)` : `${s.schema.blockCount} block(s)`, s.schema.blockCount ? (s.schema.invalidBlocks ? 'fact--bad' : 'fact--good') : 'fact--warn')}
          ${fact('FAQ', s.schema.hasFaq ? 'Marked up' : s.hasFaqHeading ? 'Content only' : 'None', s.schema.hasFaq ? 'FAQPage schema present' : s.hasFaqHeading ? 'Questions on page, no schema' : 'No FAQ section', s.schema.hasFaq ? 'fact--good' : s.hasFaqHeading ? 'fact--warn' : '')}
          ${fact('Internal links', num(s.internalLinks), `${s.externalLinks} external`, s.internalLinks < 3 ? 'fact--warn' : '')}
          ${fact('Images', num(s.imageCount), s.imagesMissingAlt ? `${s.imagesMissingAlt} missing alt` : 'All have alt text', s.imagesMissingAlt ? 'fact--warn' : '')}
        </div>
      </div>
    </div>

    <h2 class="section-title">Recommendations</h2>
    <div class="card">
      <div class="card__body card__body--flush">
        ${audit.recommendations.length
          ? audit.recommendations.map((rec) => `
            <div class="rec">
              <div>
                <span class="sev sev--${rec.severity}">${rec.severity}</span>
                <div class="rec__category" style="margin-top:6px">${rec.category}</div>
              </div>
              <div>
                <p class="rec__title">${rec.title}</p>
                <p class="rec__detail">${rec.detail}</p>
                <div class="rec__meta">Observed: ${rec.evidence}</div>
                <div class="rec__action"><strong>Do this:</strong> ${rec.action}</div>
              </div>
            </div>`).join('')
          : '<div class="empty">No issues found — this page is in good shape.</div>'}
      </div>
    </div>`;

  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

    const rankings = state.rankings;
    const rankingNotes = (rankings?.warnings || []).length
      ? `<div class="error-box" style="color:#a96a00;background:#fff6e5;border:1px solid #ffe3ab">
           <strong>Ranking data notes (${rankings.warnings.length})</strong>
           <p style="margin:4px 0 6px;font-weight:400">Internal only — these are not shown on the Rankings report.</p>
           <ul style="margin:0;padding-left:18px">
             ${rankings.warnings.map((w) => `<li style="margin-bottom:3px">${w}</li>`).join('')}
           </ul>
         </div>`
      : '';

    const rankingStatus = rankings?.snapshotCount
      ? `<div class="check-row">
           <span class="check-row__name">Rank tracking (AWR)</span>
           <span class="pill pill--live"><span class="pill__dot"></span>${rankings.snapshotCount} snapshot${rankings.snapshotCount === 1 ? '' : 's'}</span>
           <span class="cell-secondary">latest ${longDate(rankings.latest)}${
             rankings.filesRead && rankings.filesRead !== rankings.snapshotCount
               ? ` · ${rankings.filesRead} files read, ${rankings.filesRead - rankings.snapshotCount} skipped`
               : ''
           }</span>
         </div>`
      : `<div class="check-row">
           <span class="check-row__name">Rank tracking (AWR)</span>
           <span class="pill pill--demo"><span class="pill__dot"></span>No exports</span>
           <span class="cell-secondary">add a CSV to data/rankings/</span>
         </div>`;

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
      rankingStatus +
      (health.serviceAccountEmail
        ? `<p class="cell-secondary" style="margin:14px 0 0">Grant this service account read access in GA4 and Search Console: <code>${health.serviceAccountEmail}</code></p>`
        : `<p class="cell-secondary" style="margin:14px 0 0">No Google service account is configured yet.</p>`) +
      rankingNotes;
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
  else if (state.view === 'competitors') renderCompetitors();
  else if (state.view === 'pages') renderPages();
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
    fetchCompetitors(controller.signal),
  ]);

  if (controller.signal.aborted) return;

  const [ga4Result, gscResult, mouseflowResult, rankingsResult, competitorsResult] = results;

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

  if (competitorsResult.status === 'fulfilled') state.competitors = competitorsResult.value;

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
  'gsc-queries': () => {
    // Export the tracked position alongside the Search Console counts, which
    // is what the table shows.
    const tracked = trackedByKeyword();
    return {
      filename: 'brandwide-search-queries',
      rows: (state.gsc?.queries || []).map((row) => {
        const match = tracked.get(
          String(row.query || '').trim().toLowerCase().replace(/\s+/g, ' ')
        );
        return {
          ...row,
          trackedPosition: match?.position ?? '',
          aiCitationRank: match?.aiCitationRank ?? '',
          gscAveragePosition: row.position,
        };
      }),
      columns: [
        { key: 'query', label: 'Query' },
        { key: 'clicks', label: 'Clicks' },
        { key: 'impressions', label: 'Impressions' },
        { key: 'ctr', label: 'CTR' },
        { key: 'trackedPosition', label: 'True position (AWR)' },
        { key: 'aiCitationRank', label: 'AI Overview citation rank' },
        { key: 'gscAveragePosition', label: 'GSC average position' },
      ],
    };
  },
  'gsc-pages': () => ({
    filename: 'brandwide-search-pages',
    rows: state.gsc?.pages || [],
    columns: [
      { key: 'page', label: 'Page' },
      { key: 'clicks', label: 'Clicks' },
      { key: 'impressions', label: 'Impressions' },
      { key: 'ctr', label: 'CTR' },
    ],
  }),
  rankings: () => {
    const latest = state.rankings?.snapshots?.[state.rankings.snapshots.length - 1];
    return {
      filename: 'brandwide-rankings',
      rows: (latest?.keywords || []).map((row) => ({
        ...row,
        features: row.features?.join(' | ') || '',
        aiCitationRank: row.aiCitationRank ?? '',
        aiTopSource: row.aiTopSource ? 'Yes' : 'No',
        serpHasAiOverview: row.serpHasAiOverview ? 'Yes' : 'No',
      })),
      columns: [
        { key: 'keyword', label: 'Keyword' },
        { key: 'position', label: 'Position' },
        { key: 'previousPosition', label: 'Previous position' },
        { key: 'change', label: 'Change' },
        { key: 'aiCitationRank', label: 'AI Overview citation rank' },
        { key: 'aiTopSource', label: 'Top AI Overview source' },
        { key: 'serpHasAiOverview', label: 'SERP has AI Overview' },
        { key: 'searchVolume', label: 'Search volume' },
        { key: 'url', label: 'URL' },
        { key: 'features', label: 'SERP features' },
      ],
    };
  },
  'comp-contested': () => {
    const data = analyseCompetitors(state.competitors);
    return {
      filename: 'brandwide-contested-keywords',
      rows: (data?.contested || []).map((row) => ({
        keyword: row.keyword, volume: row.volume, difficulty: row.keywordDifficulty,
        ourPosition: row.mine?.position ?? '', ourKind: row.mine?.kind ?? '',
        bestRival: row.bestRival?.label ?? '', bestRivalPosition: row.bestRivalRank ?? '',
        outcome: row.outcome,
      })),
      columns: [
        { key: 'keyword', label: 'Keyword' }, { key: 'volume', label: 'Volume' },
        { key: 'difficulty', label: 'Difficulty' }, { key: 'ourPosition', label: 'Our position' },
        { key: 'ourKind', label: 'Our result type' }, { key: 'bestRival', label: 'Best rival' },
        { key: 'bestRivalPosition', label: 'Their position' }, { key: 'outcome', label: 'Outcome' },
      ],
    };
  },
  'comp-gaps': () => {
    const data = analyseCompetitors(state.competitors);
    return {
      filename: 'brandwide-content-gaps',
      rows: (data?.gaps || []).map((row) => ({
        keyword: row.keyword, volume: row.volume, difficulty: row.keywordDifficulty,
        whoRanks: row.rivals.map((r) => `${r.label} #${r.rank.position}`).join(' | '),
        theirPage: row.bestRival?.rank.url ?? '',
      })),
      columns: [
        { key: 'keyword', label: 'Keyword' }, { key: 'volume', label: 'Monthly volume' },
        { key: 'difficulty', label: 'Difficulty' }, { key: 'whoRanks', label: 'Who ranks' },
        { key: 'theirPage', label: 'Their ranking page' },
      ],
    };
  },
  pages: () => ({
    filename: 'brandwide-page-priorities',
    rows: opportunityList().pages.map((page) => ({
      path: page.path,
      clicks: page.clicks,
      impressions: page.impressions,
      ctr: page.actualCtr,
      expectedCtr: page.expectedCtr,
      position: page.position,
      ctrGapClicks: Math.round(page.ctrGapClicks),
      strikingUpside: Math.round(page.strikingUpside),
      aiUpside: Math.round(page.aiUpside),
      totalUpside: Math.round(page.totalUpside),
      strikingKeywords: page.strikingDistance.length,
      aiOverviewGaps: page.aiGaps.length,
      quickWin: page.easy ? 'Yes' : 'No',
      flags: page.flags.join(' | '),
    })),
    columns: [
      { key: 'path', label: 'Page' },
      { key: 'totalUpside', label: 'Estimated clicks available' },
      { key: 'ctrGapClicks', label: 'From CTR gap' },
      { key: 'strikingUpside', label: 'From striking distance' },
      { key: 'aiUpside', label: 'From AI Overview gaps' },
      { key: 'clicks', label: 'Clicks' },
      { key: 'impressions', label: 'Impressions' },
      { key: 'ctr', label: 'CTR' },
      { key: 'expectedCtr', label: 'Expected CTR' },
      { key: 'position', label: 'Position' },
      { key: 'strikingKeywords', label: 'Striking-distance keywords' },
      { key: 'aiOverviewGaps', label: 'AI Overview gaps' },
      { key: 'quickWin', label: 'Quick win' },
      { key: 'flags', label: 'Flags' },
    ],
  }),
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
    const auditButton = event.target.closest('[data-audit]');
    if (auditButton) {
      runPageAudit(auditButton.dataset.audit);
      return;
    }

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
