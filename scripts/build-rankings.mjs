#!/usr/bin/env node
/**
 * Turns AWR Cloud exports in data/rankings/ into public/data/rankings.json.
 *
 * Runs as part of the Netlify build, so adding a ranking export is: commit the
 * CSV, push, done. Each file is one dated snapshot; several files build a
 * history the dashboard can trend.
 *
 * Naming: the snapshot date comes from the filename where possible
 * (2026-09-22.csv, awr-2026-09-22.csv, rankings_2026_09_22.csv), otherwise
 * from a date column, otherwise the file's modification time.
 *
 * A malformed file fails the build loudly rather than publishing an empty
 * report — a rankings panel that is quietly blank is worse than one that
 * never deployed.
 */
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { parseCsvRows } from './lib/csv.mjs';
import { looksLikeHeader, mapColumns, normaliseRows, summarise } from './lib/awr.mjs';

const INPUT_DIR = 'data/rankings';
const OUTPUT_FILE = 'public/data/rankings.json';
// Logic shared by the serverless functions and the browser. Copied rather than
// duplicated, so the scoring rules have exactly one definition.
const SHARED_DIR = 'shared';
const SHARED_OUT = 'public/js/shared';
const COMPETITOR_DIR = 'data/competitors';
const COMPETITOR_OUT = 'public/data/competitors.json';

const DATE_IN_NAME = /(\d{4})[-_]?(\d{1,2})[-_]?(\d{1,2})/;

function dateFromFilename(name) {
  const match = name.match(DATE_IN_NAME);
  if (!match) return null;
  const [, year, month, day] = match;
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

/** Most common date found in a date column, if the export carries one. */
function dateFromRows(rows, mapping) {
  if (!mapping.date) return null;
  for (const row of rows) {
    const raw = row[mapping.date];
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

async function readSnapshot(dir, filename) {
  const path = join(dir, filename);
  const text = await readFile(path, 'utf8');
  const contentHash = createHash('sha1').update(text).digest('hex').slice(0, 12);

  const { headers, rows, headerIndex } = parseCsvRows(text, { looksLikeHeader });
  if (!headers.length) {
    throw new Error(`${filename}: no readable rows — is the file empty?`);
  }

  const { mapping, unmatchedHeaders } = mapColumns(headers);

  if (!mapping.keyword) {
    throw new Error(
      `${filename}: could not find a keyword column.\n` +
        `  Headers seen: ${headers.join(' | ')}\n` +
        `  Add the correct spelling to COLUMN_CANDIDATES.keyword in scripts/lib/awr.mjs.`
    );
  }
  if (!mapping.position) {
    throw new Error(
      `${filename}: could not find a position/rank column.\n` +
        `  Headers seen: ${headers.join(' | ')}\n` +
        `  Add the correct spelling to COLUMN_CANDIDATES.position in scripts/lib/awr.mjs.`
    );
  }

  const keywords = normaliseRows(rows, mapping);
  if (!keywords.length) {
    throw new Error(`${filename}: header parsed but no keyword rows followed.`);
  }

  // The export's own Date column is authoritative — a filename is just a
  // label, and mislabelling one is easy. Both are kept so a mismatch is
  // reportable rather than silently resolved.
  const dateFromData = dateFromRows(rows, mapping);
  const labelDate = dateFromFilename(filename);
  const date =
    dateFromData || labelDate || (await stat(path)).mtime.toISOString().slice(0, 10);

  return {
    contentHash,
    date,
    labelDate,
    dateFromData,
    dateMismatch: Boolean(dateFromData && labelDate && dateFromData !== labelDate),
    file: filename,
    headerIndex,
    columns: mapping,
    unmatchedHeaders,
    totals: summarise(keywords),
    keywords,
  };
}

/**
 * Publishes shared/*.mjs to public/js/shared as .js.
 *
 * The extension matters: some static hosts serve .mjs as
 * application/octet-stream, and browsers refuse a module script with the wrong
 * MIME type — which would take down the whole dashboard, not just this import.
 * Relative specifiers between the shared modules are rewritten to match.
 */
async function copyShared() {
  await mkdir(SHARED_OUT, { recursive: true });
  const files = (await readdir(SHARED_DIR)).filter((name) => name.endsWith('.mjs'));

  for (const name of files) {
    const source = await readFile(join(SHARED_DIR, name), 'utf8');
    const rewritten = source.replace(
      /(\bfrom\s*['"])(\.\.?\/[^'"]+)\.mjs(['"])/g,
      '$1$2.js$3'
    );
    await writeFile(join(SHARED_OUT, name.replace(/\.mjs$/, '.js')), rewritten);
  }
  console.log(`[shared] published ${files.length} module(s) to ${SHARED_OUT} as .js`);
}

/** Publishes the newest competitor snapshot, if one has been committed. */
async function copyCompetitors() {
  let files = [];
  try {
    files = (await readdir(COMPETITOR_DIR))
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    console.log(`[competitors] ${COMPETITOR_DIR}/ not present — skipping.`);
    return;
  }

  if (!files.length) {
    console.log('[competitors] no snapshots found.');
    return;
  }

  // Newest by filename; older snapshots stay in the repo as history.
  const newest = files[files.length - 1];
  const raw = await readFile(join(COMPETITOR_DIR, newest), 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${newest}: not valid JSON — ${error.message}`);
  }
  if (!parsed.self || !Array.isArray(parsed.keywords)) {
    throw new Error(`${newest}: missing "self" or "keywords".`);
  }

  await mkdir('public/data', { recursive: true });
  await writeFile(COMPETITOR_OUT, `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(
    `[competitors] ${newest}: ${parsed.domains?.length || 0} domains, ` +
      `${parsed.keywords.length} keywords -> ${COMPETITOR_OUT}`
  );
}

async function main() {
  await copyShared();
  await copyCompetitors();

  let filenames = [];
  try {
    filenames = (await readdir(INPUT_DIR))
      .filter((name) => ['.csv', '.tsv', '.txt'].includes(extname(name).toLowerCase()))
      .filter((name) => !name.startsWith('.') && !name.toLowerCase().startsWith('readme'))
      .sort();
  } catch {
    console.log(`[rankings] ${INPUT_DIR}/ not present — skipping.`);
  }

  const parsed = [];
  for (const filename of filenames) {
    const snapshot = await readSnapshot(INPUT_DIR, filename);
    parsed.push(snapshot);
    console.log(
      `[rankings] ${filename}: ${snapshot.keywords.length} keywords, ` +
        `${snapshot.totals.top3} in top 3, ${snapshot.totals.aiCited} cited in AI Overviews ` +
        `(${snapshot.date})`
    );
    if (snapshot.unmatchedHeaders.length) {
      console.log(`[rankings]   unmapped columns: ${snapshot.unmatchedHeaders.join(', ')}`);
    }
  }

  // A duplicated export would otherwise show as a flat week that looks like
  // real stability, so it is reported and only the first copy is kept.
  const warnings = [];
  const seenContent = new Map();
  const seenDate = new Map();
  const snapshots = [];

  // When duplicates exist, keep the copy whose filename agrees with its Date
  // column, so the retained snapshot is the correctly labelled one.
  const ordered = [...parsed].sort((a, b) => {
    const aTrusted = a.dateMismatch ? 1 : 0;
    const bTrusted = b.dateMismatch ? 1 : 0;
    return aTrusted - bTrusted || a.file.localeCompare(b.file);
  });

  for (const snapshot of ordered) {
    if (snapshot.dateMismatch) {
      warnings.push(
        `${snapshot.file} is named for ${snapshot.labelDate} but its Date column ` +
          `says ${snapshot.dateFromData}. Using ${snapshot.dateFromData}.`
      );
    }

    const twin = seenContent.get(snapshot.contentHash);
    if (twin) {
      warnings.push(
        `${snapshot.file} is byte-identical to ${twin} — the same export appears ` +
          `to have been uploaded twice. Ignoring ${snapshot.file}.`
      );
      continue;
    }
    seenContent.set(snapshot.contentHash, snapshot.file);

    const sameDate = seenDate.get(snapshot.date);
    if (sameDate) {
      warnings.push(
        `${snapshot.file} and ${sameDate} both resolve to ${snapshot.date}. ` +
          `Ignoring ${snapshot.file}.`
      );
      continue;
    }
    seenDate.set(snapshot.date, snapshot.file);

    snapshots.push(snapshot);
  }

  // Oldest first, so the dashboard can trend them left to right.
  snapshots.sort((a, b) => a.date.localeCompare(b.date));

  // A large swing in how many keywords rank at all changes the population that
  // average and median are computed over, so movement in those can be
  // composition rather than performance. Say so rather than let it read as a win.
  for (let i = 1; i < snapshots.length; i++) {
    const current = snapshots[i].totals;
    const prior = snapshots[i - 1].totals;
    if (!prior.rankedKeywords) continue;
    const swing = (current.rankedKeywords - prior.rankedKeywords) / prior.rankedKeywords;
    if (Math.abs(swing) >= 0.2) {
      warnings.push(
        `${snapshots[i].date}: keywords ranking at all moved from ` +
          `${prior.rankedKeywords} to ${current.rankedKeywords} ` +
          `(${swing > 0 ? '+' : ''}${Math.round(swing * 100)}%). Average and median ` +
          `position cover a different set of keywords than the week before, so read ` +
          `the top-3 and top-10 counts instead.`
      );
    }
  }

  if (warnings.length) {
    console.log('');
    for (const warning of warnings) console.log(`[rankings] WARNING: ${warning}`);
    console.log('');
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'AWR Cloud',
    snapshotCount: snapshots.length,
    filesRead: parsed.length,
    warnings,
    latest: snapshots.length ? snapshots[snapshots.length - 1].date : null,
    // Trend of the headline numbers across every uploaded export.
    history: snapshots.map((snapshot) => ({
      date: snapshot.date,
      ...snapshot.totals,
    })),
    snapshots,
  };

  await mkdir('public/data', { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(
    snapshots.length
      ? `[rankings] wrote ${OUTPUT_FILE} (${snapshots.length} snapshot(s))`
      : `[rankings] wrote ${OUTPUT_FILE} (empty — drop an export in ${INPUT_DIR}/)`
  );
}

main().catch((error) => {
  console.error(`\n[rankings] BUILD FAILED\n${error.message}\n`);
  process.exit(1);
});
