-- =========================================================================
-- LLM Wiki — initial schema
--
-- Layers:
--   sources         : raw source records (content bytes live in Google Drive)
--   pages           : wiki / notes / schema page metadata (body in Drive)
--   page_links      : cross-reference graph
--   llm_profiles    : user's OpenAI-compatible provider configs (encrypted key)
--   ingest_jobs     : async LLM ingest state
--   logs            : chronological activity log
--
-- Data ownership model:
--   - Supabase owns metadata + realtime broadcast
--   - Google Drive owns the actual markdown bytes (source_id_file_id, drive_file_id)
--   - Row Level Security scopes every read/write to auth.uid()
-- =========================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------
-- workspaces
-- -----------------------------------------------------------------------
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  drive_folder_id text not null,
  default_profile_id uuid,
  ingest_profile_id uuid,
  query_profile_id uuid,
  lint_profile_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workspaces_owner_idx on public.workspaces (owner_id);

-- -----------------------------------------------------------------------
-- pages — metadata only, body lives in Google Drive
-- -----------------------------------------------------------------------
create table if not exists public.pages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  slug text not null,
  kind text not null check (kind in (
    'index','log','entity','concept','summary','synthesis','note','schema','lint'
  )),
  zone text not null check (zone in ('wiki','notes','schema')),
  title text,
  drive_file_id text not null,
  content_hash text,
  frontmatter jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text not null default 'llm' check (updated_by in ('llm','human')),
  locked_by_human boolean not null default false,
  unique (workspace_id, slug)
);

create index pages_workspace_idx on public.pages (workspace_id);
create index pages_workspace_zone_idx on public.pages (workspace_id, zone);
create index pages_updated_idx on public.pages (workspace_id, updated_at desc);

-- -----------------------------------------------------------------------
-- sources
-- -----------------------------------------------------------------------
create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('url','file','text')),
  title text,
  url text,
  drive_file_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  ingested_at timestamptz
);

create index sources_workspace_idx on public.sources (workspace_id);

-- -----------------------------------------------------------------------
-- page_links — wiki cross-reference graph (slugs, not UUIDs, so they
-- survive rename races and external edits in Drive)
-- -----------------------------------------------------------------------
create table if not exists public.page_links (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  from_slug text not null,
  to_slug text not null,
  primary key (workspace_id, from_slug, to_slug)
);

create index page_links_to_idx on public.page_links (workspace_id, to_slug);

-- -----------------------------------------------------------------------
-- llm_profiles — OpenAI-compatible provider configs (OpenRouter, etc.)
-- -----------------------------------------------------------------------
create table if not exists public.llm_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  base_url text not null,
  api_key_encrypted bytea not null,
  model text not null,
  extra_headers jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create index llm_profiles_owner_idx on public.llm_profiles (owner_id);

-- FK wiring now that llm_profiles exists
alter table public.workspaces
  add constraint workspaces_default_profile_fk
    foreign key (default_profile_id) references public.llm_profiles(id) on delete set null,
  add constraint workspaces_ingest_profile_fk
    foreign key (ingest_profile_id) references public.llm_profiles(id) on delete set null,
  add constraint workspaces_query_profile_fk
    foreign key (query_profile_id) references public.llm_profiles(id) on delete set null,
  add constraint workspaces_lint_profile_fk
    foreign key (lint_profile_id) references public.llm_profiles(id) on delete set null;

-- -----------------------------------------------------------------------
-- ingest_jobs
-- -----------------------------------------------------------------------
create table if not exists public.ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','running','done','failed')),
  touched_pages text[] not null default '{}',
  profile_id uuid references public.llm_profiles(id) on delete set null,
  error text,
  started_at timestamptz,
  finished_at timestamptz
);

create index ingest_jobs_workspace_idx on public.ingest_jobs (workspace_id, status);

-- -----------------------------------------------------------------------
-- logs — chronological feed
-- -----------------------------------------------------------------------
create table if not exists public.logs (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('ingest','query','lint','manual_edit')),
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index logs_workspace_idx on public.logs (workspace_id, created_at desc);

-- =========================================================================
-- Row Level Security
-- =========================================================================

alter table public.workspaces enable row level security;
alter table public.pages enable row level security;
alter table public.sources enable row level security;
alter table public.page_links enable row level security;
alter table public.llm_profiles enable row level security;
alter table public.ingest_jobs enable row level security;
alter table public.logs enable row level security;

-- Helper: does this workspace belong to the current user?
create or replace function public.owns_workspace(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = ws and w.owner_id = auth.uid()
  );
$$;

-- workspaces: owner-only CRUD
create policy workspaces_rw on public.workspaces
  for all
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- llm_profiles: owner-only CRUD
create policy llm_profiles_rw on public.llm_profiles
  for all
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- pages / sources / page_links / ingest_jobs / logs scope via workspace ownership
create policy pages_rw on public.pages
  for all
  to authenticated
  using (public.owns_workspace(workspace_id))
  with check (public.owns_workspace(workspace_id));

create policy sources_rw on public.sources
  for all
  to authenticated
  using (public.owns_workspace(workspace_id))
  with check (public.owns_workspace(workspace_id));

create policy page_links_rw on public.page_links
  for all
  to authenticated
  using (public.owns_workspace(workspace_id))
  with check (public.owns_workspace(workspace_id));

create policy ingest_jobs_rw on public.ingest_jobs
  for all
  to authenticated
  using (public.owns_workspace(workspace_id))
  with check (public.owns_workspace(workspace_id));

create policy logs_rw on public.logs
  for all
  to authenticated
  using (public.owns_workspace(workspace_id))
  with check (public.owns_workspace(workspace_id));

-- =========================================================================
-- Realtime — broadcast all change events for authorized workspaces
-- =========================================================================

alter publication supabase_realtime add table public.pages;
alter publication supabase_realtime add table public.sources;
alter publication supabase_realtime add table public.ingest_jobs;
alter publication supabase_realtime add table public.logs;

-- =========================================================================
-- Triggers — keep updated_at fresh
-- =========================================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger workspaces_touch
  before update on public.workspaces
  for each row execute function public.touch_updated_at();

create trigger pages_touch
  before update on public.pages
  for each row execute function public.touch_updated_at();
