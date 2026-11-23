/**
 * GET|POST /api/ga4
 *
 * Fetches a full dashboard payload from the Google Analytics Data API (v1beta)
 * using batchRunReports, split into chunks of five (the API's per-batch limit)
 * and issued in parallel.
 *
 * Params: startDate, endDate, compareStartDate, compareEndDate (YYYY-MM-DD),
 *         limit (rows per breakdown table).
 */
import { googleFetch } from '../lib/google-auth.mjs';
import { ga4Config } from '../lib/config.mjs';
import { errorResponse, json, readParams, safeDate, safeLimit } from '../lib/http.mjs';
import { demoGa4 } from '../lib/demo-data.mjs';

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const API = 'https://analyticsdata.googleapis.com/v1beta';

/** batchRunReports rejects anything larger; exceeding it fails the whole call. */
const MAX_REPORTS_PER_BATCH = 5;

const SUMMARY_METRICS = [
  // GA4 counts these three differently, and the dashboard reports all three
  // rather than picking one and inviting the discrepancy to be noticed later:
  //   activeUsers — distinct users with an engaged session. This is the figure
  //                 GA4's own UI headlines as "Users".
  //   totalUsers  — distinct users with any event at all. Always >= activeUsers.
  //   newUsers    — driven by first_visit events, so it is an occurrence count
  //                 rather than a deduplicated user count, and can exceed both.
  'activeUsers',
  'totalUsers',
  'newUsers',
  'sessions',
  'screenPageViews',
  'engagementRate',
  'averageSessionDuration',
  'userEngagementDuration',
  'conversions',
];

/** Reads a metric out of a report row by its position in the header. */
function metricReader(report) {
  const index = new Map(
    (report?.metricHeaders || []).map((header, i) => [header.name, i])
  );
  return (row, name) => {
    const i = index.get(name);
    if (i === undefined) return 0;
    return Number(row?.metricValues?.[i]?.value ?? 0);
  };
}

function dimensionReader(report) {
  const index = new Map(
    (report?.dimensionHeaders || []).map((header, i) => [header.name, i])
  );
  return (row, name) => {
    const i = index.get(name);
    if (i === undefined) return '';
    return row?.dimensionValues?.[i]?.value ?? '';
  };
}

/** GA4 returns dates as YYYYMMDD; the dashboard wants YYYY-MM-DD. */
function isoDate(compact) {
  if (!/^\d{8}$/.test(compact)) return compact;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function summaryTotals(report) {
  const row = report?.rows?.[0];
  if (!row) {
    return {
      activeUsers: 0, users: 0, newUsers: 0, sessions: 0, pageViews: 0,
      conversions: 0, engagementRate: 0, avgEngagementDuration: 0,
    };
  }
  const m = metricReader(report);
  return {
    activeUsers: m(row, 'activeUsers'),
    users: m(row, 'totalUsers'),
    newUsers: m(row, 'newUsers'),
    sessions: m(row, 'sessions'),
    pageViews: m(row, 'screenPageViews'),
    conversions: m(row, 'conversions'),
    engagementRate: m(row, 'engagementRate'),
    avgEngagementDuration: m(row, 'averageSessionDuration'),
  };
}

const metrics = (names) => names.map((name) => ({ name }));
const dimensions = (names) => names.map((name) => ({ name }));

/**
 * Audience filtering.
 *
 * GA4's own bot exclusion only drops traffic on the IAB/Spiders list, which
 * misses the headless and datacentre traffic that inflated this property's
 * user totals. Two filters narrow the report to the audience the business
 * actually sells to:
 *
 *   country  — filtered on countryId (ISO 3166-1 alpha-2) rather than the
 *              display name, because the display name is localised and would
 *              silently stop matching.
 *   channel  — sessionDefaultChannelGroup, for isolating a single acquisition
 *              channel.
 *
 * The filter is applied to EVERY report in the batch, including the comparison
 * period, so the headline totals and the breakdown tables cannot disagree. It
 * is also echoed back in the payload: a filtered report that does not say it is
 * filtered is worse than an inflated one, because the number looks clean.
 */
const DEFAULT_COUNTRIES = ['US', 'CA'];

/** Only the codes this dashboard offers need a readable name. */
const COUNTRY_NAMES = {
  US: 'United States',
  CA: 'Canada',
  GB: 'United Kingdom',
  AU: 'Australia',
  IN: 'India',
};

/** Accepts "US,CA", ["US","CA"], or "all"/"" to clear the filter. */
function parseList(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = raw.map((item) => String(item).trim()).filter(Boolean);
  if (!cleaned.length) return [];
  if (cleaned.length === 1 && /^(all|any|\*)$/i.test(cleaned[0])) return [];
  return cleaned;
}

/** Country codes only — anything else would be rejected by the API anyway. */
const isCountryCode = (value) => /^[A-Za-z]{2}$/.test(value);

function buildAudienceFilter({ countries, channels }) {
  const expressions = [];

  if (countries.length) {
    expressions.push({
      filter: {
        fieldName: 'countryId',
        inListFilter: { values: countries.map((c) => c.toUpperCase()) },
      },
    });
  }

  if (channels.length) {
    expressions.push({
      filter: {
        fieldName: 'sessionDefaultChannelGroup',
        inListFilter: { values: channels, caseSensitive: false },
      },
    });
  }

  if (!expressions.length) return null;
  // A single expression still has to be wrapped: andGroup with one child is
  // valid, and keeps the shape uniform.
  return { andGroup: { expressions } };
}

export default async (req) => {
  try {
    const params = await readParams(req);
    const startDate = safeDate(params.startDate, 28);
    const endDate = safeDate(params.endDate, 1);
    const compareStartDate = safeDate(params.compareStartDate, 56);
    const compareEndDate = safeDate(params.compareEndDate, 29);
    const limit = safeLimit(params.limit, 10, 100);

    const compareRange = { startDate: compareStartDate, endDate: compareEndDate };

    const countries = parseList(params.countries, DEFAULT_COUNTRIES).filter(isCountryCode);
    const channels = parseList(params.channels, []);
    const audienceFilter = buildAudienceFilter({ countries, channels });

    const settings = ga4Config();

    if (!settings.ready) {
      // Say why rather than quietly serving sample data — a silent fallback
      // is indistinguishable from a broken connection.
      return json({
        ...demoGa4(startDate, endDate, compareRange),
        demoReason: settings.problem,
        // Sample data is not filtered; say so rather than letting the report
        // claim a filter that was never applied.
        filters: { countries: [], channels: [], applied: false, countryNames: [] },
      });
    }
    const propertyId = settings.propertyId;

    const dateRanges = [{ startDate, endDate }];
    const url = `${API}/properties/${propertyId}:batchRunReports`;

    const reportRequests = [
          // 0 — headline totals for the selected period
          { dateRanges, metrics: metrics(SUMMARY_METRICS) },
          // 1 — headline totals for the comparison period
          {
            dateRanges: [compareRange],
            metrics: metrics(SUMMARY_METRICS),
          },
          // 2 — daily trend
          {
            dateRanges,
            dimensions: dimensions(['date']),
            metrics: metrics([
              'activeUsers',
              'totalUsers',
              'newUsers',
              'sessions',
              'screenPageViews',
              'conversions',
            ]),
            orderBys: [{ dimension: { dimensionName: 'date' } }],
            limit: 400,
          },
          // 3 — acquisition channels
          {
            dateRanges,
            dimensions: dimensions(['sessionDefaultChannelGroup']),
            metrics: metrics([
              'sessions',
              'totalUsers',
              'engagementRate',
              'conversions',
            ]),
            orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
            limit,
          },
          // 4 — top pages
          {
            dateRanges,
            dimensions: dimensions(['pagePath', 'pageTitle']),
            metrics: metrics([
              'screenPageViews',
              'totalUsers',
              'userEngagementDuration',
            ]),
            orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
            limit,
          },
          // 5 — device split
          {
            dateRanges,
            dimensions: dimensions(['deviceCategory']),
            metrics: metrics(['sessions']),
            orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
            limit: 10,
          },
          // 6 — top countries
          {
            dateRanges,
            dimensions: dimensions(['country']),
            metrics: metrics(['sessions']),
            orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit,
      },
    ];

    // Applied uniformly: a filter on the totals but not the breakdowns would
    // produce tables that do not add up to the headline.
    const filteredRequests = audienceFilter
      ? reportRequests.map((request) => ({ ...request, dimensionFilter: audienceFilter }))
      : reportRequests;

    // The Data API rejects a batch of more than five reports, so send them in
    // chunks. Promise.all preserves input order, and the chunks are in order,
    // so the flattened reports line up with reportRequests exactly.
    const batches = [];
    for (let i = 0; i < filteredRequests.length; i += MAX_REPORTS_PER_BATCH) {
      batches.push(filteredRequests.slice(i, i + MAX_REPORTS_PER_BATCH));
    }

    const responses = await Promise.all(
      batches.map((requests) => googleFetch(url, { scope: SCOPE, body: { requests } }))
    );
    const allReports = responses.flatMap((response) => response.reports || []);

    const [
      summary,
      compareSummary,
      trend,
      channelReport,
      pageReport,
      deviceReport,
      countryReport,
    ] = allReports;

    const trendMetric = metricReader(trend);
    const trendDimension = dimensionReader(trend);
    const channelMetric = metricReader(channelReport);
    const channelDimension = dimensionReader(channelReport);
    const pageMetric = metricReader(pageReport);
    const pageDimension = dimensionReader(pageReport);
    const deviceMetric = metricReader(deviceReport);
    const deviceDimension = dimensionReader(deviceReport);
    const countryMetric = metricReader(countryReport);
    const countryDimension = dimensionReader(countryReport);

    return json({
      source: 'ga4',
      configured: true,
      demo: false,
      propertyId,
      range: { startDate, endDate },
      compareRange,
      // Stated explicitly so the report can label itself. Without this a
      // reader cannot tell a filtered figure from an unfiltered one.
      filters: {
        countries,
        channels,
        applied: Boolean(audienceFilter),
        countryNames: countries.map((code) => COUNTRY_NAMES[code] || code),
      },
      totals: summaryTotals(summary),
      previousTotals: summaryTotals(compareSummary),
      // Each user's first visit falls on exactly one day, so the daily new-user
      // figures should sum to the period total. Total users, by contrast, is
      // deduplicated across the period and so sums to more than it reports.
      // Comparing the two exposes whether new users is being counted per user
      // or per first_visit event.
      userCountCheck: (() => {
        const rows = trend?.rows || [];
        const m = metricReader(trend);
        const dailyNew = rows.reduce((total, row) => total + m(row, 'newUsers'), 0);
        const dailyTotal = rows.reduce((total, row) => total + m(row, 'totalUsers'), 0);
        const periodNew = summaryTotals(summary).newUsers;
        const periodTotal = summaryTotals(summary).users;
        return {
          dailyNewUsersSum: dailyNew,
          dailyTotalUsersSum: dailyTotal,
          periodNewUsers: periodNew,
          periodTotalUsers: periodTotal,
          // True when new users exceeds total users, which should be impossible.
          inverted: periodNew > periodTotal,
          newUsersExceedsBy: periodNew - periodTotal,
        };
      })(),
      timeseries: (trend?.rows || []).map((row) => ({
        date: isoDate(trendDimension(row, 'date')),
        activeUsers: trendMetric(row, 'activeUsers'),
        users: trendMetric(row, 'totalUsers'),
        newUsers: trendMetric(row, 'newUsers'),
        sessions: trendMetric(row, 'sessions'),
        pageViews: trendMetric(row, 'screenPageViews'),
        conversions: trendMetric(row, 'conversions'),
      })),
      channels: (channelReport?.rows || []).map((row) => ({
        channel: channelDimension(row, 'sessionDefaultChannelGroup') || '(not set)',
        sessions: channelMetric(row, 'sessions'),
        users: channelMetric(row, 'totalUsers'),
        engagementRate: channelMetric(row, 'engagementRate'),
        conversions: channelMetric(row, 'conversions'),
      })),
      topPages: (pageReport?.rows || []).map((row) => {
        const users = pageMetric(row, 'totalUsers');
        return {
          path: pageDimension(row, 'pagePath'),
          title: pageDimension(row, 'pageTitle'),
          views: pageMetric(row, 'screenPageViews'),
          users,
          // The API gives total engagement seconds; per-user is the readable form.
          avgEngagementDuration: users
            ? Math.round(pageMetric(row, 'userEngagementDuration') / users)
            : 0,
        };
      }),
      devices: (deviceReport?.rows || []).map((row) => ({
        device: deviceDimension(row, 'deviceCategory'),
        sessions: deviceMetric(row, 'sessions'),
      })),
      countries: (countryReport?.rows || []).map((row) => ({
        country: countryDimension(row, 'country'),
        sessions: countryMetric(row, 'sessions'),
      })),
    });
  } catch (error) {
    return errorResponse(error, 'ga4');
  }
};

export const config = { path: '/api/ga4' };
