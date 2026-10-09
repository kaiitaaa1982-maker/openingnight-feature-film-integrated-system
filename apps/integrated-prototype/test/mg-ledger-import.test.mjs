import test from 'node:test';
import assert from 'node:assert/strict';
import {foreignKeyViolations, openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {normalizeMgVersion, mgPeriods, MG_AMOUNT_LABELS as SERVER_LABELS} from '../src/mg.mjs';
import {
  registerMgLedgerImportRoutes, MG_AMOUNT_LABELS, MG_IMPORT_COLUMNS, mgCandidate, candidateDifference, differenceText, contractProgress, progressTotals,
  ledgerView, nextReportPeriod, derivePhases, defaultFirstClose, buildContractPayload, buildReportPayload, emptyContractForm, contractFormFromVersion,
  evaluationState, mapMgImportHeaders, sheetToMgImport, workbookToMgImport, splitCsv, parseMgImportRows, planMgImport, priorAppliedYen, sumMismatch,
  mgTemplateSheets, supersededIds, fillAmounts,
} from '../src/mg-ledger-import.mjs';
import {encodeReportXlsx} from '../src/xlsx-report.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';

const HEADERS = MG_IMPORT_COLUMNS.map((column) => column.header);

async function fixture(t) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  registerMgLedgerImportRoutes(app, app.ux);
  const login = async (email) => {
    const r = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    return r.headers.get('set-cookie').split(';')[0];
  };
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, input, cookie = admin) => {
    const r = await app.request(`/api${path}`, {method: input ? 'POST' : 'GET', headers: {cookie, ...(input ? {'content-type': 'application/json'} : {})}, body: input ? JSON.stringify(input) : undefined});
    return {status: r.status, data: await r.json()};
  };
  return {db, app, admin, login, req};
}
const good = (r) => { assert.ok(r.status < 300 && r.data.ok === true, JSON.stringify(r.data)); return r.data; };
const terms = (overrides = {}) => ({
  direction: 'incoming', code: 'MG-IN', title: '架空の受取MG', partnerId: 2, contractDate: '2026-09-20', contractSourceReference: 'CONTRACT-IN',
  mgAmountYen: 100000, startsOn: '2026-10-01', endsOn: '2027-09-30', mode: 'cross', reason: '架空条件の登録', sourceReference: 'TERMS-IN',
  products: [{productId: 1, evaluationYen: 70000}, {productId: 2, evaluationYen: 30000}],
  phases: [{startsOn: '2026-10-01', endsOn: '2027-09-30', intervalMonths: 3, firstCloseOn: '2026-12-31', reportOffsetMonths: 1, reportDay: 28, payOffsetMonths: 2, payDay: 28}],
  ...overrides,
});
// 取込の1行（見出しの並びどおりの文字）
const importRow = (cells, rowNo = 2) => ({rowNo, values: MG_IMPORT_COLUMNS.map((column) => (cells[column.key] === undefined ? '' : String(cells[column.key])))});
const preview = (f, rows, extra = {}) => f.req('/mg/ledger/import/preview', {direction: 'incoming', fileName: '架空MG報告.xlsx', headers: HEADERS, rows, ...extra});
const commit = (f, rows, fingerprint, extra = {}) => f.req('/mg/ledger/import/commit', {direction: 'incoming', fileName: '架空MG報告.xlsx', headers: HEADERS, rows, fingerprint, confirmed: true, ...extra});
const STORED = 'period_from,period_to,report_received_on,accounting_month,source_reference,reported_eligible_yen,applied_recoup_yen,reported_overage_yen,recognized_yen,status,acknowledgement,confirmation_reason';
const stored = (db) => db.all(`SELECT ${STORED},(SELECT o.source_reference FROM mg_ledger_entries o WHERE o.id=l.reverses_entry_id) AS reverses_source,(SELECT p.sku FROM products p WHERE p.id=l.product_id) AS sku FROM mg_ledger_entries l ORDER BY source_reference`);

test('FR-SETL-MGL-007 候補: 実充当は未消化残高と消化対象の小さい方、超過報告は残り。差は入力−候補', () => {
  assert.deepEqual(mgCandidate({eligibleYen: 30000, guaranteeYen: 100000, priorAppliedYen: 50000}), {remainingBeforeYen: 50000, appliedYen: 30000, overageYen: 0, remainingAfterYen: 20000, reachesNow: false});
  assert.deepEqual(mgCandidate({eligibleYen: 80000, guaranteeYen: 100000, priorAppliedYen: 50000}), {remainingBeforeYen: 50000, appliedYen: 50000, overageYen: 30000, remainingAfterYen: 0, reachesNow: true});
  assert.equal(mgCandidate({eligibleYen: 5000, guaranteeYen: 100000, priorAppliedYen: 120000}).appliedYen, 0, '到達後は全額が超過');
  assert.equal(mgCandidate({eligibleYen: 5000, guaranteeYen: 0, priorAppliedYen: 0}).overageYen, 5000);
  assert.equal(mgCandidate({eligibleYen: '', guaranteeYen: 100, priorAppliedYen: 0}), null);
  assert.equal(mgCandidate({eligibleYen: -1, guaranteeYen: 100, priorAppliedYen: 0}), null);
  const candidate = mgCandidate({eligibleYen: 12000, guaranteeYen: 100000, priorAppliedYen: 0});
  const diff = candidateDifference(candidate, {appliedRecoupYen: 10000, reportedOverageYen: 2000});
  assert.deepEqual(diff, {appliedDiffYen: -2000, overageDiffYen: 2000, differs: true});
  assert.equal(differenceText(diff), '実充当 −2,000円・超過報告 +2,000円');
  assert.equal(candidateDifference(candidate, {appliedRecoupYen: 12000, reportedOverageYen: 0}).differs, false);
  assert.deepEqual(fillAmounts({eligibleYen: 12000, appliedRecoupYen: null, reportedOverageYen: null, candidate}), {appliedRecoupYen: 12000, reportedOverageYen: 0, filled: ['appliedRecoupYen', 'reportedOverageYen']});
  assert.deepEqual(fillAmounts({eligibleYen: 12000, appliedRecoupYen: 5000, reportedOverageYen: '', candidate}), {appliedRecoupYen: 5000, reportedOverageYen: 7000, filled: ['reportedOverageYen']}, '片方だけ入れたら残り');
  assert.deepEqual(fillAmounts({eligibleYen: 12000, appliedRecoupYen: null, reportedOverageYen: 20000, candidate}), {appliedRecoupYen: 0, reportedOverageYen: 20000, filled: ['appliedRecoupYen']});
  assert.deepEqual(fillAmounts({eligibleYen: null, appliedRecoupYen: null, reportedOverageYen: null, candidate: null}).filled, [], '消化対象が無ければ埋めない');
  assert.deepEqual(fillAmounts({eligibleYen: 100, appliedRecoupYen: 'abc', reportedOverageYen: null, candidate}).filled, [], '読めない値からは埋めない');
  assert.match(sumMismatch({reportedEligibleYen: 100, appliedRecoupYen: 50, reportedOverageYen: 10}), /一致しません/);
  assert.equal(sumMismatch({reportedEligibleYen: 100, appliedRecoupYen: 90, reportedOverageYen: 10}), '');
});

test('金額の呼び名は画面・取込・サーバーで同じ（消化対象・実充当・超過報告・計上）', () => {
  assert.deepEqual(Object.values(MG_AMOUNT_LABELS), ['消化対象', '実充当', '超過報告', '計上']);
  assert.equal(MG_AMOUNT_LABELS, SERVER_LABELS);
  for (const label of Object.values(MG_AMOUNT_LABELS)) assert.ok(HEADERS.includes(label), `取込の見出しに${label}`);
});

test('FR-SETL-MGL-008 FR-SETL-MGL-012 契約の回収状況と台帳の累計・残高は訂正前を除いて積み上げる', () => {
  const contracts = [{id: 10, code: 'MG-A', title: 'A', versions: [{id: 100, version: 1, mg_amount_yen: 100000, products: []}]},
    {id: 11, code: 'MG-B', title: 'B', versions: [{id: 110, version: 1, mg_amount_yen: 0, products: []}]}];
  const row = (id, month, applied, extra = {}) => ({id, incoming_contract_id: 10, term_version_id: 100, product_id: 1, sku: 'SKU', product_name: '商品', period_from: `${month}-01`, period_to: `${month}-28`, accounting_month: month, source_reference: `R${id}`, reported_eligible_yen: applied, applied_recoup_yen: applied, reported_overage_yen: 0, recognized_yen: 0, status: 'unverified', ...extra});
  const ledger = [row(1, '2026-10', 40000), row(2, '2026-11', 50000), row(3, '2026-11', 45000, {reverses_entry_id: 2, status: 'reviewed'}), row(4, '2026-12', 30000)];
  assert.deepEqual([...supersededIds(ledger)], [2]);
  const progress = contractProgress(contracts[0], ledger, 'incoming');
  assert.equal(progress.cumulativeAppliedYen, 115000);
  assert.equal(progress.remainingYen, 0);
  assert.equal(progress.exceedYen, 15000);
  assert.equal(progress.status.label, '到達済');
  assert.equal(progress.barPercent, 100);
  assert.equal(progress.unverifiedCount, 2);
  assert.equal(contractProgress(contracts[1], ledger, 'incoming').status.label, '保証額0円');
  assert.equal(contractProgress(contracts[1], ledger, 'incoming').rate, null);
  const totals = progressTotals([progress, contractProgress(contracts[1], ledger, 'incoming')]);
  assert.equal(totals.guaranteeYen, 100000);
  assert.equal(totals.cumulativeAppliedYen, 115000);
  const view = ledgerView({ledger, contracts, direction: 'incoming'});
  assert.deepEqual(view.map((r) => [r.id, r.cumulativeAppliedYen, r.remainingYen]), [[1, 40000, 60000], [3, 85000, 15000], [4, 115000, 0]]);
  const history = ledgerView({ledger, contracts, direction: 'incoming', showHistory: true});
  assert.equal(history.find((r) => r.id === 2).superseded, true);
  assert.equal(history.find((r) => r.id === 2).cumulativeAppliedYen, null, '訂正前の行は累計に入れない');
  assert.equal(history.find((r) => r.id === 3).reversesSource, 'R2');
  assert.deepEqual(ledgerView({ledger, contracts, direction: 'incoming', month: '2026-12'}).map((r) => [r.id, r.cumulativeAppliedYen]), [[4, 115000]], '絞込後も累計は全期間で計算');
  assert.deepEqual(ledgerView({ledger, contracts, direction: 'outgoing'}), []);
  assert.equal(priorAppliedYen(ledger, {direction: 'incoming', contractId: 10, excludeEntryIds: [3]}), 70000);
  const periods = [{periodFrom: '2026-10-01', periodTo: '2026-10-28'}, {periodFrom: '2026-11-01', periodTo: '2026-11-28'}, {periodFrom: '2027-01-01', periodTo: '2027-01-31'}];
  assert.equal(nextReportPeriod(periods, ledger, {termVersionId: 100, productId: 1}).periodFrom, '2027-01-01');
});

test('契約フォーム: 日程の開始日・最後の終了日・1商品の評価額は導出し、サーバーの検証を通る', () => {
  assert.equal(defaultFirstClose('2026-10-15', '2027-09-30', 'eom'), '2026-10-31');
  assert.equal(defaultFirstClose('2026-10-26', '2027-09-30', '25'), '2026-11-25');
  assert.equal(defaultFirstClose('2026-10-01', '2026-10-20', 'eom'), '2026-10-20');
  // 12月開始で締め日が開始日より前なら、翌年1月の締めになる（13月にしない）
  assert.equal(defaultFirstClose('2026-12-21', '2027-12-31', '20'), '2027-01-20');
  assert.equal(defaultFirstClose('2026-12-31', '2027-12-31', '15'), '2027-01-15');
  const phases = derivePhases({startsOn: '2026-10-01', endsOn: '2027-09-30'}, [{endsOn: '2027-03-31', closeDay: 'eom', firstCloseOn: ''}, {endsOn: '', closeDay: 'eom', firstCloseOn: ''}]);
  assert.deepEqual(phases.map((p) => [p.startsOn, p.endsOn, p.firstCloseOn]), [['2026-10-01', '2027-03-31', '2026-10-31'], ['2027-04-01', '2027-09-30', '2027-04-30']]);
  const form = {...emptyContractForm('2026-09-24'), code: 'MG-X', title: '架空', partyId: '2', contractSourceReference: '契約書X', mgAmountYen: '１２０，０００円', startsOn: '2026-10-01', endsOn: '2027-09-30', reason: '新規', sourceReference: '条件書X', products: [{productId: 1, evaluationYen: ''}]};
  const built = buildContractPayload(form, {direction: 'incoming'});
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(built.body.mgAmountYen, 120000);
  assert.deepEqual(built.body.products, [{productId: 1, evaluationYen: 120000}], '1商品の評価額は保証額と同じ');
  assert.equal(built.body.partnerId, 2);
  const normalized = normalizeMgVersion(built.body);
  assert.equal(mgPeriods(normalized.phases).at(-1).periodTo, '2027-09-30');
  const multi = buildContractPayload({...form, mode: 'cross', products: [{productId: 1, evaluationYen: '¥70,000'}, {productId: 2, evaluationYen: '40000'}]}, {direction: 'incoming'});
  assert.equal(multi.ok, false);
  assert.match(multi.errors.products, /あと10,000円足りません/);
  assert.equal(evaluationState({...form, mode: 'cross', products: [{productId: 1, evaluationYen: '80,000'}, {productId: 2, evaluationYen: '40,000'}]}).differenceYen, 0);
  const missing = buildContractPayload(emptyContractForm('2026-09-24'), {direction: 'outgoing'});
  assert.equal(missing.errors.partyId, '仕入先・権利元を選択してください');
  assert.equal(missing.errors.mgAmountYen, 'MG保証額を入力してください');
  const revision = contractFormFromVersion({code: 'MG-X', title: '架空', party_id: 2, contract_date: '2026-09-20', source_reference: '契約書X'},
    {mg_amount_yen: 100000, starts_on: '2026-10-01', ends_on: '2027-09-30', mode: 'cross', source_reference: '条件書X', special_unverified: 0,
      products: [{product_id: 1, evaluation_yen: 70000}, {product_id: 2, evaluation_yen: 30000}],
      phases: [{ends_on: '2027-09-30', interval_months: 3, close_day: 'eom', first_close_on: '2026-12-31', report_offset_months: 1, report_day: 28, pay_offset_months: 2, pay_day: 28}]});
  assert.equal(revision.sourceReference, '条件書X', '条件根拠は前回の版を既定にする');
  assert.equal(revision.reason, '', '改訂の理由は新しく書く');
  const next = buildContractPayload({...revision, reason: '保証額の増額'}, {direction: 'incoming', editing: {baseVersion: 1}});
  assert.equal(next.ok, true, JSON.stringify(next.errors));
  assert.equal(next.body.baseVersion, 1);
  assert.equal(next.body.code, undefined, '改訂では契約の識別を送らない');
});

test('FR-SETL-MGL-007 当期報告の入力: 全角・カンマ・¥を吸収し、候補と違えば差の理由を求める', () => {
  const report = {termVersionId: 7, productId: 1, periodFrom: '2026-10-01', periodTo: '2026-12-31', accountingMonth: '2027/1', reportReceivedOn: '', sourceReference: ' Q4報告 ',
    reportedEligibleYen: '１２，０００', appliedRecoupYen: '¥10,000', reportedOverageYen: '2000円', recognizedYen: '0', status: 'unverified', acknowledgement: false, confirmationReason: '', reversesEntryId: null, differenceReason: ''};
  const candidate = mgCandidate({eligibleYen: 12000, guaranteeYen: 100000, priorAppliedYen: 0});
  const missing = buildReportPayload(report, {candidate});
  assert.equal(missing.ok, false);
  assert.match(missing.errors.differenceReason, /実充当 −2,000円/);
  const ok = buildReportPayload({...report, differenceReason: '報告書の充当額に合わせる'}, {candidate});
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual([ok.body.reportedEligibleYen, ok.body.appliedRecoupYen, ok.body.reportedOverageYen, ok.body.accountingMonth, ok.body.sourceReference], [12000, 10000, 2000, '2027-01', 'Q4報告']);
  assert.equal(buildReportPayload(report, {candidate, special: true}).ok, true, '特殊条件は候補を参考値として扱う');
  const reviewed = buildReportPayload({...report, appliedRecoupYen: '12000', reportedOverageYen: '0', status: 'reviewed'}, {candidate});
  assert.deepEqual(Object.keys(reviewed.errors).sort(), ['acknowledgement', 'confirmationReason']);
  assert.equal(buildReportPayload({...report, recognizedYen: ''}, {candidate}).errors.recognizedYen, '計上を入力してください');
});

test('取込の読み取り: 見出しの揺れ・参考列・タイトル行・CSV', () => {
  const mapping = mapMgImportHeaders(['契約コード（必須）', '商品', '対象開始', '対象終了日', '計上月', '報告資料参照', '当期MG消化対象額', 'MG充当', '当期計上報告額', '参考_メモ', '謎の列', '計上']);
  assert.deepEqual(mapping.ignored, ['参考_メモ']);
  assert.deepEqual(mapping.unknown, ['謎の列']);
  assert.deepEqual(mapping.duplicate, ['計上']);
  assert.deepEqual(mapping.missingRequired, []);
  assert.deepEqual(mapMgImportHeaders(['契約コード', '商品コード']).missingRequired, ['対象開始日', '対象終了日', '計上月', '報告資料参照', '消化対象', '計上']);
  const sheet = sheetToMgImport([['MG報告（架空）'], [], HEADERS, ['MG-IN', '', 'SKU-DIGI'], [], ['MG-IN', '', 'SKU-DIGI', '2026-10-01']], {fileName: 'a.xlsx'});
  assert.equal(sheet.headerRowNo, 3);
  assert.deepEqual(sheet.rows.map((r) => r.rowNo), [4, 6]);
  assert.throws(() => sheetToMgImport([['a', 'b'], ['c']]), /見出しの行/);
  assert.deepEqual(splitCsv('﻿契約コード,報告資料参照\r\n"MG-IN","A,""B"""\n'), [['契約コード', '報告資料参照'], ['MG-IN', 'A,"B"']]);
});

test('テンプレートのExcelを書き出して読み戻すと見出しが対応し、記入前の行は読み飛ばす', () => {
  const contracts = [{id: 10, code: 'MG-IN', title: '架空', party_id: 2, versions: [{id: 100, version: 1, mode: 'cross', mg_amount_yen: 100000, starts_on: '2026-10-01', ends_on: '2027-09-30', products: [{product_id: 1, sku: 'SKU-DIGI', name: 'デジタル視聴'}, {product_id: 2, sku: 'SKU-PACK', name: 'パッケージ'}]}]}];
  const sheets = mgTemplateSheets({direction: 'incoming', contracts, ledger: [], parties: [{id: 2, name: '架空の販売先'}], generatedAt: '2026-09-24T00:00:00Z'});
  const decoded = decodeXlsx(encodeReportXlsx({sheets}));
  const read = workbookToMgImport(decoded, {fileName: 'テンプレート.xlsx'});
  assert.deepEqual(read.meta, {kind: 'mg_ledger', direction: 'incoming', version: '1'});
  assert.equal(read.rows.length, 2);
  const {mapping, parsed} = parseMgImportRows(read.headers, read.rows);
  assert.deepEqual(mapping.missingRequired, []);
  assert.deepEqual(mapping.ignored, ['参考_契約名', '参考_商品名', '参考_未消化残高']);
  const plan = planMgImport({direction: 'incoming', rows: parsed, contracts: contracts.map((c) => ({...c, permitted: true})), ledger: []});
  assert.equal(plan.summary.skipped, 2, '契約コードと商品コードだけの行は読み飛ばす');
  assert.equal(plan.canCommit, false);
});

// 同じ入力を手入力（POST /api/mg/ledger）と取込（プレビュー→登録）で1行ずつ流し、判定・理由・保存内容を比べる。
test('FR-SETL-MGL-010 取込の検証は既存の手入力と同じ結果になる（理由の文・登録内容・訂正版）', async (t) => {
  const manual = await fixture(t);
  const imported = await fixture(t);
  try {
    const contract = good(await manual.req('/mg/contracts', terms()));
    good(await imported.req('/mg/contracts', terms()));
    const base = {periodFrom: '2026-10-01', periodTo: '2026-12-31', accountingMonth: '2027-01', status: 'unverified'};
    const entryIds = new Map();
    // [名前, 手入力の本文, 取込の行, 期待: 'ok' | 理由の文 | 'reject'（DB制約で拒否。手入力は英語の制約文）]
    const cases = [
      ['候補どおり', {productId: 1, sourceReference: 'Q4-DIGI', reportedEligibleYen: 30000, appliedRecoupYen: 30000, reportedOverageYen: 0, recognizedYen: 30000},
        {sku: 'SKU-DIGI', sourceReference: 'Q4-DIGI', reportedEligibleYen: '30,000', appliedRecoupYen: '30000', reportedOverageYen: '0', recognizedYen: '３０，０００'}, 'ok'],
      ['候補と違う（理由つき）', {productId: 2, sourceReference: 'Q4-PACK', reportedEligibleYen: 12000, appliedRecoupYen: 10000, reportedOverageYen: 2000, recognizedYen: 9000, differenceReason: '報告書の充当額'},
        {sku: 'SKU-PACK', sourceReference: 'Q4-PACK', reportedEligibleYen: '12000', appliedRecoupYen: '¥10,000', reportedOverageYen: '2000', recognizedYen: '9000', differenceReason: '報告書の充当額'}, 'ok'],
      ['消化対象が空欄', {productId: 1, sourceReference: 'E1', appliedRecoupYen: 0, reportedOverageYen: 0, recognizedYen: 0},
        {sku: 'SKU-DIGI', sourceReference: 'E1', appliedRecoupYen: '0', reportedOverageYen: '0', recognizedYen: '0'}, '消化対象を入力してください'],
      ['実充当が負', {productId: 1, sourceReference: 'E2', reportedEligibleYen: 1, appliedRecoupYen: -1, reportedOverageYen: 0, recognizedYen: 0},
        {sku: 'SKU-DIGI', sourceReference: 'E2', reportedEligibleYen: '1', appliedRecoupYen: '-1', reportedOverageYen: '0', recognizedYen: '0'}, '実充当は0以上の整数円で入力してください'],
      ['計上が空欄', {productId: 1, sourceReference: 'E3', reportedEligibleYen: 1, appliedRecoupYen: 1, reportedOverageYen: 0},
        {sku: 'SKU-DIGI', sourceReference: 'E3', reportedEligibleYen: '1', appliedRecoupYen: '1', reportedOverageYen: '0'}, '計上を入力してください'],
      ['計上月の形式', {productId: 1, sourceReference: 'E4', reportedEligibleYen: 1, appliedRecoupYen: 1, reportedOverageYen: 0, recognizedYen: 0, accountingMonth: '2027-13'},
        {sku: 'SKU-DIGI', sourceReference: 'E4', reportedEligibleYen: '1', appliedRecoupYen: '1', reportedOverageYen: '0', recognizedYen: '0', accountingMonth: '2027-13'}, '計上月はYYYY-MM形式で入力してください'],
      ['存在しない日付', {productId: 1, sourceReference: 'E5', reportedEligibleYen: 1, appliedRecoupYen: 1, reportedOverageYen: 0, recognizedYen: 0, periodFrom: '2026-02-30'},
        {sku: 'SKU-DIGI', sourceReference: 'E5', reportedEligibleYen: '1', appliedRecoupYen: '1', reportedOverageYen: '0', recognizedYen: '0', periodFrom: '2026-02-30'}, '対象開始日に存在する日付を入力してください'],
      ['期間が逆', {productId: 1, sourceReference: 'E6', reportedEligibleYen: 1, appliedRecoupYen: 1, reportedOverageYen: 0, recognizedYen: 0, periodFrom: '2026-12-31', periodTo: '2026-10-01'},
        {sku: 'SKU-DIGI', sourceReference: 'E6', reportedEligibleYen: '1', appliedRecoupYen: '1', reportedOverageYen: '0', recognizedYen: '0', periodFrom: '2026-12-31', periodTo: '2026-10-01'}, '対象終了日は対象開始日以降にしてください'],
      ['報告資料参照が空欄', {productId: 1, sourceReference: '', reportedEligibleYen: 1, appliedRecoupYen: 1, reportedOverageYen: 0, recognizedYen: 0},
        {sku: 'SKU-DIGI', sourceReference: '', reportedEligibleYen: '1', appliedRecoupYen: '1', reportedOverageYen: '0', recognizedYen: '0'}, '報告資料参照は1〜300文字で入力してください'],
      ['確認済みで了承なし', {productId: 1, sourceReference: 'E7', reportedEligibleYen: 1, appliedRecoupYen: 1, reportedOverageYen: 0, recognizedYen: 0, status: 'reviewed', confirmationReason: '照合'},
        {sku: 'SKU-DIGI', sourceReference: 'E7', reportedEligibleYen: '1', appliedRecoupYen: '1', reportedOverageYen: '0', recognizedYen: '0', status: '手動確認済み', confirmationReason: '照合'}, '確認済みには手動値であることへの了承が必要です'],
      ['確認済みで理由なし', {productId: 1, sourceReference: 'E8', reportedEligibleYen: 1, appliedRecoupYen: 1, reportedOverageYen: 0, recognizedYen: 0, status: 'reviewed', acknowledgement: true},
        {sku: 'SKU-DIGI', sourceReference: 'E8', reportedEligibleYen: '1', appliedRecoupYen: '1', reportedOverageYen: '0', recognizedYen: '0', status: '手動確認済み', acknowledgement: 'はい'}, '確認・訂正理由は1〜500文字で入力してください'],
      ['条件版の対象外の商品', null, {sku: 'SKU-NONE', sourceReference: 'E9', reportedEligibleYen: '1', appliedRecoupYen: '1', reportedOverageYen: '0', recognizedYen: '0'}, 'reject'],
      ['同じ資料参照で内容が違う', {productId: 1, sourceReference: 'Q4-DIGI', reportedEligibleYen: 1, appliedRecoupYen: 1, reportedOverageYen: 0, recognizedYen: 0},
        {sku: 'SKU-DIGI', sourceReference: 'Q4-DIGI', reportedEligibleYen: '1', appliedRecoupYen: '1', reportedOverageYen: '0', recognizedYen: '0'}, 'reject'],
      ['訂正で理由なし', {productId: 1, sourceReference: 'Q4-DIGI-訂正', reportedEligibleYen: 20000, appliedRecoupYen: 20000, reportedOverageYen: 0, recognizedYen: 20000, reverses: 'Q4-DIGI'},
        {sku: 'SKU-DIGI', sourceReference: 'Q4-DIGI-訂正', reportedEligibleYen: '20000', appliedRecoupYen: '20000', reportedOverageYen: '0', recognizedYen: '20000', reversesSource: 'Q4-DIGI'}, '確認・訂正理由は1〜500文字で入力してください'],
      ['訂正版（元の行を残す）', {productId: 1, sourceReference: 'Q4-DIGI-訂正', reportedEligibleYen: 20000, appliedRecoupYen: 20000, reportedOverageYen: 0, recognizedYen: 20000, reverses: 'Q4-DIGI', confirmationReason: '訂正版の報告書を受領', status: 'reviewed', acknowledgement: true},
        {sku: 'SKU-DIGI', sourceReference: 'Q4-DIGI-訂正', reportedEligibleYen: '20000', appliedRecoupYen: '20000', reportedOverageYen: '0', recognizedYen: '20000', reversesSource: 'Q4-DIGI', confirmationReason: '訂正版の報告書を受領', status: '手動確認済み', acknowledgement: 'はい'}, 'ok'],
      ['同じ報告の二度目の訂正', {productId: 1, sourceReference: 'Q4-DIGI-訂正2', reportedEligibleYen: 1, appliedRecoupYen: 1, reportedOverageYen: 0, recognizedYen: 0, reverses: 'Q4-DIGI', confirmationReason: '再訂正'},
        {sku: 'SKU-DIGI', sourceReference: 'Q4-DIGI-訂正2', reportedEligibleYen: '1', appliedRecoupYen: '1', reportedOverageYen: '0', recognizedYen: '0', reversesSource: 'Q4-DIGI', confirmationReason: '再訂正'}, 'この報告には既に訂正版があります'],
      ['別の商品の報告を訂正元にする', {productId: 1, sourceReference: 'X-1', reportedEligibleYen: 1, appliedRecoupYen: 1, reportedOverageYen: 0, recognizedYen: 0, reverses: 'Q4-PACK', confirmationReason: '誤り'},
        {sku: 'SKU-DIGI', sourceReference: 'X-1', reportedEligibleYen: '1', appliedRecoupYen: '1', reportedOverageYen: '0', recognizedYen: '0', reversesSource: 'Q4-PACK', confirmationReason: '誤り'}, 'reject'],
    ];
    for (const [name, body, cells, expected] of cases) {
      let manualResult = null;
      if (body) {
        const {reverses, ...rest} = body;
        manualResult = await manual.req('/mg/ledger', {termVersionId: contract.versionId, ...base, ...rest, ...(reverses ? {reversesEntryId: entryIds.get(reverses)} : {})});
      }
      const row = importRow({contractCode: 'MG-IN', ...base, accountingMonth: base.accountingMonth, ...cells});
      const p = good(await preview(imported, [row]));
      const result = p.rows[0];
      if (expected === 'ok') {
        assert.equal(manualResult.status, 201, `${name}: 手入力 ${JSON.stringify(manualResult.data)}`);
        entryIds.set(body.sourceReference, manualResult.data.entryId);
        assert.ok(['insert', 'correction'].includes(result.action), `${name}: 取込 ${JSON.stringify(result.errors)}`);
        good(await commit(imported, [row], p.fingerprint));
      } else if (expected === 'reject') {
        if (manualResult) assert.ok(manualResult.status >= 400, `${name}: 手入力も拒否する`);
        assert.equal(result.action, 'error', `${name}: 取込も拒否する`);
      } else {
        assert.equal(manualResult.data.error, expected, `${name}: 手入力の理由`);
        assert.equal(result.action, 'error', name);
        assert.deepEqual(result.errors.map((e) => e.message), [expected], `${name}: 取込の理由`);
      }
    }
    assert.deepEqual(await stored(imported.db), await stored(manual.db), '保存内容（金額・状態・理由・訂正元）が同じ');
    const rows = await stored(manual.db);
    assert.equal(rows.find((r) => r.source_reference === 'Q4-PACK').confirmation_reason, '候補との差: 報告書の充当額', '候補との差の理由を残す');
    assert.equal(rows.find((r) => r.source_reference === 'Q4-DIGI-訂正').reverses_source, 'Q4-DIGI');
    // 訂正版の扱い: 元の行は残り、一覧では訂正前として扱われ、集計から外れる
    for (const f of [manual, imported]) {
      const ledger = good(await f.req('/mg/ledger')).rows;
      assert.equal(ledger.length, 3);
      assert.equal(ledger.find((r) => r.source_reference === 'Q4-DIGI').isSuperseded, 1);
      const contracts = good(await f.req('/mg/contracts?direction=incoming')).contracts;
      assert.equal(contractProgress(contracts[0], ledger, 'incoming').cumulativeAppliedYen, 30000, '訂正後の20,000円＋PACKの10,000円');
      await assert.rejects(f.db.run('UPDATE mg_ledger_entries SET recognized_yen=0'), /変更できません/);
    }
    assert.deepEqual(await foreignKeyViolations(imported.db), []);
  } finally {
    await manual.db.close();
    await imported.db.close();
  }
});

test('FR-SETL-MGL-007 FR-SETL-MGL-010 取込: 空欄の実充当・超過報告は候補で埋め、同じファイルの前の行を残高に反映する。候補と違えば理由が要る', async (t) => {
  const f = await fixture(t);
  try {
    good(await f.req('/mg/contracts', terms()));
    const rows = [
      importRow({contractCode: 'mg-in', sku: 'SKU-DIGI', periodFrom: '2026/10/1', periodTo: '2026年12月31日', accountingMonth: '2027/1', sourceReference: 'R1', reportedEligibleYen: '80,000', recognizedYen: '0'}, 2),
      importRow({contractCode: 'MG-IN', sku: 'SKU-PACK', periodFrom: '2026-10-01', periodTo: '2026-12-31', accountingMonth: '2027-01', sourceReference: 'R2', reportedEligibleYen: '50000', recognizedYen: '0'}, 3),
      importRow({contractCode: 'MG-IN', sku: 'SKU-PACK', periodFrom: '2027-01-01', periodTo: '2027-03-31', accountingMonth: '2027-04', sourceReference: 'R3', reportedEligibleYen: '5000', appliedRecoupYen: '5000', reportedOverageYen: '0', recognizedYen: '0'}, 4),
      importRow({contractCode: 'MG-IN', sku: 'SKU-PACK', periodFrom: '2027-01-01', periodTo: '2027-03-31', accountingMonth: '2027-04', sourceReference: 'R2', reportedEligibleYen: '1', recognizedYen: '0'}, 5),
      importRow({contractCode: 'MG-IN', sku: 'SKU-DIGI'}, 6),
    ];
    const p = good(await preview(f, rows));
    const [r1, r2, r3, r4] = p.rows;
    assert.equal(p.summary.skipped, 1, '契約コードと商品コードだけの行は読み飛ばす');
    assert.deepEqual([r1.values.appliedRecoupYen, r1.values.reportedOverageYen, r1.values.periodTo, r1.values.accountingMonth], [80000, 0, '2026-12-31', '2027-01']);
    assert.deepEqual(r1.filled, ['appliedRecoupYen', 'reportedOverageYen']);
    assert.deepEqual([r2.candidate.remainingBeforeYen, r2.values.appliedRecoupYen, r2.values.reportedOverageYen], [20000, 20000, 30000], '前の行の実充当を残高から引く');
    assert.equal(r3.action, 'error');
    assert.match(r3.errors[0].message, /候補と違います（実充当 \+5,000円・超過報告 −5,000円）/);
    assert.equal(r3.errors[0].column, '候補との差の理由');
    assert.equal(r4.action, 'error');
    assert.match(r4.errors[0].message, /3行目と報告資料参照が重なっています/);
    assert.equal(p.canCommit, false);
    assert.equal((await commit(f, rows, p.fingerprint)).status, 400, '1行でもエラーなら登録しない');
    assert.equal((await f.db.get('SELECT COUNT(*) n FROM mg_ledger_entries')).n, 0);
    const fixed = [rows[0], rows[1], importRow({...Object.fromEntries(MG_IMPORT_COLUMNS.map((c, i) => [c.key, rows[2].values[i]])), differenceReason: '報告書どおり'}, 4)];
    const p2 = good(await preview(f, fixed));
    assert.equal(p2.canCommit, true, JSON.stringify(p2.rows.map((r) => r.errors)));
    const done = good(await commit(f, fixed, p2.fingerprint));
    assert.equal(done.inserted.length, 3);
    assert.equal(done.saved.length, 3);
    // 同じファイルをもう一度: すべて登録済み（同じ内容）で、件数は増えない
    const again = good(await preview(f, fixed));
    assert.deepEqual([again.summary.unchanged, again.summary.insert, again.canCommit], [3, 0, false]);
    assert.equal((await commit(f, fixed, again.fingerprint)).status, 400);
    assert.equal((await f.db.get('SELECT COUNT(*) n FROM mg_ledger_entries')).n, 3);
    const history = good(await f.req('/mg/ledger/import/history?direction=incoming')).rows;
    assert.deepEqual([history.length, history[0].insert, history[0].fileName], [1, 3, '架空MG報告.xlsx']);
    const audit = await f.db.all("SELECT detail_json FROM audit_log WHERE action='mg_ledger_import'");
    assert.equal(audit.length, 3);
    assert.equal(JSON.parse(audit.find((a) => JSON.parse(a.detail_json).rowNo === 4).detail_json).differenceReason, '報告書どおり');
  } finally {
    await f.db.close();
  }
});

test('FR-SETL-MGL-008 FR-SETL-MGL-010 取込の訂正: 同じファイルで同じ報告を2回訂正できない。訂正は元の条件版を使い、プレビュー後に台帳が変われば登録しない', async (t) => {
  const f = await fixture(t);
  try {
    const contract = good(await f.req('/mg/contracts', terms()));
    const first = good(await f.req('/mg/ledger', {termVersionId: contract.versionId, productId: 1, periodFrom: '2026-10-01', periodTo: '2026-12-31', accountingMonth: '2027-01', sourceReference: 'ORIG', reportedEligibleYen: 10000, appliedRecoupYen: 10000, reportedOverageYen: 0, recognizedYen: 0}));
    const fresh = {...terms(), baseVersion: 1, mgAmountYen: 200000, products: [{productId: 1, evaluationYen: 140000}, {productId: 2, evaluationYen: 60000}], reason: '増額', sourceReference: 'TERMS-2'};
    for (const key of ['direction', 'code', 'title', 'partnerId', 'contractDate', 'contractSourceReference']) delete fresh[key];
    good(await f.req(`/mg/contracts/incoming/${contract.contractId}/versions`, fresh));
    const correction = (rowNo, source) => importRow({contractCode: 'MG-IN', sku: 'SKU-DIGI', periodFrom: '2026-10-01', periodTo: '2026-12-31', accountingMonth: '2027-01', sourceReference: source, reportedEligibleYen: '12000', recognizedYen: '0', reversesSource: 'ORIG', confirmationReason: '訂正版を受領'}, rowNo);
    const p = good(await preview(f, [correction(2, 'ORIG-A'), correction(3, 'ORIG-B')]));
    assert.equal(p.rows[0].action, 'correction');
    assert.equal(p.rows[0].termVersion, 1, '条件版が空欄の訂正は元の報告の版');
    assert.equal(p.rows[0].original.sourceReference, 'ORIG');
    assert.equal(p.rows[0].candidate.remainingBeforeYen, 100000, '訂正する元の報告は残高の計算から外す');
    assert.match(p.rows[1].errors[0].message, /2行目がこの報告を訂正しています/);
    const single = [correction(2, 'ORIG-A')];
    const p2 = good(await preview(f, single));
    // プレビューの後に手入力で台帳が変わった
    good(await f.req('/mg/ledger', {termVersionId: contract.versionId, productId: 2, periodFrom: '2026-10-01', periodTo: '2026-12-31', accountingMonth: '2027-01', sourceReference: 'OTHER', reportedEligibleYen: 1000, appliedRecoupYen: 1000, reportedOverageYen: 0, recognizedYen: 0}));
    const stale = await commit(f, single, p2.fingerprint);
    assert.equal(stale.status, 409);
    assert.match(stale.data.error, /プレビューの後/);
    const p3 = good(await preview(f, single));
    good(await commit(f, single, p3.fingerprint));
    const ledger = good(await f.req('/mg/ledger')).rows;
    assert.equal(ledger.find((r) => r.id === first.entryId).isSuperseded, 1);
    assert.equal(ledger.find((r) => r.source_reference === 'ORIG-A').reverses_entry_id, first.entryId);
    const again = good(await preview(f, single));
    assert.equal(again.rows[0].action, 'unchanged', '登録済みの訂正版を読み直しても二重に訂正しない');
    assert.equal((await commit(f, single, p3.fingerprint, {confirmed: false})).status, 400, '確認の印がなければ登録しない');
  } finally {
    await f.db.close();
  }
});

test('取込の権限と入力の境界: 制作担当は403、別組織は契約が見つからない、向き・必須列・件数を確かめる', async (t) => {
  const f = await fixture(t);
  try {
    good(await f.req('/mg/contracts', terms()));
    const row = importRow({contractCode: 'MG-IN', sku: 'SKU-DIGI', periodFrom: '2026-10-01', periodTo: '2026-12-31', accountingMonth: '2027-01', sourceReference: 'R1', reportedEligibleYen: '1', recognizedYen: '0'});
    const production = await f.login('production@openingnight.invalid');
    assert.equal((await f.req('/mg/ledger/import/preview', {direction: 'incoming', headers: HEADERS, rows: [row]}, production)).status, 403);
    assert.equal((await f.req('/mg/ledger/import/commit', {direction: 'incoming', headers: HEADERS, rows: [row], confirmed: true}, production)).status, 403);
    assert.equal((await f.req('/mg/ledger/import/history', null, production)).status, 403);
    const outsider = await f.login('outsider@other.invalid');
    const other = good(await f.req('/mg/ledger/import/preview', {direction: 'incoming', headers: HEADERS, rows: [row]}, outsider));
    assert.equal(other.rows[0].action, 'error');
    assert.match(other.rows[0].errors[0].message, /契約コード「MG-IN」の受取MGの契約がありません/);
    assert.equal((await f.req('/mg/ledger/import/commit', {direction: 'incoming', headers: HEADERS, rows: [row], fingerprint: other.fingerprint, confirmed: true}, outsider)).status, 400);
    assert.deepEqual(good(await f.req('/mg/ledger/import/history', null, outsider)).rows, []);
    const outgoing = good(await preview(f, [row], {direction: 'outgoing'}));
    assert.equal(outgoing.rows[0].action, 'error', '受取MGの契約は支払MGでは見つからない');
    const wrongMeta = await preview(f, [row], {meta: {kind: 'mg_ledger', direction: 'outgoing'}});
    assert.equal(wrongMeta.status, 400);
    assert.match(wrongMeta.data.error, /支払MG用のテンプレート/);
    assert.equal((await preview(f, [row], {meta: {kind: 'bulk'}})).status, 400);
    const missing = await preview(f, [{rowNo: 2, values: ['MG-IN']}], {headers: ['契約コード']});
    assert.equal(missing.status, 400);
    assert.ok(missing.data.details.missingColumns.includes('報告資料参照'));
    assert.equal((await preview(f, [], {})).status, 400);
    assert.equal((await preview(f, Array.from({length: 2001}, (_, i) => importRow({contractCode: 'MG-IN'}, i + 2)))).status, 413);
    assert.equal((await f.req('/mg/ledger/import/preview', {direction: 'sideways', headers: HEADERS, rows: [row]})).status, 400);
  } finally {
    await f.db.close();
  }
});

test('FR-SETL-MGL-011 財務権限のない契約の行は、取込の記録にもホームの「未確認のMG台帳の行」にも出さない', async (t) => {
  const f = await fixture(t);
  try {
    good(await f.req('/mg/contracts', terms()));
    const rows = [importRow({contractCode: 'MG-IN', sku: 'SKU-DIGI', periodFrom: '2026-10-01', periodTo: '2026-12-31', accountingMonth: '2027-01', sourceReference: 'R1', reportedEligibleYen: '1000', recognizedYen: '0'})];
    const p = good(await preview(f, rows));
    good(await commit(f, rows, p.fingerprint));
    const editor = await f.login('editor@openingnight.invalid');
    const mgItem = async (cookie) => good(await f.req('/work-queue', null, cookie)).items.find((item) => item.id === 'mg-unverified');
    assert.equal(good(await f.req('/mg/ledger/import/history', null, editor)).rows.length, 1, '財務権限があれば見える');
    assert.equal((await mgItem(editor)).count, 1);
    await f.db.run("UPDATE project_memberships SET permission='production' WHERE user_id=2");
    assert.deepEqual(good(await f.req('/mg/ledger/import/history', null, editor)).rows, [], 'ファイル名・件数も出さない');
    assert.equal((await mgItem(editor))?.count ?? 0, 0);
    assert.equal((await mgItem(f.admin)).count, 1, '管理者には出る');
  } finally {
    await f.db.close();
  }
});
