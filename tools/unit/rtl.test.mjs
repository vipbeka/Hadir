import test from 'node:test'; import assert from 'node:assert/strict';
import { rtlPieces } from '../../web/js/pages/owner/payroll-export.js';
const vis = (s) => rtlPieces(s).map((p) => p.s).join('|');
test('mixed Arabic/number lines are ordered for an RTL paragraph', () => {
  assert.equal(vis('1 × 50 ج.م = 50 ج.م'), 'ج.م| |50| |=| |ج.م| |1 × 50');
  assert.equal(vis('112 س 30 د'), 'د| |30| |س| |112');
  assert.equal(vis('خضراء (حضور)'), '(|حضور|)| |خضراء');
  assert.equal(vis('-1,050 ج.م'), 'ج.م| |-1,050');
  assert.equal(vis('صفحة 1 / 1'), '1 / 1| |صفحة');
  assert.equal(vis('Africa/Cairo'), 'Africa/Cairo');
  assert.equal(vis('22 نوفمبر 2026 5:42 م'), 'م| |2026 5:42| |نوفمبر| |22');
});
