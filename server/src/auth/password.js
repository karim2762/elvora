import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 32768, r = 8, p = 1, KEYLEN = 64;
const opts = { N, r, p, maxmem: 128 * N * r * 2 };

// Stored as scrypt$N$r$p$salt$hash so parameters can be raised later without breaking old hashes.
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, opts);
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [alg, n, rr, pp, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length,
    { N: +n, r: +rr, p: +pp, maxmem: 128 * +n * +rr * 2 });
  return crypto.timingSafeEqual(key, expected);
}

// Used when the email is unknown, so response time doesn't reveal which emails are registered.
let dummy;
export async function dummyVerify(password) {
  dummy ??= await hashPassword('elvora-dummy-password');
  await verifyPassword(password, dummy);
  return false;
}
