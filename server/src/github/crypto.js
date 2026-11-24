import crypto from 'node:crypto';
import { config } from '../config/index.js';

// Stage 09C — AES-256-GCM for the few GitHub secrets ELVORA must keep (user tokens, PKCE verifiers). The key is derived with HKDF from
// GITHUB_TOKEN_ENCRYPTION_KEY, or from SESSION_SECRET when that is not set, so no extra secret is mandatory. Format: v1.<iv>.<tag>.<ciphertext>.
const key = () => Buffer.from(crypto.hkdfSync('sha256', config.github.tokenKey || config.sessionSecret, 'elevora-github-token-salt', 'elevora-github-token-v1', 32));
const b64 = (b) => Buffer.from(b).toString('base64url');

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
}
// Returns null (never throws, never echoes input) when the value is missing, tampered with or encrypted under another key.
export function decrypt(blob) {
  try {
    const [v, iv, tag, ct] = String(blob ?? '').split('.');
    if (v !== 'v1' || !iv || !tag || !ct) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}
export const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');
