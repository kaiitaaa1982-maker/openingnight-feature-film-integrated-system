// FR-REV-FOLDER-008。必ず成り立つ7つの検査は、仕様の壊した入力でそれぞれ落ちる。
// 期待値は要件（行数・合計・期間・紐づけ・往復・検算・重なり）から作る。実装の戻りを写して期待にしない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFolderChecks} from '../src/revenue/folders/folders-checks.mjs';

function baseInput() {
  const rows = [
    {sourceRow: 2, values: {商品: 'A', 税抜: '1000', 税額: '100', 税込: '1100'}, date: '2026-05-15', month: '2026-05'},
    {sourceRow: 3, values: {商品: 'B', 税抜: '2000', 税額: '200', 税込: '2200'}, date: '2026-05-31', month: '2026-05'},
  ];
  return {
    source: {headers: ['商品', '税抜', '税額', '税込'], rows},
    planned: {
      lines: [
        {sourceRow: 2, workId: 10, productId: 100, partnerId: 7, amountExTax: 1000, taxAmount: 100, amountIncTax: 1100},
        {sourceRow: 3, workId: 10, productId: 101, partnerId: 7, amountExTax: 2000, taxAmount: 200, amountIncTax: 2200},
      ],
      excluded: [],
    },
    terms: {partnerId: 7, kind: 'download', periodFrom: '2026-05-01', periodTo: '2026-05-31', declared: null},
    expected: {targetMonth: '2026-05'},
    typeVersion: {
      splitByProduct: true,
      moneyColumns: {amountExTax: '税抜', taxAmount: '税額', amountIncTax: '税込'},
      checks: [{type: 'difference', left: '税込', right: '税額', result: '税抜'}],
    },
    roundTrip: {
      headers: ['商品', '税抜', '税額', '税込'],
      rows: rows.map(row => ({sourceRow: row.sourceRow, values: {...row.values}})),
    },
    activeReports: [],
  };
}

const edit = (mutate) => {
  const input = structuredClone(baseInput());
  mutate(input);
  return input;
};
const by = (result, key) => result.checks.find(check => check.key === key);
const KEYS = ['row_count', 'totals', 'period', 'linkage', 'round_trip', 'arithmetic', 'overlap'];

function assertOnly(result, key) {
  assert.deepEqual(result.checks.map(check => check.key), KEYS);
  for (const check of result.checks) assert.equal(check.pass, check.key !== key, check.key);
  assert.equal(result.allPass, false);
}

test('FR-REV-FOLDER-008 揃った架空の1通は7つの検査が全部合い、申告合計が無い項目は未検証のまま', () => {
  const result = evaluateFolderChecks(baseInput());
  assert.equal(result.allPass, true);
  assert.equal(result.passed, 14);
  assert.equal(result.total, 14);
  assert.equal(by(result, 'totals').declared, 'unverified');
  assert.equal(by(result, 'totals').items.find(item => item.field === 'amountExTax').source, 3000);
  assert.equal(by(result, 'totals').items.find(item => item.field === 'identity').pass, true);
});

test('FR-REV-FOLDER-008 合計を1円ずらすと合計額だけが落ち、その1通は確定できない', () => {
  const result = evaluateFolderChecks(edit(input => {
    input.planned.lines[0].amountExTax = 1001;
    input.planned.lines[0].amountIncTax = 1101;
  }));
  assertOnly(result, 'totals');
  const ex = by(result, 'totals').items.find(item => item.field === 'amountExTax');
  assert.equal(ex.pass, false);
  assert.equal(ex.source, 3000);
  assert.equal(ex.planned, 3001);
  assert.equal(ex.difference, 1);
});

test('FR-REV-FOLDER-008 列の和が登録予定と一致しても税込が税抜＋税額でなければ合計額が落ちる', () => {
  const result = evaluateFolderChecks(edit(input => {
    input.typeVersion.checks = [];
    input.source.rows[0].values.税込 = '1200';
    input.planned.lines[0].amountIncTax = 1200;
    input.roundTrip.rows[0].values.税込 = '1200';
  }));
  assertOnly(result, 'totals');
  assert.equal(by(result, 'totals').items.find(item => item.field === 'amountIncTax').pass, true);
  assert.equal(by(result, 'totals').items.find(item => item.field === 'identity').pass, false);
});

test('FR-REV-FOLDER-008 申告合計が1円違えば合計額が落ち、読めない申告は0円にしない', () => {
  const off = evaluateFolderChecks(edit(input => {
    input.terms.declared = {amountExTax: 3001, taxAmount: null, amountIncTax: ''};
  }));
  assertOnly(off, 'totals');
  const declared = by(off, 'totals').items.find(item => item.field === 'declared_amountExTax');
  assert.equal(declared.pass, false);
  assert.equal(declared.expected, 3001);
  assert.equal(declared.actual, 3000);
  assert.equal(by(off, 'totals').items.some(item => item.field === 'declared_taxAmount'), false);

  const unread = evaluateFolderChecks(edit(input => {
    input.terms.declared = {amountExTax: 'abc'};
  }));
  assertOnly(unread, 'totals');
  const bad = by(unread, 'totals').items.find(item => item.field === 'declared_amountExTax');
  assert.equal(bad.pass, false);
  assert.equal(bad.expected, null);
  assert.equal(bad.actual, 3000);
});

test('FR-REV-FOLDER-008 原本の金額が読めなければ合計額が落ち、0円として登録予定と合わせない', () => {
  const result = evaluateFolderChecks(edit(input => {
    input.typeVersion.checks = [];
    input.source.rows[0].values.税抜 = 'abc';
    input.roundTrip.rows[0].values.税抜 = 'abc';
  }));
  assert.equal(by(result, 'totals').pass, false);
  assert.equal(result.allPass, false);
  const ex = by(result, 'totals').items.find(item => item.field === 'amountExTax');
  assert.equal(ex.source, null);
  assert.equal(ex.planned, 3000);
});

test('FR-REV-FOLDER-008 行が登録予定にも取り込まない行にも無いと行数が落ちる', () => {
  const result = evaluateFolderChecks(edit(input => {
    input.source.rows.push({sourceRow: 4, values: {商品: 'C', 税抜: '0', 税額: '0', 税込: '0'}, date: '2026-05-20', month: '2026-05'});
    input.roundTrip.rows.push({sourceRow: 4, values: {商品: 'C', 税抜: '0', 税額: '0', 税込: '0'}});
  }));
  assert.equal(by(result, 'row_count').pass, false);
  assert.deepEqual(by(result, 'row_count').broken, [{sourceRow: 4, code: 'missing'}]);
  assert.equal(by(result, 'totals').pass, true, '0円の欠けは合計をずらさない');
  assert.equal(by(result, 'linkage').pass, false, '取り込む行として残っているので紐づけも落ちる');
  assert.equal(by(result, 'period').pass, true);
  assert.equal(by(result, 'round_trip').pass, true);
  assert.equal(by(result, 'arithmetic').pass, true);
  assert.equal(by(result, 'overlap').pass, true);
  assert.equal(result.allPass, false);
});

test('FR-REV-FOLDER-008 理由の無い取り込まない行は行数が落ち、理由のある合計行は合計に入れない', () => {
  const withReason = evaluateFolderChecks(edit(input => {
    input.source.rows.push({sourceRow: 4, values: {商品: '合計', 税抜: '500', 税額: '50', 税込: '550'}, date: '2026-05-20', month: '2026-05'});
    input.roundTrip.rows.push({sourceRow: 4, values: {商品: '合計', 税抜: '500', 税額: '50', 税込: '550'}});
    input.planned.excluded.push({sourceRow: 4, reason: '合計の行'});
  }));
  assert.equal(withReason.allPass, true);
  assert.equal(by(withReason, 'totals').items.find(item => item.field === 'amountExTax').source, 3000);

  const noReason = evaluateFolderChecks(edit(input => {
    input.source.rows.push({sourceRow: 4, values: {商品: '合計', 税抜: '500', 税額: '50', 税込: '550'}, date: '2026-05-20', month: '2026-05'});
    input.roundTrip.rows.push({sourceRow: 4, values: {商品: '合計', 税抜: '500', 税額: '50', 税込: '550'}});
    input.planned.excluded.push({sourceRow: 4, reason: '  '});
  }));
  assertOnly(noReason, 'row_count');
  assert.deepEqual(by(noReason, 'row_count').reasonMissing, [4]);
});

test('FR-REV-FOLDER-008 期間の終わりの日は入り、翌日と届くはずの報告が無い1通は対象期間が落ちる', () => {
  assert.equal(evaluateFolderChecks(baseInput()).checks.find(check => check.key === 'period').pass, true);
  const outside = evaluateFolderChecks(edit(input => {
    input.source.rows[1].date = '2026-06-01';
    input.source.rows[1].month = '2026-06';
  }));
  assertOnly(outside, 'period');
  assert.equal(by(outside, 'period').items.find(item => item.sourceRow === 3).code, 'outside');
  const missingExpected = evaluateFolderChecks(edit(input => {
    input.expected = null;
  }));
  assertOnly(missingExpected, 'period');
  assert.equal(by(missingExpected, 'period').items[0].code, 'expected_missing');
});

test('FR-REV-FOLDER-008 作品や商品に照合できない行と、フォルダと違う取引先は紐づけだけが落ちる', () => {
  const unmatched = evaluateFolderChecks(edit(input => {
    input.planned.lines[0].productId = null;
  }));
  assertOnly(unmatched, 'linkage');
  assert.deepEqual(by(unmatched, 'linkage').items.find(item => item.sourceRow === 2).problems, ['product']);

  const otherPartner = evaluateFolderChecks(edit(input => {
    input.planned.lines[1].partnerId = 8;
  }));
  assertOnly(otherPartner, 'linkage');
  assert.deepEqual(by(otherPartner, 'linkage').items.find(item => item.sourceRow === 3).problems, ['partner']);

  const singleWork = evaluateFolderChecks(edit(input => {
    input.typeVersion.splitByProduct = false;
    input.planned.lines[0].productId = null;
    input.planned.lines[1].productId = null;
  }));
  assert.equal(singleWork.allPass, true);
});

test('FR-REV-FOLDER-008 原本の形へ戻した値が1つでも違えば往復の照合だけが落ちる', () => {
  const value = evaluateFolderChecks(edit(input => {
    input.roundTrip.rows[0].values.税抜 = '1001';
  }));
  assertOnly(value, 'round_trip');
  assert.deepEqual(by(value, 'round_trip').items.find(item => item.sourceRow === 2).fields, ['税抜']);

  const headers = evaluateFolderChecks(edit(input => {
    input.roundTrip.headers = ['税抜', '商品', '税額', '税込'];
  }));
  assertOnly(headers, 'round_trip');
  assert.equal(by(headers, 'round_trip').items[0].code, 'headers');
});

test('FR-REV-FOLDER-008 検算の決まりに反する行は検算だけが落ちる', () => {
  const result = evaluateFolderChecks(edit(input => {
    input.typeVersion.checks = [{type: 'required', column: '商品'}];
    input.source.rows[0].values.商品 = '';
    input.roundTrip.rows[0].values.商品 = '';
  }));
  assertOnly(result, 'arithmetic');
  const items = by(result, 'arithmetic').items;
  assert.equal(items.find(item => item.sourceRow === 2).pass, false);
  assert.equal(items.find(item => item.sourceRow === 3).pass, true);
});

test('FR-REV-FOLDER-008 同じ作品・取引先・種類で期間が接する有効な報告があると重なりが落ち、翌日と別作品は落ちない', () => {
  const touching = evaluateFolderChecks(edit(input => {
    input.activeReports.push({id: 41, workId: 10, partnerId: 7, kind: 'download', periodFrom: '2026-05-31', periodTo: '2026-06-30'});
  }));
  assertOnly(touching, 'overlap');
  assert.deepEqual(by(touching, 'overlap').hits, [{id: 41, code: 'overlap'}]);

  const nextDay = evaluateFolderChecks(edit(input => {
    input.activeReports.push({id: 42, workId: 10, partnerId: 7, kind: 'download', periodFrom: '2026-06-01', periodTo: '2026-06-30'});
  }));
  assert.equal(nextDay.allPass, true);

  const otherWork = evaluateFolderChecks(edit(input => {
    input.activeReports.push({id: 43, workId: 99, partnerId: 7, kind: 'download', periodFrom: '2026-05-01', periodTo: '2026-05-31'});
  }));
  assert.equal(otherWork.allPass, true);

  const unverified = evaluateFolderChecks(edit(input => {
    delete input.activeReports;
  }));
  assertOnly(unverified, 'overlap');
});

test('FR-REV-FOLDER-008 返品の負の額は合計が合い、安全な整数を超える和は合計額が落ちる', () => {
  const returned = evaluateFolderChecks(edit(input => {
    input.source.rows = [{sourceRow: 2, values: {商品: '返品', 税抜: '-1000', 税額: '-100', 税込: '-1100'}, date: '2026-05-02', month: '2026-05'}];
    input.planned.lines = [{sourceRow: 2, workId: 10, productId: 100, partnerId: 7, amountExTax: -1000, taxAmount: -100, amountIncTax: -1100}];
    input.roundTrip.rows = [{sourceRow: 2, values: {商品: '返品', 税抜: '-1000', 税額: '-100', 税込: '-1100'}}];
  }));
  assert.equal(returned.allPass, true);
  assert.equal(by(returned, 'totals').items.find(item => item.field === 'amountExTax').source, -1000);

  const big = Number.MAX_SAFE_INTEGER;
  const text = String(big);
  const overflow = evaluateFolderChecks(edit(input => {
    input.typeVersion.checks = [];
    input.source.rows = [
      {sourceRow: 2, values: {商品: 'A', 税抜: text, 税額: '0', 税込: text}, date: '2026-05-02', month: '2026-05'},
      {sourceRow: 3, values: {商品: 'B', 税抜: text, 税額: '0', 税込: text}, date: '2026-05-03', month: '2026-05'},
    ];
    input.planned.lines = [
      {sourceRow: 2, workId: 10, productId: 100, partnerId: 7, amountExTax: big, taxAmount: 0, amountIncTax: big},
      {sourceRow: 3, workId: 10, productId: 101, partnerId: 7, amountExTax: big, taxAmount: 0, amountIncTax: big},
    ];
    input.roundTrip.rows = input.source.rows.map(row => ({sourceRow: row.sourceRow, values: {...row.values}}));
  }));
  assert.equal(by(overflow, 'totals').pass, false);
  assert.equal(by(overflow, 'totals').items.find(item => item.field === 'amountExTax').source, null);
  assert.equal(overflow.allPass, false);
});

test('FR-REV-FOLDER-008 入力が空でも投げず、確定にはしない', () => {
  const result = evaluateFolderChecks(null);
  assert.equal(result.allPass, false);
  assert.equal(by(result, 'row_count').pass, false);
});
