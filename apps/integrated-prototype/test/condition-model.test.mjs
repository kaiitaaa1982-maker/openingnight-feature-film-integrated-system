import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FISCAL_START_MONTH, CONDITION_KEYS, fiscalYearOf, fiscalYearRange, quarterRange, halfRange, presetRange, monthsBetween,
  addMonths, fiscalYearLabel, fiscalRuleText, fiscalYearOptions, fiscalSettingFrom, readConditions, paramUpdates,
  conditionsToQuery, describeConditions, currentYm, rangeText,
} from '../src/ui/condition-model.mjs';

const today = new Date('2026-09-24T03:00:00Z');
const params = (object) => (key, fallback) => (Object.hasOwn(object, key) ? object[key] : fallback);

test('既定の年度開始月は5月（決算4月）', () => {
  assert.equal(DEFAULT_FISCAL_START_MONTH, 5);
  assert.equal(fiscalRuleText(5), '年度: 5月〜翌4月（決算4月・解釈は未確認）');
  assert.equal(fiscalRuleText(5, {confirmed: true}), '年度: 5月〜翌4月（決算4月）');
  assert.equal(fiscalRuleText(1, {confirmed: true}), '年度: 1月〜12月（決算12月）');
});

test('年度5月開始: 年度・上期・下期・四半期の月範囲', () => {
  assert.deepEqual(fiscalYearRange(2026, 5), {from: '2026-05', to: '2027-04'});
  assert.deepEqual(halfRange(2026, 1, 5), {from: '2026-05', to: '2026-10'});
  assert.deepEqual(halfRange(2026, 2, 5), {from: '2026-11', to: '2027-04'});
  assert.deepEqual(quarterRange(2026, 1, 5), {from: '2026-05', to: '2026-07'});
  assert.deepEqual(quarterRange(2026, 2, 5), {from: '2026-08', to: '2026-10'});
  assert.deepEqual(quarterRange(2026, 3, 5), {from: '2026-11', to: '2027-01'});
  assert.deepEqual(quarterRange(2026, 4, 5), {from: '2027-02', to: '2027-04'});
  assert.deepEqual(presetRange('q3', 2026, 5), {from: '2026-11', to: '2027-01'});
  assert.deepEqual(presetRange('h2', 2026), {from: '2026-11', to: '2027-04'}, '開始月の既定は5');
  assert.equal(presetRange('custom', 2026, 5), null);
  const months = monthsBetween('2026-05', '2027-04');
  assert.equal(months.length, 12);
  assert.equal(months[0], '2026-05');
  assert.equal(months[7], '2026-12');
  assert.equal(months[8], '2027-01');
  assert.equal(months[11], '2027-04');
  const quarters = [1, 2, 3, 4].flatMap((q) => monthsBetween(...Object.values(quarterRange(2026, q, 5))));
  assert.deepEqual(quarters, months, '四半期をつなぐと年度になる');
});

test('その月の年度（開始月がある暦年）', () => {
  assert.equal(fiscalYearOf('2026-05', 5), 2026);
  assert.equal(fiscalYearOf('2027-04', 5), 2026);
  assert.equal(fiscalYearOf('2026-04', 5), 2025);
  assert.equal(fiscalYearOf('2026-12', 1), 2026);
  assert.equal(fiscalYearOf('2026-01', 1), 2026);
  assert.equal(fiscalYearOf('bad', 5), null);
  assert.equal(fiscalYearLabel(2026, 5), '2026年度（2026年5月〜2027年4月）');
  assert.equal(fiscalYearLabel(2026, 1), '2026年度（2026年1月〜2026年12月）');
});

test('年度1月開始・4月開始でも四半期と半期が年度内で切れる', () => {
  assert.deepEqual(quarterRange(2026, 4, 1), {from: '2026-10', to: '2026-12'});
  assert.deepEqual(halfRange(2026, 2, 4), {from: '2026-10', to: '2027-03'});
  assert.deepEqual(fiscalYearRange(2026, 13), {from: '2026-05', to: '2027-04'}, '不正な開始月は既定の5月');
});

test('月の計算', () => {
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-05', 23), '2028-04');
  assert.deepEqual(monthsBetween('2026-09', '2026-08'), []);
  assert.equal(currentYm(new Date('2026-09-30T16:00:00Z')), '2026-10', '日本時間で月を決める');
  assert.equal(rangeText('2026-05', '2026-07'), '2026年5月〜2026年7月（3か月）');
  assert.equal(rangeText('2026-09', '2026-09'), '2026年9月（1か月）');
});

test('URL に値が無いときは当年度・年度全体・計上月・税抜を既定にする', () => {
  const values = readConditions(params({}), ['fiscalYear', 'period', 'basis', 'tax', 'axis', 'work', 'partner'], {fiscalStartMonth: 5, today});
  assert.equal(values.fiscalYear, 2026);
  assert.equal(values.period, 'fy');
  assert.equal(values.from, '2026-05');
  assert.equal(values.to, '2027-04');
  assert.equal(values.months.length, 12);
  assert.equal(values.periodLabel, '2026年度（2026年5月〜2027年4月）');
  assert.equal(values.basis, 'accounting');
  assert.equal(values.tax, 'ex');
  assert.equal(values.axis, 'total');
  assert.equal(values.workId, null);
  assert.equal(values.partnerId, null);
  assert.deepEqual(values.errors, []);
  assert.equal(values.valid, true);
  assert.equal('direction' in values, false, '使わない条件は値を持たない');
});

test('URL の値を読み、四半期・任意期間・基準・税・作品を反映する', () => {
  const q = readConditions(params({fy: '2025', period: 'q4', basis: 'sales', tax: 'inc', workId: '3', partnerId: '12'}),
    ['period', 'basis', 'tax', 'work', 'partner'], {fiscalStartMonth: 5, today});
  assert.deepEqual([q.from, q.to], ['2026-02', '2026-04']);
  assert.equal(q.periodLabel, '2025年度 第4四半期（2026年2月〜2026年4月）');
  assert.equal(q.basis, 'sales');
  assert.equal(q.tax, 'inc');
  assert.equal(q.workId, '3');
  assert.equal(q.partnerId, '12');
  const custom = readConditions(params({period: 'custom', from: '2026-01', to: '2026-09'}), ['period'], {today});
  assert.deepEqual([custom.from, custom.to, custom.months.length], ['2026-01', '2026-09', 9]);
  const reversed = readConditions(params({period: 'custom', from: '2026-09', to: '2026-01'}), ['period'], {today});
  assert.equal(reversed.valid, false);
  assert.match(reversed.errors.join(), /開始月が終了月より後/);
});

test('不正な URL の値は既定に戻し、理由を残す', () => {
  const values = readConditions(params({fy: 'abc', period: 'q9', basis: 'x', tax: '??', workId: 'DROP TABLE', axis: 'nope', month: '2026-13'}),
    ['period', 'basis', 'tax', 'work', 'axis', 'month'], {fiscalStartMonth: 5, today});
  assert.equal(values.fiscalYear, 2026);
  assert.equal(values.period, 'fy');
  assert.equal(values.basis, 'accounting');
  assert.equal(values.tax, 'ex');
  assert.equal(values.workId, null);
  assert.equal(values.axis, 'total');
  assert.equal(values.month, '2026-09');
  assert.equal(values.errors.length, 3);
  assert.equal(values.valid, true, '既定に戻せた誤りでは実行を止めない');
});

test('基準月は選択肢の先頭（最新）を既定にし、MG の向きは受取MGを既定にする', () => {
  const monthOptions = [{value: '2026-08', label: '2026年8月（3明細）'}, {value: '2026-06', label: '2026年6月（1明細）'}];
  const values = readConditions(params({}), ['month', 'direction'], {monthOptions, today});
  assert.equal(values.month, '2026-08');
  assert.equal(values.direction, 'incoming');
  assert.equal(readConditions(params({direction: 'outgoing', month: '2026-06'}), ['month', 'direction'], {monthOptions, today}).direction, 'outgoing');
  const axis = readConditions(params({axis: 'b'}), ['axis'], {axisOptions: [{value: 'a', label: 'A'}, {value: 'b', label: 'B'}]});
  assert.equal(axis.axis, 'b');
});

test('条件の変更は URL のキーと値の組にする', () => {
  assert.deepEqual(paramUpdates('fiscalYear', 2025), [[CONDITION_KEYS.fiscalYear, '2025']]);
  assert.deepEqual(paramUpdates('period', 'q2'), [['period', 'q2'], ['from', null], ['to', null]]);
  assert.deepEqual(paramUpdates('period', 'fy'), [['period', null], ['from', null], ['to', null]], '既定値は URL から消す');
  assert.deepEqual(paramUpdates('period', 'custom', {from: '2026-08', to: '2026-10', fiscalYear: 2026}), [['period', 'custom'], ['from', '2026-08'], ['to', '2026-10']]);
  assert.deepEqual(paramUpdates('work', 7), [['workId', '7']]);
  assert.deepEqual(paramUpdates('partner', null), [['partnerId', null]]);
  assert.deepEqual(paramUpdates('basis', 'sales'), [['basis', 'sales']]);
  assert.deepEqual(paramUpdates('unknown', 'x'), []);
});

test('帳票 API への問い合わせ文字列と Excel の条件行', () => {
  const values = readConditions(params({fy: '2026', period: 'h1', tax: 'inc', workId: '3'}), ['period', 'basis', 'tax', 'work', 'partner'], {fiscalStartMonth: 5, today});
  assert.equal(conditionsToQuery(values, ['period', 'basis', 'tax', 'work', 'partner']), 'from=2026-05&to=2026-10&basis=accounting&tax=inc&workId=3');
  const rows = describeConditions(values, ['period', 'basis', 'tax', 'work', 'partner'], {names: {work: (id) => (id === '3' ? '風のあとさき（WRK-DEMO）' : id)}});
  assert.deepEqual(rows, [
    ['期間', '2026年度 上期（2026年5月〜2026年10月）'],
    ['集計の基準', '計上月'],
    ['税', '税込'],
    ['作品', '風のあとさき（WRK-DEMO）'],
    ['取引先', 'すべての取引先'],
  ]);
});

test('年度の選択肢と組織の年度設定の読み取り', () => {
  const options = fiscalYearOptions(2026, {count: 3, extra: ['2019']});
  assert.deepEqual(options.map((option) => option.value), ['2027', '2026', '2025', '2019']);
  assert.equal(options[1].label, '2026年度');
  assert.deepEqual(fiscalSettingFrom({ok: true, fiscalStartMonth: 4, confirmed: true}), {fiscalStartMonth: 4, confirmed: true, fromServer: true});
  assert.deepEqual(fiscalSettingFrom({setting: {fiscal_start_month: 7, confirmed: 0}}), {fiscalStartMonth: 7, confirmed: false, fromServer: true});
  assert.deepEqual(fiscalSettingFrom(null), {fiscalStartMonth: 5, confirmed: false, fromServer: false});
  assert.deepEqual(fiscalSettingFrom({fiscalStartMonth: 0}), {fiscalStartMonth: 5, confirmed: false, fromServer: false});
});
