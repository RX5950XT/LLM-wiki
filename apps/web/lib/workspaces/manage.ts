import type { drive_v3 } from 'googleapis';
import { createAdminClient } from '@/lib/supabase/admin';
import { initWorkspaceDrive } from '@/lib/drive/workspace-init';
import { ensureWorkspaceSystemPages } from '@/lib/drive/system-pages';
import { getNextWorkspaceSortOrder, isMissingSortOrderError } from './queries';

export type ManageResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/**
 * Create a workspace end-to-end (Drive folders + DB row + system pages +
 * default profile binding). Shared by the workspaces POST route and the
 * AI createWorkspace tool.
 */
export async function createWorkspaceForUser(
  drive: drive_v3.Drive,
  userId: string,
  name: string,
  locale?: string | null,
): Promise<ManageResult<{ id: string }>> {
  const admin = createAdminClient();
  const workspaceId = crypto.randomUUID();

  const { driveFolderId } = await initWorkspaceDrive(drive, workspaceId, locale);

  const nextSortOrder = await getNextWorkspaceSortOrder(admin, userId);

  const workspaceRecord = {
    id: workspaceId,
    owner_id: userId,
    name,
    drive_folder_id: driveFolderId,
    ...(nextSortOrder == null ? {} : { sort_order: nextSortOrder }),
  };

  let { error: workspaceError } = await admin.from('workspaces').insert(workspaceRecord);
  if (isMissingSortOrderError(workspaceError)) {
    const { sort_order: _sortOrder, ...legacyWorkspaceRecord } = workspaceRecord as typeof workspaceRecord & {
      sort_order?: number;
    };
    const retry = await admin.from('workspaces').insert(legacyWorkspaceRecord);
    workspaceError = retry.error;
  }
  if (workspaceError) {
    return { ok: false, error: `Failed to create workspace record: ${workspaceError.message}` };
  }

  await ensureWorkspaceSystemPages(drive, workspaceId, driveFolderId, locale);

  const { data: defaultProfile } = await admin
    .from('llm_profiles')
    .select('id')
    .eq('owner_id', userId)
    .eq('is_default', true)
    .maybeSingle();

  if (defaultProfile) {
    const { error: bindError } = await admin
      .from('workspaces')
      .update({ default_profile_id: defaultProfile.id })
      .eq('id', workspaceId);
    if (bindError) {
      return { ok: false, error: `Failed to bind default profile: ${bindError.message}` };
    }
  }

  return { ok: true, id: workspaceId };
}

export async function renameWorkspaceForUser(
  userId: string,
  workspaceId: string,
  name: string,
): Promise<ManageResult<{ name: string }>> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('workspaces')
    .update({ name: name.trim(), updated_at: new Date().toISOString() })
    .eq('id', workspaceId)
    .eq('owner_id', userId)
    .select('id, name')
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'Workspace not found' };
  return { ok: true, name: data.name };
}

/**
 * Delete a workspace: trash the Drive folder FIRST, then remove the DB row.
 * Drive trash failing aborts the delete so mobile/Web/Drive never diverge.
 */
export async function deleteWorkspaceForUser(
  drive: drive_v3.Drive,
  userId: string,
  workspaceId: string,
): Promise<ManageResult> {
  const admin = createAdminClient();
  const { data: workspace, error: lookupError } = await admin
    .from('workspaces')
    .select('id, drive_folder_id')
    .eq('id', workspaceId)
    .eq('owner_id', userId)
    .maybeSingle();

  if (lookupError) return { ok: false, error: lookupError.message };
  if (!workspace) return { ok: false, error: 'Workspace not found' };

  await drive.files.update({
    fileId: workspace.drive_folder_id,
    requestBody: { trashed: true },
    fields: 'id',
  });

  const { error: deleteError } = await admin
    .from('workspaces')
    .delete()
    .eq('id', workspace.id)
    .eq('owner_id', userId);

  if (deleteError) {
    // The folder is already in Drive's trash but the workspace survived. Put it
    // back, or the user keeps a workspace whose content quietly rots in the bin.
    await drive.files
      .update({ fileId: workspace.drive_folder_id, requestBody: { trashed: false }, fields: 'id' })
      .catch(() => {});
    return { ok: false, error: deleteError.message };
  }
  return { ok: true };
}
