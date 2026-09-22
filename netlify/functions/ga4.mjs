/**
 * GET|POST /api/ga4
 *
 * Fetches a full dashboard payload from the Google Analytics Data API (v1beta)
 * in a single batchRunReports call, plus one call for the comparison period.
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

const SUMMARY_METRICS = [
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
      users: 0, newUsers: 0, sessions: 0, pageViews: 0,
      conversions: 0, engagementRate: 0, avgEngagementDuration: 0,
    };
  }
  const m = metricReader(report);
  return {
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

export default async (req) => {
  try {
    const params = await readParams(req);
    const startDate = safeDate(params.startDate, 28);
    const endDate = safeDate(params.endDate, 1);
    const compareStartDate = safeDate(params.compareStartDate, 56);
    const compareEndDate = safeDate(params.compareEndDate, 29);
    const limit = safeLimit(params.limit, 10, 100);

    const compareRange = { startDate: compareStartDate, endDate: compareEndDate };
    const settings = ga4Config();

    if (!settings.ready) {
      // Say why rather than quietly serving sample data — a silent fallback
      // is indistinguishable from a broken connection.
      return json({
        ...demoGa4(startDate, endDate, compareRange),
        demoReason: settings.problem,
      });
    }
    const propertyId = settings.propertyId;

    const dateRanges = [{ startDate, endDate }];
    const url = `${API}/properties/${propertyId}:batchRunReports`;

    const payload = await googleFetch(url, {
      scope: SCOPE,
      body: {
        requests: [
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
              'totalUsers',
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
        ],
      },
    });

    const [
      summary,
      compareSummary,
      trend,
      channelReport,
      pageReport,
      deviceReport,
      countryReport,
    ] = payload.reports || [];

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
      totals: summaryTotals(summary),
      previousTotals: summaryTotals(compareSummary),
      timeseries: (trend?.rows || []).map((row) => ({
        date: isoDate(trendDimension(row, 'date')),
        users: trendMetric(row, 'totalUsers'),
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
