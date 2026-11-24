import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent } from './helpers.js';

let srv;
before(async () => { srv = await startServer({ RATE_LIMIT_LOGIN_MAX: '20', RATE_LIMIT_LOGIN_ACCOUNT_MAX: '3', RATE_LIMIT_FORGOT_MAX: '2' }); });
after(() => srv.close());

test('login is rate limited per account after repeated failures', async () => {
  const c = client(srv.base);
  await c.post('/auth/register', validStudent());
  c.reset();
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await c.post('/auth/login', { email: 'asha@example.com', password: 'wrong-pass1' })).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  // a different account from the same IP is not locked by that
  assert.equal((await c.post('/auth/login', { email: 'other@example.com', password: 'wrong-pass1' })).status, 401);
  const r = await c.post('/auth/login', { email: 'asha@example.com', password: 'Str0ng!Pass1' });
  assert.equal(r.status, 429); // even the right password is refused while limited
  assert.match(r.data.error.message, /too many/i);
});

test('forgot-password is rate limited', async () => {
  const c = client(srv.base);
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await c.post('/auth/forgot-password', { email: 'asha@example.com' })).status);
  assert.deepEqual(codes, [200, 200, 429]);
});
