# Competitor snapshots (Ahrefs)

Each file is one dated snapshot of the competitive set, compiled from the
Ahrefs API. The build publishes the newest one; older files stay as history.

## Refreshing

Ahrefs is reached through the Ahrefs MCP connector in a Claude session, which
the deployed site cannot call at runtime — so this is a committed snapshot
rather than a live feed, the same pattern as the AWR ranking exports.

To refresh, ask Claude to pull the current figures and write a new dated file
here. Roughly monthly is enough; keyword positions move faster than domain
authority, and the weekly AWR exports already cover that.

If you have Ahrefs API credentials on a plan that permits server-side calls,
this could become a live serverless function instead. Worth doing only if the
snapshot cadence becomes a constraint.

## File shape

```jsonc
{
  "date": "2026-09-21",
  "country": "us",
  "self": "meetbrandwide.com",        // which domain is us
  "domains": [                         // one per tracked domain
    { "domain": "...", "label": "...", "self": true,
      "orgKeywords": 25, "orgTop3": 16, "orgTraffic": 473, "orgValueUsd": 3628.92,
      "domainRating": 50, "ahrefsRank": 725064,
      "backlinks": 18682, "referringDomains": 2762,
      "backlinksAllTime": 70174, "referringDomainsAllTime": 8314 }
  ],
  "keywords": [
    { "keyword": "franchise software", "volume": 600, "keywordDifficulty": 48,
      "ranks": {
        "meetbrandwide.com": { "position": 1, "kind": "ai_overview",
                               "url": "https://...", "traffic": 73 }
      } }
  ]
}
```

`kind` is Ahrefs' position type. `ai_overview` means the domain is cited in the
AI Overview rather than holding that organic position — which is why a keyword
can show position 1 for several domains at once. The dashboard marks these
separately rather than treating them as equivalent to a blue link.

## Scope of the current snapshot

Brandwide and FranchiseSoft are captured in full. FranConnect and Delightree
are limited to non-branded keywords with volume >= 50, since their full keyword
sets are much larger and the long tail is mostly irrelevant to this comparison.
That limit is recorded in the file's `note` field and shown on the report.
