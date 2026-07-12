-- =========================================================================
-- Migration 0012: google_oauth_tokens 只留 service_role
--
-- 0011 依「所有表補 GRANT」慣例把 anon/authenticated 也授權給
-- google_oauth_tokens（存加密 Google refresh token）。RLS default-deny
-- （0002 policy: authenticated using(false)、anon 無 policy）目前擋得住，
-- 但 client 端從不需要讀這張表——收回 GRANT 讓任何未來的 RLS 誤設
-- 都不會直接暴露 token 表。
--
-- 注意：0011 對 owns_workspace(uuid) 的 GRANT EXECUTE to authenticated
-- 是「必要的」，不可 revoke——pages/sources/page_links/ingest_jobs/logs
-- 的 RLS policy 以查詢角色的權限評估該函數，revoke 會讓所有 client 端
-- 直查這些表的查詢直接 permission denied。
-- =========================================================================

revoke all on public.google_oauth_tokens from anon;
revoke all on public.google_oauth_tokens from authenticated;
