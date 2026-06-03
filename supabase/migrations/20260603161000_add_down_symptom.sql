-- One-tap reporting: a single "problem or not" signal per tool, instead of
-- forcing users to pick a symptom. Add a generic 'down' value; keep the
-- richer symptoms valid so detailed reporting can return later.

alter table public.reports drop constraint reports_symptom_chk;
alter table public.reports add constraint reports_symptom_chk check (symptom in (
  'slow', 'errors', 'limits', 'no-reset', 'quality', 'down'
));
