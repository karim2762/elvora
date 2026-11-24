import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, todayIST, backdateError, earliestStartDate, MAX_BACKDATE_DAYS } from '../src/utils/dates.js';

test('start dates may go back at most 90 days', () => {
  const now = new Date('2026-11-23T10:00:00Z');
  assert.equal(MAX_BACKDATE_DAYS, 90);
  assert.equal(earliestStartDate(now), addDays(todayIST(now), -90));
  assert.equal(backdateError(addDays(todayIST(now), -90), now), null);
  assert.match(backdateError(addDays(todayIST(now), -91), now), /90 days/);
  assert.equal(backdateError(addDays(todayIST(now), 5), now), null, 'a future start is allowed');
});
