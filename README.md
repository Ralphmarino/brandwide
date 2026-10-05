# Brandwide Analytics Dashboard

A self-hosted reporting dashboard — the Looker Studio / Data Studio idea, but on
Netlify, in Brandwide's own branding, with **Google Analytics 4**, **Google
Search Console** and **Mouseflow** side by side.

- Zero npm dependencies. The serverless functions use Node's built-in `crypto`
  and `fetch`, so deploys are fast and there is no dependency tree to maintain.
- Credentials live only in Netlify environment variables and are read inside the
  functions. Nothing sensitive is ever sent to the browser.
- Any source without credentials renders clearly-labelled **sample data**, so the
  dashboard is fully explorable before the connections are arranged.

---

## Quick start

```bash
npm install -g netlify-cli     # once
netlify init                   # link this repo to a Netlify site
netlify dev                    # http://localhost:8888
netlify deploy --prod
```

There is no build step — `public/` is published as-is.

---

## What's in each report

| Report | Source | Contents |
|---|---|---|
| **Overview** | GA4 + GSC | Users, new users, sessions, page views, engagement rate, average session; traffic trend with a metric switcher; clicks/impressions sparklines; top pages and top queries |
| **Acquisition** | GA4 | Sessions by channel, device donut, channel performance table, top countries |
| **Search Console** | GSC | Clicks, impressions, CTR, average position with prior-period deltas; four trend charts; top queries; top landing pages; device and country splits |
| **Behaviour** | Mouseflow | Recording volume and trend, average duration, pages per session, high-friction share, device split, entry pages, and a recent-sessions table that deep-links into Mouseflow playback |
| **Data sources** | — | Live connection status plus setup instructions |

Every table has a **Export CSV** button, and **PDF** in the header prints the
current report through the browser's print dialog.

Date ranges: last 7 / 28 / 90 days, 6 or 12 months, month-to-date, or a custom
range. Every range is automatically compared against the immediately preceding
period of the same length.

---

## Connecting the data sources

All three are configured in Netlify under
**Site configuration → Environment variables**. See `.env.example` for the full
list. Set what you have — each source works independently.

### 1. Google Analytics 4 and Search Console (one service account covers both)

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or pick)
   a project.
2. Enable both APIs:
   - **Google Analytics Data API**
   - **Google Search Console API**
3. **IAM & Admin → Service Accounts → Create service account.** No project roles
   are needed — access is granted inside GA4 and Search Console instead.
4. On the service account, **Keys → Add key → Create new key → JSON**. Download it.
5. Set these variables from the JSON file:

   | Variable | Value |
   |---|---|
   | `GOOGLE_CLIENT_EMAIL` | the `client_email` field |
   | `GOOGLE_PRIVATE_KEY` | the `private_key` field, `\n` escapes left intact |

6. **Grant GA4 access:** GA4 → Admin → Property access management → add the
   service account email as **Viewer**. Set `GA4_PROPERTY_ID` to the numeric
   property ID (Admin → Property Settings).
7. **Grant Search Console access:** Search Console → Settings → Users and
   permissions → add the same email (**Full** or **Restricted**). Set
   `GSC_SITE_URL` to the property exactly as Search Console shows it:
   - Domain property: `sc-domain:brandwide.com`
   - URL-prefix property: `https://www.brandwide.com/`

> **The private key is the usual snag.** Netlify's variable editor stores a
> pasted key with literal `\n` sequences; a multi-line paste keeps real
> newlines. The dashboard accepts both, and strips surrounding quotes. If the
> key is malformed you get a clear "GOOGLE_PRIVATE_KEY looks malformed" message
> rather than a generic failure.

> **Search Console lags 2–3 days.** The dashboard shifts the Search Console
> window back by three days so recent bars don't look like a cliff. GA4 is
> queried right up to yesterday.

### 2. Mouseflow

1. In Mouseflow: **Settings → API Keys → generate a key.** Note the region shown
   there (US or EU).
2. Set:

   | Variable | Value |
   |---|---|
   | `MOUSEFLOW_USERNAME` | the email you log in to Mouseflow with |
   | `MOUSEFLOW_API_KEY` | the generated key |
   | `MOUSEFLOW_REGION` | `us` or `eu` |
   | `MOUSEFLOW_WEBSITE_ID` | optional — defaults to the first site on the account |

Authentication is HTTP Basic (`email:apikey`) against
`https://api-us.mouseflow.com` or `https://api-eu.mouseflow.com`.

**This plan's public API returns nothing usable**, so the Behaviour report is
fed by a *snapshot sync* instead — see below. If you later move to a plan whose
API works, set the variables above and the function will prefer it automatically;
no code change needed.

### Snapshot sync (how Behaviour is actually fed)

The figures are captured from the endpoints Mouseflow's own web app calls,
using your logged-in session, by a bookmarklet you run from inside Mouseflow.

1. Set `MOUSEFLOW_INGEST_SECRET` and `GITHUB_TOKEN` in Netlify (below).
2. Open `https://brandwide.netlify.app/tools` and drag the bookmarklet to your
   bookmarks bar.
3. On **us.mouseflow.com**, signed in, click the bookmark. The first run asks
   for the ingest secret and remembers it in that browser.

What happens: the tool pulls 90 days of daily aggregates — sessions, visitors,
pageviews, visit and engagement duration, friction score — plus daily session
counts by device, entry page, country, referrer type and browser, then the most
recent recordings and top pages. It POSTs that to `/api/mouseflow-ingest`,
which merges it into `data/mouseflow/daily.json` and commits. Netlify rebuilds,
and the report updates.

**Days are merged, never replaced.** Mouseflow retains about 90 days, so the
committed file is the only place older days survive. After a few months of
syncing the report reaches back further than Mouseflow itself can.

Two things the roll-up is careful about, because both would otherwise be wrong:

- Visit duration, engagement duration and friction arrive as *per-day averages*
  and are recombined **weighted by each day's session count**. A plain mean
  would let a quiet Sunday count as heavily as a busy Tuesday.
- Summing daily visitors gives the **sum of daily uniques**, not unique
  visitors for the period — someone returning on three days counts three
  times. The card is labelled accordingly and says so on hover.

Personal fields (IP, latitude, longitude, city, visitor ID) are stripped in the
browser before anything is sent, and stripped again server-side so a stale copy
of the tool cannot commit them.

Because Mouseflow has revised its field names over time, the function reads each
value from a list of candidate keys and normalises the result, and it retries
without date filters if the API rejects them. If your account returns a shape it
doesn't recognise, use the passthrough to inspect the raw response:

```
/api/mouseflow?path=websites
/api/mouseflow?path=websites/<website-id>/recordings
```

---

## Restricting access

The dashboard is `noindex`, but that is not access control. Two options:

- **Netlify password protection** (Site configuration → Access control) — simplest.
- **Built-in basic auth**: set `DASHBOARD_USER` and `DASHBOARD_PASSWORD`. The
  edge function in `netlify/edge-functions/auth.js` then gates every request.
  With both unset it passes through, so the site can never lock itself out.

---

## Project layout

```
data/mouseflow/
  daily.json                Accumulated Mouseflow snapshot, written by syncs
public/                     Static dashboard (published as-is)
  tools/index.html          Sync bookmarklet and instructions
  tools/mouseflow-sync.js   The script the bookmarklet loads
  index.html                Shell and all five report panels
  css/dashboard.css         Brand tokens, layout, components
  js/app.js                 State, data loading, rendering
  js/api.js                 Date-range maths and fetch layer
  js/charts.js              Chart.js config and the validated palette
  js/format.js              Number, date and CSV helpers
netlify/functions/
  ga4.mjs                   GA4 Data API (one batchRunReports call)
  gsc.mjs                   Search Console Search Analytics API
  mouseflow.mjs             Behaviour data: API key, else snapshot, else demo
  mouseflow-ingest.mjs      Receives a snapshot sync and commits it to the repo
  health.mjs                Which sources have credentials (never echoes them)
netlify/lib/
  mouseflow-snapshot.mjs    Reads and rolls up the committed Mouseflow snapshot
  google-auth.mjs           Service-account JWT signing and token cache
  http.mjs                  Shared request/response helpers
  demo-data.mjs             Deterministic sample data
netlify/edge-functions/
  auth.js                   Optional basic-auth gate
```

### API endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/ga4` | GA4 totals, prior-period totals, daily trend, channels, top pages, devices, countries |
| `GET /api/gsc` | Search Console totals, prior-period totals, daily trend, queries, pages, devices, countries |
| `GET /api/mouseflow` | Mouseflow site, recording roll-ups, trend, device split, entry pages, recent recordings |
| `GET /api/health` | Per-source configuration status, the service-account email, and Mouseflow snapshot coverage |
| `POST /api/mouseflow-ingest` | Receives a Mouseflow snapshot from the sync bookmarklet. Origin-locked to `https://us.mouseflow.com` and gated by `MOUSEFLOW_INGEST_SECRET` |

All accept `startDate`, `endDate`, `compareStartDate`, `compareEndDate`
(`YYYY-MM-DD`) and `limit`.

---

## Design notes

Brand colours are sampled from the logo: orange `#FB4513`, charcoal `#4C4C4C`.

The categorical chart palette (`public/js/charts.js`) leads with the brand orange
and was validated for colour-vision-deficiency separation and contrast — worst
adjacent pair ΔE 16.8 (deuteranopia) / 19.3 (normal vision), all six at or above
3:1 against the card surface. Hues are assigned in fixed order and never cycled.

No chart uses two y-axes. Where two measures have different magnitudes — Search
Console clicks against impressions — they are drawn as separate charts rather
than overlaid on mismatched scales. Counts start at zero; rates and rankings do
not, and the average-position axis is reversed so a rising line always means
improving.

---

## Adding another metric

1. Add the metric or dimension to the relevant request in `netlify/functions/`.
2. Map it into the JSON response.
3. Render it in `public/js/app.js` — `kpiCard()` for a scorecard, `renderTable()`
   for a table, or one of the chart helpers.
4. Add a matching entry to `demoGa4` / `demoGsc` / `demoMouseflow` in
   `netlify/lib/demo-data.mjs` so sample mode stays complete.
