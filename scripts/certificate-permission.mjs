// Usage: node scripts/certificate-permission.mjs <grant|revoke|list> [<adminEmail>] --by <superAdminEmail>
//
// Grants, revokes or lists the 'certificate.correct' permission (create / review / approve certificate corrections).
//   * Only a SUPER ADMINISTRATOR may change it: --by must be an existing administrator account whose e-mail is listed in SUPER_ADMIN_EMAILS.
//     With SUPER_ADMIN_EMAILS empty this script refuses to change anything.
//   * There is deliberately no HTTP route for this: changing the permission needs shell access to the server plus a super administrator's e-mail.
//   * Every change is written to the audit log (permission.grant / permission.revoke) in the super administrator's name.
//   * Separation of duties is enforced by the service, not here: an administrator who creates a correction can never approve it, so a correction needs
//     at least TWO administrators holding this permission. Revoking the second-to-last holder leaves corrections pending, which is the safe failure.
import 'dotenv/config';
const { db } = await import('../server/src/db/index.js');
const { config } = await import('../server/src/config/index.js');
const { grantPermission, revokePermission, permissionHolders } = await import('../server/src/db/payments.js');
const audit = await import('../server/src/db/audit.js');

const PERM = 'certificate.correct';
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const by = flag('--by');
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--by');
const [action, targetEmail] = positional;
const usage = () => { console.error('Usage: node scripts/certificate-permission.mjs <grant|revoke|list> [<adminEmail>] --by <superAdminEmail>'); process.exit(1); };

if (!['grant', 'revoke', 'list'].includes(action) || !by || (action !== 'list' && !targetEmail)) usage();
const adminByEmail = (e) => db.prepare("SELECT id, email, full_name AS fullName FROM students WHERE lower(email) = lower(?) AND role = 'admin'").get(e);

if (!config.superAdminEmails.length) { console.error('SUPER_ADMIN_EMAILS is empty. List at least one super administrator e-mail in the environment before changing this permission.'); process.exit(1); }
const grantor = adminByEmail(by);
if (!grantor || !config.superAdminEmails.includes(String(grantor.email).toLowerCase())) {
  try { audit.record({ admin: null, action: 'admin.access_denied', targetType: 'permission', targetId: PERM, result: 'failure', reason: 'permission change refused: caller is not a super administrator', actorName: 'Permission script' }); } catch { /* ignore */ }
  console.error(`${by} is not a super administrator (an existing administrator account listed in SUPER_ADMIN_EMAILS).`); process.exit(1);
}
const actor = { via: 'session', id: grantor.id, fullName: grantor.fullName };

if (action === 'list') {
  const rows = permissionHolders(PERM);
  console.log(rows.length ? `Holders of ${PERM}:\n` + rows.map((r) => ` - ${r.email}`).join('\n') : `Nobody holds ${PERM}.`);
  process.exit(0);
}
const target = adminByEmail(targetEmail);
if (!target) { console.error(`${targetEmail} is not an administrator account.`); process.exit(1); }
if (action === 'grant') {
  const changed = grantPermission(target.id, PERM, `super admin ${grantor.email}`);
  if (changed) audit.record({ admin: actor, action: 'permission.grant', targetType: 'admin', targetId: target.id, reason: `${PERM} granted to ${target.email}` });
  console.log(changed ? `Granted ${PERM} to ${target.email}.` : `${target.email} already holds ${PERM}.`);
} else {
  const changed = revokePermission(target.id, PERM);
  if (changed) audit.record({ admin: actor, action: 'permission.revoke', targetType: 'admin', targetId: target.id, reason: `${PERM} revoked from ${target.email}` });
  const left = permissionHolders(PERM).length;
  console.log(changed ? `Revoked ${PERM} from ${target.email}.` : `${target.email} did not hold ${PERM}.`);
  if (left < 2) console.warn(`Warning: ${left} administrator(s) now hold ${PERM}. Corrections need two different people (one creates, another approves), so they will stay pending.`);
}
