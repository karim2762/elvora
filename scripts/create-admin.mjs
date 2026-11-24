// Creates an administrator account, or authorizes an existing account as one. This is the ONLY way to get an admin role:
// there is no sign-up page, API route or request field for it. Run on the server, where the database lives:
//
//   npm run admin:create                                                          (asks for e-mail, name and password; password is hidden)
//   npm run admin:create -- --email you@example.com --name "Your Name"          (asks for the password, hidden)
//   npm run admin:create -- --email existing@student.com                         (promotes an existing account; its password is unchanged)
//   npm run admin:create -- --email you@example.com --revoke                     (turns an administrator back into a student)
//   npm run admin:create -- --email you@example.com --set-password               (sets a NEW password for an existing account, hidden prompt)
//   npm run admin:create -- --email you@example.com --payments                   (also gives every payment permission: verify, refund, report, configure, pricing)
//   npm run admin:create -- --email you@example.com --payments payment.review    (or just the named permission(s), comma-separated)
//   npm run admin:create -- --email you@example.com --verify-payments           (shortcut: verify/approve payments + see reports: payment.review and payment.report)
//
// When an existing account is promoted you are ALWAYS asked for a new admin password in a terminal (press Enter on an empty password only if you really want to keep the old one),
// and then asked which payment permissions to give.
//
// Passwords are never taken from the command line or the environment, so they do not end up in shell history.
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server')); // same relative DATABASE_URL / .env as the API

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
let email = String(flag('email') ?? '').trim().toLowerCase();
let name = String(flag('name') ?? '').trim();
const revoke = args.includes('--revoke');
const wantNewPassword = args.includes('--set-password');
const payIdx = args.indexOf('--payments');
const payArg = payIdx >= 0 && args[payIdx + 1] && !args[payIdx + 1].startsWith('--') ? args[payIdx + 1] : null;
const verifyPayments = args.includes('--verify-payments');
const interactive = Boolean(process.stdin.isTTY);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
if (email && !validEmail(email)) { console.error('That e-mail address is not valid.'); process.exit(1); }

// One readline interface for both prompts (works on a real terminal and with piped input). Typed characters are not echoed.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
let muted = false;
const write = rl._writeToOutput?.bind(rl);
rl._writeToOutput = (str) => { if (!muted) write?.(str); };
const lines = rl[Symbol.asyncIterator]();
async function ask(prompt) { // visible answer (e-mail, name)
  process.stdout.write(prompt);
  const { value } = await lines.next();
  return String(value ?? '').trim();
}
async function askHidden(prompt) {
  process.stdout.write(prompt); muted = true;
  const { value } = await lines.next();
  muted = false; process.stdout.write('\n');
  return value ?? '';
}

if (!email) { // no --email given: ask for it
  email = (await ask('E-mail address: ')).toLowerCase();
  if (!validEmail(email)) { console.error('That e-mail address is not valid.'); process.exit(1); }
}

await import('../server/src/db/index.js'); // opens the database and applies any pending migrations
const students = await import('../server/src/db/students.js');
const { hashPassword } = await import('../server/src/auth/password.js');
const { validatePassword } = await import('../server/src/utils/validation.js');
const { deleteSessionsForStudent } = await import('../server/src/db/sessions.js');
const { grantPermission } = await import('../server/src/db/payments.js');
const { PERMISSIONS } = await import('../server/src/services/payments.js');
const audit = await import('../server/src/db/audit.js');

const existing = students.findByEmail(email);

// Asks (hidden) for a new password twice and applies the same rules as a new administrator. Returns the hash, or exits.
async function readNewPassword() {
  const pw = await askHidden('New password (min 12 characters, letters and numbers): ');
  const problem = pw.length < 12 ? 'Use at least 12 characters for an administrator' : validatePassword(pw, { email });
  if (problem) { console.error(problem); process.exit(1); }
  if (pw !== await askHidden('Repeat password: ')) { console.error('Passwords do not match.'); process.exit(1); }
  return hashPassword(pw);
}
const yes = async (q) => /^y(es)?$/i.test(await ask(`${q} [y/N]: `));
const yesDefault = async (q) => !/^n(o)?$/i.test(await ask(`${q} [Y/n]: `)); // Enter = yes
async function setPassword(account) {
  students.setPasswordHash(account.id, await readNewPassword());
  deleteSessionsForStudent(account.id); // anyone signed in with the old password is signed out
  console.log(`Password updated for ${email}. Existing sessions were signed out.`);
}
// Payment permissions: --payments (all) or --payments payment.review,payment.refund. In a terminal, ask when the flag is absent.
async function maybeGrantPayments(account) {
  let wanted = null;
  if (verifyPayments) wanted = ['payment.review', 'payment.report'];
  else if (payIdx >= 0) wanted = payArg ? payArg.split(',').map((x) => x.trim()).filter(Boolean) : ['all'];
  else if (interactive) {
    console.log('\nPayment permissions for this administrator:');
    console.log('  1) Verify / approve payments and view reports  (payment.review, payment.report)');
    console.log('  2) Everything: verify, refunds, reports, UPI settings, pricing');
    console.log('  3) None (default)');
    const choice = (await ask('Choose 1, 2 or 3 [3]: ')).trim();
    if (choice === '1') wanted = ['payment.review', 'payment.report'];
    else if (choice === '2') wanted = ['all'];
  }
  if (!wanted) return;
  const list = wanted.includes('all') ? PERMISSIONS : wanted;
  const bad = list.filter((p) => !PERMISSIONS.includes(p));
  if (bad.length) { console.error(`Unknown permission: ${bad.join(', ')}. Choose from ${PERMISSIONS.join(', ')} or leave the name out for all.`); process.exit(1); }
  for (const p of list) {
    if (grantPermission(account.id, p, 'script')) audit.record({ admin: null, action: 'permission.grant', targetType: 'admin', targetId: account.id, reason: `${p} granted to ${email} (admin:create script)`, actorName: 'Permission script' });
  }
  console.log(`Payment permissions for ${email}: ${list.join(', ')}.`);
}
if (revoke) {
  if (!existing || existing.role !== 'admin') { console.error('That account is not an administrator.'); process.exit(1); }
  if (students.countAdmins() <= 1) { console.error('Refusing to remove the last administrator.'); process.exit(1); }
  students.setRole(existing.id, 'student');
  console.log(`${email} is a student again.`); process.exit(0);
}
if (existing) {
  if (existing.role === 'admin') {
    console.log(`${email} is already an administrator.`);
    if (wantNewPassword || (interactive && payIdx < 0 && !verifyPayments && await yes('Set a new password for this administrator?'))) await setPassword(existing);
    await maybeGrantPayments(existing);
    process.exit(0);
  }
  students.setRole(existing.id, 'admin');
  console.log(`${existing.fullName} <${email}> is now an administrator.`);
  // Promoting keeps the old student password unless you choose a new one now (recommended: an admin password should be 12+ characters and not reused).
  // An admin account should have its own strong password, so a terminal ALWAYS asks (Enter = yes). Without a terminal the old password is kept unless --set-password is given.
  if (wantNewPassword || (interactive && await yesDefault('Set a new admin password for this account now? (recommended; No keeps the current student password)'))) await setPassword(existing);
  else console.log('Password unchanged. Run again with --set-password to change it.');
  await maybeGrantPayments(existing);
  process.exit(0);
}
if (!name) name = await ask('Full name: ');
if (!name) { console.error('A new administrator needs a full name.'); process.exit(1); }
const pw = await askHidden('Password (min 12 characters, letters and numbers): ');
const problem = pw.length < 12 ? 'Use at least 12 characters for an administrator' : validatePassword(pw, { email });
if (problem) { console.error(problem); process.exit(1); }
if (pw !== await askHidden('Repeat password: ')) { console.error('Passwords do not match.'); process.exit(1); }
const created = students.createStudent({
  fullName: name, email, phone: '0000000000', passwordHash: await hashPassword(pw), college: 'ELVORA', degree: 'Administrator',
  branch: 'Administration', academicYear: 'N/A', graduationYear: new Date().getFullYear(), skills: [],
});
students.setRole(created.id, 'admin');
console.log(`Administrator created: ${name} <${email}>. Sign in at /admin/login.`);
await maybeGrantPayments(created);
process.exit(0);
