-- Encrypt llm_profiles.extra_headers at rest (P3 from Phase 12 audit).
-- New writes store AES-256-GCM ciphertext in extra_headers_encrypted and keep
-- the legacy jsonb column empty. Reads fall back to the plaintext column only
-- for rows created before this migration (self-hosted installs).
alter table public.llm_profiles
  add column if not exists extra_headers_encrypted bytea;

comment on column public.llm_profiles.extra_headers_encrypted is
  'AES-256-GCM ciphertext of the extra_headers JSON (same layout as api_key_encrypted: iv || authTag || ciphertext). Decrypted server-side only.';
