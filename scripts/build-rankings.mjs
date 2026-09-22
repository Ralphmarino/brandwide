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
import { join, extname, basename } from 'node:path';
import { parseCsvRows } from './lib/csv.mjs';
import { looksLikeHeader, mapColumns, normaliseRows, summarise } from './lib/awr.mjs';

const INPUT_DIR = 'data/rankings';
const OUTPUT_FILE = 'public/data/rankings.json';

const DATE_IN_NAME = /(\d{4})[-_]?(\d{2})[-_]?(\d{2})/;

function dateFromFilename(name) {
  const match = name.match(DATE_IN_NAME);
  if (!match) return null;
  const [, year, month, day] = match;
  const iso = `${year}-${month}-${day}`;
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

  const date =
    dateFromFilename(filename) ||
    dateFromRows(rows, mapping) ||
    (await stat(path)).mtime.toISOString().slice(0, 10);

  return {
    date,
    file: filename,
    headerIndex,
    columns: mapping,
    unmatchedHeaders,
    totals: summarise(keywords),
    keywords,
  };
}

async function main() {
  let filenames = [];
  try {
    filenames = (await readdir(INPUT_DIR))
      .filter((name) => ['.csv', '.tsv', '.txt'].includes(extname(name).toLowerCase()))
      .filter((name) => !name.startsWith('.') && !name.toLowerCase().startsWith('readme'))
      .sort();
  } catch {
    console.log(`[rankings] ${INPUT_DIR}/ not present — skipping.`);
  }

  const snapshots = [];
  for (const filename of filenames) {
    const snapshot = await readSnapshot(INPUT_DIR, filename);
    snapshots.push(snapshot);
    console.log(
      `[rankings] ${filename}: ${snapshot.keywords.length} keywords, ` +
        `${snapshot.totals.top3} in top 3, ${snapshot.totals.aiOverviews} with AI Overview ` +
        `(${snapshot.date})`
    );
    if (snapshot.unmatchedHeaders.length) {
      console.log(`[rankings]   unmapped columns: ${snapshot.unmatchedHeaders.join(', ')}`);
    }
  }

  // Oldest first, so the dashboard can trend them left to right.
  snapshots.sort((a, b) => a.date.localeCompare(b.date));

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'AWR Cloud',
    snapshotCount: snapshots.length,
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
