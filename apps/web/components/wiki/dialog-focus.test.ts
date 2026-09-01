import { describe, expect, test } from 'bun:test';
import { isSafeHttpUrl } from './dialog-focus';

describe('dialog URL safety', () => {
  test('only allows web URLs for source links', () => {
    expect(isSafeHttpUrl('https://example.com/a')).toBe(true);
    expect(isSafeHttpUrl('http://example.com')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('file:///secret')).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
  });
});
