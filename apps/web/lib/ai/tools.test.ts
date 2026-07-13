import { describe, expect, it } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { buildWikiTools } from './tools';

function tools(allowWorkspaceDelete?: boolean) {
  return buildWikiTools({
    supabase: {} as SupabaseClient,
    drive: {} as drive_v3.Drive,
    workspaceId: '11111111-1111-4111-8111-111111111111',
    wikiFolderId: 'folder',
    userId: 'user',
    crossWorkspace: true,
    confirmDestructive: false,
    allowWorkspaceDelete,
  });
}

describe('buildWikiTools', () => {
  it('withholds deleteWorkspace when the caller disables it', () => {
    // The failure it prevents: a maintenance pass "merges" workspaces by sweeping
    // one workspace's pages into an unrelated one and deleting the husk — a whole
    // shelf disappears and the UI only says "N changes". Empty workspaces are swept
    // by code (organize-mechanical.ts), so the model never needs this tool.
    expect(Object.keys(tools(false))).not.toContain('deleteWorkspace');
  });

  it('keeps deleteWorkspace for the chat, where the user asks and confirms', () => {
    expect(Object.keys(tools())).toContain('deleteWorkspace');
  });
});
