import { expect, it } from 'bun:test';
import { buildSynthesisSlug } from './route';

it('creates unique legal slugs for non-ASCII questions', () => {
  const now = new Date('2026-08-31T12:00:00.000Z');
  const first = buildSynthesisSlug('中文問題', now);
  const second = buildSynthesisSlug('中文問題', now);
  const pattern = /^synthesis\/2026-08-31-1200-query-[0-9a-f]{12}\.md$/;

  expect(first).toMatch(pattern);
  expect(second).toMatch(pattern);
  expect(second).not.toBe(first);
});
