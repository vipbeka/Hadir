// Unit tests for the single time-display helper. Run with a NON-Cairo
// device timezone to prove the output never depends on the device:
//   TZ=America/New_York node --test tools/unit/
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { formatTime, formatClock, formatDate } = await import('../../web/js/core/format.js');

test('device timezone is not Cairo in this run', () => {
  assert.notEqual(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Africa/Cairo');
});
test('afternoon: 16:44 Cairo → 4:44 م / 4:44 PM (winter, UTC+2)', () => {
  assert.equal(formatTime('2026-01-15T14:44:00Z', 'ar'), '4:44 م');
  assert.equal(formatTime('2026-01-15T14:44:00Z', 'en'), '4:44 PM');
});
test('summer (EEST, UTC+3): 13:44Z → 4:44 PM', () => {
  assert.equal(formatTime('2026-07-15T13:44:00Z', 'en'), '4:44 PM');
  assert.equal(formatTime('2026-07-15T13:44:00Z', 'ar'), '4:44 م');
});
test('midnight and noon', () => {
  assert.equal(formatTime('2026-01-15T22:00:00Z', 'en'), '12:00 AM');   // 00:00 Cairo next day
  assert.equal(formatTime('2026-01-15T22:00:00Z', 'ar'), '12:00 ص');
  assert.equal(formatTime('2026-01-15T10:00:00Z', 'en'), '12:00 PM');
  assert.equal(formatTime('2026-01-15T10:00:00Z', 'ar'), '12:00 م');
});
test('the Cairo calendar day is used (late-night UTC is already tomorrow in Cairo)', () => {
  assert.match(formatDate('2026-01-15T22:30:00Z', 'en'), /16 Jan 2026/);
});
test('no 24-hour or dotted output', () => {
  for (const s of [formatTime('2026-01-15T14:44:00Z', 'ar'), formatTime('2026-01-15T14:44:00Z', 'en')]) {
    assert.doesNotMatch(s, /16[.:]44/); assert.match(s, /^\d{1,2}:\d{2} /);
  }
});
test('schedule clock values are not parsed as dates', () => {
  assert.equal(formatClock('09:00:00', 'ar'), '9:00 ص');
  assert.equal(formatClock('17:00', 'en'), '5:00 PM');
  assert.equal(formatClock('00:30', 'en'), '12:30 AM');
  assert.equal(formatClock('12:00', 'ar'), '12:00 م');
  assert.equal(formatClock('', 'ar'), '');
});
test('bare work date keeps its calendar day', () => {
  assert.match(formatDate('2026-11-22', 'en'), /22 Nov 2026/);
});
