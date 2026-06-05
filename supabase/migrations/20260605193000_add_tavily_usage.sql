-- Monthly Tavily API credit budget counter.
-- The social fetcher reads the current month's credit total before each Tavily
-- search and, once a configurable cap is reached, stops calling Tavily and falls
-- back to the free scrapers — so a narrow monthly Tavily allotment can never be
-- exceeded, even by manual workflow runs. Same lockdown as public.reports /
-- public.signal_snapshots: only the service-role key (the GitHub Action) touches
-- it; anon/authenticated get no access at all.

create table if not exists public.tavily_usage (
  month      text primary key,            -- calendar month, 'YYYY-MM' (UTC)
  credits    integer not null default 0,  -- credits spent this month
  updated_at timestamptz not null default now()
);

alter table public.tavily_usage enable row level security;
revoke all on public.tavily_usage from anon, authenticated;
