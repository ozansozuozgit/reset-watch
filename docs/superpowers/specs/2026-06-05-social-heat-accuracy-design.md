# Social-heat accuracy — design

**Date:** 2026-06-05
**Status:** Approved (design); implementation pending
**Related:** PR #4 (UI-level `communityHeatRead` cross-feed honesty)

## Problem

The Community heat score reads ~0 for Claude Code even during an active official
incident with elevated on-site reports. Root causes in `scripts/fetch-social.mjs`
and `scripts/lib/social-score.mjs`:

1. **Real free APIs are dead code.** `redditSearch()` (Reddit `search.json`) and
   `blueskySearch()` (Bluesky `app.bsky.feed.searchPosts`) are written but never
   called — the live `fetchers` array scrapes **DuckDuckGo HTML snippets** for
   Reddit and Bluesky instead. DDG returns ~8 stale cached snippets per query,
   no timestamps, and breaks when the page markup changes. This was true from the
   first commit (`9ab6c0a`); the APIs were never wired in, almost certainly
   because the scanner runs on a **shared GitHub Actions runner IP** that Reddit
   403/429s (the same class of problem `retry.mjs` documents for
   `status.claude.com`). DDG was the uniform won't-block fallback; the cost was
   recall.
2. **Rigid exact-phrase queries.** `"Claude Code slow"`, `"Claude Code degraded"`
   miss the way people actually post ("claude is down again", "anthropic limits
   hit", "opus erroring").
3. **Uncalibrated substring scoring.** `heat = volume*5 + painHits*5 + …`, so an
   empty scrape → 0. Codex's `100` is the **manual override**, not real signal.
   Substring matching misfires (`un`**`limit`**`ed`, `**down**load`), and tutorial
   "how to fix slow Codex" posts count as outage pain.

## Goals / non-goals

**Goals:** materially higher recall and precision for public chatter; a heat
number that stays honest when chatter is sparse but other evidence is strong;
stay **100% free / key-less**; resilient to per-source failure from CI.

**Non-goals:** paid X/Twitter coverage (deliberately out — preserves the
free-only design); sentiment-model sophistication; changing the on-site report
or official-incident pipelines.

## Design

### Lever 1 — Resilient free-source chain

Replace the DDG-for-everything `fetchers` array with a **primary→fallback per
source**, each wrapped in the existing `withRetry` and isolated so one source
failing lands in `snapshot.errors` without zeroing the topic.

| Source | Primary | Fallback |
|---|---|---|
| Bluesky | `blueskySearch` (public API, no auth) | DDG `site:bsky.app` |
| Reddit | `redditSearch` (`search.json` + descriptive UA) | DDG `site:reddit.com` |
| X/Twitter | DDG `site:x.com` (no free API) | — |
| HN | `hnSearch` (Algolia) | — |
| Official handles | `officialProfileSearch` (DDG) | — |

- A source runs its fallback only when the primary **throws or returns empty**,
  so `volume` isn't double-counted. `dedupe()` still guards overlap.
- Descriptive `User-Agent` already set; Reddit may still 403 from CI → fallback
  covers it. Bluesky is the realistic big win from CI.
- Real-API items carry `published_at`; DDG items don't (drives Lever 2 decay).

### Lever 2 — Query + scoring overhaul (`social-score.mjs` + queries)

- **Queries:** search by product/brand sorted newest (`Claude Code`, plus a small
  `aliases` list e.g. `Claude`, `Anthropic`) instead of `"<product> <symptom>"`
  phrases. Recall comes from the query; precision from scoring.
- **Word-boundary matching:** replace substring `includes()` with token/boundary
  regex so `unlimited`/`download` stop matching `limit`/`down`. Multi-word terms
  (`rate limit`, `limits reset`) matched as phrases.
- **Noise control:** a `stopTerms` list and down-weighting of tutorial framing
  (`how to`, `tip`, `fix:`, `try this`) so help posts don't register as live pain.
- **Recency decay:** weight each item by age using `published_at` — full weight
  `<6h`, decaying to ~0 by `7d`. Items without a timestamp (DDG) get a neutral
  default (~0.5). `volume`/`painHits`/`resetHits` become decay-weighted sums.
- **Recalibrate** the heat/pain/reset constants against the decay-weighted inputs
  so a single fresh complaint and ten week-old snippets don't read alike.

### Lever 3 — Honest "effective heat" (app side, pure + tested)

Keep the **scraper pure** (chatter only — `heat` means one clear thing). Do the
fusion in the app, where all three feeds are loaded and minute-fresh:

- New pure function (in `incident-model.ts`) `effectiveHeat({ chatterHeat,
  officialIncident, reportTier })` → returns an adjusted heat (bounded 0–100)
  that floors/boosts chatter heat when an official incident or elevated on-site
  reports exist. Pairs with the shipped `communityHeatRead` (which decides card
  tone).
- In `App.tsx`, derive an **effective topics** list (`useMemo` mapping
  `socialSnapshot.topics` → topics with adjusted `heat`/`pain_chatter` via the
  fusion fn + `corroboration` + `deriveStatus(reportStat)`).
- Feed those effective topics to **all consumers** so the honesty is global:
  the Community heat card, the hero **"hot topics"** count (`heat >= 58`), and
  `buildPredictions(...)` pain — by passing a derived `SocialSnapshot` so
  `buildPredictions` needs no signature change.

### Lever 4 — Baseline-relative heat (stretch; land 1–3 first)

Express heat as a **surge over the topic's own rolling baseline**, not an
absolute count, mirroring the on-site report model (`baselineFromBuckets`).
Source history from the Supabase `signal_snapshots` rows the scanner already
writes: compute a median of recent per-topic decay-weighted volume, and scale
heat by `current / max(baseline, floor)`. Separable and last because it needs a
history read and adds the most surface area; recency decay (Lever 2) already
removes most stale-signal error, so this is a refinement, not a blocker.

## Testing

- `scripts/lib/social-score.test.ts`: word-boundary matching (no `unlimited`
  hit), stoplist/tutorial down-weight, recency decay (fresh > stale), recalibrated
  heat sanity.
- `src/incident-model.test.ts`: `effectiveHeat` — incident floors a 0-chatter
  topic; elevated reports floor it; pure chatter passes through; result clamped.
- App-side: effective topics flow into hot-topic count + predictions (extend
  existing tests where present).
- Manual: run `npm run fetch:social` locally and confirm real Reddit/Bluesky
  items + non-zero Claude heat; verify graceful fallback when a primary fails.

## Risks

- **Reddit 403/429 from CI** — accepted; DDG fallback + `withRetry` absorb it,
  Bluesky carries real-API recall.
- **Bluesky/Reddit shape drift** — isolated per-source try/catch + fallback keep
  a bad source from zeroing a topic.
- **Over-broad brand queries add noise** — mitigated by word-boundary scoring,
  stoplist, and the `score > 0` filter in `summarizeTopic`.

## Rollout

Phases land independently and safely: **1 → 2 → 3 → (4 stretch)**. Each ships
with its tests; the free-only guarantee holds throughout.
