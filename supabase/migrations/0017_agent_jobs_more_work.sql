-- A deep maintenance pass rarely fits in one Vercel invocation (maxDuration 300s):
-- the model gets cut off mid-plan, e.g. having moved 6 of a workspace's 9 pages
-- but not yet deleted the emptied workspace. The pipeline now reports whether it
-- finished, and the client chains another pass until the base is genuinely done.
alter table public.agent_jobs
  add column if not exists more_work boolean not null default false;

comment on column public.agent_jobs.more_work is
  'true = the pipeline stopped on its time budget with work still outstanding; the client should start another pass.';
