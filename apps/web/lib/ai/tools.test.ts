import { describe, expect, it } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { buildWikiTools } from './tools';

const WS_WITH_PAGES = '11111111-1111-4111-8111-111111111111';
const WS_EMPTY = '22222222-2222-4222-8222-222222222222';

/** Enough of PostgREST to satisfy deleteWorkspace's ownership lookup. */
function stubSupabase(): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: { id: WS_WITH_PAGES, name: 'Finance' }, error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

function tools(deletable: Set<string>) {
  return buildWikiTools({
    supabase: stubSupabase(),
    drive: {} as drive_v3.Drive,
    workspaceId: WS_EMPTY,
    wikiFolderId: 'folder',
    userId: 'user',
    crossWorkspace: true,
    confirmDestructive: false,
    deletableWorkspaceIds: deletable,
  });
}

describe('deleteWorkspace guard', () => {
  it('refuses a workspace that held pages when the run started', async () => {
    // The failure it prevents: a maintenance pass "merges" by sweeping a workspace's
    // pages into an unrelated one, then deletes the husk — a whole shelf disappears.
    const deleteWorkspace = tools(new Set([WS_EMPTY])).deleteWorkspace;
    const result = await deleteWorkspace.execute!(
      { workspace_id: WS_WITH_PAGES },
      { toolCallId: 't', messages: [] },
    );
    expect(result).toMatchObject({ error: expect.stringContaining('already empty') });
  });
});
