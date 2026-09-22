/**
 * Lightweight extraction of on-page SEO signals from raw HTML.
 *
 * Deliberately not a full DOM parser: it reads a fixed, well-defined set of
 * elements, and every extractor is written to fail to `null` rather than to
 * guess. Anything it cannot determine is reported as unknown, never as absent —
 * the difference matters when the output becomes a recommendation.
 */

const stripTags = (html) =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
};

export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

const clean = (text) => decodeEntities(text).replace(/\s+/g, ' ').trim();

/** Reads a meta tag's content by name or property. */
function meta(html, attribute, value) {
  const pattern = new RegExp(
    `<meta[^>]*\\b${attribute}\\s*=\\s*["']${value}["'][^>]*>`,
    'i'
  );
  const tag = html.match(pattern)?.[0];
  if (!tag) return null;
  const content = tag.match(/\bcontent\s*=\s*["']([\s\S]*?)["']/i)?.[1];
  return content === undefined ? null : clean(content);
}

/** All text contents of a given heading level, in document order. */
function headings(html, level) {
  const pattern = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
  return [...html.matchAll(pattern)]
    .map((match) => clean(stripTags(match[1])))
    .filter(Boolean);
}

/** Parses every JSON-LD block, tolerating one malformed block among several. */
function jsonLd(html) {
  const blocks = [...html.matchAll(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];

  const parsed = [];
  let invalid = 0;
  for (const block of blocks) {
    try {
      parsed.push(JSON.parse(block[1].trim()));
    } catch {
      invalid += 1;
    }
  }
  return { parsed, blockCount: blocks.length, invalid };
}

/** Collects @type values from arbitrarily nested JSON-LD, including @graph. */
function schemaTypes(nodes) {
  const found = new Set();
  const visit = (node, depth = 0) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;

    const type = node['@type'];
    if (typeof type === 'string') found.add(type);
    else if (Array.isArray(type)) type.forEach((t) => typeof t === 'string' && found.add(t));

    for (const [key, value] of Object.entries(node)) {
      if (key === '@type') continue;
      if (value && typeof value === 'object') visit(value, depth + 1);
    }
  };
  visit(nodes);
  return [...found];
}

/**
 * Extracts the on-page signals the recommendations rely on.
 * @param {string} html
 * @param {string} pageUrl absolute URL, used to classify links as internal
 */
export function extractSignals(html, pageUrl) {
  const headSection = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? html;

  const titleRaw = headSection.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = titleRaw === undefined ? null : clean(stripTags(titleRaw));

  const description = meta(html, 'name', 'description');
  const robots = meta(html, 'name', 'robots');
  const canonical = (() => {
    const tag = headSection.match(/<link[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i)?.[0];
    if (!tag) return null;
    const href = tag.match(/\bhref\s*=\s*["']([\s\S]*?)["']/i)?.[1];
    return href ? clean(href) : null;
  })();

  const h1 = headings(html, 1);
  const h2 = headings(html, 2);
  const h3 = headings(html, 3);

  // Word count over the body only, with chrome-heavy elements removed first.
  const bodySection = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const readable = stripTags(
    bodySection
      .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ')
  );
  const words = decodeEntities(readable).split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));

  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imagesMissingAlt = images.filter(
    (tag) => !/\balt\s*=\s*["'][^"']*\S[^"']*["']/i.test(tag)
  ).length;

  let origin = null;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    /* leave origin null and count all links as external */
  }

  const links = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1].trim())
    .filter((href) => href && !href.startsWith('#') && !/^(mailto|tel|javascript):/i.test(href));

  const internalLinks = links.filter(
    (href) => href.startsWith('/') || (origin && href.startsWith(origin))
  ).length;

  const { parsed, blockCount, invalid } = jsonLd(html);
  const types = schemaTypes(parsed);

  return {
    title,
    titleLength: title?.length ?? null,
    description,
    descriptionLength: description?.length ?? null,
    canonical,
    robots,
    h1,
    h2,
    h3,
    headingCount: h1.length + h2.length + h3.length,
    wordCount: words.length,
    imageCount: images.length,
    imagesMissingAlt,
    linkCount: links.length,
    internalLinks,
    externalLinks: links.length - internalLinks,
    schema: {
      blockCount,
      invalidBlocks: invalid,
      types,
      hasFaq: types.includes('FAQPage') || types.includes('Question'),
      hasOrganization: types.includes('Organization') || types.includes('Corporation'),
      hasBreadcrumb: types.includes('BreadcrumbList'),
      hasProductOrService:
        types.includes('Product') ||
        types.includes('Service') ||
        types.includes('SoftwareApplication'),
      hasArticle: types.includes('Article') || types.includes('BlogPosting'),
    },
    openGraph: {
      title: meta(html, 'property', 'og:title'),
      description: meta(html, 'property', 'og:description'),
      image: meta(html, 'property', 'og:image'),
    },
    // Visible FAQ-style markup, separate from FAQ schema — many pages have the
    // content without the structured data, which is the actionable gap.
    hasFaqHeading: [...h2, ...h3].some((heading) =>
      /\b(faq|frequently asked|common questions|questions)\b/i.test(heading)
    ),
  };
}
