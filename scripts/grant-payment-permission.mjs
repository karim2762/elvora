// Usage: node scripts/grant-payment-permission.mjs <adminEmail> <pricing.manage|payment.configure|payment.review|payment.refund|payment.report|all>
// Grants an existing administrator account a payment permission (stored in admin_permissions). Alternative: list e-mails in PAYMENT_ADMIN_EMAILS.
import 'dotenv/config';
const { db } = await import('../server/src/db/index.js');
const { grantPermission } = await import('../server/src/db/payments.js');
const { PERMISSIONS } = await import('../server/src/services/payments.js');
const audit = await import('../server/src/db/audit.js');
const [email, perm] = process.argv.slice(2);
const a = email && db.prepare("SELECT id FROM students WHERE lower(email) = lower(?) AND role = 'admin'").get(email);
if (!a || !(perm === 'all' || PERMISSIONS.includes(perm))) { console.error('Usage: grant-payment-permission.mjs <adminEmail> <' + PERMISSIONS.join('|') + '|all>  (the account must already be an administrator)'); process.exit(1); }
for (const p of perm === 'all' ? PERMISSIONS : [perm]) {
  // Stage 10C Part 2: every permission change is audited (the script has no signed-in administrator, so it is recorded as the permission script).
  if (grantPermission(a.id, p, 'script')) audit.record({ admin: null, action: 'permission.grant', targetType: 'admin', targetId: a.id, reason: `${p} granted to ${email} (script)`, actorName: 'Permission script' });
}
console.log(`Granted ${perm} to ${email}.`);
