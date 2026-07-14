import { describe, expect, it } from 'bun:test';
import { canonicalWikiAlias, normalizeWikiSlug, parseWikiLink } from './slug';

describe('parseWikiLink', () => {
  it('keeps a plain target as both slug and label', () => {
    expect(parseWikiLink('entities/donald-trump')).toEqual({
      slug: 'entities/donald-trump',
      label: 'entities/donald-trump',
      anchor: '',
    });
  });

  it('drops the display text from the slug', () => {
    expect(parseWikiLink('entities/donald-trump|Donald Trump')).toEqual({
      slug: 'entities/donald-trump',
      label: 'Donald Trump',
      anchor: '',
    });
  });

  it('splits the anchor off the slug', () => {
    expect(parseWikiLink('concepts/rag#history|檢索增強')).toEqual({
      slug: 'concepts/rag',
      label: '檢索增強',
      anchor: 'history',
    });
  });
});

describe('slug helpers still resolve the display form', () => {
  it('normalizes the slug half to .md', () => {
    expect(normalizeWikiSlug(parseWikiLink('entities/foo|Foo (2026)').slug)).toBe('entities/foo.md');
  });

  it('aliases the slug half, not the label', () => {
    expect(canonicalWikiAlias(parseWikiLink('entities/scott-bessent|Scott Bessent (斯科特)').slug))
      .toBe(canonicalWikiAlias('entities/Scott_Bessent.md'));
  });
});
