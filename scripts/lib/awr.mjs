/**
 * Maps an Advanced Web Ranking (AWR Cloud) export onto the dashboard's shape.
 *
 * AWR has several report types and localisations, so columns are matched by a
 * list of candidate names rather than fixed positions. Add a spelling to the
 * relevant list if an export is not recognised — nothing else needs to change.
 *
 * The matcher is deliberately loud: `mapColumns` reports what it matched and
 * what it could not, so the build fails with a readable message instead of
 * producing a silently empty report.
 */

const COLUMN_CANDIDATES = {
  keyword: ['keyword', 'keywords', 'search term', 'searchterm', 'query', 'phrase', 'term'],
  position: [
    'position', 'rank', 'current position', 'current rank', 'best position',
    'best rank', 'google', 'ranking', 'pos',
  ],
  previousPosition: [
    'previous position', 'previous rank', 'prev position', 'prev rank',
    'previous', 'prev', 'last position', 'start position',
  ],
  url: ['url', 'landing page', 'ranking url', 'page', 'result url', 'target url'],
  searchVolume: [
    'search volume', 'volume', 'monthly searches', 'searches', 'avg monthly searches',
    'sv',
  ],
  searchEngine: ['search engine', 'engine', 'searchengine', 'se'],
  location: ['location', 'region', 'country', 'market', 'geo'],
  device: ['device', 'platform'],
  features: ['serp features', 'features', 'special results', 'serp feature', 'snippets'],
  aiOverview: [
    'ai overview', 'ai overviews', 'aio', 'google ai overview', 'ai_overview',
    'sge', 'ai snapshot',
  ],
  date: ['date', 'snapshot date', 'crawl date', 'day'],
  group: ['group', 'keyword group', 'category', 'tag', 'project'],
};

const normalise = (value) =>
  String(value || '').toLowerCase().replace(/[\s_\-.]+/g, ' ').trim();

/** True if a row plausibly contains a keyword column — used to skip preamble. */
export function looksLikeHeader(row) {
  const cells = row.map(normalise);
  return (
    cells.some((cell) => COLUMN_CANDIDATES.keyword.includes(cell)) &&
    cells.some((cell) =>
      COLUMN_CANDIDATES.position.includes(cell) ||
      COLUMN_CANDIDATES.previousPosition.includes(cell)
    )
  );
}

/**
 * Resolves header names to canonical fields.
 * Exact matches win; a contains-match is the fallback so "Position (Google US)"
 * still resolves, without letting "Previous Position" satisfy "position".
 */
export function mapColumns(headers) {
  const mapping = {};
  const used = new Set();
  const normalised = headers.map(normalise);

  for (const [field, candidates] of Object.entries(COLUMN_CANDIDATES)) {
    const exact = normalised.findIndex(
      (header, i) => !used.has(i) && candidates.includes(header)
    );
    if (exact >= 0) {
      mapping[field] = headers[exact];
      used.add(exact);
    }
  }

  // Second pass: looser matching only for fields still unresolved.
  for (const [field, candidates] of Object.entries(COLUMN_CANDIDATES)) {
    if (mapping[field]) continue;
    const loose = normalised.findIndex(
      (header, i) =>
        !used.has(i) && candidates.some((candidate) => header.includes(candidate))
    );
    if (loose >= 0) {
      mapping[field] = headers[loose];
      used.add(loose);
    }
  }

  return {
    mapping,
    matched: Object.keys(mapping),
    unmatchedHeaders: headers.filter((h) => !Object.values(mapping).includes(h)),
  };
}

/** "12", "12.0", "#12", "> 100", "-" -> number or null. */
function toPosition(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || /^(-|--|n\/a|na|not ranked|nr|none)$/i.test(text)) return null;
  // ">100" means beyond the tracked depth; treat as unranked rather than 100.
  if (/^[>＞]/.test(text)) return null;
  const n = Number.parseFloat(text.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toNumber(value) {
  if (value === undefined || value === null) return null;
  // Strip thousands separators and any currency/unit decoration.
  const n = Number.parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Reads a truthy flag from the many ways exports spell "yes". */
function toFlag(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim().toLowerCase();
  if (!text) return false;
  return !/^(0|no|false|n|-|none|not present)$/.test(text);
}

/** Splits a SERP-features cell into a clean list. */
function toFeatures(value) {
  if (!value) return [];
  return String(value)
    .split(/[,;|/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const AI_OVERVIEW_PATTERN = /\b(ai overview|ai overviews|aio|sge|ai snapshot)\b/i;

/** Converts mapped rows into the dashboard's keyword records. */
export function normaliseRows(rows, mapping) {
  const read = (row, field) =>
    mapping[field] === undefined ? undefined : row[mapping[field]];

  return rows
    .map((row) => {
      const keyword = (read(row, 'keyword') || '').trim();
      if (!keyword) return null;

      const features = toFeatures(read(row, 'features'));
      // AI Overview may arrive as its own column or as a SERP feature value.
      const aiOverview =
        toFlag(read(row, 'aiOverview')) ||
        features.some((feature) => AI_OVERVIEW_PATTERN.test(feature));

      const position = toPosition(read(row, 'position'));
      const previousPosition = toPosition(read(row, 'previousPosition'));

      return {
        keyword,
        position,
        previousPosition,
        // Positive means improved (moved closer to 1).
        change:
          position !== null && previousPosition !== null
            ? previousPosition - position
            : null,
        url: (read(row, 'url') || '').trim() || null,
        searchVolume: toNumber(read(row, 'searchVolume')),
        searchEngine: (read(row, 'searchEngine') || '').trim() || null,
        location: (read(row, 'location') || '').trim() || null,
        device: (read(row, 'device') || '').trim() || null,
        group: (read(row, 'group') || '').trim() || null,
        features,
        aiOverview,
      };
    })
    .filter(Boolean);
}

/** Roll-ups that answer "where do we actually rank?" across the tracked set. */
export function summarise(keywords) {
  const ranked = keywords.filter((k) => k.position !== null);
  const inTop = (n) => ranked.filter((k) => k.position <= n).length;

  const improved = keywords.filter((k) => k.change !== null && k.change > 0).length;
  const declined = keywords.filter((k) => k.change !== null && k.change < 0).length;

  // Mean over ranked keywords only — including unranked ones as 100 would
  // reproduce exactly the distortion that makes GSC's average unhelpful.
  const averagePosition = ranked.length
    ? ranked.reduce((total, k) => total + k.position, 0) / ranked.length
    : null;

  const sorted = [...ranked].map((k) => k.position).sort((a, b) => a - b);
  const medianPosition = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : null;

  return {
    trackedKeywords: keywords.length,
    rankedKeywords: ranked.length,
    unrankedKeywords: keywords.length - ranked.length,
    top3: inTop(3),
    top10: inTop(10),
    top20: inTop(20),
    averagePosition,
    medianPosition,
    aiOverviews: keywords.filter((k) => k.aiOverview).length,
    improved,
    declined,
    // Visibility weighted by search volume, if the export carries volume.
    volumeInTop10: ranked
      .filter((k) => k.position <= 10)
      .reduce((total, k) => total + (k.searchVolume || 0), 0),
  };
}

export { COLUMN_CANDIDATES };
