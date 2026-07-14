-- One maintenance run per user, enforced by the database.
--
-- /api/organize checked for a running job and *then* inserted one, with several
-- seconds of Drive calls in between. Two tabs polling the same job both saw
-- `done && more_work`, both passed the check, and both inserted: two maintenance
-- pipelines rewriting the same wiki at the same time, each burning the full LLM
-- budget. A check cannot serialise concurrent requests — a constraint can.
--
-- Stale rows (an after() killed at maxDuration) are still swept to 'failed' by the
-- route before it inserts, so this index cannot wedge the button shut.
create unique index if not exists agent_jobs_one_running_per_owner
  on public.agent_jobs (owner_id)
  where status = 'running';
