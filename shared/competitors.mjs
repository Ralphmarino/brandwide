/**
 * Derives the competitive views from a committed Ahrefs snapshot.
 *
 * Three questions, kept separate because they lead to different work:
 *   Battleground — keywords we and a rival both rank for. Who is winning, and
 *                  by how much. This is defence and incremental gain.
 *   Gaps         — keywords a rival ranks for and we do not at all. This is
 *                  new content.
 *   Strengths    — keywords we lead on. Worth knowing so they are protected,
 *                  and so the pattern behind them can be repeated.
 */

const AI_KINDS = new Set(['ai_overview', 'ai_overview_sitelink']);

/** Lower is better; a missing rank sorts last. */
function betterOf(a, b) {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  return Math.min(a, b);
}

export function analyseCompetitors(snapshot) {
  if (!snapshot?.keywords?.length) return null;

  const self = snapshot.self;
  const rivals = snapshot.domains.filter((domain) => domain.domain !== self);

  const rows = snapshot.keywords.map((entry) => {
    const mine = entry.ranks[self] || null;
    const theirs = rivals
      .map((rival) => ({ ...rival, rank: entry.ranks[rival.domain] || null }))
      .filter((rival) => rival.rank);

    const bestRivalRank = theirs.reduce(
      (best, rival) => betterOf(best, rival.rank.position),
      null
    );
    const bestRival = theirs.find((rival) => rival.rank.position === bestRivalRank) || null;

    // "Contested" needs both sides present; everything else is a gap or a hold.
    const contested = Boolean(mine && theirs.length);
    const gap = !mine && theirs.length > 0;

    let outcome = 'unranked';
    if (mine && !theirs.length) outcome = 'uncontested';
    else if (contested) {
      if (mine.position < bestRivalRank) outcome = 'ahead';
      else if (mine.position > bestRivalRank) outcome = 'behind';
      else outcome = 'level';
    } else if (gap) outcome = 'absent';

    return {
      keyword: entry.keyword,
      volume: entry.volume ?? null,
      keywordDifficulty: entry.keywordDifficulty ?? null,
      mine,
      rivals: theirs,
      bestRival,
      bestRivalRank,
      contested,
      gap,
      outcome,
      // Ahrefs reports an AI Overview citation as a position kind.
      myAiOverview: Boolean(mine && AI_KINDS.has(mine.kind)),
      rivalAiOverview: theirs.filter((rival) => AI_KINDS.has(rival.rank.kind)),
    };
  });

  const contested = rows.filter((row) => row.contested);
  const gaps = rows.filter((row) => row.gap).sort((a, b) => (b.volume || 0) - (a.volume || 0));

  const summary = {
    keywordsCompared: rows.length,
    contested: contested.length,
    ahead: contested.filter((row) => row.outcome === 'ahead').length,
    behind: contested.filter((row) => row.outcome === 'behind').length,
    level: contested.filter((row) => row.outcome === 'level').length,
    gaps: gaps.length,
    // Volume sitting behind keywords we do not rank for at all.
    gapVolume: gaps.reduce((total, row) => total + (row.volume || 0), 0),
    myAiOverviews: rows.filter((row) => row.myAiOverview).length,
    aiOverviewsLost: rows.filter(
      (row) => !row.myAiOverview && row.rivalAiOverview.length
    ).length,
  };

  // Per-rival head-to-head, so each competitor can be spoken about separately.
  const headToHead = rivals.map((rival) => {
    const shared = rows.filter((row) => row.mine && row.ranks !== undefined
      ? false
      : row.mine && row.rivals.some((r) => r.domain === rival.domain));

    const wins = shared.filter((row) => {
      const theirRank = row.rivals.find((r) => r.domain === rival.domain).rank.position;
      return row.mine.position < theirRank;
    }).length;
    const losses = shared.filter((row) => {
      const theirRank = row.rivals.find((r) => r.domain === rival.domain).rank.position;
      return row.mine.position > theirRank;
    }).length;

    const exclusive = rows.filter(
      (row) => !row.mine && row.rivals.some((r) => r.domain === rival.domain)
    );

    return {
      ...rival,
      shared: shared.length,
      wins,
      losses,
      draws: shared.length - wins - losses,
      exclusiveKeywords: exclusive.length,
      exclusiveVolume: exclusive.reduce((total, row) => total + (row.volume || 0), 0),
      // Overlap says whether this rival competes for the same searches at all.
      overlap: rows.length ? shared.length / (shared.length + exclusive.length || 1) : 0,
    };
  });

  return {
    date: snapshot.date,
    country: snapshot.country,
    source: snapshot.source,
    note: snapshot.note,
    self,
    domains: snapshot.domains,
    summary,
    headToHead,
    rows,
    contested: contested.sort((a, b) => (b.volume || 0) - (a.volume || 0)),
    gaps,
  };
}

/**
 * Competitive context for one page, keyed on the keywords that page targets.
 *
 * The authority comparison matters more than it looks: losing to a rival with
 * a weaker link profile means the gap is content and relevance, not domain
 * strength — which is a different, cheaper piece of work, and worth stating
 * rather than leaving the reader to assume they need links.
 */
export function competitorContextForPage(analysis, pageKeywords) {
  if (!analysis || !pageKeywords?.length) return null;

  const wanted = new Set(
    pageKeywords.map((k) => String(k.keyword || '').trim().toLowerCase())
  );
  const rows = analysis.rows.filter((row) => wanted.has(row.keyword.toLowerCase()));
  if (!rows.length) return null;

  const self = analysis.domains.find((domain) => domain.domain === analysis.self);

  const losing = rows
    .filter((row) => row.outcome === 'behind')
    .map((row) => {
      const rival = row.bestRival;
      const rivalDomain = analysis.domains.find((d) => d.domain === rival.domain);
      return {
        keyword: row.keyword,
        volume: row.volume,
        ourPosition: row.mine.position,
        rival: rival.label,
        rivalPosition: rival.rank.position,
        rivalUrl: rival.rank.url,
        rivalDomainRating: rivalDomain?.domainRating ?? null,
        rivalReferringDomains: rivalDomain?.referringDomains ?? null,
        // The interesting case: they rank higher with less authority.
        weakerAuthority:
          rivalDomain?.domainRating != null &&
          self?.domainRating != null &&
          rivalDomain.domainRating < self.domainRating,
      };
    })
    .sort((a, b) => (b.volume || 0) - (a.volume || 0));

  const aiLost = rows
    .filter((row) => !row.myAiOverview && row.rivalAiOverview.length)
    .map((row) => ({
      keyword: row.keyword,
      volume: row.volume,
      rivals: row.rivalAiOverview.map((rival) => rival.label),
    }))
    .sort((a, b) => (b.volume || 0) - (a.volume || 0));

  return {
    self,
    matched: rows.length,
    losing,
    aiLost,
    winning: rows.filter((row) => row.outcome === 'ahead').length,
    // True when every loss on this page is to a lower-authority rival.
    allLossesToWeaker: losing.length > 0 && losing.every((row) => row.weakerAuthority),
  };
}
