-- =========================================================================
-- MCP access tokens: let other agents (Claude Code, Codex, Grok CLI, Hermes…)
-- read the wiki through POST /api/mcp with `Authorization: Bearer <token>`.
--
-- Only the SHA-256 of a token is stored; the token itself is shown once.
-- Like google_oauth_tokens (0012), clients never touch this table directly:
-- the settings API and the MCP route use the service role and filter by
-- owner_id. 0011's default privileges would grant anon/authenticated, so
-- they are revoked explicitly; RLS stays on as a second wall.
-- =========================================================================

create table public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  token_hash text not null unique,
  token_prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

grant select, insert, update, delete on public.mcp_tokens to service_role;
revoke all on public.mcp_tokens from anon;
revoke all on public.mcp_tokens from authenticated;

alter table public.mcp_tokens enable row level security;

create index mcp_tokens_owner_idx on public.mcp_tokens (owner_id);
