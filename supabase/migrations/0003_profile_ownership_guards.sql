-- Prevent workspace profile pointers from referencing another user's LLM profile.

alter table public.llm_profiles
  add constraint llm_profiles_id_owner_unique unique (id, owner_id);

alter table public.workspaces
  add constraint workspaces_default_profile_owner_fk
    foreign key (default_profile_id, owner_id)
    references public.llm_profiles(id, owner_id),
  add constraint workspaces_ingest_profile_owner_fk
    foreign key (ingest_profile_id, owner_id)
    references public.llm_profiles(id, owner_id),
  add constraint workspaces_query_profile_owner_fk
    foreign key (query_profile_id, owner_id)
    references public.llm_profiles(id, owner_id),
  add constraint workspaces_lint_profile_owner_fk
    foreign key (lint_profile_id, owner_id)
    references public.llm_profiles(id, owner_id);

create or replace function public.assert_ingest_job_profile_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  workspace_owner uuid;
  profile_owner uuid;
begin
  if new.profile_id is null then
    return new;
  end if;

  select owner_id into workspace_owner
  from public.workspaces
  where id = new.workspace_id;

  select owner_id into profile_owner
  from public.llm_profiles
  where id = new.profile_id;

  if workspace_owner is null or profile_owner is distinct from workspace_owner then
    raise exception 'ingest job profile must belong to workspace owner';
  end if;

  return new;
end;
$$;

create trigger ingest_jobs_profile_owner_guard
  before insert or update of workspace_id, profile_id on public.ingest_jobs
  for each row execute function public.assert_ingest_job_profile_owner();
