-- Signal snapshot storage (GitHub issue #2).
-- The hourly fetchers append the generated status/social/auto-resets payloads
-- here instead of committing JSON files back into git. Same lockdown pattern as
-- public.reports: writes use the service-role key (GitHub Action); the anon role
-- gets NO direct table access and reads only the latest row via an RPC.

create table if not exists public.signal_snapshots (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  generated_at timestamptz not null default now(),
  payload      jsonb not null,
  constraint signal_snapshots_kind_chk check (kind in ('social', 'status', 'auto-resets'))
);

-- Latest-row-per-kind lookups.
create index if not exists signal_snapshots_kind_generated_idx
  on public.signal_snapshots (kind, generated_at desc);

-- Lock the table down: RLS on + no policies => anon/authenticated cannot read or
-- write directly. Only the service-role key (the Action) bypasses RLS to insert.
alter table public.signal_snapshots enable row level security;
revoke all on public.signal_snapshots from anon, authenticated;

-- Aggregate-free but public read surface: return the most recent payload for a
-- kind. SECURITY DEFINER so anon can call it without table access. The payload is
-- already public data (it was a static file), so returning it verbatim is fine.
create or replace function public.latest_snapshot(p_kind text)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select payload
  from public.signal_snapshots
  where kind = p_kind
  order by generated_at desc
  limit 1
$$;

revoke all on function public.latest_snapshot(text) from public;
grant execute on function public.latest_snapshot(text) to anon, authenticated;
