import { describe, expect, it } from 'bun:test';
import {
  findDuplicateClusters,
  pickDeletableWorkspaces,
  type InventoryRow,
  type WorkspaceRow,
} from './organize-mechanical';

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const OLD = new Date(NOW - 5 * HOUR).toISOString();

const page = (workspace_id: string, slug: string, title: string): InventoryRow => ({
  workspace_id,
  slug,
  title,
  kind: 'entity',
});

describe('pickDeletableWorkspaces', () => {
  const current: WorkspaceRow = { id: 'current', name: 'Current', created_at: OLD };
  const empty: WorkspaceRow = { id: 'empty', name: 'Empty husk', created_at: OLD };
  const full: WorkspaceRow = { id: 'full', name: 'Full', created_at: OLD };
  const fresh: WorkspaceRow = {
    id: 'fresh',
    name: 'Just created',
    created_at: new Date(NOW - 5 * 60_000).toISOString(),
  };

  const pages = [
    page('current', 'index.md', 'Index'),
    page('empty', 'index.md', 'Index'),
    page('empty', 'log.md', 'Log'),
    page('full', 'entities/nvidia.md', 'NVIDIA'),
  ];

  it('deletes a workspace left with nothing but scaffolding', () => {
    const picked = pickDeletableWorkspaces([current, empty, full, fresh], pages, 'current', NOW);
    expect(picked.map((w) => w.id)).toEqual(['empty']);
  });

  it('keeps a workspace created moments ago (its import may still be running)', () => {
    const picked = pickDeletableWorkspaces([fresh], [], 'current', NOW);
    expect(picked).toEqual([]);
  });

  it('never deletes on an unparseable created_at', () => {
    const picked = pickDeletableWorkspaces(
      [{ id: 'weird', name: 'No date', created_at: null }],
      [],
      'current',
      NOW,
    );
    expect(picked).toEqual([]);
  });
});

describe('findDuplicateClusters', () => {
  it('matches slugs across workspaces regardless of case, prefix and extension', () => {
    const clusters = findDuplicateClusters([
      page('a', 'concepts/HBM', '高頻寬記憶體'),
      page('b', 'concepts/hbm.md', 'HBM'),
      page('a', 'entities/tsmc.md', '台積電'),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.pages.map((p) => p.slug).sort()).toEqual(['concepts/HBM', 'concepts/hbm.md']);
  });

  it('matches identical titles under different slugs', () => {
    const clusters = findDuplicateClusters([
      page('a', 'entities/nvidia.md', '輝達'),
      page('b', 'entities/nvidia_corp.md', '輝達'),
    ]);
    expect(clusters).toHaveLength(1);
  });

  it('ignores index.md / log.md, which every workspace has', () => {
    expect(
      findDuplicateClusters([
        page('a', 'index.md', 'Index'),
        page('b', 'index.md', 'Index'),
        page('a', 'log.md', 'Log'),
        page('b', 'log.md', 'Log'),
      ]),
    ).toEqual([]);
  });
});
