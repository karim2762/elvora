import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent, validApplication } from './helpers.js';

let srv;
before(async () => { srv = await startServer({ RATE_LIMIT_APPLY_MAX: '2' }); });
after(() => srv.close());

test('application submissions are rate limited per student', async () => {
  const c = client(srv.base);
  await c.post('/auth/register', validStudent());
  const codes = [];
  // 1st succeeds, 2nd is a duplicate (still counts as an attempt), 3rd is refused by the limiter
  for (const _ of [1, 2, 3]) codes.push((await c.post('/applications', validApplication())).status);
  assert.deepEqual(codes, [201, 409, 429]);
  // another student is not affected by Asha's limit
  const other = client(srv.base);
  await other.post('/auth/register', validStudent({ email: 'other@example.com' }));
  assert.equal((await other.post('/applications', validApplication())).status, 201);
});

test('with no ADMIN_API_KEY configured a key header grants nothing (401, same as any unauthenticated caller)', async () => {
  const r = await client(srv.base).patch('/admin/applications/ELV-APP-AAAAAAAA/status', { status: 'Approved' }, { 'x-admin-key': 'anything' });
  assert.equal(r.status, 401);
});
