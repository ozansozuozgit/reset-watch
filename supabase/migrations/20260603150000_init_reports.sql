-- AI Down Detector — crowdsourced report storage (Approach A)
-- Writes go through the submit-report Edge Function (service role).
-- Reads go through report_stats() which returns aggregates only.
-- The anon role gets NO direct table access.

create extension if not exists pgcrypto;

create table if not exists public.reports (
  id         uuid primary key default gen_random_uuid(),
  provider   text not null,
  symptom    text not null,
  device_id  text not null,
  ip_hash    text not null,
  created_at timestamptz not null default now(),
  constraint reports_provider_chk check (provider in (
    'codex', 'claude-code', 'chatgpt', 'claude-ai', 'openai-api', 'claude-api'
  )),
  constraint reports_symptom_chk check (symptom in (
    'slow', 'errors', 'limits', 'no-reset', 'quality'
  ))
);

create index if not exists reports_provider_created_idx
  on public.reports (provider, created_at desc);
create index if not exists reports_device_idx
  on public.reports (device_id, provider, created_at desc);
create index if not exists reports_ip_idx
  on public.reports (ip_hash, provider, created_at desc);

-- Lock the table down. RLS on + no policies => anon/auth roles cannot
-- read or write directly. Only the service-role key (Edge Function) bypasses.
alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;

-- Aggregate-only read surface. SECURITY DEFINER so it can read the table
-- while the caller (anon) cannot. Never returns device_id / ip_hash.
create or replace function public.report_stats()
returns table (
  provider          text,
  count_1h          bigint,
  count_24h         bigint,
  symptom_breakdown jsonb,
  hourly_buckets    jsonb
)
language sql
security definer
set search_path = public
stable
as $$
  with windowed as (
    select provider, symptom, created_at,
           date_trunc('hour', created_at) as bucket
    from public.reports
    where created_at >= now() - interval '24 hours'
  ),
  providers as (
    select distinct provider from windowed
  ),
  totals as (
    select provider,
           count(*) filter (where created_at >= now() - interval '1 hour') as count_1h,
           count(*) as count_24h
    from windowed
    group by provider
  ),
  symptoms as (
    select provider,
           jsonb_object_agg(symptom, c) as symptom_breakdown
    from (
      select provider, symptom, count(*) as c
      from windowed
      where created_at >= now() - interval '1 hour'
      group by provider, symptom
    ) s
    group by provider
  ),
  hours as (
    select generate_series(
      date_trunc('hour', now() - interval '23 hours'),
      date_trunc('hour', now()),
      interval '1 hour'
    ) as bucket
  ),
  buckets as (
    select p.provider, h.bucket,
           count(w.*) as c
    from providers p
    cross join hours h
    left join windowed w
      on w.provider = p.provider and w.bucket = h.bucket
    group by p.provider, h.bucket
  ),
  series as (
    select provider,
           jsonb_agg(jsonb_build_object('t', bucket, 'c', c) order by bucket) as hourly_buckets
    from buckets
    group by provider
  )
  select
    p.provider,
    coalesce(t.count_1h, 0)            as count_1h,
    coalesce(t.count_24h, 0)           as count_24h,
    coalesce(s.symptom_breakdown, '{}'::jsonb) as symptom_breakdown,
    coalesce(se.hourly_buckets, '[]'::jsonb)   as hourly_buckets
  from providers p
  left join totals t   on t.provider = p.provider
  left join symptoms s on s.provider = p.provider
  left join series se  on se.provider = p.provider;
$$;

revoke all on function public.report_stats() from public;
grant execute on function public.report_stats() to anon, authenticated;
