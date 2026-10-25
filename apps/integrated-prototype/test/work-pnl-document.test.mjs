// 作品別収支の文書データ（フェーズ1 #8。計画の K-5）と、その文書データから出す Excel・印刷・画面の試験。
// 壊れたら: 画面と Excel の数字が別の計算から出てずれる・照合 NG の帳票が Excel で外へ出る・同じデータで hash が変わり data-ready が付かない。
// 期待値は架空の明細から手で足した額（実装から作らない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {buildWorkPnlDocument, documentChecks, workPnlDocument, workPnlSource, WORK_PNL_DEFINITION_VERSION} from '../src/accounting/work-pnl/work-pnl-document.mjs';
import {checkPassed, documentExportBlock, documentChecksOk, documentSheets, documentXlsx, documentPrintHtml, exportDocument} from '../src/report-output.mjs';
import {workPnlReadyHash} from '../src/reports/work-pnl-model.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {cellText} from '../src/ui/grid-model.mjs';

// app.mjs の canonical と同じ形（キーを並べ替えた JSON）と SHA-256。受け口は app の道具（app.ux）を渡す
const canonical = (value) => JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const sha256 = async (text) => createHash('sha256').update(text).digest('hex');
const deps = {sha256, canonical};

function input() {
  const line = (fields) => ({month: fields.accounting_month, product_name: '架空の商品', description: '架空売上', quantity: 1, report_key: 'R-DOC', product_sku: 'SKU-DOC', ...fields});
  return {
    work: {id: 7, code: 'WRK-DOC-1', title: '架空の作品'},
    conditions: {workId: 7, from: '2026-05', to: '2026-07'},
    dataAsOf: {latestImportAt: '2026-08-01T00:00:00.000Z', generatedAt: '2026-10-10T01:00:00.000Z'},
    lines: [
      line({id: 1, accounting_month: '2026-05', amount: 1000, allocation_bps: 10000, distribution_code: 'svod', distribution_label: 'SVOD', deal_label: 'MG', partner_name: '架空配信', source_row: 2}),
      line({id: 2, accounting_month: '2026-07', amount: 500, allocation_bps: 6000, distribution_code: 'svod', distribution_label: 'SVOD', deal_label: 'FLAT（定額）', partner_name: '架空配信', source_row: 3}),
      line({id: 3, accounting_month: '2026-07', amount: -200, allocation_bps: 10000, distribution_code: 'dvd', distribution_label: 'DVD', deal_label: 'ロイヤリティ', partner_name: '架空販売', source_row: 4}),
    ],
    expenses: [{id: 11, accounting_month: '2026-06', incurred_on: '2026-06-10', category: '宣伝費', description: '架空の経費', partner_name: '架空の支払先', actual_ex_tax: 300, tax_amount: 30, actual_inc_tax: 330}],
    unallocatedExpenses: [{id: 21, accounting_month: '2026-06', incurred_on: '2026-06-12', category: '共通費', description: '架空の共通経費', partner_name: null, actual_ex_tax: 50, tax_amount: 5, actual_inc_tax: 55}],
  };
}

const HASH = 'a'.repeat(64);
const CHECK_CODES = ['monthly_sales', 'lines_sales', 'distribution_sales', 'monthly_expense', 'expense_lines', 'distribution_balance', 'monthly_breakdown', 'balance', 'unallocated'];
const table = (doc, name) => doc.tables.find((t) => t.name === name);
const amountOf = (doc, code) => table(doc, 'summary').rows.find((row) => row.code === code).amount;
const pick = (rows, key) => rows.map((row) => row[key]);

test('作品別収支の文書データは K-5 の形（title・conditions・dataAsOf・definitionVersion・basis・tables・notes・checks・sourceHash）で、JSON にしても変わらない', () => {
  const doc = buildWorkPnlDocument(input(), {sourceHash: HASH});
  assert.deepEqual(Object.keys(doc).sort(), ['basis', 'checks', 'conditions', 'dataAsOf', 'definitionVersion', 'notes', 'sourceHash', 'tables', 'title']);
  assert.equal(doc.title, '作品別収支（架空の作品）');
  assert.deepEqual(doc.conditions, [
    {key: 'work', label: '作品', value: '架空の作品（WRK-DOC-1）'},
    {key: 'period', label: '期間', value: '2026-05〜2026-07'},
    {key: 'basis', label: '基準', value: '計上（計上月・税抜）'},
  ]);
  assert.deepEqual(doc.dataAsOf, {label: '最終取込', at: '2026-08-01T00:00:00.000Z', generatedAt: '2026-10-10T01:00:00.000Z'});
  assert.equal(doc.definitionVersion, WORK_PNL_DEFINITION_VERSION);
  assert.match(doc.definitionVersion, /^work-pnl\.\d{4}-\d{2}-\d{2}$/);
  assert.equal(doc.basis, 'accrual');
  assert.equal(doc.sourceHash, HASH);
  assert.deepEqual(doc.tables.map((t) => t.name), ['summary', 'distributions', 'monthly', 'lines', 'expenses', 'unallocated']);
  for (const t of doc.tables) {
    assert.equal(typeof t.title, 'string', t.name);
    for (const column of t.columns) {
      assert.deepEqual(Object.keys(column).filter((key) => !['nullText'].includes(key)).sort(), ['key', 'label', 'type'], `${t.name}.${column.key}`);
      assert.ok(['text', 'month', 'date', 'yen', 'int', 'bps', 'code'].includes(column.type), `${t.name}.${column.key} ${column.type}`);
    }
    assert.ok(Array.isArray(t.rows), t.name);
  }
  assert.ok(doc.notes.length >= 3 && doc.notes.every((note) => typeof note.code === 'string' && typeof note.text === 'string' && note.text));
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc, '関数・undefined・BigInt を持たない（画面・Excel・将来の台本へそのまま渡せる）');
});

test('作品別収支の文書データの表は、架空の明細から手で足した額になる（作品計・流通別・月別・明細・未配賦）', () => {
  const doc = buildWorkPnlDocument(input(), {sourceHash: HASH});
  // 作品計: 売上 1000+500−200=1300、経費 300、差額 1000、制作費の区分の経費なし、未配賦 50（作品計に含めない）
  assert.deepEqual(['sales', 'expense', 'balance', 'productionCost', 'unallocated'].map((code) => amountOf(doc, code)), [1300, 300, 1000, 0, 50]);
  // 流通別: 売上の大きい順。経費は流通別に記録が無いので null（0円で埋めない）。作品の経費は「流通に紐づかない経費」の行
  const d = table(doc, 'distributions');
  assert.deepEqual(d.rows.map(({label, sales, expense, balance, lineCount, expenseCount, deals, partners}) => ({label, sales, expense, balance, lineCount, expenseCount, deals, partners})), [
    {label: 'SVOD', sales: 1500, expense: null, balance: 1500, lineCount: 2, expenseCount: null, deals: 'FLAT（定額）、MG', partners: '架空配信'},
    {label: 'DVD', sales: -200, expense: null, balance: -200, lineCount: 1, expenseCount: null, deals: 'ロイヤリティ', partners: '架空販売'},
    {label: '流通に紐づかない経費', sales: 0, expense: 300, balance: -300, lineCount: 0, expenseCount: 1, deals: null, partners: null},
  ]);
  assert.deepEqual(d.total, {sales: 1300, expense: 300, balance: 1000, lineCount: 3, expenseCount: 1});
  assert.equal(d.columns.find((c) => c.key === 'expense').nullText, '流通別の記録なし');
  // 月別: 期間の3か月すべてに行。流通の内訳は列「売上のうち ○○」
  const m = table(doc, 'monthly');
  assert.deepEqual(pick(m.rows, 'month'), ['2026-05', '2026-06', '2026-07']);
  assert.deepEqual(pick(m.rows, 'sales'), [1000, 0, 300]);
  assert.deepEqual(pick(m.rows, 'expense'), [0, 300, 0]);
  assert.deepEqual(pick(m.rows, 'balance'), [1000, -300, 300]);
  assert.deepEqual(pick(m.rows, 'd:svod'), [1000, 0, 500]);
  assert.deepEqual(pick(m.rows, 'd:dvd'), [0, 0, -200]);
  assert.deepEqual(m.columns.map((c) => c.label), ['計上月', '売上（税抜）', '経費（税抜）', '差額（売上−経費）', '売上のうち SVOD', '売上のうち DVD']);
  assert.deepEqual(m.total, {sales: 1300, expense: 300, balance: 1000, 'd:svod': 1500, 'd:dvd': -200});
  // 明細: 配賦率は整数の bp のまま
  const l = table(doc, 'lines');
  assert.deepEqual(pick(l.rows, 'amount'), [1000, 500, -200]);
  assert.deepEqual(pick(l.rows, 'allocation_bps'), [10000, 6000, 10000]);
  assert.equal(l.columns.find((c) => c.key === 'allocation_bps').type, 'bps');
  assert.deepEqual(l.total, {amount: 1300, quantity: 3});
  assert.deepEqual(table(doc, 'expenses').total, {actual_ex_tax: 300, tax_amount: 30, actual_inc_tax: 330});
  assert.deepEqual(table(doc, 'unallocated').total, {actual_ex_tax: 50, tax_amount: 5, actual_inc_tax: 55});
  // 照合は表どうしで必ず等しくなる額の9項目で、全部 OK（差額 0）
  assert.deepEqual(doc.checks.map((check) => check.code), CHECK_CODES);
  assert.deepEqual(doc.checks.filter((check) => !check.ok), []);
  assert.ok(doc.checks.every((check) => typeof check.label === 'string' && check.label && check.ok === true && check.value === 0));
  assert.equal(documentChecksOk(doc), true);
  assert.ok(!doc.notes.some((note) => note.code === 'production_cost_exceeds'), '制作費が経費を超えていなければ超過の注記は出ない');
});

test('同じ入力から同じ sourceHash が出る。作った時刻は hash に入らず、明細が1円・期間・データ時点・作品の経費・未配賦の経費・作品・定義の版が変わると hash が変わる', async () => {
  const a = await workPnlDocument(input(), deps);
  const again = await workPnlDocument(input(), deps);
  assert.match(a.sourceHash, /^[0-9a-f]{64}$/);
  assert.equal(again.sourceHash, a.sourceHash);
  const later = input();
  later.dataAsOf.generatedAt = '2026-10-11T09:00:00.000Z';
  const laterDoc = await workPnlDocument(later, deps);
  assert.equal(laterDoc.sourceHash, a.sourceHash, '作った時刻だけが違う');
  assert.equal(laterDoc.dataAsOf.generatedAt, '2026-10-11T09:00:00.000Z');
  assert.ok(!canonical(workPnlSource(later)).includes('2026-10-11T09:00:00.000Z'), 'hash の元に作った時刻を入れない');

  // 1つずつ変えると、どれも元の hash とも互いとも違う hash になる（hash の元から抜けた入力があると、その変更で hash が変わらず落ちる）
  const changes = {
    明細の1円: (x) => { x.lines[2].amount = -199; },
    期間: (x) => { x.conditions.to = '2026-08'; },
    データ時点: (x) => { x.dataAsOf.latestImportAt = '2026-08-02T00:00:00.000Z'; },
    作品の経費の税: (x) => { x.expenses[0].tax_amount = 31; x.expenses[0].actual_inc_tax = 331; },
    未配賦の経費の額: (x) => { x.unallocatedExpenses[0].actual_ex_tax = 51; },
    未配賦の経費の税: (x) => { x.unallocatedExpenses[0].tax_amount = 6; x.unallocatedExpenses[0].actual_inc_tax = 56; },
    作品のコード: (x) => { x.work.code = 'WRK-DOC-2'; },
    作品の題名: (x) => { x.work.title = '架空の作品・改題'; },
  };
  const hashes = new Map([[a.sourceHash, '元']]);
  for (const [name, change] of Object.entries(changes)) {
    const item = input();
    change(item);
    const hash = (await workPnlDocument(item, deps)).sourceHash;
    assert.ok(!hashes.has(hash), `${name}を変えても hash が「${hashes.get(hash)}」と同じ`);
    hashes.set(hash, name);
  }

  // 文書の sourceHash は、定義の版を持つ hash の元（workPnlSource）の canonical の SHA-256（受け口が渡す道具で作る）。
  // 版を上げると canonical の文字が変わり、hash が変わる
  const seen = [];
  const texts = [];
  const doc = await workPnlDocument(input(), {
    canonical: (value) => { seen.push(value); return canonical(value); },
    sha256: async (text) => { texts.push(text); return sha256(text); },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['basis', 'conditions', 'dataAsOf', 'definitionVersion', 'expenses', 'lines', 'unallocatedExpenses', 'work']);
  assert.deepEqual(seen[0], workPnlSource(input()));
  assert.equal(seen[0].definitionVersion, WORK_PNL_DEFINITION_VERSION);
  assert.equal(seen[0].basis, 'accrual');
  assert.deepEqual(texts, [canonical(seen[0])]);
  assert.equal(doc.sourceHash, await sha256(texts[0]));
  assert.equal(doc.sourceHash, a.sourceHash);
  const otherVersion = canonical({...seen[0], definitionVersion: 'work-pnl.2099-01-01'});
  assert.notEqual(otherVersion, texts[0]);
  assert.notEqual(await sha256(otherVersion), doc.sourceHash);
});

test('明細に期間外の行が入ると照合が NG になり、Excel・CSV・印刷を出さない（照合が全部 OK の文書だけ出す）', () => {
  const okDoc = buildWorkPnlDocument(input(), {sourceHash: HASH});
  assert.equal(documentExportBlock(okDoc), null);
  assert.ok(documentXlsx(okDoc, {generatedAt: new Date('2026-10-10T01:00:00Z')}) instanceof Uint8Array);

  const broken = input();
  broken.lines.push({...broken.lines[0], id: 4, month: '2026-09', accounting_month: '2026-09', amount: 999});
  const ngDoc = buildWorkPnlDocument(broken, {sourceHash: HASH});
  const failed = ngDoc.checks.filter((check) => !check.ok);
  assert.deepEqual(failed.map((check) => [check.code, check.value]), [['lines_sales', 999]], '作品計（期間内）と明細の和が 999円ずれる');
  assert.equal(documentChecksOk(ngDoc), false);
  const block = documentExportBlock(ngDoc);
  assert.match(block, /照合が NG の項目が1件/);
  assert.match(block, /売上明細の和＝作品計の売上/);
  assert.throws(() => documentXlsx(ngDoc), (error) => error.message === block);
  assert.throws(() => documentPrintHtml(ngDoc), (error) => error.message === block);
  for (const format of ['xlsx', 'csv', 'print', 'html']) assert.throws(() => exportDocument(format, ngDoc, {filename: 'x'}), (error) => error.message === block, format);

  assert.match(documentExportBlock({...okDoc, sourceHash: null}), /出典の hash/);
  assert.match(documentExportBlock({...okDoc, definitionVersion: ''}), /定義の版/);
  assert.match(documentExportBlock({...okDoc, checks: []}), /照合の項目が無い/);
  assert.match(documentExportBlock(null), /文書データがありません/);
});

// 照合の1項目ずつ: 表の1か所（または合わせて動く数か所）をずらすと、その項目が NG（差額≠0）になる。
// 期待する NG の組は、上の架空の明細の表（作品計 売上1300・経費300・差額1000・未配賦50、SVOD 1500・DVD −200）から手で決めた。
// 壊れたら（照合の1つが常に 0 を返す）: その項目の行で NG の組が欠けて落ちる
const clone = (value) => JSON.parse(JSON.stringify(value));
const rowOf = (tables, name, find) => tables.find((t) => t.name === name).rows.find(find);
const TAMPER = [
  {name: '月別のある月の売上だけ', expect: [['monthly_sales', 7], ['monthly_breakdown', 7]],
    tamper: (t) => { rowOf(t, 'monthly', (r) => r.month === '2026-06').sales += 7; }},
  {name: '売上明細の1行の額', expect: [['lines_sales', 7]],
    tamper: (t) => { rowOf(t, 'lines', (r) => r.id === 1).amount += 7; }},
  {name: '流通に紐づかない経費の行の売上', expect: [['distribution_sales', 7]],
    tamper: (t) => { rowOf(t, 'distributions', (r) => r.kind === 'expense-only').sales += 7; }},
  {name: '月別のある月の経費', expect: [['monthly_expense', 7]],
    tamper: (t) => { rowOf(t, 'monthly', (r) => r.month === '2026-06').expense += 7; }},
  {name: '作品の経費の明細の1行の税抜', expect: [['expense_lines', 7]],
    tamper: (t) => { rowOf(t, 'expenses', (r) => r.id === 11).actual_ex_tax += 7; }},
  {name: '流通別の1行の差額', expect: [['distribution_balance', -7]],
    tamper: (t) => { rowOf(t, 'distributions', (r) => r.kind === 'expense-only').balance -= 7; }},
  {name: '流通の内訳を月の間で付け替える（列の和は同じ）', expect: [['monthly_breakdown', 14]],
    tamper: (t) => { rowOf(t, 'monthly', (r) => r.month === '2026-05')['d:svod'] -= 7; rowOf(t, 'monthly', (r) => r.month === '2026-07')['d:svod'] += 7; }},
  {name: '流通別の売上を流通の間で付け替える（和は同じ）', expect: [['monthly_breakdown', 14]],
    tamper: (t) => { rowOf(t, 'distributions', (r) => r.code === 'svod').sales += 7; rowOf(t, 'distributions', (r) => r.code === 'dvd').sales -= 7; }},
  {name: '作品計の差額と流通別の差額を同じだけ（売上−経費とは合わない）', expect: [['balance', 7]],
    tamper: (t) => { rowOf(t, 'summary', (r) => r.code === 'balance').amount += 7; rowOf(t, 'distributions', (r) => r.kind === 'expense-only').balance += 7; }},
  {name: '作品計の差額だけ', expect: [['distribution_balance', -7], ['balance', 7]],
    tamper: (t) => { rowOf(t, 'summary', (r) => r.code === 'balance').amount += 7; }},
  {name: '未配賦の経費の明細の1行の税抜', expect: [['unallocated', 7]],
    tamper: (t) => { rowOf(t, 'unallocated', (r) => r.id === 21).actual_ex_tax += 7; }},
];

test('照合は表の1か所のずれをその項目の NG（差額≠0）として見つけ、ほかの項目は OK のまま（9項目すべて）', () => {
  const doc = buildWorkPnlDocument(input(), {sourceHash: HASH});
  assert.deepEqual(documentChecks(doc.tables).filter((check) => !check.ok), [], 'ずらす前は全部 OK');
  const covered = new Set();
  for (const {name, expect, tamper} of TAMPER) {
    const tables = clone(doc.tables);
    tamper(tables);
    const checks = documentChecks(tables);
    assert.deepEqual(checks.map((check) => check.code), CHECK_CODES, name);
    assert.deepEqual(checks.filter((check) => !check.ok).map((check) => [check.code, check.value]), expect, name);
    assert.ok(checks.every((check) => check.ok === (check.value === 0)), `${name}: ok は差額 0 のときだけ`);
    for (const [code] of expect) covered.add(code);
    assert.match(documentExportBlock({...doc, tables, checks}), new RegExp(`照合が NG の項目が${expect.length}件`), name);
  }
  assert.deepEqual([...covered].sort(), [...CHECK_CODES].sort(), 'どの照合の項目も、どれかのずれで NG になる');
});

test('作品の経費・未配賦の経費に期間外の行が入ると、その明細の照合が NG になり、作品計には入らない', () => {
  const expense = input();
  expense.expenses.push({...expense.expenses[0], id: 12, accounting_month: '2026-08', incurred_on: '2026-08-05', actual_ex_tax: 40, tax_amount: 4, actual_inc_tax: 44});
  const expenseDoc = buildWorkPnlDocument(expense, {sourceHash: HASH});
  assert.equal(amountOf(expenseDoc, 'expense'), 300, '作品計の経費は期間内の 300円のまま');
  assert.deepEqual(expenseDoc.checks.filter((check) => !check.ok).map((check) => [check.code, check.value]), [['expense_lines', 40]]);
  assert.match(documentExportBlock(expenseDoc), /照合が NG の項目が1件.*作品の経費の明細の和＝作品計の経費/);

  const unallocated = input();
  unallocated.unallocatedExpenses.push({...unallocated.unallocatedExpenses[0], id: 22, accounting_month: '2026-04', incurred_on: '2026-04-20', actual_ex_tax: 60, tax_amount: 6, actual_inc_tax: 66});
  const unallocatedDoc = buildWorkPnlDocument(unallocated, {sourceHash: HASH});
  assert.equal(amountOf(unallocatedDoc, 'unallocated'), 50, '未配賦の合計は期間内の 50円のまま');
  assert.deepEqual(unallocatedDoc.checks.filter((check) => !check.ok).map((check) => [check.code, check.value]), [['unallocated', 60]]);
  assert.match(documentExportBlock(unallocatedDoc), /照合が NG の項目が1件.*未配賦の経費の明細の和＝未配賦の合計/);
});

// 入金ベースの未確定の照合（unsettled_in・unsettled_out）。作品計の未確定は期間内の行だけ、未確定の表は受け取った行のすべてを足すので、
// 期間外の行が渡ると差が出る（作品計と表を同じ行から足すと必ず一致して、照合が出力の関門にならない）。期待値は下の架空の行から手で足した額
const cashInput = () => ({
  ...input(), basis: 'cash', lines: [], expenses: [], unallocatedExpenses: [],
  unsettled: [
    {kind: 'receipt', kindLabel: '入金', on: '2026-06-05', month: '2026-06', amount: 19958, reason: 'receipt_amount_differs', reasonLabel: '請求額と違う額の入金', ref: '入金 2・請求 2', category: null},
    {kind: 'expense', kindLabel: '作品の経費の出金', on: '2026-06-20', month: '2026-06', amount: 4000, reason: 'expense_amount_differs', reasonLabel: '経費の税込額と違う額の出金', ref: '経費 2・出金 2', category: '架空の費目'},
    {kind: 'unallocated', kindLabel: '未配賦の経費の出金', on: '2026-06-25', month: '2026-06', amount: 1000, reason: 'expense_amount_differs', reasonLabel: '経費の税込額と違う額の出金', ref: '経費 3・出金 3', category: '架空の費目'},
  ],
});

test('入金ベースの未確定の照合: 期間内の行だけなら OK、期間外の未確定の入金・出金が渡ると作品計に入れずに照合が NG になり、出力を止める', () => {
  const okDoc = buildWorkPnlDocument(cashInput(), {sourceHash: HASH});
  assert.deepEqual([amountOf(okDoc, 'unsettledIn'), amountOf(okDoc, 'unsettledOut')], [19958, 4000], '未配賦の経費の未確定は作品の未確定の出金に入れない');
  assert.deepEqual(okDoc.checks.filter((check) => !check.ok), []);
  assert.deepEqual(okDoc.checks.slice(-2).map((check) => check.code), ['unsettled_in', 'unsettled_out']);

  const late = cashInput();
  late.unsettled.push({...late.unsettled[0], on: '2026-08-03', month: '2026-08', amount: 777});
  late.unsettled.push({...late.unsettled[1], on: '2026-04-28', month: '2026-04', amount: 55});
  const ngDoc = buildWorkPnlDocument(late, {sourceHash: HASH});
  assert.deepEqual([amountOf(ngDoc, 'unsettledIn'), amountOf(ngDoc, 'unsettledOut')], [19958, 4000], '作品計の未確定は期間内の行のまま');
  assert.equal(table(ngDoc, 'unsettled').rows.length, 5, '未確定の表には受け取った行をすべて載せる');
  assert.deepEqual(ngDoc.checks.filter((check) => !check.ok).map((check) => [check.code, check.value]), [['unsettled_in', 777], ['unsettled_out', 55]]);
  assert.match(documentExportBlock(ngDoc), /照合が NG の項目が2件/);

  // 表の1か所のずれ（未確定の表の1行・作品計の未確定）もその項目の NG になる
  const tables = clone(okDoc.tables);
  tables.find((t) => t.name === 'unsettled').rows.find((row) => row.kind === 'receipt').amount += 7;
  tables.find((t) => t.name === 'summary').rows.find((row) => row.code === 'unsettledOut').amount -= 3;
  assert.deepEqual(documentChecks(tables).filter((check) => !check.ok).map((check) => [check.code, check.value]), [['unsettled_in', 7], ['unsettled_out', 3]]);
});

test('出力の関門は ok が真偽値の true で差額が 0 の照合だけを OK と数える（ok の欠け・文字の true・null・照合なし・ok:true で差額あり は止める）', () => {
  const okDoc = buildWorkPnlDocument(input(), {sourceHash: HASH});
  assert.equal(documentExportBlock(okDoc), null);
  const cases = {
    'ok の欠け': [{code: 'x', label: '架空の照合', value: 0}],
    '文字の true': [{code: 'x', label: '架空の照合', ok: 'true', value: 0}],
    'ok が null': [{code: 'x', label: '架空の照合', ok: null, value: 0}],
    'ok が 1': [{code: 'x', label: '架空の照合', ok: 1, value: 0}],
    'ok:true で差額 5円': [{code: 'x', label: '架空の照合', ok: true, value: 5}],
    'ok:true で差額が文字の 0': [{code: 'x', label: '架空の照合', ok: true, value: '0'}],
    '照合の項目が null': [null],
  };
  for (const [name, checks] of Object.entries(cases)) {
    const doc = {...okDoc, checks: [...okDoc.checks, ...checks]};
    assert.equal(documentChecksOk(doc), false, name);
    assert.match(documentExportBlock(doc), /照合が NG の項目が1件あるため/, name);
    assert.throws(() => documentXlsx(doc), /照合が NG の項目が1件/, name);
  }
  // 照合の項目が無い文書は「照合OK」とも出さず、出力もしない
  for (const checks of [[], undefined, 'ok']) {
    const doc = {...okDoc, checks};
    assert.equal(documentChecksOk(doc), false, String(checks));
    assert.match(documentExportBlock(doc), /照合の項目が無い/, String(checks));
  }
  // 差額を持たない照合（value の無い型）は ok:true なら OK
  assert.equal(checkPassed({code: 'x', ok: true}), true);
  assert.equal(checkPassed({code: 'x', ok: true, value: null}), true);
  assert.equal(checkPassed({code: 'x', ok: true, value: 0}), true);
  // Excel の照合のシートも同じ判定で NG と書く（ok:true でも差額があれば NG）
  const mixed = {...okDoc, checks: [{code: 'x', label: '架空の照合', ok: true, value: 5}]};
  assert.deepEqual(documentSheets(mixed).at(-1).rows, [{label: '架空の照合', value: 5, result: 'NG'}]);
});

test('制作費が作品計の経費を超えても（制作費以外の区分の返金）照合は OK のまま出力でき、超えたことを注記で知らせる', () => {
  const refund = (production, other) => {
    const x = input();
    x.expenses = [
      {id: 31, accounting_month: '2026-06', incurred_on: '2026-06-01', category: '制作費', description: '架空の制作費', partner_name: null,
        actual_ex_tax: production, tax_amount: 0, actual_inc_tax: production, expense_recognition_timing: 'release_month_once'},
      {id: 32, accounting_month: '2026-06', incurred_on: '2026-06-02', category: '宣伝費', description: '架空の返金', partner_name: null,
        actual_ex_tax: other, tax_amount: 0, actual_inc_tax: other, expense_recognition_timing: 'incurred_month'},
    ];
    return buildWorkPnlDocument(x, {sourceHash: HASH});
  };
  // 制作費 100円・宣伝費の返金 −150円 → 作品計の経費 −50円。制作費が経費を超える
  const over = refund(100, -150);
  assert.deepEqual([amountOf(over, 'productionCost'), amountOf(over, 'expense')], [100, -50]);
  assert.deepEqual(over.checks.filter((check) => !check.ok), []);
  assert.equal(documentExportBlock(over), null, '正しいデータなので Excel・印刷を止めない');
  assert.ok(documentXlsx(over) instanceof Uint8Array);
  assert.match(over.notes.find((note) => note.code === 'production_cost_exceeds')?.text ?? '', /経費のうち制作費が作品計の経費を超えています/);
  // ちょうど同じ（制作費 100円・返金 0円 → 経費 100円）なら注記は出ない。1円超えると出る
  assert.ok(!refund(100, 0).notes.some((note) => note.code === 'production_cost_exceeds'));
  assert.ok(refund(100, -1).notes.some((note) => note.code === 'production_cost_exceeds'));
});

test('data-ready の値: 表示中の文書が今の条件で読んだ応答のもので、送信中・誤りでないときだけ sourceHash', () => {
  const body = {ok: true, document: {sourceHash: HASH}};
  const q = 'workId=7&from=2026-05&to=2026-07';
  assert.equal(workPnlReadyHash({body, query: q}, q), HASH, '描き終えた応答');
  assert.equal(workPnlReadyHash({body, query: q, loading: true}, q), null, '送信中（前の応答を出したまま）');
  assert.equal(workPnlReadyHash({body, query: q}, 'workId=7&from=2026-05&to=2026-08'), null, '条件を変えた直後（表示中は前の条件の応答）');
  assert.equal(workPnlReadyHash({body, query: q, error: new Error('架空の誤り')}, q), null, '誤り');
  assert.equal(workPnlReadyHash({body, query: q, failure: '集計できませんでした'}, q), null, '応答の誤り');
  assert.equal(workPnlReadyHash({error: new Error('架空の誤り')}, q), null, '誤りで文書が無い');
  assert.equal(workPnlReadyHash({body: {ok: true}, query: q}, q), null, '応答に文書が無い');
  assert.equal(workPnlReadyHash({body: {ok: true, document: {sourceHash: ''}}, query: q}, q), null, 'hash が空');
  assert.equal(workPnlReadyHash({body, query: ''}, ''), null, '条件がそろっていない');
  assert.equal(workPnlReadyHash({}, q), null, '読む前');
  assert.equal(workPnlReadyHash(undefined, q), null);
});

test('Excel は文書データの表をそのまま出す: 見出し・行・合計行・条件・データ時点・定義の版・出典の hash が文書データと同じ', () => {
  const doc = buildWorkPnlDocument(input(), {sourceHash: HASH});
  const sheets = decodeXlsx(documentXlsx(doc, {generatedAt: new Date('2026-10-10T01:00:00Z')}));
  assert.deepEqual(sheets.map((s) => s.name), ['作品計', '流通別', '月別', '売上明細', '作品の経費', '未配賦の経費', '照合']);
  assert.deepEqual(documentSheets(doc).map((s) => s.name), sheets.map((s) => s.name));
  for (const t of doc.tables) {
    const sheet = sheets.find((s) => s.name === documentSheets(doc)[doc.tables.indexOf(t)].name);
    const labels = t.columns.map((c) => c.label);
    const headerAt = sheet.rows.findIndex((row) => row.length === labels.length && row.every((cell, i) => cell === labels[i]));
    assert.ok(headerAt > 0, `${t.name} の見出し`);
    const expected = t.rows.map((row) => t.columns.map((c) => {
      const raw = row[c.key];
      if (raw === null || raw === undefined) return c.nullText ?? null;
      return c.type === 'bps' ? raw / 10000 : raw; // 率は割合のセル（書式は %）
    }));
    assert.deepEqual(sheet.rows.slice(headerAt + 1, headerAt + 1 + t.rows.length), expected, `${t.name} の行`);
    if (t.total) {
      const totalRow = sheet.rows.slice(headerAt + 1 + t.rows.length).find((row) => row[0] === '合計');
      assert.ok(totalRow, `${t.name} の合計行`);
      t.columns.forEach((c, i) => { if (i > 0) assert.equal(totalRow[i] ?? null, t.total[c.key] ?? null, `${t.name}.${c.key} の合計`); });
    }
    assert.match(sheet.rows[1][0], /作品 架空の作品（WRK-DOC-1） ／ 期間 2026-05〜2026-07 ／ 基準 計上（計上月・税抜） ／ 定義の版 work-pnl\.\d{4}-\d{2}-\d{2}/);
    assert.match(sheet.rows[2][0], /^データ時点: 2026\/08\/01 09:00/);
  }
  const flat = (name) => sheets.find((s) => s.name === name).rows.flat().filter((cell) => typeof cell === 'string');
  assert.ok(flat('作品計').includes(`出典の hash（sourceHash）: ${HASH}`));
  const checks = sheets.find((s) => s.name === '照合').rows;
  const checkHeader = checks.findIndex((row) => row[0] === '項目');
  assert.deepEqual(checks.slice(checkHeader + 1, checkHeader + 1 + doc.checks.length).map((row) => [row[0], row[1], row[2]]), doc.checks.map((check) => [check.label, 0, 'OK']));
});

test('印刷は Excel と同じ文書データのシートから出る: 月別の行と合計・流通別の「流通別の記録なし」が印刷の表にある', () => {
  const doc = buildWorkPnlDocument(input(), {sourceHash: HASH});
  const html = documentPrintHtml(doc, {generatedAt: '2026-10-10T01:00:00.000Z'});
  assert.match(html, /<title>作品別収支（架空の作品）<\/title>/);
  assert.match(html, /作品 架空の作品（WRK-DOC-1） ／ 期間 2026-05〜2026-07 ／ 基準 計上（計上月・税抜）/);
  const monthly = html.split('<h2>').find((part) => part.startsWith('月別</h2>'));
  assert.ok(monthly, '月別のページ');
  const cells = [...monthly.matchAll(/<tr( class="total")?>(.*?)<\/tr>/g)].map((match) => [...match[2].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) => cell[1])).filter((row) => row.length);
  const m = table(doc, 'monthly');
  const yenText = (value) => cellText({type: 'yen'}, value);
  const monthText = (value) => cellText({type: 'month'}, value);
  assert.deepEqual(cells.slice(0, 3), m.rows.map((row) => [monthText(row.month), ...['sales', 'expense', 'balance', 'd:svod', 'd:dvd'].map((key) => yenText(row[key]))]));
  assert.deepEqual(cells[3], ['合計', ...['sales', 'expense', 'balance', 'd:svod', 'd:dvd'].map((key) => yenText(m.total[key]))]);
  const distribution = html.split('<h2>').find((part) => part.startsWith('流通別</h2>'));
  assert.equal((distribution.match(/流通別の記録なし/g) || []).length, 2, 'SVOD と DVD の経費の欄');
  assert.equal(documentPrintHtml(doc, {sheetIndex: 2, generatedAt: '2026-10-10T01:00:00.000Z'}).split('<h2>').length, 2, '1枚だけ選んで印刷できる');
});

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let rendered = null;
async function renderer() {
  rendered ??= buildRenderer();
  return rendered;
}
async function buildRenderer() {
  const {build} = await import('esbuild');
  const result = await build({
    stdin: {
      contents: "import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {WorkPnlDocumentView, WorkPnlReportScreen} from './src/reports/WorkPnlReport.jsx'; import {ReportOutputBar} from './src/ui/ReportOutputBar.jsx';\n"
        + 'export const view = (props) => renderToStaticMarkup(React.createElement(WorkPnlDocumentView, props));\n'
        + 'export const screen = (props) => renderToStaticMarkup(React.createElement(WorkPnlReportScreen, props));\n'
        + 'export const bar = (props) => renderToStaticMarkup(React.createElement(ReportOutputBar, props));',
      resolveDir: appDir, loader: 'jsx', sourcefile: 'work-pnl-document-entry.jsx',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', logLevel: 'silent', loader: {'.css': 'empty'},
  });
  const dir = mkdtempSync(join(tmpdir(), 'on-work-pnl-doc-'));
  const file = join(dir, 'work-pnl-doc.cjs');
  writeFileSync(file, result.outputFiles[0].text);
  try { return createRequire(import.meta.url)(file); } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('作品別収支の画面は文書データの表から描き、読んだ文書の sourceHash を描き終えたときだけ data-ready に付ける', async (t) => {
  let view, bar;
  try { ({view, bar} = await renderer()); } catch (error) {
    if (/EPERM|EACCES|spawn/.test(String(error))) { t.skip('サンドボックスでは esbuild の子プロセスを起動できない'); return; }
    throw error;
  }
  const doc = buildWorkPnlDocument(input(), {sourceHash: HASH});
  const html = view({doc, readyHash: HASH});
  assert.match(html, new RegExp(`data-source-hash="${HASH}"`));
  assert.match(html, new RegExp(`data-ready="${HASH}"`));
  // 作品計のタイルは文書データの作品計の行
  const tiles = [...html.matchAll(/<div><span>([^<]+)<\/span><strong[^>]*>([^<]+)<\/strong>/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(tiles.map((tile) => tile[0]), ['売上（税抜）', '経費（税抜・作品に付いた分）', '差額（売上−経費）', '経費のうち制作費']);
  for (const [label, amount] of [['売上（税抜）', 1300], ['経費（税抜・作品に付いた分）', 300], ['差額（売上−経費）', 1000], ['経費のうち制作費', 0]]) {
    const tile = tiles.find((item) => item[0] === label);
    assert.ok(tile, label);
    assert.equal(tile[1].replace(/[^\d-]/g, ''), String(amount), label);
  }
  // 流通別のカード（文書データの流通別の行）。流通の経費は「流通別の記録なし」
  for (const label of ['SVOD', 'DVD', '流通に紐づかない経費']) assert.match(html, new RegExp(`<span class="rp-card-title">${label}</span>`));
  // 取引区分は取引ごとに1つのバッジ（文書データの「、」でつないだ文字を分けて出す）
  assert.deepEqual([...html.matchAll(/<span class="rp-badge">([^<]+)<\/span>/g)].map((match) => match[1]), ['取引区分: FLAT（定額）', '取引区分: MG', '取引区分: ロイヤリティ']);
  assert.equal((html.match(/流通別の記録なし/g) || []).length, 2);
  // 月別の表の行と合計行は文書データの月別の行と合計（0 は表では「—」）
  const grid = html.slice(html.indexOf('aria-label="月別の収支"'));
  const textOf = (cell) => cell.replace(/<[^>]+>/g, '');
  const rowsOf = (part) => [...part.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) => textOf(cell[1])));
  const m = table(doc, 'monthly');
  const keys = ['sales', 'expense', 'balance', 'd:svod', 'd:dvd'];
  const screenYen = (value) => (value === 0 ? '—' : cellText({type: 'yen'}, value));
  assert.deepEqual(rowsOf(grid.slice(grid.indexOf('<tbody>'), grid.indexOf('</tbody>'))), m.rows.map((row) => [cellText({type: 'month'}, row.month), ...keys.map((key) => screenYen(row[key]))]));
  assert.deepEqual(rowsOf(grid.slice(grid.indexOf('<tfoot>'), grid.indexOf('</tfoot>'))), [['合計（3行）', ...keys.map((key) => cellText({type: 'yen'}, m.total[key]))]]);
  assert.match(html, /照合OK/);
  assert.match(html, new RegExp(doc.definitionVersion.replace('.', '\\.')));
  const okBar = bar({document: doc, name: doc.title});
  assert.match(okBar, /<button type="button" class="secondary">Excel<\/button>/, '照合 OK なら Excel を押せる');
  assert.doesNotMatch(okBar, /disabled/);

  const loading = view({doc, readyHash: null});
  assert.doesNotMatch(loading, /data-ready=/, '読み込み中・条件を変えた直後は付けない');
  assert.match(loading, new RegExp(`data-source-hash="${HASH}"`));
  assert.doesNotMatch(view({doc, readyHash: 'b'.repeat(64)}), /data-ready=/, '表示中の文書と違う hash は付けない');

  const broken = input();
  broken.lines.push({...broken.lines[0], id: 4, month: '2026-09', accounting_month: '2026-09', amount: 999});
  const ngDoc = buildWorkPnlDocument(broken, {sourceHash: HASH});
  const ng = view({doc: ngDoc, readyHash: HASH});
  assert.match(ng, /照合NG/);
  assert.match(ng, /NG: 売上明細の和＝作品計の売上（差額 /);
  const ngBar = bar({document: ngDoc, name: ngDoc.title});
  for (const label of ['Excel', 'CSV', '印刷・PDF', '印刷用HTML']) {
    assert.match(ngBar, new RegExp(`<button type="button" class="secondary" disabled="">${label}</button>`), `照合 NG では ${label} を押せない`);
  }
  assert.match(ngBar, /照合が NG の項目が1件あるため/);
  assert.match(ng, /<details[^>]* open=""/, '照合の内訳を開いて見せる');
});

test('作品別収支の画面の枠: 出力ボタンは表示中の文書データで関門を通し、data-ready は読み終わった応答の hash を渡されたときだけ付く', async (t) => {
  let screen;
  try { ({screen} = await renderer()); } catch (error) {
    if (/EPERM|EACCES|spawn/.test(String(error))) { t.skip('サンドボックスでは esbuild の子プロセスを起動できない'); return; }
    throw error;
  }
  const work = {id: 7, code: 'WRK-DOC-1', title: '架空の作品'};
  const values = {workId: '7', from: '2026-05', to: '2026-07', fiscalYear: 2026, period: 'custom', fiscalStartMonth: 4, valid: true};
  const query = 'workId=7&from=2026-05&to=2026-07';
  const props = (doc, extra = {}) => ({state: {body: {ok: true, work, document: doc}, query}, doc, values, works: [work], ...extra});
  const buttons = (html) => [...html.matchAll(/<button type="button" class="secondary"( disabled="")?>(Excel|CSV|印刷・PDF|印刷用HTML)<\/button>/g)].map((match) => [match[2], Boolean(match[1])]);

  const okDoc = buildWorkPnlDocument(input(), {sourceHash: HASH});
  const ready = screen(props(okDoc, {readyHash: HASH}));
  assert.match(ready, /<h2>作品別収支（架空の作品）<\/h2>/);
  assert.match(ready, new RegExp(`data-ready="${HASH}"`), '読み終わった応答の hash');
  assert.deepEqual(buttons(ready), [['Excel', false], ['CSV', false], ['印刷・PDF', false], ['印刷用HTML', false]], '照合 OK の文書なら押せる');
  assert.doesNotMatch(ready, /照合が NG の項目/);

  const loading = screen(props(okDoc, {state: {body: {ok: true, work, document: okDoc}, query, loading: true}, readyHash: null}));
  assert.match(loading, new RegExp(`data-source-hash="${HASH}"`), '読み直すあいだも前の文書は出す');
  assert.doesNotMatch(loading, /data-ready=/, '読み直すあいだは付けない');

  // 出力ボタンに渡すのは表示中の文書データ（渡し忘れると関門を通らず、照合 NG の文書でも押せてしまう）
  const broken = input();
  broken.lines.push({...broken.lines[0], id: 4, month: '2026-09', accounting_month: '2026-09', amount: 999});
  const ngDoc = buildWorkPnlDocument(broken, {sourceHash: HASH});
  const ng = screen(props(ngDoc, {readyHash: HASH}));
  assert.deepEqual(buttons(ng), [['Excel', true], ['CSV', true], ['印刷・PDF', true], ['印刷用HTML', true]], '照合 NG の文書では押せない');
  assert.match(ng, /照合が NG の項目が1件あるため/);

  const failure = screen({state: {failure: '集計できませんでした'}, doc: null, readyHash: null, values, works: [work]});
  assert.match(failure, /集計できませんでした/);
  assert.doesNotMatch(failure, /rp-document|data-ready=/);
  assert.deepEqual(buttons(failure), [], '文書が無ければ出力ボタンを出さない');
});

const wait = (ms = 10) => new Promise((done) => setTimeout(done, ms));
async function waitFor(check, what, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await wait(10);
  }
  assert.fail(`待っても起きなかった: ${what}`);
}

test('作品別収支の画面の状態: 読み終えると hash が付き、条件を変えて読み直すあいだ・誤り・応答の誤り・条件の誤りのあいだは外れる（本物の React）', async () => {
  globalThis.window = {event: undefined, addEventListener() {}, removeEventListener() {}, HTMLIFrameElement: class {}};
  const React = (await import('react')).default;
  const {createRoot} = await import('react-dom/client');
  const {useWorkPnlDocument} = await import('../src/reports/use-work-pnl-document.mjs');
  const work = {id: 7, code: 'WRK-DOC-1', title: '架空の作品'};
  const queryTo = (to) => new URLSearchParams({workId: '7', from: '2026-05', to}).toString();
  const hashOf = {'2026-07': 'a'.repeat(64), '2026-08': 'b'.repeat(64), '2026-09': 'c'.repeat(64)};
  // 文書を返す request。応答を止める・誤りにする・ok:false を返すを切り替える
  const gate = {hold: false, fail: null, failure: null, waiters: [], sent: []};
  const release = () => { for (const done of gate.waiters.splice(0)) done(); };
  const request = async (path) => {
    gate.sent.push(path);
    if (gate.hold) await new Promise((done) => { gate.waiters.push(done); });
    if (gate.fail) throw gate.fail;
    if (gate.failure) return {ok: false, error: gate.failure};
    const to = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('to');
    return {ok: true, work, document: buildWorkPnlDocument(input(), {sourceHash: hashOf[to]})};
  };
  const out = {};
  function Harness() {
    const [query, setQuery] = React.useState(queryTo('2026-07'));
    const [valid, setValid] = React.useState(true);
    out.setQuery = setQuery;
    out.setValid = setValid;
    out.result = useWorkPnlDocument({request, query, valid});
    return null;
  }
  const ownerDocument = {nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null};
  const container = {nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument, addEventListener() {}, removeEventListener() {}, set textContent(value) {}};
  const root = createRoot(container);
  root.render(React.createElement(Harness));
  try {
    await waitFor(() => out.result?.hash, '最初の応答の hash');
    assert.equal(out.result.hash, hashOf['2026-07']);
    assert.equal(out.result.doc.sourceHash, hashOf['2026-07']);
    assert.deepEqual(gate.sent, [`/reports/work-pnl?${queryTo('2026-07')}`]);

    // 条件を変えて読み直すあいだ: 前の文書は出したまま、hash は外す。届くと新しい文書の hash
    gate.hold = true;
    out.setQuery(queryTo('2026-08'));
    await waitFor(() => out.result.state.loading, '送信中');
    assert.equal(out.result.doc.sourceHash, hashOf['2026-07'], '表示中は前の文書');
    assert.equal(out.result.hash, null, '送信中は付けない');
    gate.hold = false;
    release();
    await waitFor(() => out.result.hash === hashOf['2026-08'], '新しい応答の hash');
    assert.equal(out.result.state.loading, undefined);

    // 通信の誤り: 文書を外し hash も付けない。再試行で付く
    gate.fail = new Error('架空の通信の誤り');
    out.setQuery(queryTo('2026-09'));
    await waitFor(() => out.result.state.error, '誤り');
    assert.equal(out.result.hash, null);
    assert.equal(out.result.doc, null);
    gate.fail = null;
    out.result.reload();
    await waitFor(() => out.result.hash === hashOf['2026-09'], '再試行のあとの hash');

    // 応答の誤り（ok:false）
    gate.failure = '集計できませんでした';
    out.result.reload();
    await waitFor(() => out.result.state.failure, '応答の誤り');
    assert.equal(out.result.hash, null);
    assert.equal(out.result.doc, null);
    gate.failure = null;

    // 条件の誤り（開始月が終了月より後など）: 読まず、状態を空にする
    const sent = gate.sent.length;
    out.setValid(false);
    await waitFor(() => !out.result.state.failure, '状態を空にする');
    await wait(30);
    assert.deepEqual(out.result.state, {});
    assert.equal(out.result.hash, null);
    assert.equal(gate.sent.length, sent, '誤りのある条件では読まない');
  } finally {
    root.unmount();
    await wait(20);
    delete globalThis.window;
  }
});
