// Prints a fresh random admin key. Put it in .env as ADMIN_API_KEY=<key> and restart the server.
import crypto from 'node:crypto';
console.log(crypto.randomBytes(32).toString('hex'));
