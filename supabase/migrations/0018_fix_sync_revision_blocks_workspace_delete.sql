-- Deleting a workspace cascade-deletes its pages; this AFTER DELETE trigger then
-- tried to bump a sync revision for a workspace row that no longer exists, which
-- violates workspace_sync_state's FK and aborts the whole delete. Net effect: no
-- workspace could EVER be deleted (the AI renamed them "【已空】…" as a workaround,
-- and the Web/Android delete buttons 500'd the same way).
create or replace function public.bump_workspace_sync_revision()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
DECLARE
  _wid uuid;
BEGIN
  _wid := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;

  -- The workspace itself may be mid-delete (its pages cascade first). There is
  -- nothing left to sync, and inserting here would abort the deletion.
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = _wid) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.workspace_sync_state (workspace_id, pages_revision, pages_updated_at)
  VALUES (_wid, 1, now())
  ON CONFLICT (workspace_id)
  DO UPDATE SET
    pages_revision   = workspace_sync_state.pages_revision + 1,
    pages_updated_at = now();

  RETURN NULL;
END;
$function$;
