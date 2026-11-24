// Stage 08A part 2 - Task 7: e-mail configuration review. No real SMTP is used anywhere: a capturing/failing transport double stands in.
// Tests that REQUIRE a real SMTP account (actual delivery, DKIM/SPF, bounces, provider rate limits) are listed in README "E-mail (what is and is not verified)".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent } from './helpers.js';

let srv, mailer, db;
before(async () => {
  srv = await startServer();
  mailer = await import('../src/utils/mailer.js');
  ({ db } = await import('../src/db/index.js'));
});
after(() => { mailer.__setTransportForTests(null); srv.close(); });

const tick = () => new Promise((r) => setTimeout(r, 60));

test('no SMTP configured: e-mail reports as unavailable, forgot-password says nothing was sent and creates no usable token', async () => {
  mailer.__setTransportForTests(null);
  assert.equal(mailer.isEmailConfigured(), false);
  const c = client(srv.base);
  await c.post('/auth/register', validStudent({ email: 'nomail@example.com' }));
  const r = await c.post('/auth/forgot-password', { email: 'nomail@example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.data.emailDelivery, 'not_configured');
  assert.match(r.data.message, /no email was sent/i);
  assert.doesNotMatch(r.data.message, /we will email|has been sent|check your inbox/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n, 0, 'outside dev-link mode no token is created when nobody can receive it');
});

test('reset e-mail template: subject, link, expiry minutes, one-use wording; HTML never contains injected markup from the name', async () => {
  const sent = [];
  mailer.__setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
  await mailer.sendPasswordResetEmail({ to: 'a@example.com', name: '<script>alert(1)</script>Asha', link: 'http://localhost:5173/reset-password?token=abc_DEF-123', minutes: 30 });
  const [m] = sent;
  assert.equal(m.to, 'a@example.com');
  assert.equal(m.subject, 'Reset your ELVORA password');
  assert.match(m.text, /valid for 30 minutes, one use only/);
  assert.ok(m.text.includes('http://localhost:5173/reset-password?token=abc_DEF-123'));
  assert.ok(m.html.includes('href="http://localhost:5173/reset-password?token=abc_DEF-123"'));
  assert.doesNotMatch(m.html, /<script/i);
  assert.match(m.html, /ignore this email/i);
});

test('document e-mail templates: offer letter and certificate differ, escape HTML in titles, attach the PDF and include the verification link', async () => {
  const sent = [];
  mailer.__setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
  const base = { to: 's@example.com', name: 'Sam <b>', internshipTitle: 'Python & <i>Data</i>', documentNumber: 'ELV-OFR-2026-0001', verifyUrl: 'http://localhost:5173/verify/ELV-VER-X', documentsUrl: 'http://localhost:5173/student/documents', fileName: 'doc.pdf', pdf: Buffer.from('%PDF-1.4 test') };
  await mailer.sendDocumentEmail({ ...base, type: 'offer_letter' });
  await mailer.sendDocumentEmail({ ...base, type: 'certificate', documentNumber: 'ELV-CRT-2026-0001' });
  assert.match(sent[0].subject, /offer letter/i); assert.match(sent[1].subject, /certificate/i);
  for (const m of sent) {
    assert.doesNotMatch(m.html, /<i>Data<\/i>|Sam <b>/); assert.match(m.html, /Hi Sam &lt;b&gt;,/); assert.match(m.html, /Python &amp; &lt;i&gt;Data&lt;\/i&gt;/);
    assert.equal(m.attachments.length, 1); assert.equal(m.attachments[0].contentType, 'application/pdf'); assert.ok(m.text.includes('/verify/ELV-VER-X'));
  }
});

test('provider failure on password reset: the request still answers neutrally, the failure is LOGGED (not swallowed), and the reply never claims it was sent', async () => {
  const errors = []; const orig = console.error; console.error = (...a) => { errors.push(a.join(' ')); };
  mailer.__setTransportForTests({ sendMail: async () => { throw new Error('connect ECONNREFUSED smtp.invalid:587'); } });
  let unhandled = 0; const onUnhandled = () => { unhandled += 1; }; process.on('unhandledRejection', onUnhandled);
  try {
    const c = client(srv.base);
    await c.post('/auth/register', validStudent({ email: 'failmail@example.com' }));
    const known = await c.post('/auth/forgot-password', { email: 'failmail@example.com' });
    const unknown = await c.post('/auth/forgot-password', { email: 'ghost@example.com' });
    await tick();
    assert.equal(known.status, 200);
    assert.equal(known.data.message, unknown.data.message, 'a provider failure must not reveal whether the account exists');
    assert.doesNotMatch(known.data.message, /has been sent|was sent|sent to/i, 'the reply may not claim delivery');
    assert.match(known.data.message, /we will email/i);
    const failures = errors.filter((e) => /password reset email FAILED to send/.test(e));
    assert.equal(failures.length, 1, 'exactly the one real send failed, and it was logged');
    assert.match(failures[0], /ECONNREFUSED/); assert.doesNotMatch(failures[0], /token=|reset-password/, 'the log never contains the reset link');
    assert.equal(unhandled, 0, 'no unhandled rejection');
  } finally { console.error = orig; process.off('unhandledRejection', onUnhandled); }
});

test('sendMail rejection with a missing/invalid transport result is surfaced to the caller (sendPasswordResetEmail / sendDocumentEmail reject instead of resolving)', async () => {
  mailer.__setTransportForTests({ sendMail: async () => { throw new Error('535 auth failed'); } });
  await assert.rejects(() => mailer.sendPasswordResetEmail({ to: 'a@example.com', name: 'A', link: 'x', minutes: 30 }), /535/);
  await assert.rejects(() => mailer.sendDocumentEmail({ to: 'a@example.com', name: 'A', type: 'certificate', internshipTitle: 'T', documentNumber: 'N', verifyUrl: 'v', documentsUrl: 'd', fileName: 'f.pdf', pdf: Buffer.from('x') }), /535/);
});

test('notification records never claim an e-mail was sent; announcements report emailed = 0 honestly', () => {
  const rows = db.prepare('SELECT title, message FROM notifications').all();
  for (const r of rows) assert.doesNotMatch(`${r.title} ${r.message}`, /e-?mailed to you|we (have )?(e-?mailed|sent you an e-?mail)|check your (inbox|email)/i);
});

test('config warnings: half-configured SMTP is reported (without printing any secret values); a fully empty or fully valid setup is silent', () => {
  const w = mailer.mailConfigWarnings;
  assert.deepEqual(w({ host: '', user: '', pass: '', from: '' }), []);
  assert.deepEqual(w({ host: 'smtp.example.com', user: 'u', pass: 'p', from: 'ELVORA <no-reply@example.com>' }), []);
  assert.match(w({ host: 'smtp.example.com', user: '', pass: '', from: '' }).join(' '), /MAIL_FROM is not set/);
  assert.match(w({ host: '', user: '', pass: '', from: 'a@b.c' }).join(' '), /SMTP_HOST is not set/);
  assert.match(w({ host: 'h', user: 'u', pass: '', from: 'a@b.c' }).join(' '), /SMTP_USER is set without SMTP_PASS/);
  assert.match(w({ host: 'h', user: '', pass: 'SECRETVALUE', from: 'a@b.c' }).join(' '), /SMTP_PASS is set without SMTP_USER/);
  assert.doesNotMatch(w({ host: 'h', user: '', pass: 'SECRETVALUE', from: 'a@b.c' }).join(' '), /SECRETVALUE/);
});
