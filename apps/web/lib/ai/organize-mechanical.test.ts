import { describe, expect, it } from 'bun:test';
import {
  buildSeedIndexMarkdown,
  findDeadLinks,
  findPagesMissingFromIndex,
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

  // The maintenance run created it and then never filled it — the grace period is
  // there for the import router's freshly created workspace, not for this.
  it('deletes an empty workspace this run created itself', () => {
    const picked = pickDeletableWorkspaces([fresh], [], 'current', NOW, new Set(['fresh']));
    expect(picked.map((w) => w.id)).toEqual(['fresh']);
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

describe('findDeadLinks', () => {
  const pages: InventoryRow[] = [
    { workspace_id: 'ai', slug: 'concepts/agentic_ai.md', title: 'Agentic AI', kind: 'concept' },
    { workspace_id: 'chips', slug: 'summaries/dram-crisis.md', title: 'DRAM 市場危機', kind: 'summary' },
  ];

  it('accepts a link written with the page title (the page API resolves it)', () => {
    const dead = findDeadLinks(
      [{ workspace_id: 'chips', from_slug: 'entities/tsmc.md', to_slug: 'DRAM 市場危機' }],
      pages,
    );
    expect(dead).toEqual([]);
  });

  it('flags a link whose page was re-shelved into another workspace', () => {
    const dead = findDeadLinks(
      [{ workspace_id: 'chips', from_slug: 'entities/tsmc.md', to_slug: 'concepts/agentic-ai' }],
      pages,
    );
    expect(dead).toHaveLength(1);
    expect(dead[0]!.lives_in_workspace_id).toBe('ai');
  });

  it('flags a link to a page nobody ever wrote', () => {
    const dead = findDeadLinks(
      [{ workspace_id: 'ai', from_slug: 'index.md', to_slug: 'concepts/never-written' }],
      pages,
    );
    expect(dead).toHaveLength(1);
    expect(dead[0]!.lives_in_workspace_id).toBeUndefined();
  });
});

describe('findPagesMissingFromIndex', () => {
  it('lists the pages index.md never links to', () => {
    const pages: InventoryRow[] = [
      { workspace_id: 'ai', slug: 'index.md', title: 'Index', kind: 'index' },
      { workspace_id: 'ai', slug: 'concepts/listed.md', title: 'Listed', kind: 'concept' },
      { workspace_id: 'ai', slug: 'concepts/orphan.md', title: 'Orphan', kind: 'concept' },
    ];
    const links = [{ workspace_id: 'ai', from_slug: 'index.md', to_slug: 'concepts/listed' }];
    expect(findPagesMissingFromIndex('ai', pages, links)).toEqual(['concepts/orphan.md']);
  });
});

describe('buildSeedIndexMarkdown', () => {
  const pages: InventoryRow[] = [
    { workspace_id: 'w1', slug: 'index.md', title: 'Wiki 索引', kind: 'index' },
    { workspace_id: 'w1', slug: 'log.md', title: '更新日誌', kind: 'log' },
    { workspace_id: 'w1', slug: 'entities/nasa.md', title: '國家航空暨太空總署 (NASA)', kind: 'entity' },
    { workspace_id: 'w1', slug: 'concepts/uap.md', title: '不明異常現象 (UAP)', kind: 'concept' },
  ];

  it('lists the workspace pages as wikilinks, grouped by kind', () => {
    const md = buildSeedIndexMarkdown('UAP 與國家安全', pages, 'zh-TW');
    expect(md).toContain('# UAP 與國家安全');
    expect(md).toContain('## 實體');
    expect(md).toContain('[[entities/nasa.md|國家航空暨太空總署 (NASA)]]');
    expect(md).toContain('[[concepts/uap.md|不明異常現象 (UAP)]]');
  });

  // index.md/log.md are scaffolding — an index that links to itself is noise.
  it('leaves the scaffolding pages out', () => {
    const md = buildSeedIndexMarkdown('UAP 與國家安全', pages, 'zh-TW');
    expect(md).not.toContain('[[index.md');
    expect(md).not.toContain('[[log.md');
  });
});
