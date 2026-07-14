import { describe, expect, it } from 'bun:test';
import { pickAliasMatch } from './resolve';

const PAGES = [
  { slug: 'summaries/dram-market-2026-crisis.md', title: 'DRAM 市場 2026 年供需危機' },
  { slug: 'concepts/agentic_ai_transformation.md', title: 'Agentic AI 轉型' },
  { slug: 'entities/he-limei.md', title: '何麗梅 (Lora Ho)' },
];

describe('pickAliasMatch', () => {
  it('matches a slug written without folder, case or extension', () => {
    expect(pickAliasMatch(PAGES, 'Agentic_AI_Transformation.md')?.slug).toBe(
      'concepts/agentic_ai_transformation.md',
    );
  });

  // 37 production links were written as the page's TITLE, not its slug. The old
  // resolver only compared slugs, so every one of them rendered as a dead link.
  it('matches a link written with the page title', () => {
    expect(pickAliasMatch(PAGES, 'DRAM 市場 2026 年供需危機')?.slug).toBe(
      'summaries/dram-market-2026-crisis.md',
    );
  });

  it('matches a title whose page slug looks nothing like it', () => {
    expect(pickAliasMatch(PAGES, '何麗梅 (Lora Ho)')?.slug).toBe('entities/he-limei.md');
  });

  it('leaves a colliding basename unresolved rather than guessing', () => {
    const colliding = [
      { slug: 'concepts/dram.md', title: 'DRAM' },
      { slug: 'entities/dram.md', title: 'DRAM Inc' },
    ];
    expect(pickAliasMatch(colliding, 'dram')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(pickAliasMatch(PAGES, 'concepts/does-not-exist')).toBeNull();
  });
});
