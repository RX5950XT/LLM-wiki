export type DriveReadErrorCode =
  | 'DRIVE_RECONNECT_REQUIRED'
  | 'DRIVE_PERMISSION_DENIED'
  | 'DRIVE_FILE_NOT_FOUND'
  | 'DRIVE_FILE_TRASHED'
  | 'DRIVE_RATE_LIMITED'
  | 'UNSUPPORTED_MIME_TYPE'
  | 'EMPTY_DRIVE_RESPONSE';

export class DriveReadError extends Error {
  constructor(
    public readonly code: DriveReadErrorCode,
    public readonly statusCode: number,
    public readonly publicMessage: string,
    public readonly publicMeta: Record<string, unknown> = {},
    public readonly logMeta: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${publicMessage}`);
    this.name = 'DriveReadError';
  }
}
