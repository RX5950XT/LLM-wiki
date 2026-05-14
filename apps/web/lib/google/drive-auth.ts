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

export async function createDriveClientForUser(userId: string): Promise<drive_v3.Drive> {
  const refreshToken = await getGoogleRefreshToken(userId);
  if (!refreshToken) {
    throw new GoogleDriveAuthError();
  }

  try {
    const accessToken = await getAccessToken(refreshToken);
    return createDriveClient(accessToken);
  } catch {
    throw new GoogleDriveAuthError();
  }
}
