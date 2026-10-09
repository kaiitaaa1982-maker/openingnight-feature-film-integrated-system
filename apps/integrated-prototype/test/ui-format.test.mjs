import test from 'node:test';
import assert from 'node:assert/strict';
import {
  int, yen, rate, month, dateJst, dateTimeJst, cellText, decimal, displayWidth, compactDateJst, toNumber, parseTimestamp,
  UNKNOWN_TEXT, BLANK_ZERO_TEXT,
} from '../src/ui/format.mjs';

test('整数・円は桁区切りで、負数は符号つき', () => {
  assert.equal(int(-1234), '-1,234');
  assert.equal(int(1234567), '1,234,567');
  assert.equal(int('1200'), '1,200');
  assert.equal(int(-0.4), '0');
  assert.equal(cellText('yen', -1234), '-1,234');
  assert.equal(cellText('int', 1234), '1,234');
  assert.match(yen(-1234), /^-[¥￥]1,234$/);
  assert.match(yen(1500000), /^[¥￥]1,500,000$/);
  assert.equal(decimal(1234.5678), '1,234.57');
});

test('0は blankZero のときだけ「—」、値が無いときは「未確認」で0にしない', () => {
  assert.equal(cellText('yen', 0, {blankZero: true}), BLANK_ZERO_TEXT);
  assert.equal(cellText('yen', 0, {blankZero: true}), '—');
  assert.equal(cellText('yen', 0), '0');
  assert.equal(cellText('int', '0', {blankZero: true}), '—');
  for (const type of ['yen', 'int', 'rate', 'date', 'month', 'text', 'id', 'datetime']) {
    assert.equal(cellText(type, null), '未確認', type);
    assert.equal(cellText(type, undefined), UNKNOWN_TEXT, type);
  }
  assert.equal(yen(null), '未確認');
  assert.equal(int(undefined), '未確認');
  assert.equal(cellText('yen', 'HOLD（未算定）'), 'HOLD（未算定）');
  assert.equal(cellText('yen', ''), '未確認');
});

test('月は年付き、率は百分率', () => {
  assert.equal(month('2026-09'), '2026年9月');
  assert.equal(month('2026-12-31'), '2026年12月');
  assert.equal(month('202601'), '2026年1月');
  assert.equal(month('2026-13'), '2026-13');
  assert.equal(month(null), '未確認');
  assert.equal(cellText('month', '2026-09'), '2026年9月');
  assert.equal(rate(0.1234), '12.3%');
  assert.equal(rate(0.1234, {digits: 2}), '12.34%');
  assert.equal(rate(-0.00001), '0.0%');
  assert.equal(rate(Infinity), '—');
  assert.equal(cellText('rate', 0.5), '50.0%');
});

test('日時は日本時間で表示し、SQLite の時差なし日時は UTC とみなす', () => {
  assert.equal(dateJst('2026-09-24'), '2026/09/24');
  assert.equal(dateJst('2026-09-23T15:30:00Z'), '2026/09/24');
  assert.equal(dateTimeJst('2026-09-24 00:18:32'), '2026/09/24 09:18');
  assert.equal(dateTimeJst('2026-09-24T00:18:32Z'), '2026/09/24 09:18');
  assert.equal(dateTimeJst('2026-09-24T00:18:32+09:00'), '2026/09/24 00:18');
  assert.equal(dateTimeJst('2026-09-24'), '2026/09/24');
  assert.equal(dateTimeJst('不明'), '不明');
  assert.equal(parseTimestamp('2026-09-24'), null);
  assert.equal(cellText('date', '2026-09-01'), '2026/09/01');
  assert.equal(cellText('datetime', '2026-09-24 15:00:00'), '2026/09/25 00:00');
  assert.equal(compactDateJst(new Date('2026-09-23T16:00:00Z')), '20260924');
});

test('表示幅は全角2・半角1で数える', () => {
  assert.equal(displayWidth('作品A'), 5);
  assert.equal(displayWidth('ｶﾀｶﾅ'), 4);
  assert.equal(displayWidth(''), 0);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber(' -12.5 '), -12.5);
});
