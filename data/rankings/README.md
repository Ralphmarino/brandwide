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
| AI Overview | AI Overview, AI Overviews, AIO, SGE, AI Snapshot |
| SERP features | SERP Features, Features, Special Results, Snippets |
| Search engine | Search Engine, Engine, SE |
| Location | Location, Region, Country, Market, Geo |
| Device | Device, Platform |
| Group | Group, Keyword Group, Category, Tag, Project |

AI Overview presence is picked up either from its own column or from the value
appearing in the SERP-features column.

Comma, semicolon and tab delimiters are all handled, as is a title/preamble
block above the header row — the parser finds the real header itself.

### Values treated as "not ranked"

`-`, `--`, blank, `N/A`, `NR`, `Not ranked`, and anything prefixed `>` (such as
`>100`, meaning beyond tracked depth). These count toward *tracked* but are
excluded from average and median position, so a keyword entering the set at
position 80 cannot quietly drag the average down.

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
