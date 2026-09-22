/**
 * Expected organic CTR by position, used to estimate how many clicks a page
 * is leaving on the table.
 *
 * The site's own Search Console data is the primary source: actual CTR by
 * position, measured across this site's queries, is far more defensible than a
 * published industry average. The fallback table is only used for positions
 * where the site has too little data to measure, and it is deliberately
 * conservative — these are estimates for prioritisation, not forecasts.
 */

/**
 * Fallback curve, blended desktop/mobile. Values sit below older published
 * studies because AI Overviews and SERP features have depressed click-through
 * across the board; an over-generous curve would manufacture opportunity that
 * is not really there.
 */
const FALLBACK_CTR = new Map([
  [1, 0.27], [2, 0.145], [3, 0.10], [4, 0.073], [5, 0.055],
  [6, 0.043], [7, 0.035], [8, 0.029], [9, 0.025], [10, 0.022],
  [12, 0.016], [15, 0.011], [20, 0.007], [30, 0.004], [50, 0.002],
]);

const FALLBACK_POSITIONS = [...FALLBACK_CTR.keys()].sort((a, b) => a - b);

/** Interpolates the fallback curve between its defined points. */
function fallbackCtr(position) {
  if (!Number.isFinite(position) || position < 1) return null;
  if (position >= 50) return 0.002;

  let lower = FALLBACK_POSITIONS[0];
  let upper = FALLBACK_POSITIONS[FALLBACK_POSITIONS.length - 1];
  for (const point of FALLBACK_POSITIONS) {
    if (point <= position) lower = point;
    if (point >= position) { upper = point; break; }
  }
  if (lower === upper) return FALLBACK_CTR.get(lower);

  const span = upper - lower;
  const ratio = (position - lower) / span;
  return FALLBACK_CTR.get(lower) + (FALLBACK_CTR.get(upper) - FALLBACK_CTR.get(lower)) * ratio;
}

/** Position buckets wide enough to hold a meaningful sample. */
function bucketOf(position) {
  if (position < 1.5) return 1;
  if (position < 2.5) return 2;
  if (position < 3.5) return 3;
  if (position < 5.5) return 5;
  if (position < 8.5) return 8;
  if (position < 12.5) return 11;
  if (position < 20.5) return 16;
  return 30;
}

/**
 * Builds a site-specific CTR curve from Search Console query rows.
 * A bucket is only trusted once it holds enough impressions to be stable.
 * @param {{impressions:number, clicks:number, position:number}[]} rows
 */
export function buildCtrModel(rows, { minImpressions = 500, minQueries = 5 } = {}) {
  const buckets = new Map();

  for (const row of rows || []) {
    const position = Number(row.position);
    const impressions = Number(row.impressions) || 0;
    if (!Number.isFinite(position) || position < 1 || impressions <= 0) continue;

    const key = bucketOf(position);
    const bucket = buckets.get(key) || { clicks: 0, impressions: 0, queries: 0 };
    bucket.clicks += Number(row.clicks) || 0;
    bucket.impressions += impressions;
    bucket.queries += 1;
    buckets.set(key, bucket);
  }

  const measured = new Map();
  for (const [key, bucket] of buckets) {
    if (bucket.impressions >= minImpressions && bucket.queries >= minQueries) {
      measured.set(key, bucket.clicks / bucket.impressions);
    }
  }

  return {
    measured,
    bucketsMeasured: measured.size,
    /** Expected CTR at a position, preferring this site's own measurement. */
    expected(position) {
      const key = bucketOf(Number(position));
      const own = measured.get(key);
      // Guard against a bucket that is measurably zero, which would erase any
      // gap rather than reveal one.
      if (own !== undefined && own > 0.0005) return own;
      return fallbackCtr(Number(position));
    },
    source(position) {
      return measured.has(bucketOf(Number(position))) ? 'site' : 'benchmark';
    },
  };
}

/**
 * Estimated additional clicks if a page's CTR rose to the expected rate for
 * the position it already holds. Never negative: a page already beating
 * expectation is not an opportunity, it is a template to copy.
 */
export function clickGap({ impressions, clicks, position }, model) {
  const impressionCount = Number(impressions) || 0;
  const clickCount = Number(clicks) || 0;
  const expected = model.expected(position);

  if (!impressionCount || expected === null) return { gap: 0, expected, actual: null };

  const actual = clickCount / impressionCount;
  const gap = Math.max(0, (expected - actual) * impressionCount);
  return { gap, expected, actual };
}

export { fallbackCtr };
