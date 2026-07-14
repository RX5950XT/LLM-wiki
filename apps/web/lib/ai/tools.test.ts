import { describe, expect, it } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { buildWikiTools } from './tools';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222';

function tools(overrides: Partial<Parameters<typeof buildWikiTools>[0]> = {}) {
  return buildWikiTools({
    supabase: {} as SupabaseClient,
    drive: {} as drive_v3.Drive,
    workspaceId: WORKSPACE,
    wikiFolderId: 'folder',
    userId: 'user',
    crossWorkspace: true,
    confirmDestructive: false,
    ...overrides,
  });
}

describe('buildWikiTools', () => {
  it('withholds deleteWorkspace when the caller disables it', () => {
    // The failure it prevents: a maintenance pass "merges" workspaces by sweeping
    // one workspace's pages into an unrelated one and deleting the husk — a whole
    // shelf disappears and the UI only says "N changes". Empty workspaces are swept
    // by code (organize-mechanical.ts), so the model never needs this tool.
    expect(Object.keys(tools({ allowWorkspaceDelete: false }))).not.toContain('deleteWorkspace');
  });

  it('keeps deleteWorkspace for the chat, where the user asks and confirms', () => {
    expect(Object.keys(tools())).toContain('deleteWorkspace');
  });

  // Measured on a production run: 4 pages were moved out by one maintenance pass and
  // straight back by the next, because each pass re-derives the taxonomy. The churn
  // also keeps `more_work` true, so the button spends passes undoing itself.
  it('refuses to move a page an earlier pass of the same run already moved', async () => {
    const move = tools({ frozenMoveSlugs: new Set(['concepts/data-center-infrastructure.md']) })
      .movePageToWorkspace;

    const result = (await move.execute!(
      {
        slug: 'concepts/data-center-infrastructure.md',
        to_workspace_id: OTHER_WORKSPACE,
      },
      { toolCallId: 'test', messages: [] },
    )) as { error?: string };

    expect(result.error).toContain('already re-shelved');
  });
});
