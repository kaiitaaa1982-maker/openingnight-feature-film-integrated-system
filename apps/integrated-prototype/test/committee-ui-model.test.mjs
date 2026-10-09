import test from 'node:test';
import assert from 'node:assert/strict';
import {
  windowBasisOptions, applyWindowRules, blankWindow, windowWithKind, blankPhase, samplePhases, newTermsForm, termsFormFromVersion, copyTermsInto,
  membersOfIntake, validateTermsForm, termsPayload, phaseSummary, windowSummary, builderDefaults, nextPeriodIndex, basisByKind, snapshotRows,
  jointReportViews, JOINT_VIEW_ORDER, jointAssumptionRows, latestSnapshotId, mgSelectionDefaults, memberDistributionTable,
} from '../src/rights/committee-ui-model.mjs';
import {validateCommitteeTerms} from '../src/committee.mjs';
import {gridSheetSpec} from '../src/ui/grid-model.mjs';
import {encodeReportXlsx} from '../src/xlsx-report.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {deductionPayload} from '../src/rights/committee-ui-model.mjs';

const ALLOWED = new Set(['MG', 'PF']);
const englishWords = (text) => (String(text).match(/[A-Za-z]{2,}/g) || []).filter((word) => !ALLOWED.has(word));
const assertJapanese = (text, where) => assert.deepEqual(englishWords(text), [], `${where}: 英語が残っている「${text}」`);

const members = [{partnerId: 3, partnerName: '架空A社', shareBps: 6000}, {partnerId: 4, partnerName: '架空B社', shareBps: 4000}];

test('控除順ごとの計算の基礎: 選択肢が1つなら自動で決め、幹事なしは直接・幹事手数料0%', () => {
  assert.deepEqual(windowBasisOptions('window_first').window.map((o) => o.value), ['platform_net']);
  assert.deepEqual(windowBasisOptions('manager_first').manager.map((o) => o.value), ['platform_net']);
  assert.deepEqual(windowBasisOptions('').window, []);
  const noManager = applyWindowRules({feeOrder: 'window_first', route: 'via_manager', managerFee: '5', windowFeeBasis: '', managerFeeBasis: ''}, '');
  assert.equal(noManager.route, 'direct');
  assert.equal(noManager.managerFee, '0');
  assert.equal(noManager.windowFeeBasis, 'platform_net');
  assert.equal(noManager.managerFeeBasis, 'platform_net');
  const withManager = applyWindowRules({feeOrder: 'manager_first', route: '', managerFee: '', windowFeeBasis: 'platform_net', managerFeeBasis: 'after_window'}, '3');
  assert.equal(withManager.managerFeeBasis, 'platform_net');
  assert.equal(withManager.windowFeeBasis, 'platform_net');
  assert.equal(withManager.route, '');
  const switched = applyWindowRules({feeOrder: 'window_first', windowFeeBasis: 'after_manager', managerFeeBasis: 'after_manager'}, '3');
  assert.equal(switched.windowFeeBasis, 'platform_net');
  assert.equal(switched.managerFeeBasis, '');
  for (const options of [windowBasisOptions('window_first'), windowBasisOptions('manager_first')]) {
    [...options.window, ...options.manager].forEach((o) => assertJapanese(o.label, o.value));
  }
});

test('新しい窓口・日程の既定値（出資者1者なら窓口担当を自動、次の日程は前の翌日から・決め方を引き継ぐ）', () => {
  const one = blankWindow({members: [members[0]], managerPartnerId: ''});
  assert.equal(one.windowPartnerId, '3');
  assert.equal(one.feeOrder, 'window_first');
  assert.equal(one.route, 'direct');
  assert.equal(blankWindow({members, managerPartnerId: '3'}).windowPartnerId, '');
  assert.equal(windowWithKind({kind: '', label: ''}, 'digital').label, '配信');
  assert.equal(windowWithKind({kind: 'digital', label: '配信'}, 'broadcast').label, '放送');
  assert.equal(windowWithKind({kind: 'digital', label: '配信窓口A'}, 'broadcast').label, '配信窓口A');
  const first = blankPhase();
  assert.equal(first.closeDay, '月末');
  const next = blankPhase({endsOn: '2026-09-30', intervalMonths: '3', closeDay: '月末', reportOffsetMonths: '1', reportDay: '15', paymentOffsetMonths: '2', paymentDay: '月末', referenceType: 'release', referenceDate: '2026-09-01'});
  assert.equal(next.startsOn, '2026-10-01');
  assert.equal(next.intervalMonths, '3');
  assert.equal(next.reportDay, '15');
  assert.equal(next.label, '');
  assert.equal(newTermsForm({work: {code: 'W1'}, contracts: [{contract_code: 'W1-委員会-01'}]}).contractCode, 'W1-委員会-02');
});

function filledForm() {
  const form = newTermsForm({work: {code: 'W1'}});
  return {
    ...form, intakeCaseId: '9', documentId: '19', title: '架空委員会', managerPartnerId: '3',
    windows: [applyWindowRules({...blankWindow({members, managerPartnerId: '3'}), kind: 'digital', label: '配信', windowPartnerId: '4', route: 'via_manager', platformRate: '30', windowFee: '１０', managerFee: '5%', managerFeeBasis: 'after_window'}, '3')],
    phases: samplePhases(),
  };
}

test('保存前の検査: サーバーと同じ規則を段落（基本・出資・窓口・控除・日程）ごとの日本語で示す', () => {
  const ok = validateTermsForm(filledForm(), {members});
  assert.deepEqual(ok.errors, []);
  const empty = validateTermsForm(newTermsForm(), {members: []});
  const sections = new Set(empty.errors.map((e) => e.section));
  for (const section of ['basic', 'windows', 'deductions', 'schedule']) assert.ok(sections.has(section), section);
  empty.errors.forEach((e) => assertJapanese(e.message, e.section));
  const broken = filledForm();
  broken.managerPartnerId = '';
  broken.windows = [...broken.windows, {...broken.windows[0]}];
  broken.phases = [{...broken.phases[0], closeDay: '32', intervalMonths: '0'}, {...broken.phases[1], startsOn: '2026-10-05'}];
  broken.funding = {productionCostYen: 'abc', investments: [{partnerId: 3, amountYen: '1,000'}]};
  const messages = validateTermsForm(broken, {members}).errors.map((e) => e.message);
  assert.ok(messages.some((m) => /重複/.test(m)));
  assert.ok(messages.some((m) => /幹事を経由する経路には幹事/.test(m)));
  assert.ok(messages.some((m) => /締め日: 日は/.test(m)));
  assert.ok(messages.some((m) => /締めの間隔は1〜12/.test(m)));
  assert.ok(messages.some((m) => /途切れず重ならない/.test(m)));
  assert.ok(messages.some((m) => /製作費総額/.test(m)));
  assert.ok(messages.some((m) => /架空B社の出資額を入力/.test(m)));
  messages.forEach((m) => assertJapanese(m, m));
});

test('入力 → API: 率は bp、日は月末/日、サーバーの条件検査（validateCommitteeTerms）を通る', () => {
  const payload = termsPayload({...filledForm(), funding: {productionCostYen: '１，０００万'.replace('万', '0000'), investments: [{partnerId: 3, amountYen: '600万'.replace('万', '0000')}, {partnerId: 4, amountYen: '4,000,000'}]}}, 1);
  assert.equal(payload.windows[0].platformRateBps, 3000);
  assert.equal(payload.windows[0].windowFeeBps, 1000);
  assert.equal(payload.windows[0].managerFeeBps, 500);
  assert.equal(payload.windows[0].windowPartnerId, 4);
  assert.equal(payload.phases[0].closeDay, 'eom');
  assert.equal(payload.phases[1].intervalMonths, 3);
  assert.equal(payload.managerPartnerId, 3);
  assert.deepEqual(payload.funding, {productionCostYen: 10000000, investments: [{partnerId: 3, amountYen: 6000000}, {partnerId: 4, amountYen: 4000000}]});
  assert.equal(Object.hasOwn(payload, 'sourceVersionId'), false);
  const normalized = validateCommitteeTerms({managerPartnerId: payload.managerPartnerId, members: members.map((m, i) => ({partnerId: m.partnerId, shareBps: m.shareBps, memberOrder: i + 1})), windows: payload.windows, phases: payload.phases.map((p, i) => ({...p, phaseOrder: i + 1}))});
  assert.equal(normalized.windows.length, 1);
});

const savedVersion = {
  id: 31, version_no: 2, manager_partner_id: 3, note: 'メモ', funding: {productionCostYen: 1000, investments: [{partnerId: 3, amountYen: 600}]},
  windows: [{id: 1, kind: 'digital', label: '配信', window_partner_id: 4, window_partner_name: '架空B社', route: 'via_manager', platform_rate_bps: 3000, window_fee_bps: 1000, manager_fee_bps: 500, fee_order: 'window_first', window_fee_basis: 'platform_net', manager_fee_basis: 'after_window'}],
  phases: [{label: '初回', starts_on: '2026-09-01', ends_on: '2026-09-30', first_close_on: '2026-09-30', interval_months: 1, close_day: 'eom', report_offset_months: 1, report_day: 'eom', payment_offset_months: 2, payment_day: '15', reference_type: 'release', reference_date: '2026-09-01'}],
};

test('前回の条件版を既定値に: 新しい版は全項目を写し、新しい契約へは窓口と日程を写す', () => {
  const form = termsFormFromVersion({id: 8, intake_case_id: 9, document_id: 19, contract_code: 'C-1', title: '委員会'}, savedVersion);
  assert.equal(form.sourceVersionId, 31);
  assert.equal(form.contractId, 8);
  assert.equal(form.managerPartnerId, '3');
  assert.deepEqual(form.funding, {productionCostYen: '1,000', investments: [{partnerId: 3, amountYen: '600'}]});
  assert.equal(form.windows[0].platformRate, '30');
  assert.equal(form.phases[0].closeDay, '月末');
  assert.equal(form.phases[0].paymentDay, '15');
  assert.equal(termsPayload(form, 1).sourceVersionId, 31);
  // 出資者にいない窓口担当は空に戻す
  const copied = copyTermsInto(newTermsForm(), savedVersion, [members[0]]);
  assert.equal(copied.windows[0].windowPartnerId, '');
  assert.equal(copied.managerPartnerId, '3');
  assert.equal(copied.phases[0].startsOn, '2026-09-01');
  const copiedNoManager = copyTermsInto(newTermsForm(), savedVersion, [members[1]]);
  assert.equal(copiedNoManager.managerPartnerId, '');
  assert.equal(copiedNoManager.windows[0].route, 'direct');
  assert.equal(copiedNoManager.windows[0].managerFee, '0');
  assert.equal(membersOfIntake({participants: [{partner_id: 3, partner_name: 'A', explicit_share_bps: 6000, role: '幹事'}, {partner_id: null}]}).length, 1);
});

test('日程と窓口の要約は日本語の文（+1月 / eom / window_first を出さない）', () => {
  const text = phaseSummary(savedVersion.phases[0]);
  assert.equal(text, '2026/09/01〜2026/09/30・初回締め 2026/09/30・毎月の月末締め・報告 翌月の月末・支払 2か月後の15日');
  assertJapanese(text, '日程');
  const window = windowSummary(savedVersion.windows[0]);
  assert.equal(window, '配信｜窓口 架空B社｜PF 30%・窓口 10%・幹事 5%（窓口手数料が先）');
  assertJapanese(window, '窓口');
});

const periods = [{index: 1, start: '2026-09-01', end: '2026-09-30'}, {index: 2, start: '2026-10-01', end: '2026-12-31'}, {index: 3, start: '2027-01-01', end: '2027-03-31'}];

test('期間報告の既定: 直近の報告の契約の最新の条件版・次の締め期間・前回の期間の基準と報告額の基準', () => {
  const contracts = [{id: 8, versions: [{id: 31, version_no: 1}, {id: 32, version_no: 2}]}, {id: 9, versions: [{id: 41, version_no: 1}]}];
  const snapshots = [
    {id: 2, contract_id: 8, term_version_id: 31, period_to: '2026-12-31', period_date_basis: 'report_received', calculation: {selectedReports: [{kind: 'digital', reportBasis: 'net'}]}},
    {id: 1, contract_id: 8, term_version_id: 31, period_to: '2026-09-30', period_date_basis: 'sales_period', calculation: {selectedReports: [{kind: 'digital', reportBasis: 'gross'}, {kind: 'package', reportBasis: 'gross'}]}},
  ];
  assert.deepEqual(builderDefaults({contracts, snapshots}), {termVersionId: '32', periodDateBasis: 'report_received', contractId: 8});
  assert.deepEqual(builderDefaults({contracts, snapshots: []}), {termVersionId: '41', periodDateBasis: '', contractId: 9});
  assert.deepEqual(builderDefaults({contracts: [], snapshots: []}), {termVersionId: '', periodDateBasis: '', contractId: null});
  assert.equal(nextPeriodIndex(periods, snapshots, 8), '3');
  assert.equal(nextPeriodIndex(periods, snapshots, 9), '1');
  assert.equal(nextPeriodIndex(periods, [{contract_id: 8, period_to: '2027-03-31'}], 8), '');
  assert.equal(nextPeriodIndex([], snapshots, 8), '');
  assert.deepEqual(basisByKind(snapshots, 8), {digital: 'net', package: 'gross'});
  assert.deepEqual(basisByKind(snapshots, 9), {});
});

test('保存済みの期間報告の一覧の行（期間は日付、状態は下書き、分配原資は数値）', () => {
  const rows = snapshotRows([{id: 5, contract_id: 8, term_version_id: 32, period_from: '2026-10-01', period_to: '2026-12-31', period_date_basis: 'sales_period', stub: 1,
    calculation: {contract: {code: 'C-1', title: '委員会'}, totals: {distributionPool: 12000, platformNet: 20000}}}], [{id: 8, versions: [{id: 32, version_no: 2}]}]);
  assert.equal(rows[0].contractText, 'C-1｜委員会');
  assert.equal(rows[0].versionText, '版2');
  assert.equal(rows[0].periodText, '2026/10/01〜2026/12/31（端数期間）');
  assert.equal(rows[0].basisText, '販売期間');
  assert.equal(rows[0].pool, 12000);
  assert.equal(rows[0].statusText, '下書き（未確認）');
});

test('共同製作の帳票: 列は日本語・金額は円の型で合計を持つ', () => {
  const results = [{periodSequence: 1, to: '2026-12-31', managerReceiptOn: '2027-02-10', committeeIncomeYen: 1000, rightsCostYen: 100, managerFeeBasisYen: 900, managerFeeYen: 90, masterCostYen: 10, bankAdvanceRepaidYen: 0, distributableYen: 800, roundingResidualYen: 0, investorPaymentDueOn: '2027-03-31',
    windows: [{windowId: 1, windowLabel: '配信', partnerId: 3, netReceiptYen: 1200, directExpenseYen: 100, windowFeeYen: 100, musicFeeYen: 0, committeeIncomeYen: 1000, previousCarryYen: 0, cashReceivedYen: 1000, carriedYen: 0}],
    distributions: [{partnerId: 3, shareBps: 6000, earnedYen: 480, paidYen: 0, outstandingYen: 480}, {partnerId: 4, shareBps: 4000, earnedYen: 320, paidYen: 320, outstandingYen: 0}]}];
  const views = jointReportViews(results, [{id: 1, stage: 'shooting_complete', due_on: '2026-08-01', amount_inc_tax_yen: 500, paid_inc_tax_yen: 500, paid_on: '2026-08-02'}], {3: '架空A社'});
  assert.deepEqual(Object.keys(views).sort(), [...JOINT_VIEW_ORDER].sort());
  for (const key of JOINT_VIEW_ORDER) {
    const view = views[key];
    assertJapanese(view.title, key);
    for (const column of view.columns) assertJapanese(column.label, `${key}.${column.key}`);
    assert.ok(view.columns.some((c) => c.type === 'yen' && c.total === 'sum'), key);
  }
  assert.equal(views.joint_member_distributions.rows[1].partner, '名称未登録の取引先');
  assert.equal(views.joint_member_distributions.rows[0].share, 0.6);
  assert.equal(views.joint_production_milestones.rows[0].stage, '撮影終了');
  assert.equal(views.joint_period_totals.rows[0].period, '1期');
  // 繰越残高のような合計しても意味のない列は合計しない
  assert.equal(views.joint_window_periods.columns.find((c) => c.key === 'carryOut').total, 'none');
  jointAssumptionRows({title: '架空映画', calculationVersion: 'joint_cash_v1'}).forEach((row) => { assertJapanese(row.item, row.item); assertJapanese(row.value, row.item); });
});

test('権利先への帳票: 最新の保存報告と、契約1件・最新の条件版を既定に選ぶ。分配の表に合計行', () => {
  assert.equal(latestSnapshotId([{id: 3}, {id: 7}, {id: 5}]), '7');
  assert.equal(latestSnapshotId([]), '');
  const contracts = [{id: 4, versions: [{id: 40, version: 1}, {id: 41, version: 2}]}];
  assert.deepEqual(mgSelectionDefaults(contracts), {contractId: '4', versionId: '41'});
  assert.deepEqual(mgSelectionDefaults(contracts, '4', '40'), {contractId: '4', versionId: '40'});
  assert.deepEqual(mgSelectionDefaults([...contracts, {id: 5, versions: []}]), {contractId: '', versionId: ''});
  const report = {totals: {
    previous: {memberDistributions: [{partnerId: 1, amount: 100}]},
    current: {memberDistributions: [{partnerId: 1, amount: 50}, {partnerId: 2, amount: 30}]},
    cumulative: {memberDistributions: [{partnerId: 1, amount: 150}, {partnerId: 2, amount: 30}]},
  }};
  const table = memberDistributionTable(report, (id) => `社${id}`);
  assert.deepEqual(table.rows.map((r) => [r.name, r.previous, r.current, r.cumulative]), [['社1', 100, 50, 150], ['社2', 0, 30, 30]]);
  assert.deepEqual(table.total, {previous: 100, current: 80, cumulative: 180});
});

test('共同製作の帳票: 日付が無いことに意味がある列は「未着金・実受入なし・未払」と書く（未確認にしない）', () => {
  const results = [{periodSequence: 1, to: '2032-04-30', managerReceiptOn: null, investorPaymentDueOn: null, committeeIncomeYen: 0, rightsCostYen: 0, managerFeeBasisYen: 0, managerFeeYen: 0, masterCostYen: 0, bankAdvanceRepaidYen: 0, distributableYen: 0, roundingResidualYen: 0,
    windows: [{windowId: 2, windowLabel: '非劇場', partnerId: 2, managerReceiptOn: null, netReceiptYen: 18000, directExpenseYen: 2000, windowFeeYen: 0, musicFeeYen: 0, committeeIncomeYen: 0, previousCarryYen: 0, cashReceivedYen: 0, carriedYen: 16000}],
    distributions: [{partnerId: 1, shareBps: 5800, earnedYen: 0, paidYen: 0, outstandingYen: 0}]}];
  const views = jointReportViews(results, [{id: 2, stage: 'shooting_complete', due_on: '2031-07-31', amount_inc_tax_yen: 14000000, condition_met_on: null, acceptance_on: null, paid_on: null, paid_inc_tax_yen: 0}], {1: '架空A社', 2: '架空B社'});
  assert.equal(views.joint_period_totals.rows[0].receiptOn, '実受入なし');
  assert.equal(views.joint_period_totals.rows[0].payDue, '実受入なし');
  assert.equal(views.joint_window_periods.rows[0].receiptOn, '未着金');
  assert.equal(views.joint_member_distributions.rows[0].payDue, '実受入なし');
  assert.deepEqual([views.joint_production_milestones.rows[0].met, views.joint_production_milestones.rows[0].accepted, views.joint_production_milestones.rows[0].paidOn], ['未成就', '未検収', '未払']);
  const dated = jointReportViews([{...results[0], managerReceiptOn: '2032-08-10'}], [], {});
  assert.equal(dated.joint_period_totals.rows[0].receiptOn, '2032/08/10');
});

test('共同製作の帳票は日本語の列名のまま Excel に書き出せる（全帳票を1冊に）', () => {
  const results = [{periodSequence: 1, to: '2032-04-30', managerReceiptOn: '2032-05-31', investorPaymentDueOn: '2032-06-30', committeeIncomeYen: 1000, rightsCostYen: 0, managerFeeBasisYen: 1000, managerFeeYen: 25, masterCostYen: 0, bankAdvanceRepaidYen: 0, distributableYen: 975, roundingResidualYen: 0,
    windows: [{windowId: 1, windowLabel: '国内劇場', partnerId: 1, managerReceiptOn: '2032-05-31', netReceiptYen: 1200, directExpenseYen: 200, windowFeeYen: 0, musicFeeYen: 0, committeeIncomeYen: 1000, previousCarryYen: 0, cashReceivedYen: 1000, carriedYen: 0, windowReportDueOn: '2032-05-15', windowPaymentDueOn: '2032-05-31'}],
    distributions: [{partnerId: 1, shareBps: 5800, earnedYen: 565, paidYen: 0, outstandingYen: 565}, {partnerId: 2, shareBps: 4200, earnedYen: 409, paidYen: 0, outstandingYen: 409}]}];
  const views = jointReportViews(results, [], {1: '架空A社', 2: '架空B社'});
  const sheets = [
    {name: '帳票の前提', title: '帳票の前提', columns: [{key: 'item', label: '項目', type: 'text'}, {key: 'value', label: '内容', type: 'text'}], rows: jointAssumptionRows({title: '架空作品', calculationVersion: 'joint_cash_v1'})},
    ...JOINT_VIEW_ORDER.map((key) => gridSheetSpec({columns: views[key].columns, rows: views[key].rows, exportSpec: {name: views[key].title, title: views[key].title}})),
  ];
  const workbook = decodeXlsx(encodeReportXlsx({sheets}));
  const names = workbook.map((sheet) => sheet.name);
  assert.deepEqual(names, ['帳票の前提', '委員会収支', '窓口報告', '出資者への分配', '制作費の支払']);
  const text = JSON.stringify(workbook);
  for (const english of ['cash_received_yen', 'partner_id', 'period_sequence', 'joint_period_totals']) assert.ok(!text.includes(english), english);
  assert.ok(text.includes('分配原資'));
});

test('追加の控除: 金額の揺れを吸収し、足りない項目は日本語の理由', () => {
  const ok = deductionPayload([{reportId: '5', category: 'royalty', recipientPartnerId: '3', amountYen: '１，２００円', sourceReference: ' 計算書A '}]);
  assert.deepEqual(ok, {ok: true, errors: [], deductions: [{reportId: 5, category: 'royalty', recipientPartnerId: 3, amountYen: 1200, sourceReference: '計算書A'}]});
  const bad = deductionPayload([{reportId: '', category: 'royalty', recipientPartnerId: '', amountYen: '0', sourceReference: ''}]);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 4);
  bad.errors.forEach((message) => assertJapanese(message, message));
});
