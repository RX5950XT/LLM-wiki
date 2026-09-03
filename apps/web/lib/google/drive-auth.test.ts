import { describe, expect, it } from 'bun:test';
import { cachedAccessToken, rememberAccessToken } from './drive-auth';

describe('access token cache', () => {
  it('reuses a token that is still comfortably valid', () => {
    const cache = new Map<string, { token: string; expiresAt: number }>();
    rememberAccessToken('u1', 'tok', 1_000_000 + 3_600_000, cache);
    expect(cachedAccessToken('u1', 1_000_000, cache)).toBe('tok');
  });

  it('drops a token inside the refresh margin rather than sending a dead one', () => {
    const cache = new Map<string, { token: string; expiresAt: number }>();
    rememberAccessToken('u1', 'tok', 1_000_000 + 30_000, cache);
    expect(cachedAccessToken('u1', 1_000_000, cache)).toBeNull();
    expect(cache.has('u1')).toBe(false);
  });

  it('keeps users apart', () => {
    const cache = new Map<string, { token: string; expiresAt: number }>();
    rememberAccessToken('u1', 'tok1', 1_000_000 + 3_600_000, cache);
    expect(cachedAccessToken('u2', 1_000_000, cache)).toBeNull();
  });
});
