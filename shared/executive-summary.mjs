/**
 * Builds the plain-English executive summary at the top of the Overview report.
 *
 * Every line is derived from data already loaded — nothing is asserted that a
 * number does not support, and a line is simply omitted when its source is
 * absent or still showing sample data. A summary that invents a narrative on
 * thin data is worse than a shorter one, because the reader cannot tell which
 * sentences to trust.
 *
 * Tone is deliberately flat: it reports what moved and by how much, and leaves
 * the interpreting to the person presenting it.
 */

/** Percentage change, or null when there is no usable baseline. */
function change(current, previous) {
  const now = Number(current);
  const before = Number(previous);
  if (!Number.isFinite(now) || !Number.isFinite(before) || before === 0) return null;
  return (now - before) / Math.abs(before);
}

/** "up 12%" / "down 4%" / "broadly flat" — with a threshold for noise. */
function describeChange(ratio, { flatBelow = 0.02 } = {}) {
  if (ratio === null) return null;
  if (Math.abs(ratio) < flatBelow) return 'broadly flat';
  const direction = ratio > 0 ? 'up' : 'down';
  return `${direction} ${Math.abs(ratio * 100).toFixed(ratio >= 0.1 || ratio <= -0.1 ? 0 : 1)}%`;
}

/**
 * Pluralises a noun. Naive "+s" produced "searchs"; words ending in a sibilant
 * take "-es".
 */
function plural(count, word) {
  if (Number(count) === 1) return word;
  return /(?:s|x|z|ch|sh)$/i.test(word) ? `${word}es` : `${word}s`;
}

/**
 * @param {object} state the dashboard's loaded state
 * @param {object} helpers formatting functions from format.js
 * @returns {{headline: string, points: object[], caveats: string[]}|null}
 */
export function buildExecutiveSummary(state, helpers) {
  const { num, compact, percent, decimal, longDate } = helpers;

  const ga4 = state.ga4 && !state.ga4.demo ? state.ga4 : null;
  const gsc = state.gsc && !state.gsc.demo ? state.gsc : null;
  const rankings = state.rankings?.snapshots?.length ? state.rankings : null;
  const competitors = state.competitors || null;
  const mouseflow = state.mouseflow && !state.mouseflow.demo ? state.mouseflow : null;

  const points = [];
  const caveats = [];

  /* --- Traffic ----------------------------------------------------------- */

  if (ga4) {
    const users = ga4.totals?.activeUsers ?? ga4.totals?.users;
    const usersWas = ga4.previousTotals?.activeUsers ?? ga4.previousTotals?.users;
    const moved = describeChange(change(users, usersWas));

    points.push({
      label: 'Traffic',
      text:
        `${num(users)} people visited the site${moved ? `, ${moved} on the previous period` : ''}. ` +
        `They viewed ${compact(ga4.totals?.pageViews)} pages across ${num(ga4.totals?.sessions)} ${plural(ga4.totals?.sessions, 'visit')}.`,
    });

    // Name the biggest channel rather than making the reader scan a table.
    const topChannel = [...(ga4.channels || [])].sort((a, b) => b.sessions - a.sessions)[0];
    if (topChannel && ga4.totals?.sessions) {
      const sharePct = (topChannel.sessions / ga4.totals.sessions) * 100;
      points.push({
        label: 'Where they came from',
        text:
          `${topChannel.channel} was the largest source at ${sharePct.toFixed(0)}% of visits ` +
          `(${num(topChannel.sessions)}).`,
      });
    }
  }

  /* --- Search ------------------------------------------------------------ */

  if (gsc) {
    const clicks = gsc.totals?.clicks;
    const moved = describeChange(change(clicks, gsc.previousTotals?.clicks));
    const impressionsMoved = describeChange(
      change(gsc.totals?.impressions, gsc.previousTotals?.impressions)
    );

    points.push({
      label: 'Google search',
      text:
        `${num(clicks)} ${plural(clicks, 'click')} from Google${moved ? `, ${moved}` : ''}. ` +
        `The site appeared in ${compact(gsc.totals?.impressions)} searches` +
        `${impressionsMoved ? ` (${impressionsMoved})` : ''}, ` +
        `and ${percent(gsc.totals?.ctr, 1)} of those turned into a visit.`,
    });
  }

  /* --- Rankings and AI Overviews ----------------------------------------- */

  if (rankings) {
    const snapshots = rankings.snapshots;
    const latest = snapshots[snapshots.length - 1].totals;
    const first = snapshots[0].totals;
    const prior = snapshots.length > 1 ? snapshots[snapshots.length - 2].totals : null;

    const top3Moved = prior ? latest.top3 - prior.top3 : null;
    points.push({
      label: 'Rankings',
      text:
        `${num(latest.top3)} tracked ${plural(latest.top3, 'keyword')} sit in the top 3 and ` +
        `${num(latest.top10)} in the top 10, from ${num(latest.trackedKeywords)} tracked. ` +
        (top3Moved === null
          ? ''
          : top3Moved === 0
            ? 'Unchanged on the previous week.'
            : `That is ${top3Moved > 0 ? 'up' : 'down'} ${Math.abs(top3Moved)} on the previous week.`),
    });

    if (latest.aiCited !== undefined) {
      const gained = latest.aiCited - first.aiCited;
      points.push({
        label: 'AI Overviews',
        text:
          `Google cites the site in the AI Overview for ${num(latest.aiCited)} ${plural(latest.aiCited, 'search')}, ` +
          `${num(latest.aiCitedFirst)} of them as its first source.` +
          (gained > 0
            ? ` That is ${gained} more than when tracking began on ${longDate(snapshots[0].date)}.`
            : ''),
      });
    }
  }

  /* --- Competitive ------------------------------------------------------- */

  if (competitors?.domains?.length) {
    const self = competitors.domains.find((d) => d.domain === competitors.self);
    const rivals = competitors.domains.filter((d) => d.domain !== competitors.self);
    const weaker = rivals.filter(
      (d) => self?.domainRating && d.domainRating && d.domainRating < self.domainRating
    );

    if (self?.domainRating) {
      points.push({
        label: 'Versus competitors',
        text:
          `Domain authority is ${decimal(self.domainRating, 0)}, ` +
          (weaker.length
            ? `higher than ${weaker.map((d) => d.label).join(' and ')}. ` +
              'Where those competitors outrank us, the gap is content coverage rather than authority.'
            : `against ${rivals.map((d) => `${d.label} ${decimal(d.domainRating, 0)}`).join(', ')}.`),
      });
    }
  }

  /* --- On-site behaviour -------------------------------------------------- */

  if (mouseflow?.totals?.sessions) {
    const friction = mouseflow.totals.frictionScore;
    const frictionWas = mouseflow.previousTotals?.frictionScore;
    const moved = describeChange(change(friction, frictionWas), { flatBelow: 0.03 });

    points.push({
      label: 'On-site behaviour',
      text:
        `${num(mouseflow.totals.sessions)} recorded ${plural(mouseflow.totals.sessions, 'session')}, ` +
        `averaging ${decimal(mouseflow.totals.avgPageViews)} pages. ` +
        `Friction scored ${decimal(friction, 2)}` +
        // Lower friction is better, so an increase is the bad direction.
        (moved && moved !== 'broadly flat'
          ? `, ${moved} on the previous period — ${/up/.test(moved) ? 'worse' : 'better'}.`
          : '.'),
    });
  }

  if (!points.length) return null;

  /* --- Headline ----------------------------------------------------------- */

  // Lead with search clicks where available, since that is the number the
  // work is judged on; fall back to visitors.
  let headline = 'Performance summary';
  if (gsc?.totals?.clicks) {
    const moved = describeChange(change(gsc.totals.clicks, gsc.previousTotals?.clicks));
    headline =
      `${num(gsc.totals.clicks)} ${plural(gsc.totals.clicks, 'click')} from Google search` +
      (moved && moved !== 'broadly flat' ? `, ${moved} on the previous period` : '');
  } else if (ga4?.totals) {
    const users = ga4.totals.activeUsers ?? ga4.totals.users;
    const moved = describeChange(change(users, ga4.previousTotals?.activeUsers ?? ga4.previousTotals?.users));
    headline =
      `${num(users)} visitors` +
      (moved && moved !== 'broadly flat' ? `, ${moved} on the previous period` : '');
  }

  /* --- Caveats ------------------------------------------------------------ */

  // Stated here rather than hidden, so a reader knows which figures are
  // partial before they quote them.
  if (!ga4) caveats.push('Google Analytics is not connected, so visitor figures are excluded.');
  if (!gsc) caveats.push('Search Console is not connected, so search figures are excluded.');
  if (!rankings) caveats.push('No ranking exports are loaded, so position figures are excluded.');
  if (state.mouseflow?.coverage?.notes?.length) {
    caveats.push(state.mouseflow.coverage.notes[0]);
  }

  return { headline, points, caveats };
}
