import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { demoInternships } from '../../client/src/data/internships.demo.js';
import { toCatalogEntry } from '../../scripts/sync-internship-catalog.mjs';
import { getInternship, effectiveStatus } from '../src/internships/catalog.js';

test('server catalog matches the client demo internships (run `npm run catalog:sync` if this fails)', () => {
  const snapshot = JSON.parse(fs.readFileSync(new URL('../src/data/internshipCatalog.json', import.meta.url), 'utf8'));
  assert.deepEqual(snapshot, demoInternships.map(toCatalogEntry));
});

test('effectiveStatus closes an open internship after its deadline day (India time)', () => {
  const item = { status: 'open', deadline: '2027-01-15' };
  assert.equal(effectiveStatus(item, new Date('2027-01-15T18:00:00Z')), 'open'); // 23:30 IST, still the deadline day
  assert.equal(effectiveStatus(item, new Date('2027-01-15T18:31:00Z')), 'closed'); // just after 00:00 IST on the 16th
  assert.equal(effectiveStatus({ status: 'upcoming', deadline: '2027-01-15' }, new Date('2026-12-01')), 'upcoming');
  assert.equal(getInternship('nope'), null);
  assert.equal(getInternship({ id: 'x' }), null);
});
