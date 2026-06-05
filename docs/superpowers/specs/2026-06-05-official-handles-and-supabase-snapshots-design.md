# Official-handle monitoring + Supabase snapshot storage — Design

**Date:** 2026-06-05
**Status:** Approved (brainstorming), pre-implementation
**Resolves:** GitHub issues #1 (official-handle monitor) and #2 (snapshot storage in Supabase)

## Context

`reset-watch` publishes two kinds of "public signal" snapshots, regenerated hourly
by `.github/workflows/refresh-status.yml`:

- `scripts/fetch-status.mjs` → `public/data/status-snapshot.json` **and** `public/data/auto-resets.json`
- `scripts/fetch-social.mjs` → `public/data/social-snapshot.json` (reads `public/data/social-overrides.json`)

The workflow commits the regenerated files back to `main`. The frontend (`src/App.tsx`)
loads them at runtime via `loadJson('/data/*.json')`.

Two curated files are **not** script-generated and stay committed: `resets.json`
(hand-authored reset feed) and `social-overrides.json` (operator boosts).

A Supabase project is already wired up for the crowdsourced-reports feature
(`src/supabase.ts`, `supabase/migrations/*`, Edge Function `submit-report`). Its
security pattern: tables are RLS deny-all to `anon`; reads go through a
`SECURITY DEFINER` RPC (`report_stats()`). This design reuses that pattern.

## Issue assessment (why these are worth doing)

- **#2 is a real problem:** 15 of the last 20 commits are automated snapshot commits,
  burying development history; concurrent maintainer push + runner push can fail
  (non-fast-forward). Migrating is the right fix *here* specifically because Supabase
  already exists in the project. Some stated benefits (`.git` bloat, Realtime) are
  minor/YAGNI and are not pursued in v1.
- **#1 is valid intent with a flawed blueprint:** the issue's `scored.score += 100`
  targets the wrong layer — per-item `score` only drives sorting/filtering, not the
  `heat`/`reset_chatter` metrics (which derive from term-match counts). This design
  delivers the intent (elevate official signals) by boosting at the topic-summary
  layer, capped, mirroring the existing `applyOverride` mechanism.

## Decisions

| Question | Decision |
|---|---|
| Migration scope | **All generated snapshots** (`social`, `status`, `auto-resets`). Workflow stops committing entirely. Curated `resets.json` + `social-overrides.json` stay committed. |
| Storage shape | **Append a row per run**, read latest per `kind`. Free time-series for future charts; trivial row volume. |
| Official-post boost | **Moderate, capped** topic-level bump (not flat +100 to item score). |
| Read path | **`SECURITY DEFINER` RPC** `latest_snapshot(kind)`, granted to `anon`. No direct table access — matches `report_stats()`. |
| Fallback | Frontend tries Supabase first, falls back to static `/data/*.json` when Supabase is unconfigured (local dev / demo / safety net). |
| Delivery | **Two sequential PRs**: #1 (official handles) first, merge, then #2 (Supabase). |

---

## Part A — Issue #1: official-handle monitoring

### Behavior
For each topic, additionally scrape a small set of official X handles via the
existing DuckDuckGo HTML fallback, surface matches tagged `[OFFICIAL]`, and give
official posts that mention a **reset** term a bounded boost to the topic's
`reset_chatter`/`heat`.

### Changes to `scripts/fetch-social.mjs`
- Add `official_handles` to each topic:
  - `openai-codex`: `['thsottiaux']`
  - `anthropic-claude-code`: `['AlexAlbert_', 'AnthropicAI']`
- New fetcher `officialProfileSearch(topic, source='official-announcement')`:
  - For each handle, query `site:x.com/<handle> reset OR limits OR cleared OR fixed`
    through the same `html.duckduckgo.com` scraper + `result__a` regex already used
    by `duckDuckGoSiteSearch`.
  - Prefix titles with `[OFFICIAL] `, mark items `{ official: true }`.
  - Resilient: wrapped by the existing per-fetcher try/catch in the runner loop;
    failures land in `snapshot.errors`, never throw.
- Mount `officialProfileSearch` into the `fetchers` array.
- Add an `official-announcement` entry to `snapshot.sources` for documentation.

### Honest, capped boost (replaces the issue's `+100`)
In `summarizeTopic`, after base metrics are computed, if any **official** item
matched a reset term, apply a bounded bump (mirrors `applyOverride`):
- `reset_chatter = min(100, reset_chatter + OFFICIAL_RESET_BOOST)` (e.g. +18)
- `heat = min(100, heat + OFFICIAL_HEAT_BOOST)` (e.g. +10)
- append a note: `"Official reset signal detected: <handle/title>"`
- official items also get a modest per-item `score` bump so they surface in the
  top `examples`, but the metric movement comes from the capped topic-level bump,
  not the item score.

One official post meaningfully elevates the signal; it cannot alone saturate every
metric to 100.

### Testability refactor (serves #1, eases #2)
The scoring/summarize logic currently lives inline in a script that executes on
import, so it is untestable. Extract the **pure** functions into
`scripts/lib/social-score.mjs`:
`painTerms`, `resetTerms`, `positiveTerms`, `termMatches`, `scoreText`, `dedupe`,
`applyOverride`, `summarizeTopic`, and the new official-boost constants/logic.
`fetch-social.mjs` imports them and keeps the I/O (fetchers, file/db writes).

### Tests (TDD — written first)
`scripts/lib/social-score.test.ts` (vitest, matches existing test setup):
- `summarizeTopic` with no official items → unchanged base behavior.
- with an official item matching a reset term → `reset_chatter`/`heat` bumped but
  **capped at 100**; note present; official example surfaces in `examples`.
- official item with **no** reset term → no boost.

---

## Part B — Issue #2: Supabase snapshot storage

### Migration `supabase/migrations/<ts>_add_signal_snapshots.sql`
```sql
create table if not exists public.signal_snapshots (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  generated_at timestamptz not null default now(),
  payload      jsonb not null,
  constraint signal_snapshots_kind_chk check (kind in ('social','status','auto-resets'))
);
create index if not exists signal_snapshots_kind_generated_idx
  on public.signal_snapshots (kind, generated_at desc);

alter table public.signal_snapshots enable row level security;
revoke all on public.signal_snapshots from anon, authenticated;

create or replace function public.latest_snapshot(p_kind text)
returns jsonb
language sql security definer set search_path = public stable
as $$
  select payload from public.signal_snapshots
  where kind = p_kind order by generated_at desc limit 1
$$;
revoke all on function public.latest_snapshot(text) from public;
grant execute on function public.latest_snapshot(text) to anon, authenticated;
```
The whole snapshot object (already containing `generated_at`, `sources`, `errors`,
`topics`/`incidents`) is stored as `payload`; `latest_snapshot` returns it verbatim.

### Writes — `scripts/lib/push-snapshot.mjs`
`pushSnapshot(kind, snapshot)` using `@supabase/supabase-js` with
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Inserts one row. If env is absent
(local dev), logs and no-ops so `npm run fetch:data` still works offline.
Both `fetch-status.mjs` and `fetch-social.mjs` call it after building their snapshot.
They continue to write the local JSON files (useful seed for local dev/fallback);
only the **workflow** stops committing them.

### Frontend — `src/supabase.ts` + `src/App.tsx`
- `src/supabase.ts`: add `fetchSnapshot<T>(kind): Promise<T | null>` calling
  `client.rpc('latest_snapshot', { p_kind: kind })`. Returns null when unconfigured
  or on error. All Supabase I/O stays in this module.
- `src/App.tsx`: for each of status/social/auto-resets, try `fetchSnapshot(kind)`
  first; if null, fall back to the existing `loadJson('/data/*.json')`. `resets.json`
  stays a static load (curated, not in Supabase). No UI/type changes — the payload
  shape is identical to today's files.

### Workflow — `.github/workflows/refresh-status.yml`
- Remove `npm run build`, the commit/push step, and `permissions: contents: write`.
- Add `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` to the `npm run fetch:data` env.
- Net: checkout → setup-node → `npm ci` → `npm run fetch:data` (pushes to Supabase).

### Side effect (bug fix)
`auto-resets.json` is currently regenerated hourly but never committed by the
workflow, so the served copy is stale. Reading it from Supabase makes it live.

## Operator handoff (requires user's Supabase/GitHub auth)
1. `npx supabase db push` — apply the new migration to the live project.
2. Add GitHub Actions secrets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
   (Settings → Secrets and variables → Actions). The service-role key is secret and
   only ever used server-side in the Action.
3. Confirm the frontend env (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`) is set
   in the Vercel project (already used by the reports feature).

## Error handling
- Supabase write fails in CI → script logs the error into `snapshot.errors` /
  console and exits non-fatally; the local file write still happens.
- Supabase read fails / unconfigured on the frontend → silent fallback to static
  `/data/*.json`; never blanks the page (existing `loadJson` already swallows errors).

## Testing
- `social-score.test.ts` (Part A) — TDD, covers boost + cap + no-op cases.
- `npm run lint`, `npm test`, `npm run build` green before each PR.
- Manual: run `npm run fetch:data` locally (no Supabase env) → files still written;
  with env → row appears. Frontend with Supabase → live data; without → static fallback.

## Out of scope (YAGNI)
- Supabase Realtime push to open tabs.
- Row retention/cleanup (append volume is trivial; add later if ever needed).
- Migrating curated `resets.json` / `social-overrides.json` (human-edited config).
- Reworking the heat model beyond the capped official boost.
