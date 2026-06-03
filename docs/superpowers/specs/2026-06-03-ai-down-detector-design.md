# AI Down Detector — Design

**Date:** 2026-06-03
**Status:** Approved (brainstorming) — pending spec review
**Supersedes:** the dead "Report Codex degradation" GitHub-issue link

## Summary

Rebrand `reset-watch` into a Downdetector-style live incident detector for AI
coding tools. Crowdsourced, one-tap user reports become the hero signal, stored
in Supabase. The existing scraped reset/pain/status model becomes supporting
context and a corroboration layer.

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Center of gravity | **Downdetector-first.** Live per-provider report graph is the hero; reset odds + status feed move below. |
| Report shape | **Provider + symptom, one tap.** Symptoms: Slow, Errors, Limits drained, No reset, Quality worse. No login, no free text in v1. |
| Anti-abuse | **Rate-limit by device + IP.** Random `device_id` in localStorage + server-side hashed IP. ~1 report per provider per device per 20 min, enforced in an Edge Function. |
| Rebrand | **Outage/incident detector framing.** Working name "AI Down Detector". Tagline: "Is your AI coding tool down right now?" |
| Backend | **Approach A:** Edge Function for writes (IP hash + cooldown), aggregate-only RPC/view for reads. Frontend polls ~45s. |
| External corroboration | **Use existing scraped sources** (status pages + social), NOT Downdetector scraping (no free API, ToS + anti-bot). Each provider shows a confidence badge: "User-reported" vs "Corroborated by official status". |

## Providers / targets

Reports are keyed to a curated product list drawn from the existing `companies`
model in `src/data.ts`:

- **OpenAI:** Codex (primary), ChatGPT, OpenAI API
- **Anthropic:** Claude Code (primary), Claude.ai, Claude API

v1 surfaces the two coding-primary targets (Codex, Claude Code) as hero cards;
the others can be enabled by config without schema change.

## Architecture

### Data model (Supabase Postgres)

`reports` table:
- `id` uuid pk default gen_random_uuid()
- `provider` text not null  (enum-checked: 'codex' | 'claude-code' | ...)
- `symptom` text not null   (enum-checked: 'slow' | 'errors' | 'limits' | 'no-reset' | 'quality')
- `device_id` text not null
- `ip_hash` text not null
- `created_at` timestamptz not null default now()

Indexes: `(provider, created_at)`, `(device_id, provider, created_at)`,
`(ip_hash, provider, created_at)`.

RLS: **enabled, deny-all** for the anon role. No direct table access from the
browser — all reads/writes mediated.

### Writes — Edge Function `submit-report`

1. Receives `{ provider, symptom, device_id }` (POST, anon JWT).
2. Validates provider/symptom against allow-lists.
3. Computes `ip_hash = sha256(client_ip + IP_HASH_SALT)` (salt is a function
   secret; raw IP never stored).
4. Cooldown check: reject if a row exists for this `device_id` OR `ip_hash`
   on the same `provider` within the last 20 minutes (429).
5. Insert via service-role client. Returns `{ ok: true }` or an error code.

### Reads — aggregate-only

A Postgres function `report_stats(window_minutes int)` (SECURITY DEFINER,
granted to anon) returns per-provider aggregates — never raw rows:
- `provider`
- `count_1h`, `count_24h`
- `symptom_breakdown` (jsonb: symptom -> count, last 1h)
- `hourly_buckets` (jsonb array, last 24h, for the sparkline)

No `ip_hash` / `device_id` ever leaves the database.

### Status derivation (frontend)

Per provider, compute a rolling baseline (median of prior 24h hourly buckets).
Status tier from current-hour count vs baseline:
- 🟩 **normal** — at/below baseline
- 🟧 **elevated** — meaningfully above baseline (e.g. ≥2× and ≥ floor)
- 🟥 **spike** — sharply above baseline (e.g. ≥4× and ≥ floor)

Floors prevent low-traffic noise from tripping a "spike". Thresholds live in one
config object, tunable without code surgery.

### Corroboration badge

Cross-reference the existing scraped status snapshot (`fetch:status`) for the
matching company/product. If an active/recent incident matches, the card shows
**"Corroborated by official status"**; otherwise **"User-reported only."**

## Frontend integration

- New `src/supabase.ts` — typed client + `submitReport()` + `fetchReportStats()`.
- New report UI: provider picker + symptom chips + submit, replacing the old
  `report-box` / `reportUrl` (removed). Optimistic local state + cooldown UI.
- New hero: per-provider incident cards with status dot, reports/hr, sparkline,
  symptom breakdown, corroboration badge.
- Reset odds + status feed relocated below the hero.
- Rebrand: title, eyebrow, tagline, meta tags, social card text.
- `device_id`: generated once, persisted in localStorage.
- Env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (in `.env.local`, gitignored;
  `.env.example` documents them).

## Components & boundaries

- `supabase.ts` — all Supabase I/O. Consumers never see the client directly.
- `incident-model.ts` — pure functions: stats + baseline -> status tier +
  corroboration. Unit-testable with no network.
- `ReportWidget` — the one-tap report UI; depends only on `submitReport`.
- `IncidentCards` — hero display; depends only on `fetchReportStats` output +
  `incident-model`.
- Edge Function `submit-report` — isolated; its only contract is the POST shape.

## Error handling

- Submit failure / 429 cooldown → inline non-blocking message, no data loss of
  user's selection.
- Stats fetch failure → cards fall back to last good data + a "stale" hint;
  never blanks the page.
- Supabase env missing → app runs in a read-only "demo" mode using existing
  static data, so local dev without keys still works.

## Testing

- `incident-model.ts`: unit tests for tiering (normal/elevated/spike, floors)
  and corroboration matching — TDD, written first.
- Edge Function: local tests for validation + cooldown logic (pure parts
  extracted so they test without a live DB).
- Manual: submit flow, cooldown enforcement, polling refresh.

## Rollout / handoff

Code is built locally and independently. Going live needs the user's Supabase
auth (interactive `supabase login` cannot be driven by the agent):

1. User: `npx supabase login` (+ create/link project).
2. Agent: `supabase link`, `supabase db push` (migration), set `IP_HASH_SALT`
   secret, `supabase functions deploy submit-report`.
3. Agent: wire `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, run/build, verify.

## Out of scope (v1 / YAGNI)

- Free-text reports, plan/timezone fields.
- CAPTCHA/Turnstile (rate-limit only; add if abused).
- Downdetector or other third-party scraping.
- Historical incident archive / per-provider detail pages.
- Auth / user accounts.
