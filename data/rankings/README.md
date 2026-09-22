# Ranking exports (AWR Cloud)

Drop AWR Cloud ranking exports in this folder. Netlify rebuilds on every push
and compiles them into the dashboard's **Rankings** report.

## How to add one

1. Export your AWR ranking report as **CSV** (not XLSX — the parser is CSV-only
   so the project keeps zero dependencies).
2. Name it with the snapshot date: `2026-09-22.csv`. Any of these work:
   `2026-09-22.csv`, `awr-2026-09-22.csv`, `rankings_2026_09_22.csv`.
3. Commit it to this folder — on github.com, **Add file → Upload files**, drag
   it in, commit to `main`.

Netlify rebuilds automatically. No environment variables, no redeploy by hand.

Each file is one dated snapshot. Several files build a history, so positions,
top-3 counts and AI Overview appearances can be trended over time. Keep the old
files — deleting one removes that point from the history.

## Which columns matter

Columns are matched by name, in any order, and anything unrecognised is ignored.
Only **keyword** and **position** are required.

| Field | Header spellings recognised |
|---|---|
| Keyword *(required)* | Keyword, Keywords, Search Term, Query, Phrase, Term |
| Position *(required)* | Position, Rank, Current Position, Best Position, Ranking, Pos |
| Previous position | Previous Position, Previous Rank, Prev, Last Position, Start Position |
| Landing page | URL, Landing Page, Ranking URL, Page, Target URL |
| Search volume | Search Volume, Volume, Monthly Searches, Searches |
| AI Overview citation rank | Citation Rank, AIO Rank, AI Citation Rank |
| Top AI Overview source | Top AIO Source, Top AI Source, AIO Source |
| AI brand mentions | AI Brand Mentions, Brand Mentions |
| SERP features | SERP Features, Features, Special Results, Snippets |
| Position change | Position Change, Pos Change, Rank Change, Change |
| Keyword group | Labels, Label, Group, Keyword Group, Category, Tag |
| Keyword difficulty | Keyword Difficulty, Difficulty, KD |
| Search intent | Search Intent, Intent |
| Impressions / clicks | Impressions, Clicks |
| Search engine | Search Engine, Engine, SE |
| Location | Location, Region, Country, Market, Geo |
| Device | Device, Platform |
| Group | Group, Keyword Group, Category, Tag, Project |

### Three separate AI Overview facts

These are **not** interchangeable, and the dashboard keeps them apart:

- **An AI Overview exists** on the SERP — read from the SERP-features column.
  In this market that is nearly every keyword, so it describes the battlefield
  rather than performance.
- **You are cited in it** — evidenced by a citation rank.
- **You are its top-cited source** — from the Top AIO Source column.

The headline figure is citations, not presence. Counting every SERP that merely
*has* an AI Overview would overstate performance by roughly fifteen times.

Comma, semicolon and tab delimiters are all handled, as is a title/preamble
block above the header row — the parser finds the real header itself.

### Values treated as "not ranked"

`-`, `--`, blank, `N/A`, `NR`, `Not ranked`, and anything prefixed `>` (such as
`>100`, meaning beyond tracked depth). These count toward *tracked* but are
excluded from average and median position, so a keyword entering the set at
position 80 cannot quietly drag the average down.

## Duplicates and mislabelled files

The **Date column inside the export is authoritative**; the filename is only a
label. If the two disagree, the build says so and trusts the Date column.

Byte-identical uploads are detected and ignored, keeping the copy whose
filename matches its own Date column. A duplicate would otherwise appear as a
flat week that reads like genuine stability.

The build also flags a snapshot where the number of keywords ranking at all
swings by 20% or more, because average and median position then cover a
different population than the week before — movement that looks like progress
but is really a change of composition.

All of these notices appear at the top of the Rankings report, not only in the
deploy log.

## If a file is not recognised

The build **fails loudly** rather than publishing an empty report, and the
Netlify deploy log names the file, lists the headers it saw, and says which
column it could not find. Add the spelling to `COLUMN_CANDIDATES` in
`scripts/lib/awr.mjs` and push — nothing else needs changing.

To check a file before pushing:

```bash
node scripts/build-rankings.mjs
```

It prints a line per file: keyword count, top-3 count, AI Overview count, and
any columns it could not map.
