-- Allow 'lint' jobs in the shared agent_jobs table so the health check runs as a
-- background job (poll-based) exactly like organize, and both share the
-- one-at-a-time-per-owner lock. Idempotent: drop the check then re-add it.
alter table public.agent_jobs drop constraint if exists agent_jobs_kind_check;
alter table public.agent_jobs add constraint agent_jobs_kind_check check (kind in ('organize', 'lint'));
