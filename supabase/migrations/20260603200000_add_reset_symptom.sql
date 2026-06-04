-- Crowdsourced reset detection: a positive "my usage limits just reset" signal.
-- Users who visually see their quota refill tap it, and a cluster of these in a
-- short window flips the forecast from "likely reset" to "reset confirmed".
-- This is the real-time detector that keeps the forecast from going stale after
-- a make-good reset that never appears on the official status page.

alter table public.reports drop constraint reports_symptom_chk;
alter table public.reports add constraint reports_symptom_chk check (symptom in (
  'slow', 'errors', 'limits', 'no-reset', 'quality', 'down', 'reset'
));
