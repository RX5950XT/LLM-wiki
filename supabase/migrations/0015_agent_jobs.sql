-- 0015: agent_jobs — cross-workspace long-running AI tasks (organize = 自動分類＋去重複)
-- ingest_jobs is workspace+source scoped (source_id NOT NULL), so cross-workspace
-- jobs get their own owner-scoped table.

create table if not exists public.agent_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('organize')),
  status text not null default 'running' check (status in ('running','done','failed')),
  progress text[] not null default '{}',
  report_workspace_id uuid references public.workspaces(id) on delete set null,
  report_slug text,
  error text,
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists agent_jobs_owner_idx on public.agent_jobs (owner_id, status);

-- GRANT immediately after CREATE TABLE, before RLS (project convention)
grant select, insert, update, delete on public.agent_jobs to authenticated;
grant select, insert, update, delete on public.agent_jobs to service_role;
grant select on public.agent_jobs to anon;

alter table public.agent_jobs enable row level security;

-- idempotent: production migration history is incomplete, migrations get re-applied by hand
drop policy if exists agent_jobs_rw on public.agent_jobs;
create policy agent_jobs_rw on public.agent_jobs
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
