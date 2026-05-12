-- ============================================================
-- 1. Broadcast trigger: only broadcasts metadata, excludes search_text
--    Uses TG_OP branch to safely handle DELETE (NEW is NULL for DELETE)
-- ============================================================
CREATE OR REPLACE FUNCTION public.broadcast_page_metadata_change()
RETURNS trigger
SECURITY DEFINER
SET search_path = ''
LANGUAGE plpgsql
AS $$
DECLARE
  _wid     uuid;
  _payload jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    _wid := OLD.workspace_id;
    _payload := jsonb_build_object(
      'eventType', 'DELETE',
      'workspaceId', OLD.workspace_id,
      'slug',        OLD.slug,
      'title',       OLD.title,
      'kind',        OLD.kind,
      'zone',        OLD.zone,
      'version',     OLD.version,
      'updatedAt',   OLD.updated_at,
      'updatedBy',   OLD.updated_by
    );
  ELSE
    _wid := NEW.workspace_id;
    _payload := jsonb_build_object(
      'eventType', TG_OP,
      'workspaceId', NEW.workspace_id,
      'slug',        NEW.slug,
      'title',       NEW.title,
      'kind',        NEW.kind,
      'zone',        NEW.zone,
      'version',     NEW.version,
      'updatedAt',   NEW.updated_at,
      'updatedBy',   NEW.updated_by
    );
  END IF;

  PERFORM realtime.send(
    _payload,
    'page_changed',
    'workspace-' || _wid::text,
    true    -- private channel (requires Realtime Authorization)
  );

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS pages_broadcast_metadata ON public.pages;
CREATE TRIGGER pages_broadcast_metadata
  AFTER INSERT OR UPDATE OR DELETE ON public.pages
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_page_metadata_change();

-- ============================================================
-- 2. Broadcast RLS: only workspace owner can receive events
--    Note: owner-only; extend to workspace_members if multi-user needed
-- ============================================================
DROP POLICY IF EXISTS "workspace owner can receive page broadcasts"
  ON realtime.messages;

CREATE POLICY "workspace owner can receive page broadcasts"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND (SELECT realtime.topic()) LIKE 'workspace-%'
  AND EXISTS (
    SELECT 1
    FROM public.workspaces w
    WHERE w.id::text = replace((SELECT realtime.topic()), 'workspace-', '')
      AND w.owner_id = (SELECT auth.uid())
  )
);

-- ============================================================
-- 3. workspace_sync_state: Android manifest for cheap sync check
-- ============================================================
CREATE TABLE IF NOT EXISTS public.workspace_sync_state (
  workspace_id     UUID PRIMARY KEY
                   REFERENCES public.workspaces(id) ON DELETE CASCADE,
  pages_revision   BIGINT NOT NULL DEFAULT 0,
  pages_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.workspace_sync_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner can read workspace sync state"
  ON public.workspace_sync_state;

CREATE POLICY "owner can read workspace sync state"
ON public.workspace_sync_state
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.workspaces w
    WHERE w.id = workspace_id
      AND w.owner_id = (SELECT auth.uid())
  )
);

-- ============================================================
-- 4. Revision bump trigger: any pages INSERT/UPDATE/DELETE
--    increments the workspace manifest revision counter
-- ============================================================
CREATE OR REPLACE FUNCTION public.bump_workspace_sync_revision()
RETURNS trigger
SECURITY DEFINER
SET search_path = ''
LANGUAGE plpgsql
AS $$
DECLARE
  _wid uuid;
BEGIN
  _wid := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;

  INSERT INTO public.workspace_sync_state (workspace_id, pages_revision, pages_updated_at)
  VALUES (_wid, 1, now())
  ON CONFLICT (workspace_id)
  DO UPDATE SET
    pages_revision   = workspace_sync_state.pages_revision + 1,
    pages_updated_at = now();

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS pages_bump_sync_revision ON public.pages;
CREATE TRIGGER pages_bump_sync_revision
  AFTER INSERT OR UPDATE OR DELETE ON public.pages
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_workspace_sync_revision();

-- Initialize sync state for existing workspaces
INSERT INTO public.workspace_sync_state (workspace_id)
SELECT id FROM public.workspaces
ON CONFLICT DO NOTHING;
