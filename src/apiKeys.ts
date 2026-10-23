import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'umk_';

/** 256 bits from the OS CSPRNG, base64url-encoded. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = KEY_PREFIX + randomBytes(32).toString('base64url');
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key) };
}

/**
 * Keys are high-entropy random secrets (not user-chosen passwords), so a fast unsalted SHA-256
 * is sufficient: brute force over 2^256 is infeasible, and a deterministic hash allows an indexed lookup.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
