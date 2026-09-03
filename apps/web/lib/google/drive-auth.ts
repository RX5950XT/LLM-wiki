import type { drive_v3 } from 'googleapis';
import { createDriveClient, getAccessToken } from '@/lib/drive/client';
import { getGoogleRefreshToken } from '@/lib/google/oauth-token';

export const GOOGLE_DRIVE_REAUTH_MESSAGE =
  'Google Drive not connected. Please sign in again.';

export class GoogleDriveAuthError extends Error {
  constructor(message = GOOGLE_DRIVE_REAUTH_MESSAGE) {
    super(message);
    this.name = 'GoogleDriveAuthError';
  }
}

export function isGoogleDriveAuthError(error: unknown): error is GoogleDriveAuthError {
  return error instanceof GoogleDriveAuthError;
}

/**
 * Google access tokens live an hour, but every request was buying a fresh one —
 * a Google round trip in front of every page read. Reuse it while it is valid.
 * Memory only: a cold instance simply exchanges again.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const TOKEN_CACHE_LIMIT = 100;

export function cachedAccessToken(
  userId: string,
  now = Date.now(),
  cache = tokenCache,
): string | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt - TOKEN_REFRESH_MARGIN_MS <= now) {
    cache.delete(userId);
    return null;
  }
  return entry.token;
}

export function rememberAccessToken(
  userId: string,
  token: string,
  expiresAt: number,
  cache = tokenCache,
): void {
  if (cache.size >= TOKEN_CACHE_LIMIT) cache.clear();
  cache.set(userId, { token, expiresAt });
}

export async function createDriveClientForUser(userId: string): Promise<drive_v3.Drive> {
  const cached = cachedAccessToken(userId);
  if (cached) return createDriveClient(cached);

  const refreshToken = await getGoogleRefreshToken(userId);
  if (!refreshToken) {
    throw new GoogleDriveAuthError();
  }

  try {
    const { token, expiresAt } = await getAccessToken(refreshToken);
    rememberAccessToken(userId, token, expiresAt);
    return createDriveClient(token);
  } catch {
    throw new GoogleDriveAuthError();
  }
}
