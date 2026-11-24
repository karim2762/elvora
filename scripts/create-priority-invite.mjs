// Usage: node scripts/create-priority-invite.mjs [studentEmail] [days]
// Prints a one-time private link. Only a hash of the token is stored; the link can't be shown again.
import 'dotenv/config';
const { db } = await import('../server/src/db/index.js');
const { createInvitation } = await import('../server/src/services/priorityCertificate.js');
const [email, days] = process.argv.slice(2);
let studentId = null;
if (email) { const r = db.prepare('SELECT id FROM students WHERE lower(email) = lower(?)').get(email); if (!r) { console.error('No student with that email.'); process.exit(1); } studentId = r.id; }
const inv = createInvitation({ studentId, expiresInDays: Number(days) || 14 });
console.log(`Invitation ${inv.id} (expires ${inv.expiresAt})\n${(process.env.CLIENT_URL || 'http://localhost:5173')}/priority-certificate#invite=${inv.token}`);
