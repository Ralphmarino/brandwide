/**
 * Ranks pages by how much organic upside is realistically available, using
 * only analytics that are already loaded — no crawling. The deep on-page audit
 * runs separately, on demand, for a single page.
 *
 * Every component is expressed in estimated clicks per period so the total is
 * a number a client can reason about, rather than an opaque 0-100 score.
 */
import { clickGap } from './ctr.mjs';

/** Normalises a URL or path to a comparable path key. */
export function pathOf(value) {
  if (!value) return null;
  let path = String(value).trim();
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    return null;
  }
  if (!path.startsWith('/')) path = `/${path}`;
  // Trailing slashes and case differences should not split one page in two.
  path = path.replace(/\/+$/, '') || '/';
  return path.toLowerCase();
}

/**
 * Keywords sitting close enough to page one that a modest gain pays off.
 * Below position 4 there is little headroom; past 20 the work is a rewrite.
 */
const STRIKING_MIN = 4;
const STRIKING_MAX = 20;

/**
 * Builds the ranked opportunity list.
 *
 * @param {object} input
 * @param {Array}  input.gscPages    Search Console page rows
 * @param {Array}  input.gscQueries  Search Console query rows (for the CTR model)
 * @param {Array}  input.keywords    AWR tracked keywords (carry a landing page)
 * @param {Array}  input.ga4Pages    GA4 top pages
 * @param {object} input.ctrModel    from buildCtrModel()
 */
export function rankOpportunities({ gscPages, gscQueries, keywords, ga4Pages, ctrModel }) {
  const pages = new Map();

  const ensure = (path) => {
    if (!path) return null;
    if (!pages.has(path)) {
      pages.set(path, {
        path,
        url: null,
        clicks: 0,
        impressions: 0,
        ctr: null,
        position: null,
        views: null,
        engagement: null,
        keywords: [],
        strikingDistance: [],
        aiGaps: [],
        aiCited: [],
      });
    }
    return pages.get(path);
  };

  for (const row of gscPages || []) {
    const path = pathOf(row.page);
    const page = ensure(path);
    if (!page) continue;
    page.url = row.page;
    page.clicks = Number(row.clicks) || 0;
    page.impressions = Number(row.impressions) || 0;
    page.ctr = Number(row.ctr) || 0;
    page.position = Number(row.position) || null;
  }

  for (const row of ga4Pages || []) {
    const page = ensure(pathOf(row.path));
    if (!page) continue;
    page.views = Number(row.views) || 0;
    page.engagement = Number(row.avgEngagementDuration) || 0;
  }

  for (const keyword of keywords || []) {
    const page = ensure(pathOf(keyword.url));
    if (!page) continue;
    page.keywords.push(keyword);

    if (
      keyword.position !== null &&
      keyword.position >= STRIKING_MIN &&
      keyword.position <= STRIKING_MAX
    ) {
      page.strikingDistance.push(keyword);
    }
    // An AI Overview exists on this SERP and we are not in it.
    if (keyword.serpHasAiOverview && !keyword.aiCited) page.aiGaps.push(keyword);
    if (keyword.aiCited) page.aiCited.push(keyword);
  }

  const scored = [...pages.values()].map((page) => {
    const { gap, expected, actual } = clickGap(page, ctrModel);

    // Striking-distance upside: assume a realistic lift to roughly position 3
    // for keywords already on the cusp, valued at this site's own CTR curve.
    const strikingUpside = page.strikingDistance.reduce((total, keyword) => {
      const volume = Number(keyword.searchVolume) || 0;
      if (!volume) return total;
      const now = ctrModel.expected(keyword.position) ?? 0;
      const potential = ctrModel.expected(3) ?? 0;
      return total + Math.max(0, (potential - now) * volume);
    }, 0);

    // AI Overview gaps are valued conservatively — a citation is worth real
    // visibility, but attributing clicks to it directly would be invention.
    const aiUpside = page.aiGaps.reduce((total, keyword) => {
      const volume = Number(keyword.searchVolume) || 0;
      return total + volume * 0.02;
    }, 0);

    const totalUpside = gap + strikingUpside + aiUpside;

    const flags = [];
    if (gap > 0 && page.impressions >= 100 && actual !== null && expected && actual < expected * 0.7) {
      flags.push('ctr');
    }
    if (page.strikingDistance.length) flags.push('striking');
    if (page.aiGaps.length && page.keywords.length) flags.push('ai');
    if (page.impressions >= 500 && (page.position ?? 99) > 20) flags.push('deep');
    if (page.views !== null && page.engagement !== null && page.engagement < 30 && page.views > 50) {
      flags.push('engagement');
    }

    // Low-hanging fruit: real upside that needs a nudge, not a rebuild.
    const easy =
      (flags.includes('ctr') && (page.position ?? 99) <= 15) ||
      page.strikingDistance.some((k) => k.position <= 10);

    return {
      ...page,
      expectedCtr: expected,
      actualCtr: actual,
      ctrGapClicks: gap,
      strikingUpside,
      aiUpside,
      totalUpside,
      flags,
      easy,
    };
  });

  return scored
    .filter((page) => page.impressions > 0 || page.keywords.length > 0)
    .sort((a, b) => b.totalUpside - a.totalUpside);
}

export { STRIKING_MIN, STRIKING_MAX };
