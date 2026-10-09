import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMonth, monthRange, guessPeriod, autoReportKey, buildDefinition, defaultFields, fieldsFromDefinition, sameDefinition, evaluateRule,
  evaluateChecks, validateChecks, buildReviewRows, reviewTotals, compareControls, overlapDecisionProblem, errorTarget, friendlyMessage,
  reportLevelErrors, sourceColumnTotals, failedRowsSheet, defaultExclusionReason, integerOrNull, blankField, exclusionTotals,
} from '../src/import/wizard-model.mjs';

const HEADERS = ['作品CD', '商品ｺｰﾄﾞ', '配信区分', '対象月', '視聴/契約数', '単価(税抜)', '総額', 'PF手数料', '正味売上', '備考'];
const DATA = [
  ['WRK-DEMO', 'SKU-DIGI', 'TVOD', '2026/08', '1250', '420', '525000', '157500', '367500', '正常'],
  ['WRK-DEMO', 'SKU-DIGI', 'SVOD', '2026/08', '1', '480000', '480000', '0', '480000', '月額固定・正常'],
  ['WRK-DEMO', 'SKU-DIGI', 'EST', '2026/08', '320', '1200', '384000', '76800', '307200', '正常'],
  ['WRK-DEMO', '', 'TVOD', '2026/08', '45', '500', '22500', '6750', '16000', '要修正'],
];
const csv = (rows) => [HEADERS, ...rows].map((row) => row.join(',')).join('\r\n');

function demoFields() {
  const {fields, notes} = defaultFields({headers: HEADERS, sampleRows: DATA, productIds: [1], period: guessPeriod(HEADERS, DATA)});
  fields.recognition_basis_id = {...blankField('literal'), value: '2'};
  fields.basis_date = {...blankField('literal'), value: '2026-09-05'};
  fields.basis_reason = {...blankField('literal'), value: '受領月で計上'};
  fields.tax_amount = blankField('zero');
  fields.amount_inc_tax = blankField('same_ex');
  return {fields, notes};
}

test('年月の読み方と対象期間の候補', () => {
  assert.equal(normalizeMonth('2026/08'), '2026-08');
  assert.equal(normalizeMonth('2026年8月'), '2026-08');
  assert.equal(normalizeMonth('２０２６年８月'), '2026-08');
  assert.equal(normalizeMonth('202608'), '2026-08');
  assert.equal(normalizeMonth('2026-08-15'), '2026-08');
  assert.equal(normalizeMonth('2026/13'), null);
  assert.equal(normalizeMonth('8月'), null);
  assert.deepEqual(monthRange('2026-02'), {from: '2026-02-01', to: '2026-02-28'});
  assert.deepEqual(guessPeriod(HEADERS, DATA), {month: '2026-08', column: '対象月', from: '2026-08-01', to: '2026-08-31'});
  assert.equal(guessPeriod(HEADERS, [...DATA, ['X', '', '', '2026/09', '1', '1', '1', '0', '1', '']]), null, '月がそろわなければ候補にしない');
  assert.equal(autoReportKey({partnerCode: 'PT-DIGITAL', periodFrom: '2026-08-01', rawHash: 'ABCDEF0123456789'}), 'PT-DIGITAL-202608-ABCDEF01');
  assert.equal(autoReportKey({partnerId: 7, periodFrom: '', rawHash: ''}), 'P7-000000-manual');
});

test('列対応の初期値: 同義語・対象月・唯一の商品から埋め、税額と税込は人に選ばせる', () => {
  const {fields, notes} = defaultFields({headers: HEADERS, sampleRows: DATA, productIds: [1], period: guessPeriod(HEADERS, DATA)});
  assert.equal(fields.amount_ex_tax.source, '正味売上');
  assert.equal(fields.quantity.source, '視聴/契約数');
  assert.equal(fields.product_id.value, '1');
  assert.equal(fields.period_from.value, '2026-08-01');
  assert.equal(fields.report_key.mode, 'auto');
  assert.equal(fields.tax_amount.mode, '');
  assert.equal(fields.amount_inc_tax.mode, '');
  assert.match(notes.period_from, /対象月/);
  const built = buildDefinition(fields, {headers: HEADERS, partnerId: 2, autoKey: 'K'});
  assert.deepEqual(built.errors.map((error) => error.target).sort(), ['accounting_month', 'amount_inc_tax', 'tax_amount'], '計上基準を使わないときの計上月・税額・税込は人が決める');
  assert.ok(built.errors.some((error) => error.target === 'tax_amount' && /0円/.test(error.message)));
});

test('版の定義: 既存APIと同じ形で、使わない列は ignoredColumns、訂正版は報告番号と訂正元を固定する', () => {
  const {fields} = demoFields();
  const built = buildDefinition(fields, {headers: HEADERS, partnerId: 2, autoKey: 'PT-DIGITAL-202608-abc'});
  assert.deepEqual(built.errors, []);
  const byTarget = Object.fromEntries(built.definition.mappings.map((rule) => [rule.target, rule]));
  assert.deepEqual(byTarget.report_key, {target: 'report_key', mode: 'literal', valueType: 'string', value: 'PT-DIGITAL-202608-abc'});
  assert.deepEqual(byTarget.partner_id, {target: 'partner_id', mode: 'literal', valueType: 'integer', value: '2'});
  assert.deepEqual(byTarget.tax_amount, {target: 'tax_amount', mode: 'literal', valueType: 'integer', value: '0'});
  assert.deepEqual(byTarget.amount_inc_tax, {target: 'amount_inc_tax', mode: 'source', source: '正味売上'});
  assert.equal(byTarget.report_received_on.value, '2026-09-05');
  assert.equal(byTarget.supersedes_id, undefined);
  assert.deepEqual(built.definition.ignoredColumns, ['作品CD', '商品ｺｰﾄﾞ', '対象月', '単価(税抜)', '総額', 'PF手数料', '備考']);
  const correction = buildDefinition(fields, {headers: HEADERS, partnerId: 2, autoKey: 'X', correction: {id: 9, reportKey: 'ORIGINAL'}});
  const corrected = Object.fromEntries(correction.definition.mappings.map((rule) => [rule.target, rule]));
  assert.equal(corrected.report_key.value, 'ORIGINAL');
  assert.deepEqual(corrected.supersedes_id, {target: 'supersedes_id', mode: 'literal', valueType: 'integer', value: '9'});
  // 入力の誤り
  const bad = buildDefinition({...fields, period_to: {...blankField('literal'), value: '2026-07-31'}, amount_ex_tax: {...blankField('subtract'), operands: ['総額', '']}, amount_inc_tax: blankField('same_ex'), tax_amount: {...blankField('source'), source: 'なし'}}, {headers: HEADERS, partnerId: 2, autoKey: 'K'});
  const messages = bad.errors.map((error) => error.message).join('／');
  assert.match(messages, /末日が初日より前/);
  assert.match(messages, /2つの列/);
  assert.match(messages, /「なし」が見出しにありません/);
  assert.match(messages, /税額が0円のときだけ/);
  // 前回の版から戻す（期間・報告番号の固定値は戻さない。税抜と同じは same_ex に戻す）
  const restored = fieldsFromDefinition(built.definition, HEADERS);
  assert.equal(restored.amount_ex_tax.source, '正味売上');
  assert.equal(restored.amount_inc_tax.mode, 'same_ex');
  assert.equal(restored.tax_amount.mode, 'zero');
  assert.equal(restored.recognition_basis_id.value, '2');
  assert.equal(restored.basis_reason.value, '受領月で計上');
  assert.equal(restored.period_from, undefined);
  assert.equal(restored.report_key, undefined);
  const again = defaultFields({headers: HEADERS, sampleRows: DATA, productIds: [5], previous: {definition: built.definition, versionNo: 3}, period: guessPeriod(HEADERS, DATA)});
  assert.match(again.notes.amount_ex_tax, /版3/);
  assert.equal(again.fields.product_id.value, '5', '前回の商品がこの作品に結び付いていなければ選び直す');
  assert.ok(sameDefinition(built.definition, {...built.definition, ignoredColumns: [...built.definition.ignoredColumns].reverse()}));
  assert.equal(sameDefinition(built.definition, correction.definition), false);
});

test('FR-REV-INTAKE-010 行ごとの評価と検算', () => {
  assert.deepEqual(evaluateRule({target: 'amount_ex_tax', mode: 'subtract', operands: ['総額', 'PF手数料']}, {総額: '22,500', PF手数料: '６７５０'}), {value: '15750', error: null});
  assert.match(evaluateRule({target: 'amount_ex_tax', mode: 'add', operands: ['a', 'b']}, {a: '1', b: 'x'}).error, /「b」が整数ではない/);
  assert.equal(integerOrNull('¥1,200'), 1200);
  assert.equal(integerOrNull('1.5'), null);
  const rows = DATA.map((cells, index) => ({sourceRow: index + 5, values: Object.fromEntries(HEADERS.map((h, i) => [h, cells[i]]))}));
  const issues = evaluateChecks([{type: 'difference', left: '総額', right: 'PF手数料', result: '正味売上'}, {type: 'required', column: '商品ｺｰﾄﾞ'}], rows);
  assert.deepEqual(issues.map((issue) => issue.sourceRow), [8, 8]);
  assert.match(issues[0].message, /15,750 ですが、「正味売上」は 16,000/);
  assert.match(issues[1].message, /「商品ｺｰﾄﾞ」が空欄/);
  assert.deepEqual(evaluateChecks([{type: 'product', left: '視聴/契約数', right: '単価(税抜)', result: '総額'}], rows.slice(0, 3)), []);
  assert.deepEqual(validateChecks([{type: 'difference', left: '総額', right: '', result: '正味売上'}, {type: 'required', column: 'ない列'}, {type: 'x'}], HEADERS),
    ['検算1: 列をすべて選んでください', '検算2: 列「ない列」が見出しにありません', '検算3: 種類を選んでください']);
});

test('FR-REV-INTAKE-021 表で確かめる: サーバーの行とエラーを原本の行番号に対応させ、検算・合計行・計算できない行をエラーにする', () => {
  const {fields} = demoFields();
  const {definition} = buildDefinition(fields, {headers: HEADERS, partnerId: 2, autoKey: 'K'});
  const selection = {canonicalCsv: csv(DATA), sourceRowNumbers: [5, 6, 7, 8]};
  const data = (ex) => ({partner_id: 2, product_id: 1, description: 'TVOD', quantity: 1, amount_ex_tax: ex, tax_amount: 0, amount_inc_tax: ex, accounting_month: '2026-09', sales_period_from: '2026-08-01', sales_period_to: '2026-08-31'});
  const preview = {ok: false, rows: [{rowNo: 2, destination: 'sale_lines', data: data(367500)}, {rowNo: 3, destination: 'sale_lines', data: data(480000)}, {rowNo: 4, destination: 'sale_lines', data: data(307200)}],
    errors: [{rowNo: 5, message: '税込額が税抜額＋税額と一致しません'}, {rowNo: 0, message: '同一報告は登録済みです（report 3）'}]};
  const rows = buildReviewRows({selection, mappings: definition.mappings, preview, checks: [{type: 'difference', left: '総額', right: 'PF手数料', result: '正味売上'}]});
  assert.deepEqual(rows.map((row) => [row.sourceRow, row.status]), [[5, 'ok'], [6, 'ok'], [7, 'ok'], [8, 'error']]);
  assert.deepEqual(rows[3].issues.map((issue) => [issue.kind, issue.target]), [['error', 'amount_inc_tax'], ['check', 'amount_ex_tax']], '検算の列「正味売上」は税抜に使っているので税抜のセルに出す');
  assert.equal(rows[3].issues[0].message, '税込が「税抜＋税額」と一致しません');
  assert.equal(rows[3].values.amount_ex_tax, 16000, 'エラーの行は手元の評価で値を出す');
  assert.deepEqual(reportLevelErrors(preview), ['同じ内容の報告は登録済みです']);
  const totals = reviewTotals(rows);
  assert.deepEqual({count: totals.count, errors: totals.errors, ex: totals.amount_ex_tax, tax: totals.tax_amount, inc: totals.amount_inc_tax}, {count: 3, errors: 1, ex: 1154700, tax: 0, inc: 1154700});
  const sums = Object.fromEntries(sourceColumnTotals(HEADERS, rows.filter((row) => row.status === 'ok')).map((item) => [item.column, item.total]));
  assert.equal(sums['総額'], 1389000);
  assert.equal(sums['PF手数料'], 234300);
  assert.equal(sums['正味売上'], 1154700);
  assert.deepEqual(compareControls({rowCount: '3', amountExTax: '1,154,700', amountIncTax: ''}, totals).map((item) => [item.key, item.match]), [['rowCount', true], ['amountExTax', true]]);
  const mismatch = compareControls({amountExTax: '1154000'}, totals)[0];
  assert.equal(mismatch.match, false);
  assert.equal(mismatch.difference, 700);
  assert.equal(compareControls({rowCount: 'abc'}, totals)[0].invalid, true);
  // 合計行の候補は、確かめて取り込むと決めるまで注意として残す
  const withTotal = buildReviewRows({selection, mappings: definition.mappings, preview: null, totalRows: [{row: 7, reason: '「合計」を含む行（合計行の可能性）'}]});
  assert.equal(withTotal.find((row) => row.sourceRow === 7).status, 'warn');
  assert.equal(buildReviewRows({selection, mappings: definition.mappings, totalRows: [{row: 7, reason: 'x'}], acceptedRows: [7]}).find((row) => row.sourceRow === 7).status, 'ok');
  assert.equal(defaultExclusionReason(withTotal.find((row) => row.sourceRow === 7)), '合計の行のため');
  // 計算に使えない値は、その行のエラー（ファイル全体を止めない）
  const arithmetic = buildReviewRows({selection: {canonicalCsv: csv([DATA[0], [...DATA[1].slice(0, 6), '不明', '0', '480000', '']]), sourceRowNumbers: [5, 6]}, mappings: [{target: 'amount_ex_tax', mode: 'subtract', operands: ['総額', 'PF手数料']}]});
  assert.deepEqual(arithmetic.map((row) => row.status), ['ok', 'error']);
  assert.match(arithmetic[1].issues[0].message, /「総額」が整数ではない/);
  const sheet = failedRowsSheet(HEADERS, rows);
  assert.deepEqual(sheet[0].slice(-2), ['原本の行', 'エラーの理由']);
  assert.equal(sheet.length, 2);
  assert.equal(sheet[1][HEADERS.length], 8);
  assert.match(sheet[1][HEADERS.length + 1], /税込.*／.*検算/);
});

test('エラー文の対象列と日本語', () => {
  assert.equal(errorTarget('有効な整数ではありません: -30', {quantity: '-30', amount_ex_tax: '100'}), 'quantity');
  assert.equal(errorTarget('日付はYYYY-MM-DD形式です: 2026/08', {period_from: '2026/08'}), 'period_from');
  assert.equal(errorTarget('商品が選択作品・販路に結び付いていません'), 'product_id');
  assert.equal(errorTarget('販売期間が報告対象期間外です'), 'sales_period_from');
  assert.equal(friendlyMessage('有効な整数ではありません: -30'), '「-30」は使えません（0以上の整数が必要です）');
  assert.match(friendlyMessage('訂正版はsupersedes_id=4を指定してください'), /訂正版として取り込むか/);
  assert.match(friendlyMessage('同じ元CSVは登録済みです（report 1）。訂正フローを使用してください'), /二重の取込/);
  assert.doesNotMatch(friendlyMessage('同じ元CSVは登録済みです（report 1）。訂正フローを使用してください'), /report/);
  assert.equal(friendlyMessage('試作の一括取込は100行までです'), '1回に取り込めるのは100行までです。ファイルを分けてください');
  assert.equal(friendlyMessage('知らない文'), '知らない文');
});

test('重なる報告の扱い（画面とサーバーで同じ判定）と除外の合計', () => {
  const overlaps = [{id: 4}, {id: 7}];
  assert.equal(overlapDecisionProblem([], null, null), null);
  assert.match(overlapDecisionProblem(overlaps, null, null), /訂正版として取り込むか/);
  assert.match(overlapDecisionProblem(overlaps, {mode: 'separate', reason: ' '}, null), /理由/);
  assert.equal(overlapDecisionProblem(overlaps, {mode: 'separate', reason: '追加分'}, null), null);
  // 訂正で対象期間を直すと、元の報告（9）は重なりに入らないことがある。元の報告以外の重なり（4・7）には理由を求めて通す
  assert.match(overlapDecisionProblem(overlaps, {mode: 'supersede'}, 9), /ほかにも重なる報告が2件/);
  assert.equal(overlapDecisionProblem(overlaps, {mode: 'supersede', reason: '期間の誤りを訂正。別の月の報告とは別物'}, 9), null);
  assert.match(overlapDecisionProblem(overlaps, {mode: 'supersede'}, null), /訂正する元の報告を選んで/);
  assert.match(overlapDecisionProblem(overlaps, {mode: 'supersede'}, 4), /ほかにも重なる報告が1件/);
  assert.equal(overlapDecisionProblem([{id: 4}], {mode: 'supersede'}, 4), null);
  assert.equal(overlapDecisionProblem(overlaps, {mode: 'separate', reason: 'x'.repeat(501)}, null) !== null, true);
  assert.deepEqual(exclusionTotals([{amountExTax: 100, taxAmount: 10, amountIncTax: 110}, {amountExTax: null, taxAmount: null, amountIncTax: null}]), {count: 2, amountExTax: 100, taxAmount: 10, amountIncTax: 110, unknown: 1});
});
