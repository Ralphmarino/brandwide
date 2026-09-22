/**
 * Turns observed page facts into prioritised recommendations.
 *
 * Every rule fires only on evidence, and every recommendation carries the
 * observation that produced it. Nothing here guesses: a signal the crawler
 * could not determine produces no recommendation rather than a speculative one,
 * because an unfounded "add schema" on a page that already has it costs more
 * credibility than the advice is worth.
 *
 * Severity:
 *   critical — actively suppressing organic performance
 *   high     — significant, evidenced upside
 *   medium   — worth doing in the next pass
 *   low      — polish
 */

const TITLE_MIN = 30;
const TITLE_MAX = 60;
const DESCRIPTION_MIN = 70;
const DESCRIPTION_MAX = 160;
const THIN_CONTENT_WORDS = 300;

function recommendation(id, severity, category, title, detail, evidence, action) {
  return { id, severity, category, title, detail, evidence, action };
}

/**
 * @param {object} signals   from extractSignals()
 * @param {object} context   page analytics: clicks, impressions, ctr, position,
 *                           expectedCtr, ctrGapClicks, keywords, strikingDistance,
 *                           aiGaps, aiCited, views, engagement
 */
export function buildRecommendations(signals, context = {}) {
  const found = [];
  const add = (...args) => found.push(recommendation(...args));

  const hasTraffic = (context.impressions || 0) > 0;
  const topKeyword =
    [...(context.keywords || [])].sort(
      (a, b) => (b.searchVolume || 0) - (a.searchVolume || 0)
    )[0] || null;

  /* --- Indexability ------------------------------------------------------ */

  if (signals.robots && /\bnoindex\b/i.test(signals.robots)) {
    add(
      'noindex', 'critical', 'Technical',
      'Page is set to noindex',
      hasTraffic
        ? 'This page carries a noindex directive yet is still receiving search impressions. It will be dropped from the index.'
        : 'This page carries a noindex directive, so it cannot rank.',
      `<meta name="robots" content="${signals.robots}">`,
      'Remove noindex if this page is meant to rank organically.'
    );
  }

  if (!signals.canonical) {
    add(
      'canonical-missing', 'low', 'Technical',
      'No canonical tag',
      'Without a canonical, near-duplicate URLs (parameters, trailing slashes) can split ranking signals.',
      'No <link rel="canonical"> found',
      'Add a self-referencing canonical tag.'
    );
  }

  /* --- Title and description --------------------------------------------- */

  if (!signals.title) {
    add(
      'title-missing', 'critical', 'Meta data',
      'Missing page title',
      'The title is the strongest on-page ranking signal and the headline of the search result.',
      'No <title> element found',
      'Add a descriptive title of 30-60 characters leading with the primary term.'
    );
  } else {
    if (signals.titleLength < TITLE_MIN) {
      add(
        'title-short', 'medium', 'Meta data',
        'Title is short',
        `At ${signals.titleLength} characters the title leaves room unused that could carry qualifying terms.`,
        `"${signals.title}" (${signals.titleLength} chars)`,
        `Extend toward ${TITLE_MIN}-${TITLE_MAX} characters without padding.`
      );
    } else if (signals.titleLength > TITLE_MAX) {
      add(
        'title-long', 'low', 'Meta data',
        'Title may be truncated',
        `At ${signals.titleLength} characters the title will likely be cut off in results.`,
        `"${signals.title}" (${signals.titleLength} chars)`,
        `Tighten to roughly ${TITLE_MAX} characters, keeping the primary term first.`
      );
    }

    if (topKeyword?.keyword) {
      const term = topKeyword.keyword.toLowerCase();
      if (!signals.title.toLowerCase().includes(term.split(' ')[0])) {
        add(
          'title-keyword', 'medium', 'Meta data',
          'Title does not reflect the page\'s main term',
          `This page's highest-volume tracked keyword is "${topKeyword.keyword}", which the title does not echo.`,
          `Title: "${signals.title}"`,
          'Work the primary term into the title naturally, toward the front.'
        );
      }
    }
  }

  if (!signals.description) {
    add(
      'description-missing', 'high', 'Meta data',
      'Missing meta description',
      'Google will assemble a snippet from page text instead, which usually reads worse and converts worse.',
      'No <meta name="description"> found',
      `Write a ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} character description with a clear reason to click.`
    );
  } else if (signals.descriptionLength < DESCRIPTION_MIN) {
    add(
      'description-short', 'medium', 'Meta data',
      'Meta description is thin',
      `At ${signals.descriptionLength} characters it wastes most of the available snippet.`,
      `"${signals.description}"`,
      `Expand toward ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} characters.`
    );
  } else if (signals.descriptionLength > DESCRIPTION_MAX) {
    add(
      'description-long', 'low', 'Meta data',
      'Meta description will be truncated',
      `At ${signals.descriptionLength} characters the end will be cut off.`,
      `"${signals.description}"`,
      `Trim to about ${DESCRIPTION_MAX} characters.`
    );
  }

  /* --- CTR: the highest-leverage evidence-backed rule -------------------- */

  if (
    context.ctrGapClicks > 1 &&
    context.expectedCtr &&
    context.actualCtr !== null &&
    context.impressions >= 100
  ) {
    const actualPct = (context.actualCtr * 100).toFixed(1);
    const expectedPct = (context.expectedCtr * 100).toFixed(1);
    add(
      'ctr-below-expected', 'high', 'Meta data',
      'Click-through rate is below par for its position',
      `The page averages position ${context.position?.toFixed(1)} but converts ${actualPct}% of impressions, against ${expectedPct}% typical at that position for this site. Closing that gap is worth roughly ${Math.round(context.ctrGapClicks)} additional clicks for this period, with no ranking change required.`,
      `${context.impressions.toLocaleString()} impressions, ${context.clicks.toLocaleString()} clicks, position ${context.position?.toFixed(1)}`,
      'Rewrite the title and meta description to match intent more directly — lead with the outcome, and make the differentiator explicit.'
    );
  }

  /* --- Content ----------------------------------------------------------- */

  if (signals.h1.length === 0) {
    add(
      'h1-missing', 'medium', 'Content',
      'No H1 heading',
      'The H1 tells both readers and crawlers what the page is about.',
      'No <h1> element found',
      'Add a single H1 that states the page topic.'
    );
  } else if (signals.h1.length > 1) {
    add(
      'h1-multiple', 'low', 'Content',
      `${signals.h1.length} H1 headings`,
      'Multiple H1s dilute the topical signal.',
      signals.h1.map((h) => `"${h}"`).join(', '),
      'Keep one H1 and demote the rest to H2.'
    );
  }

  if (signals.wordCount < THIN_CONTENT_WORDS && hasTraffic) {
    add(
      'thin-content', 'high', 'Content',
      'Thin content for a page earning impressions',
      `Roughly ${signals.wordCount} words of body copy. Pages this light rarely hold position against fuller competing pages, and give AI Overviews little to cite.`,
      `${signals.wordCount} words, ${context.impressions?.toLocaleString() || 0} impressions`,
      'Expand with substantive, specific detail — process, comparison, pricing context, and concrete examples.'
    );
  }

  if (context.strikingDistance?.length) {
    const sorted = [...context.strikingDistance].sort((a, b) => a.position - b.position);
    const list = sorted.slice(0, 6).map((k) => `"${k.keyword}" (#${k.position})`).join(', ');
    add(
      'striking-distance', 'high', 'Content',
      `${context.strikingDistance.length} keyword${context.strikingDistance.length === 1 ? '' : 's'} within reach of the top 3`,
      'These already rank on or near page one, so incremental gains need depth and internal links rather than new pages.',
      list,
      'Strengthen coverage of these specific terms on this page, and add internal links to it from related pages using those phrases as anchors.'
    );
  }

  if (signals.internalLinks < 3) {
    add(
      'internal-links', 'medium', 'Content',
      'Very few internal links',
      `Only ${signals.internalLinks} internal link${signals.internalLinks === 1 ? '' : 's'} found. Internal linking distributes authority and helps crawlers understand topical relationships.`,
      `${signals.internalLinks} internal, ${signals.externalLinks} external`,
      'Link out to related pages using descriptive anchor text.'
    );
  }

  /* --- Structured data --------------------------------------------------- */

  if (signals.schema.blockCount === 0) {
    add(
      'schema-none', 'high', 'Schema',
      'No structured data',
      'Without schema, the page cannot qualify for rich results and gives assistants less to work with when assembling answers.',
      'No JSON-LD blocks found',
      'Add Organization plus a page-appropriate type (Service, SoftwareApplication, Article or FAQPage).'
    );
  } else {
    if (signals.schema.invalidBlocks > 0) {
      add(
        'schema-invalid', 'high', 'Schema',
        `${signals.schema.invalidBlocks} structured data block${signals.schema.invalidBlocks === 1 ? '' : 's'} failed to parse`,
        'Malformed JSON-LD is ignored entirely, so any markup inside it is wasted.',
        `${signals.schema.blockCount} blocks, ${signals.schema.invalidBlocks} invalid`,
        'Validate with the Rich Results Test and fix the JSON syntax.'
      );
    }
    if (!signals.schema.hasBreadcrumb) {
      add(
        'schema-breadcrumb', 'low', 'Schema',
        'No BreadcrumbList markup',
        'Breadcrumb markup clarifies site hierarchy and can improve how the result displays.',
        `Types present: ${signals.schema.types.join(', ') || 'none'}`,
        'Add BreadcrumbList reflecting the page\'s position in the site.'
      );
    }
  }

  // The specific gap worth catching: FAQ content on the page, no FAQ schema.
  if (signals.hasFaqHeading && !signals.schema.hasFaq) {
    add(
      'faq-unmarked', 'high', 'Schema',
      'FAQ content present but not marked up',
      'The page already has question-style headings, so the content exists — it simply is not machine-readable. This is among the cheapest wins available: markup only, no writing.',
      'FAQ-style heading found, no FAQPage or Question schema',
      'Wrap the existing questions and answers in FAQPage schema.'
    );
  } else if (!signals.hasFaqHeading && !signals.schema.hasFaq && (context.aiGaps?.length || 0) > 0) {
    add(
      'faq-absent', 'medium', 'Schema',
      'No FAQ section on a page competing against AI Overviews',
      'Question-and-answer content is disproportionately drawn on when assistants assemble answers.',
      `${context.aiGaps.length} tracked keyword${context.aiGaps.length === 1 ? '' : 's'} on this page show an AI Overview without citing you`,
      'Add a short FAQ answering the questions buyers actually ask, and mark it up with FAQPage schema.'
    );
  }

  /* --- Generative / AI Overview visibility ------------------------------- */

  if (context.aiGaps?.length) {
    const sorted = [...context.aiGaps].sort(
      (a, b) => (b.searchVolume || 0) - (a.searchVolume || 0)
    );
    const list = sorted.slice(0, 5).map((k) => `"${k.keyword}"`).join(', ');
    add(
      'ai-not-cited', 'high', 'Generative search',
      `AI Overview appears for ${context.aiGaps.length} of this page's keywords without citing you`,
      'An AI Overview sits above the organic results on these searches, and the page is not among its sources — so the traffic is being answered before the click.',
      list,
      'Lead sections with a direct, self-contained answer in the first two sentences, phrase headings as the questions people ask, and keep facts specific and attributable.'
    );
  }

  if (context.aiCited?.length) {
    const notTop = context.aiCited.filter((k) => k.aiCitationRank > 1);
    if (notTop.length) {
      add(
        'ai-not-top', 'medium', 'Generative search',
        `Cited in AI Overviews, but not first, for ${notTop.length} keyword${notTop.length === 1 ? '' : 's'}`,
        'The page is already a trusted source on these searches. Moving to the primary citation is usually a matter of answer clarity rather than authority.',
        notTop.slice(0, 5).map((k) => `"${k.keyword}" (#${k.aiCitationRank})`).join(', '),
        'Tighten the opening definition of each covered concept to a single quotable sentence.'
      );
    }
  }

  /* --- Competitive position ---------------------------------------------- */

  const rivalry = context.competitors;
  if (rivalry?.losing?.length) {
    const top = rivalry.losing.slice(0, 4);
    const list = top
      .map((row) => `"${row.keyword}" — ${row.rival} at #${row.rivalPosition}, us at #${row.ourPosition}`)
      .join('; ');

    // Losing to a weaker link profile is a content problem, and saying so
    // redirects the work away from link building, which would not fix it.
    const weaker = rivalry.losing.filter((row) => row.weakerAuthority);
    const authorityNote = weaker.length
      ? ` ${weaker.length === rivalry.losing.length ? 'Every one of these rivals has' : `${weaker.length} of these rivals have`} ` +
        `a weaker link profile than this site (${weaker[0].rival} sits at DR ${weaker[0].rivalDomainRating} ` +
        `against our ${rivalry.self?.domainRating}), so the gap is content and relevance, not authority. ` +
        'More links will not close it.'
      : '';

    add(
      'competitor-outranks', 'high', 'Competitive',
      `Outranked on ${rivalry.losing.length} keyword${rivalry.losing.length === 1 ? '' : 's'} this page targets`,
      `A competitor holds a higher position than this page on searches it is built for.${authorityNote}`,
      list,
      `Compare this page against ${top[0].rival}'s ranking page (${top[0].rivalUrl}) — depth of coverage, how directly the opening answers the query, and specificity. Close the difference that matters rather than matching length.`
    );
  }

  if (rivalry?.aiLost?.length) {
    const top = rivalry.aiLost.slice(0, 4);
    add(
      'competitor-ai-overview', 'high', 'Competitive',
      `A competitor is cited in the AI Overview where this page is not`,
      'On these searches a rival is the source Google draws its answer from, so they take the visibility above the organic results.',
      top.map((row) => `"${row.keyword}" — ${row.rivals.join(', ')}`).join('; '),
      'Answer each of these questions in one self-contained, quotable paragraph near the top of the page, phrased as the question is asked.'
    );
  }

  /* --- Accessibility and media ------------------------------------------- */

  if (signals.imagesMissingAlt > 0) {
    add(
      'images-alt', 'low', 'Technical',
      `${signals.imagesMissingAlt} image${signals.imagesMissingAlt === 1 ? '' : 's'} missing alt text`,
      'Alt text serves accessibility first, and image search second.',
      `${signals.imagesMissingAlt} of ${signals.imageCount} images`,
      'Describe each meaningful image; mark decorative ones with an empty alt.'
    );
  }

  /* --- Engagement -------------------------------------------------------- */

  if (context.engagement !== null && context.engagement !== undefined &&
      context.engagement < 30 && (context.views || 0) > 50) {
    add(
      'engagement-low', 'medium', 'Content',
      'Visitors leave quickly',
      `Average engagement is ${Math.round(context.engagement)} seconds across ${context.views?.toLocaleString()} views. Short dwell time on an informational page usually means the opening does not deliver what the search promised.`,
      `${Math.round(context.engagement)}s average engagement`,
      'Make the first screen answer the query directly, then let detail follow.'
    );
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return found.sort((a, b) => order[a.severity] - order[b.severity]);
}

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const CATEGORIES = [
  'Meta data', 'Content', 'Schema', 'Generative search', 'Competitive', 'Technical',
];
