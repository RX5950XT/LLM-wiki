-- Durable ingest: a job survives the client, the Vercel invocation and provider outages.
--
-- * ingest_intakes keeps the raw request until its source is on Drive, so POST /api/ingest can
--   answer at once and a killed app or closed tab loses nothing.
-- * next_attempt_at / wait_reason / retry_count let the server resume by itself.
-- * pg_cron wakes /api/ingest/worker, so nothing depends on a client polling.

alter table public.ingest_jobs
  add column if not exists next_attempt_at timestamptz,
  add column if not exists wait_reason text,
  add column if not exists retry_count integer not null default 0,
  add column if not exists client_request_id uuid;

alter table public.ingest_jobs drop constraint if exists ingest_jobs_wait_reason_check;
alter table public.ingest_jobs add constraint ingest_jobs_wait_reason_check
  check (wait_reason is null or wait_reason in ('usage_limit', 'retry', 'continue'));

alter table public.ingest_jobs drop constraint if exists ingest_jobs_retry_count_check;
alter table public.ingest_jobs add constraint ingest_jobs_retry_count_check check (retry_count >= 0);

alter table public.ingest_jobs drop constraint if exists ingest_jobs_phase_check;
alter table public.ingest_jobs add constraint ingest_jobs_phase_check
  check (phase = any (array['intake', 'analysis', 'writing', 'review', 'done']));

-- A client that re-sends after a lost response must get the same job back.
create unique index if not exists ingest_jobs_client_request_uq
  on public.ingest_jobs (client_request_id)
  where client_request_id is not null;

-- Reading a URL or routing does not touch the wiki, so an intake need not queue behind a writer.
drop index if exists public.ingest_jobs_one_running_per_workspace;
create unique index ingest_jobs_one_running_per_workspace
  on public.ingest_jobs (workspace_id)
  where status = 'running' and phase <> 'intake';

create index if not exists ingest_jobs_active_idx
  on public.ingest_jobs (updated_at)
  where status in ('pending', 'running');

create table if not exists public.ingest_intakes (
  job_id uuid primary key references public.ingest_jobs (id) on delete cascade,
  kind text not null check (kind in ('url', 'text', 'file')),
  url text,
  title text,
  content text,
  file_base64 text,
  filename text,
  mime text,
  auto_route boolean not null default false,
  locale text,
  created_at timestamptz not null default now()
);

-- Server-only: the worker reads it with the service role; clients never need the raw payload.
revoke all on public.ingest_intakes from anon, authenticated;
grant select, insert, update, delete on public.ingest_intakes to service_role;
alter table public.ingest_intakes enable row level security;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The token is generated here and never leaves the database: the route asks Postgres to compare.
select vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'),
  'ingest_worker_secret',
  'Bearer token pg_cron presents to /api/ingest/worker'
)
where not exists (select 1 from vault.secrets where name = 'ingest_worker_secret');

create or replace function public.verify_ingest_worker_token(token text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'ingest_worker_secret' and decrypted_secret = token
  );
$$;
revoke all on function public.verify_ingest_worker_token(text) from public, anon, authenticated;
grant execute on function public.verify_ingest_worker_token(text) to service_role;

-- Calls Vercel only when a job is actually due, so an idle project costs nothing. The 320 seconds
-- is just past Vercel's 300s limit: a run still `running` by then was killed and must be recovered.
-- Set the deployment URL once per environment:
--   select vault.create_secret('https://<host>/api/ingest/worker', 'ingest_worker_url');
select cron.unschedule(jobid) from cron.job where jobname = 'ingest-worker';
select cron.schedule(
  'ingest-worker',
  '* * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'ingest_worker_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ingest_worker_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  )
  where exists (select 1 from vault.secrets where name = 'ingest_worker_url')
    and exists (
      select 1 from public.ingest_jobs
      where (status = 'pending' and coalesce(next_attempt_at, now()) <= now())
         or (status = 'running' and started_at < now() - interval '320 seconds')
    );
  $cron$
);
