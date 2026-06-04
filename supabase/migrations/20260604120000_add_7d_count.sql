-- Add a 7-day report total to report_stats(). The headline number on the live
-- status cards reads better as a week than a rolling hour (which often sits at
-- 0 with low traffic). The hour/24h aggregates, hourly buckets, and symptom
-- breakdown are unchanged — they still drive the spike tier, the sparkline, and
-- the "limits reset in the last hour" detector.

-- Adding a column to the RETURNS TABLE changes the function signature, so the
-- existing function must be dropped before recreating.
drop function if exists public.report_stats();

create or replace function public.report_stats()
returns table (
  provider          text,
  count_1h          bigint,
  count_24h         bigint,
  count_7d          bigint,
  symptom_breakdown jsonb,
  hourly_buckets    jsonb
)
language sql
security definer
set search_path = public
stable
as $$
  with weekly as (
    select provider, symptom, created_at,
           date_trunc('hour', created_at) as bucket
    from public.reports
    where created_at >= now() - interval '7 days'
  ),
  -- The 24h slice (for buckets) is derived from the weekly window.
  windowed as (
    select provider, symptom, created_at, bucket
    from weekly
    where created_at >= now() - interval '24 hours'
  ),
  -- Provider universe is anyone active in the last 7 days, so a tool that is
  -- quiet in the last 24h but had reports this week still shows its count.
  providers as (
    select distinct provider from weekly
  ),
  totals as (
    select provider,
           count(*) filter (where created_at >= now() - interval '1 hour')  as count_1h,
           count(*) filter (where created_at >= now() - interval '24 hours') as count_24h,
           count(*)                                                          as count_7d
    from weekly
    group by provider
  ),
  symptoms as (
    select provider,
           jsonb_object_agg(symptom, c) as symptom_breakdown
    from (
      select provider, symptom, count(*) as c
      from weekly
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
    coalesce(t.count_1h, 0)                    as count_1h,
    coalesce(t.count_24h, 0)                   as count_24h,
    coalesce(t.count_7d, 0)                    as count_7d,
    coalesce(s.symptom_breakdown, '{}'::jsonb) as symptom_breakdown,
    coalesce(se.hourly_buckets, '[]'::jsonb)   as hourly_buckets
  from providers p
  left join totals t   on t.provider = p.provider
  left join symptoms s on s.provider = p.provider
  left join series se  on se.provider = p.provider;
$$;

revoke all on function public.report_stats() from public;
grant execute on function public.report_stats() to anon, authenticated;
