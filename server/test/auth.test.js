import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent } from './helpers.js';

let srv, mailer, sent = [];
before(async () => {
  srv = await startServer();
  mailer = await import('../src/utils/mailer.js');
});
after(() => srv.close());

test('register: success, no secrets in response, session cookie is httpOnly', async () => {
  const c = client(srv.base);
  const r = await c.post('/auth/register', validStudent());
  assert.equal(r.status, 201);
  assert.equal(r.data.user.email, 'asha@example.com');
  assert.equal(r.data.user.phone, '9876543210');
  assert.ok(!JSON.stringify(r.data).match(/password|hash|token/i));
  assert.match(r.setCookie[0], /HttpOnly/i);
  assert.match(r.setCookie[0], /SameSite=Lax/i);
  const me = await c.get('/auth/me');
  assert.equal(me.data.user.fullName, 'Asha Verma');
  assert.equal(me.data.user.profileCompletion.percent, 82); // 9 of 11 (skills filled, github/linkedin empty)
});

test('register: duplicate email rejected (case-insensitive)', async () => {
  const r = await client(srv.base).post('/auth/register', validStudent({ email: 'ASHA@Example.com' }));
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'EMAIL_TAKEN');
});

test('register: invalid submissions return field errors', async () => {
  const c = client(srv.base);
  const empty = await c.post('/auth/register', {});
  assert.equal(empty.status, 400);
  for (const f of ['fullName', 'email', 'phone', 'password', 'college', 'degree', 'branch', 'academicYear', 'graduationYear']) assert.ok(empty.data.error.fields[f], f);
  const bad = await c.post('/auth/register', validStudent({ email: 'nope', phone: '12345', password: 'short', confirmPassword: 'x', degree: 'Wizardry', graduationYear: 1999, github: 'https://evil.com/x', linkedin: 'linkedin.com/company/x' }));
  assert.equal(bad.status, 400);
  const f = bad.data.error.fields;
  assert.ok(f.email && f.phone && f.password && f.confirmPassword && f.degree && f.graduationYear && f.github && f.linkedin);
  assert.equal((await c.post('/auth/register', validStudent({ email: 'p@example.com', password: 'abcdefgh', confirmPassword: 'abcdefgh' }))).status, 400); // no digit
  assert.equal((await c.post('/auth/register', validStudent({ email: 'q@example.com', phone: '5876543210' }))).status, 400); // must start 6-9
});

test('register: accepts phone formats, normalizes github/linkedin, ignores smuggled fields', async () => {
  const c = client(srv.base);
  const r = await c.post('/auth/register', validStudent({ email: 'raj@example.com', phone: '09123456789', github: 'github.com/rajdev', linkedin: 'linkedin.com/in/raj-dev', id: 'x', passwordHash: 'y', isAdmin: true }));
  assert.equal(r.status, 201);
  assert.equal(r.data.user.github, 'https://github.com/rajdev');
  assert.equal(r.data.user.linkedin, 'https://www.linkedin.com/in/raj-dev');
  assert.notEqual(r.data.user.id, 'x');
  assert.equal(r.data.user.profileCompletion.percent, 100);
});

test('login: success, wrong password, unknown email give the same generic error', async () => {
  const c = client(srv.base);
  const ok = await c.post('/auth/login', { email: 'asha@example.com', password: 'Str0ng!Pass1' });
  assert.equal(ok.status, 200);
  assert.ok(!/Max-Age|Expires/i.test(ok.setCookie[0]), 'session cookie when remember=false');
  const rem = await client(srv.base).post('/auth/login', { email: 'asha@example.com', password: 'Str0ng!Pass1', remember: true });
  assert.match(rem.setCookie[0], /Max-Age=/i);
  const bad = await client(srv.base).post('/auth/login', { email: 'asha@example.com', password: 'wrong-pass1' });
  const unk = await client(srv.base).post('/auth/login', { email: 'ghost@example.com', password: 'wrong-pass1' });
  assert.equal(bad.status, 401); assert.equal(unk.status, 401);
  assert.equal(bad.data.error.message, unk.data.error.message);
  assert.equal((await client(srv.base).post('/auth/login', {})).status, 400);
});

test('logout invalidates the session server-side', async () => {
  const c = client(srv.base);
  await c.post('/auth/login', { email: 'asha@example.com', password: 'Str0ng!Pass1' });
  assert.ok((await c.get('/auth/me')).data.user);
  // capture the cookie to replay after logout
  const replay = client(srv.base);
  const login = await replay.post('/auth/login', { email: 'asha@example.com', password: 'Str0ng!Pass1' });
  const stolen = login.setCookie[0].split(';')[0];
  assert.equal((await replay.post('/auth/logout')).status, 204);
  assert.equal((await replay.get('/auth/me')).data.user, null);
  const res = await fetch(`${srv.base}/students/me`, { headers: { cookie: stolen } });
  assert.equal(res.status, 401);
});

test('private routes require authentication', async () => {
  const c = client(srv.base);
  assert.equal((await c.get('/students/me')).status, 401);
  assert.equal((await c.put('/students/me', validStudent())).status, 401);
  assert.equal((await c.get('/auth/me')).data.user, null);
});

test('profile: read, edit, validation, isolation, email/password cannot be changed', async () => {
  const a = client(srv.base); const b = client(srv.base);
  await a.post('/auth/login', { email: 'asha@example.com', password: 'Str0ng!Pass1' });
  await b.post('/auth/login', { email: 'raj@example.com', password: 'Str0ng!Pass1' });
  const upd = await a.put('/students/me', { ...validStudent(), college: 'NIT Trichy', skills: 'Go, Rust, go', github: 'github.com/asha-v', email: 'hacker@example.com', passwordHash: 'x' });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.user.college, 'NIT Trichy');
  assert.deepEqual(upd.data.user.skills, ['Go', 'Rust']);
  assert.equal(upd.data.user.email, 'asha@example.com');
  assert.equal((await b.get('/students/me')).data.user.college, 'IIT Madras'); // other student untouched
  assert.equal((await a.get('/students/me')).data.user.college, 'NIT Trichy');
  const bad = await a.put('/students/me', { ...validStudent(), fullName: '', phone: '123' });
  assert.equal(bad.status, 400); assert.ok(bad.data.error.fields.fullName && bad.data.error.fields.phone);
  assert.equal((await a.post('/auth/login', { email: 'hacker@example.com', password: 'x' })).status, 401);
});

test('CSRF: cross-origin writes are blocked', async () => {
  const r = await fetch(`${srv.base}/auth/logout`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('forgot password: honest when email is not configured, no token created in test env', async () => {
  const r = await client(srv.base).post('/auth/forgot-password', { email: 'asha@example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.data.emailDelivery, 'not_configured');
  assert.match(r.data.message, /no email was sent/i);
  assert.ok(!JSON.stringify(r.data).match(/token|reset-password/i));
  assert.equal((await client(srv.base).post('/auth/forgot-password', { email: 'bad' })).status, 400);
});

test('password reset: single-use token, expiry, sessions revoked, old password dead', async () => {
  mailer.__setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
  const c = client(srv.base);
  const known = await c.post('/auth/forgot-password', { email: 'raj@example.com' });
  const unknown = await c.post('/auth/forgot-password', { email: 'nobody@example.com' });
  assert.equal(known.data.message, unknown.data.message); // no account enumeration
  assert.equal(known.data.emailDelivery, 'enabled');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'raj@example.com');
  const token = /token=([\w-]+)/.exec(sent[0].text)[1];

  const active = client(srv.base);
  await active.post('/auth/login', { email: 'raj@example.com', password: 'Str0ng!Pass1' });
  assert.equal((await c.post('/auth/reset-password', { token, password: 'weak', confirmPassword: 'weak' })).status, 400);
  assert.equal((await c.post('/auth/reset-password', { token, password: 'N3wPassw0rd', confirmPassword: 'N3wPassw0rd' })).status, 200);
  assert.equal((await c.post('/auth/reset-password', { token, password: 'An0therPass1', confirmPassword: 'An0therPass1' })).status, 400); // reused
  assert.equal((await active.get('/auth/me')).data.user, null); // old session revoked
  assert.equal((await client(srv.base).post('/auth/login', { email: 'raj@example.com', password: 'Str0ng!Pass1' })).status, 401);
  assert.equal((await client(srv.base).post('/auth/login', { email: 'raj@example.com', password: 'N3wPassw0rd' })).status, 200);

  // expired token
  sent = [];
  await c.post('/auth/forgot-password', { email: 'raj@example.com' });
  await new Promise((r) => setTimeout(r, 50));
  const t2 = /token=([\w-]+)/.exec(sent[0].text)[1];
  const { db } = await import('../src/db/index.js');
  db.prepare('UPDATE password_resets SET expires_at = ?').run(Date.now() - 1000);
  assert.equal((await c.post('/auth/reset-password', { token: t2, password: 'N3wPassw0rd2', confirmPassword: 'N3wPassw0rd2' })).status, 400);
  // a newer request invalidates the previous token
  sent = [];
  await c.post('/auth/forgot-password', { email: 'raj@example.com' }); await new Promise((r) => setTimeout(r, 50));
  await c.post('/auth/forgot-password', { email: 'raj@example.com' }); await new Promise((r) => setTimeout(r, 50));
  const [first, second] = sent.map((m) => /token=([\w-]+)/.exec(m.text)[1]);
  assert.equal((await c.post('/auth/reset-password', { token: first, password: 'N3wPassw0rd3', confirmPassword: 'N3wPassw0rd3' })).status, 400);
  assert.equal((await c.post('/auth/reset-password', { token: second, password: 'N3wPassw0rd3', confirmPassword: 'N3wPassw0rd3' })).status, 200);
  assert.equal((await c.post('/auth/reset-password', { token: 'x'.repeat(43), password: 'N3wPassw0rd3', confirmPassword: 'N3wPassw0rd3' })).status, 400);
});

test('database stores only hashed passwords and hashed tokens', async () => {
  const { db } = await import('../src/db/index.js');
  const row = db.prepare('SELECT password_hash FROM students WHERE email = ?').get('asha@example.com');
  assert.match(row.password_hash, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!row.password_hash.includes('Str0ng'));
  for (const s of db.prepare('SELECT token_hash FROM sessions').all()) assert.match(s.token_hash, /^[0-9a-f]{64}$/);
});

test('malformed JSON and oversized bodies are handled', async () => {
  const r = await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(r.status, 400);
  const big = await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200_000) }) });
  assert.equal(big.status, 413);
});
