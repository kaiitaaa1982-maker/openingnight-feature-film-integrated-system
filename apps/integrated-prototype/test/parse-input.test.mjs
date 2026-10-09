import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseYen, parseInt as parseCount, parseInteger, parseDate, parseMonth, parseFieldValue, formatNumberInput, isBlankInput,
  validateFields, createPayload, diffValues, requiredMessage,
} from '../src/ui/parse-input.mjs';

const value = (result) => {
  assert.equal(result.ok, true, result.error);
  return result.value;
};

test('金額は全角・カンマ・¥・円・空白を吸収して数値にする', () => {
  for (const text of ['１２，０００', '¥12,000', '12000円', '12,000', ' 12 000 ', '￥１２，０００', '１２０００円', 'JPY 12,000', '12、000', '12000.00']) {
    assert.equal(value(parseYen(text)), 12000, text);
  }
  assert.equal(value(parseYen(12000)), 12000);
  assert.equal(value(parseYen('0')), 0);
});

test('金額の負号（-・−・▲・△・括弧）を読む。allowNegative:false では理由を返す', () => {
  assert.equal(value(parseYen('-1,200')), -1200);
  assert.equal(value(parseYen('−1,200')), -1200);
  assert.equal(value(parseYen('▲1,200')), -1200);
  assert.equal(value(parseYen('△1,200円')), -1200);
  assert.equal(value(parseYen('(1,200)')), -1200);
  assert.equal(value(parseYen('-¥1,200')), -1200);
  assert.equal(value(parseYen('¥-1,200')), -1200);
  const result = parseYen('-100', {allowNegative: false});
  assert.equal(result.ok, false);
  assert.match(result.error, /0以上/);
});

test('金額に数字でないもの・小数があれば日本語の理由を返す', () => {
  const abc = parseYen('abc');
  assert.equal(abc.ok, false);
  assert.match(abc.error, /数字で入力/);
  assert.match(abc.error, /[ぁ-んァ-ン一-龥]/);
  const decimal = parseYen('12.5');
  assert.equal(decimal.ok, false);
  assert.match(decimal.error, /1円単位/);
  assert.equal(parseYen('1e3').ok, false);
  assert.equal(parseYen('12,000ドル').ok, false);
  assert.equal(parseYen('99999999999999999999').ok, false);
});

test('空欄は blank として null を返す（必須の判定は呼び出し側）', () => {
  for (const text of ['', '   ', '　', null, undefined]) {
    const result = parseYen(text);
    assert.deepEqual(result, {ok: true, value: null, blank: true});
    assert.equal(isBlankInput(text), true);
  }
  assert.equal(value(parseDate('')), null);
  assert.equal(value(parseMonth(' ')), null);
});

test('整数（数量）は全角・カンマ・単位を吸収する', () => {
  assert.equal(value(parseCount('１，２００')), 1200);
  assert.equal(value(parseCount('1200件')), 1200);
  assert.equal(value(parseInteger('12 本')), 12);
  assert.equal(parseCount('1.5').ok, false);
  assert.match(parseCount('たくさん').error, /整数で入力/);
  assert.match(parseInteger('0', {min: 1}).error, /1以上/);
  assert.match(parseInteger('-3', {allowNegative: false}).error, /0以上/);
});

test('日付は 2026/9/1 などを 2026-09-01 に直し、存在しない日付は理由を返す', () => {
  for (const text of ['2026/9/1', '2026-09-01', '2026.9.1', '2026年9月1日', '20260901', '２０２６／９／１', '令和8年9月1日', 'R8.9.1', '2026-09-01T10:00:00+09:00']) {
    assert.equal(value(parseDate(text)), '2026-09-01', text);
  }
  assert.equal(value(parseDate('2028/2/29')), '2028-02-29');
  assert.match(parseDate('2026/2/29').error, /存在しない日付/);
  assert.match(parseDate('2026/13/1').error, /1〜12/);
  assert.match(parseDate('9/1').error, /年を含めて/);
  assert.match(parseDate('きのう').error, /2026\/9\/1/);
});

test('月は 202609 などを 2026-09 に直す', () => {
  for (const text of ['202609', '2026/9', '2026-09', '2026年9月', '2026.09', '２０２６０９', '令和8年9月', '2026/9/15']) {
    assert.equal(value(parseMonth(text)), '2026-09', text);
  }
  assert.match(parseMonth('2026/13').error, /1〜12/);
  assert.match(parseMonth('九月').error, /2026\/9/);
});

test('parseFieldValue は型ごとに振り分け、文字は前後の空白を落として空欄を null にする', () => {
  assert.equal(value(parseFieldValue('yen', '¥1,000')), 1000);
  assert.equal(value(parseFieldValue('int', '３')), 3);
  assert.equal(value(parseFieldValue('number', '3')), 3);
  assert.equal(value(parseFieldValue('date', '2026/9/1')), '2026-09-01');
  assert.equal(value(parseFieldValue('month', '202609')), '2026-09');
  assert.equal(value(parseFieldValue('text', '  作品  ')), '作品');
  assert.equal(value(parseFieldValue('select', '')), null);
  assert.equal(value(parseFieldValue('entity', 3)), 3);
  assert.equal(parseFieldValue('yen', '-1', {allowNegative: false}).ok, false);
});

test('入力欄の整形は桁区切りだけを付ける', () => {
  assert.equal(formatNumberInput(1234567), '1,234,567');
  assert.equal(formatNumberInput(-1200), '-1,200');
  assert.equal(formatNumberInput(null), '');
  assert.equal(formatNumberInput('abc'), 'abc');
});

test('フォームの検査: 必須の空欄・変換できない値は項目ごとの日本語の理由、導出値は変換後の値から計算する', () => {
  const fields = [
    {name: 'code', label: '案件コード', required: true},
    {name: 'status', label: '状態', type: 'select', required: true},
    {name: 'budget_yen', label: '予算', type: 'yen'},
    {name: 'actual_ex_tax', label: '実績税抜', type: 'yen', allowNegative: true},
    {name: 'tax_amount', label: '税額', type: 'yen', allowNegative: true},
    {name: 'actual_inc_tax', label: '実績税込', type: 'yen', derived: (values) => (values.actual_ex_tax ?? 0) + (values.tax_amount ?? 0)},
    {name: 'project_id', type: 'int', hidden: true, defaultValue: 3},
    {name: 'close_date', label: '予定日', type: 'date', validate: (value) => (value && value < '2020-01-01' ? '2020年以降の日付にしてください' : null)},
  ];
  const bad = validateFields(fields, {code: ' ', status: '', budget_yen: 'abc', actual_ex_tax: '▲1,000', tax_amount: '100', close_date: '2019/1/1'});
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.order, ['code', 'status', 'budget_yen', 'close_date']);
  assert.equal(bad.errors.code, '案件コードを入力してください');
  assert.equal(bad.errors.status, '状態を選択してください');
  assert.match(bad.errors.budget_yen, /数字で入力/);
  assert.equal(bad.errors.close_date, '2020年以降の日付にしてください');
  const good = validateFields(fields, {code: ' P-1 ', status: 'active', budget_yen: '１２，０００', actual_ex_tax: '▲1,000', tax_amount: '-100', close_date: '2026/9/1'});
  assert.equal(good.ok, true);
  assert.deepEqual(good.values, {code: 'P-1', status: 'active', budget_yen: 12000, actual_ex_tax: -1000, tax_amount: -100, project_id: 3, close_date: '2026-09-01', actual_inc_tax: -1100});
  assert.match(validateFields([{name: 'b', label: '予算', type: 'yen'}], {b: '-5'}).errors.b, /0以上/, '金額の負は既定で受け付けない');
  assert.equal(requiredMessage({name: 'work_id', label: '作品', type: 'entity'}), '作品を選択してください');
  const hiddenWhenOff = validateFields([{name: 'x', label: 'X', required: true, visible: (raw) => raw.on === '1'}], {on: '0'});
  assert.equal(hiddenWhenOff.ok, true, '表示していない項目は検査しない');
});

test('新規登録は空欄の任意項目を送らず、修正は変わった項目だけを送る', () => {
  assert.deepEqual(createPayload({code: 'P', budget_yen: null, title: 'T', memo: undefined}), {code: 'P', title: 'T'});
  const original = {id: 5, name: '施策A', starts_on: '2026-09-01', budget_yen: 12000, objective: null};
  assert.deepEqual(diffValues({name: '施策A', starts_on: '2026-09-02', budget_yen: '12000', objective: null}, original), {starts_on: '2026-09-02'});
  assert.deepEqual(diffValues({name: null, objective: '認知'}, original), {name: null, objective: '認知'});
});
