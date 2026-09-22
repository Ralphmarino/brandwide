/**
 * GET|POST /api/gsc
 *
 * Fetches Search Console performance data via the Search Analytics API.
 * There is no batch endpoint, so the individual breakdowns are issued in
 * parallel and stitched together into one dashboard payload.
 *
 * Note: Search Console data lags by roughly 2-3 days. The UI surfaces the
 * `lastCompleteDate` returned here so the lag is visible rather than looking
 * like a drop-off at the end of the chart.
 */
import { googleFetch } from '../lib/google-auth.mjs';
import { gscConfig } from '../lib/config.mjs';
import { errorResponse, json, readParams, safeDate, safeLimit } from '../lib/http.mjs';
import { demoGsc } from '../lib/demo-data.mjs';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API = 'https://searchconsole.googleapis.com/webmasters/v3';

function queryUrl(siteUrl) {
  return `${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
}

/** Totals across a set of rows, with correctly weighted CTR and position. */
function aggregate(rows) {
  const clicks = rows.reduce((t, r) => t + (r.clicks || 0), 0);
  const impressions = rows.reduce((t, r) => t + (r.impressions || 0), 0);
  // Average position must be impression-weighted, not a plain mean.
  const weightedPosition = rows.reduce(
    (t, r) => t + (r.position || 0) * (r.impressions || 0),
    0
  );
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position: impressions ? weightedPosition / impressions : 0,
  };
}

const shape = (row, key) => ({
  [key]: row.keys?.[0] ?? '',
  clicks: row.clicks || 0,
  impressions: row.impressions || 0,
  ctr: row.ctr || 0,
  position: row.position || 0,
});

export default async (req) => {
  try {
    const params = await readParams(req);
    const startDate = safeDate(params.startDate, 28);
    const endDate = safeDate(params.endDate, 1);
    const compareStartDate = safeDate(params.compareStartDate, 56);
    const compareEndDate = safeDate(params.compareEndDate, 29);
    const limit = safeLimit(params.limit, 15, 500);

    const compareRange = { startDate: compareStartDate, endDate: compareEndDate };
    const settings = gscConfig();

    if (!settings.ready) {
      return json({
        ...demoGsc(startDate, endDate, compareRange),
        demoReason: settings.problem,
      });
    }
    const siteUrl = settings.siteUrl;

    const url = queryUrl(siteUrl);
    const run = (body) =>
      googleFetch(url, {
        scope: SCOPE,
        body: { type: 'web', dataState: 'final', ...body },
      });

    const [daily, previousDaily, queries, pages, devices, countries] =
      await Promise.all([
        run({ startDate, endDate, dimensions: ['date'], rowLimit: 500 }),
        run({
          startDate: compareStartDate,
          endDate: compareEndDate,
          dimensions: ['date'],
          rowLimit: 500,
        }),
        run({ startDate, endDate, dimensions: ['query'], rowLimit: limit }),
        run({ startDate, endDate, dimensions: ['page'], rowLimit: limit }),
        run({ startDate, endDate, dimensions: ['device'], rowLimit: 10 }),
        run({ startDate, endDate, dimensions: ['country'], rowLimit: limit }),
      ]);

    const dailyRows = daily.rows || [];
    const timeseries = dailyRows.map((row) => ({
      date: row.keys?.[0] ?? '',
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: row.ctr || 0,
      position: row.position || 0,
    }));

    return json({
      source: 'gsc',
      configured: true,
      demo: false,
      siteUrl,
      range: { startDate, endDate },
      compareRange,
      // The most recent day Search Console actually has data for.
      lastCompleteDate: timeseries.length
        ? timeseries[timeseries.length - 1].date
        : null,
      totals: aggregate(dailyRows),
      previousTotals: aggregate(previousDaily.rows || []),
      timeseries,
      queries: (queries.rows || []).map((row) => shape(row, 'query')),
      pages: (pages.rows || []).map((row) => shape(row, 'page')),
      devices: (devices.rows || []).map((row) => shape(row, 'device')),
      countries: (countries.rows || []).map((row) => shape(row, 'country')),
    });
  } catch (error) {
    return errorResponse(error, 'gsc');
  }
};

export const config = { path: '/api/gsc' };
