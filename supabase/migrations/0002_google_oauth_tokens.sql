create table if not exists public.google_oauth_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token_encrypted bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.google_oauth_tokens enable row level security;

create policy google_oauth_tokens_no_client_access on public.google_oauth_tokens
  for all
  to authenticated
  using (false)
  with check (false);

create trigger google_oauth_tokens_touch
  before update on public.google_oauth_tokens
  for each row execute function public.touch_updated_at();
