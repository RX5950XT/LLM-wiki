import { describe, expect, it } from 'bun:test';
import {
  hasSuspiciousShortening,
  markdownBody,
  mergePageFrontmatter,
  parseFrontmatter,
} from './frontmatter-merge';

describe('mergePageFrontmatter', () => {
  it('unions protected lists and keeps unknown old blocks', () => {
    const current = `---
title: "Existing"
sources: [old-source]
tags: [one, shared]
related: [concepts/old.md]
reviewed_by: "human"
custom:
  - keep-this
---
Existing body.`;
    const proposed = `---
title: "Updated"
sources: [new-source, shared]
tags: [shared, two]
related: [concepts/new.md]
---
Updated body.`;

    const result = mergePageFrontmatter(current, proposed, 'ingest-source');

    expect(result.content).toContain('sources: ["old-source", "new-source", "shared", "ingest-source"]');
    expect(result.content).toContain('tags: ["one", "shared", "two"]');
    expect(result.content).toContain('related: ["concepts/old.md", "concepts/new.md"]');
    expect(result.content).toContain('reviewed_by: "human"');
    expect(result.content).toContain('custom:\n  - keep-this');
    expect(result.frontmatter).toMatchObject({
      title: 'Updated',
      sources: ['old-source', 'new-source', 'shared', 'ingest-source'],
      tags: ['one', 'shared', 'two'],
      related: ['concepts/old.md', 'concepts/new.md'],
      reviewed_by: 'human',
    });
  });

  it('adds a source list when both documents omit frontmatter', () => {
    const result = mergePageFrontmatter('Old body.', 'New body.', 'source-1');
    expect(result.content).toBe('---\nsources: ["source-1"]\n---\nNew body.');
    expect(result.frontmatter).toEqual({ sources: ['source-1'] });
    expect(result.hasFrontmatter).toBe(true);
  });

  it('preserves a proposed body without discarding old metadata', () => {
    const result = mergePageFrontmatter(
      '---\nlegacy_flag: true\n---\nOld body.',
      'New body.',
    );
    expect(result.content).toBe('---\nlegacy_flag: true\n---\nNew body.');
    expect(result.body).toBe('New body.');
  });
});

describe('frontmatter parsing and truncation check', () => {
  it('strips the frontmatter before comparing body length', () => {
    const longBody = 'x'.repeat(500);
    expect(markdownBody(`---\ntitle: Old\n---\n${longBody}`)).toBe(longBody);
    expect(hasSuspiciousShortening(`---\ntitle: Old\n---\n${longBody}`, '---\ntitle: New\n---\nshort')).toBe(true);
    expect(hasSuspiciousShortening(`---\ntitle: Old\n---\n${longBody}`, `---\ntitle: New\n---\n${'x'.repeat(350)}`)).toBe(false);
  });

  it('reads list blocks and keeps scalar types', () => {
    expect(parseFrontmatter('---\ncount: 2\nactive: true\ntags:\n  - one\n  - two\n---\nBody')).toEqual({
      frontmatter: { count: 2, active: true, tags: ['one', 'two'] },
      body: 'Body',
      hasFrontmatter: true,
    });
  });
});
