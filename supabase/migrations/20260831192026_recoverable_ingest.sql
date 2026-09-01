-- Recoverable ingest metadata.  The existing RLS policies and Data API grants
-- remain in place; this migration only adds state used by the two-stage
-- pipeline and indexes its existing ownership boundary.

alter table public.sources
  add column if not exists content_sha256 text,
  add column if not exists mime_type text,
  add column if not exists byte_size bigint;

alter table public.ingest_jobs
  drop constraint if exists ingest_jobs_status_check;

alter table public.ingest_jobs
  add constraint ingest_jobs_status_check
    check (status in ('pending', 'running', 'paused', 'done', 'failed'));

alter table public.ingest_jobs
  add column if not exists phase text not null default 'analysis',
  add column if not exists checkpoint jsonb not null default '{}'::jsonb,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists source_sha256 text,
  add column if not exists result text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.ingest_jobs
  drop constraint if exists ingest_jobs_phase_check,
  drop constraint if exists ingest_jobs_attempt_count_check,
  drop constraint if exists ingest_jobs_result_check;

alter table public.ingest_jobs
  add constraint ingest_jobs_phase_check
    check (phase in ('analysis', 'writing', 'review', 'done')),
  add constraint ingest_jobs_attempt_count_check
    check (attempt_count >= 0),
  add constraint ingest_jobs_result_check
    check (result is null or result in ('updated', 'unchanged'));

drop trigger if exists ingest_jobs_touch on public.ingest_jobs;
create trigger ingest_jobs_touch
  before update on public.ingest_jobs
  for each row execute function public.touch_updated_at();

create unique index if not exists sources_workspace_content_sha256_uq
  on public.sources (workspace_id, content_sha256)
  where content_sha256 is not null;

create index if not exists ingest_jobs_workspace_status_started_idx
  on public.ingest_jobs (workspace_id, status, started_at);

create unique index if not exists ingest_jobs_one_running_per_workspace
  on public.ingest_jobs (workspace_id)
  where status = 'running';
