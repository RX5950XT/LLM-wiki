alter table public.workspaces
  add column if not exists sort_order integer not null default 0;

with ordered as (
  select id, row_number() over (partition by owner_id order by created_at asc, id asc) - 1 as position
  from public.workspaces
)
update public.workspaces as workspaces
set sort_order = ordered.position
from ordered
where workspaces.id = ordered.id;

create index if not exists workspaces_owner_sort_idx
  on public.workspaces (owner_id, sort_order, created_at);
