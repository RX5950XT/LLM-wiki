import crypto from 'crypto';
import { getRequiredEnv } from '@/lib/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = getRequiredEnv('ENCRYPTION_KEY');
  const hex = /^[0-9a-fA-F]{64}$/;
  const buf = hex.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (base64 or 64-char hex)');
  return buf;
}

/**
 * Encrypts a plaintext API key.
 * Returns a hex string with \\x prefix for direct insertion into Supabase bytea columns.
 * Layout: [iv (12 bytes)] [authTag (16 bytes)] [ciphertext]
 */
export function encryptApiKey(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return '\\x' + combined.toString('hex');
}

/**
 * Decrypts an API key stored as a Supabase bytea hex string.
 * Input must be the \\x{hex} format returned by Supabase.
 */
export function decryptApiKey(hexStr: string): string {
  const raw = hexStr.startsWith('\\x') ? hexStr.slice(2) : hexStr;
  const buf = Buffer.from(raw, 'hex');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}

/** Returns a masked display string: first 4 + *** + last 4 chars. */
export function maskApiKey(plaintext: string): string {
  if (plaintext.length <= 8) return '***';
  return `${plaintext.slice(0, 4)}...${plaintext.slice(-4)}`;
}
