import { describe, expect, it } from 'bun:test';
import { parseRoutingReply, type RoutableWorkspace } from './route-workspace';

const WORKSPACES: RoutableWorkspace[] = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'AI' },
  { id: '22222222-2222-4222-8222-222222222222', name: '地緣政治與全球貿易' },
];

describe('parseRoutingReply', () => {
  it('takes the id the router was asked for', () => {
    expect(parseRoutingReply(WORKSPACES[0].id, WORKSPACES, true)).toEqual({
      kind: 'existing',
      id: WORKSPACES[0].id,
    });
  });

  it('finds the id inside a chatty reply', () => {
    const reply = `This is about LLM training, so: ${WORKSPACES[0].id}`;
    expect(parseRoutingReply(reply, WORKSPACES, true)).toEqual({
      kind: 'existing',
      id: WORKSPACES[0].id,
    });
  });

  // The failure that made auto-filing look broken: a small model answers with the
  // workspace NAME. The old parser found no id, found no "NEW:", and silently
  // dumped the source into whatever workspace the user was looking at.
  it('accepts a bare workspace name', () => {
    expect(parseRoutingReply('地緣政治與全球貿易', WORKSPACES, true)).toEqual({
      kind: 'existing',
      id: WORKSPACES[1].id,
    });
  });

  it('creates a workspace when nothing fits', () => {
    expect(parseRoutingReply('NEW: 咖啡烘焙', WORKSPACES, true)).toEqual({
      kind: 'new',
      name: '咖啡烘焙',
    });
  });

  // A batch of files on one new subject must not spawn a second workspace once the
  // first file has already created it.
  it('reuses an existing workspace when NEW names it', () => {
    expect(parseRoutingReply('NEW: ai', WORKSPACES, true)).toEqual({
      kind: 'existing',
      id: WORKSPACES[0].id,
    });
  });

  it('refuses to create past the workspace cap', () => {
    expect(parseRoutingReply('NEW: 咖啡烘焙', WORKSPACES, false)).toBeNull();
  });

  it('returns null on an unusable reply so the caller retries', () => {
    expect(parseRoutingReply('I am not sure about this one.', WORKSPACES, true)).toBeNull();
  });
});
