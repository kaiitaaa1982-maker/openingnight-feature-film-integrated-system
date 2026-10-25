// 製作委員会の契約の型・条件版の式・日程の版・収支の台帳（移行 0042〜0044）を、DB の制約と store（src/committee/ledger/committee-ledger-store.mjs）で確かめる。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。期待値は要件 docs/requirements/settlement/committee.md と、test/committee-ledger-model.test.mjs と同じ
// 実装と別に計算した値。架空のデータだけを使う（組織1・2・試作の作品1・取引先1〜3は試作の行）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {calcRound} from '../src/committee/ledger/committee-formula-model.mjs';
import {roundsFor} from '../src/committee/ledger/committee-schedule-model.mjs';
import {entriesFromRound, statement, cumulativeBy} from '../src/committee/ledger/committee-ledger-model.mjs';
import {addTemplateVersion, readTemplates, saveTermFormula, readTermFormula, addScheduleVersion, addRoundOverride, readSchedule,
  appendLedgerRound, reverseLedgerRound, readLedger} from '../src/committee/ledger/committee-ledger-store.mjs';

const rejects = (promise, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), 'raise', error.message);
  assert.match(error.message, message);
  return true;
});
const rejectsConstraint = (promise) => assert.rejects(promise, (error) => {
  assert.notEqual(dbErrorKind(error), 'raise', error.message);
  return true;
});

// 試作の作品1に架空の委員会の契約と条件版を1つ作る（調達の入口と契約書の行を含む）。4社目の取引先も足す
async function fictionalCommittee(db) {
  const intake = Number((await db.get(`INSERT INTO rights_intake_cases(org_id,project_id,work_id,case_code,title,intake_type,created_by)
    VALUES(1,1,1,'FIC-COMM-I','架空の委員会','committee',1) RETURNING id`)).id);
  const doc = Number((await db.get("INSERT INTO rights_intake_documents(org_id,intake_case_id,title,reference) VALUES(1,?,'架空の委員会契約','FICT-DOC') RETURNING id", [intake])).id);
  const contract = Number((await db.get(`INSERT INTO committee_contracts(org_id,project_id,work_id,intake_case_id,document_id,contract_code,title,created_by)
    VALUES(1,1,1,?,?,'FIC-COMM','架空の委員会「星の港」',1) RETURNING id`, [intake, doc])).id);
  const term = Number((await db.get("INSERT INTO committee_term_versions(org_id,contract_id,version_no,calculation_version,created_by) VALUES(1,?,1,'committee-v3-business-rights',1) RETURNING id", [contract])).id);
  const fourth = Number((await db.get("INSERT INTO partners(org_id,code,name,kind) VALUES(1,'FIC-M','架空M社','other') RETURNING id")).id);
  return {contract, term, partners: {K: 1, L: 2, SELF: 3, M: fourth}};
}

test('FR-SETL-COMM-019 契約の型は版を足すだけで、前の版を指し、変更も削除もできない', async (t) => {
  const db = await openTestDb({t});
  const v1 = await addTemplateVersion(db, {orgId: 1, userId: 1, code: 'STD-JOINT', name: '標準の共同製作', body: {businesses: ['theatrical']}, reason: '架空の種'});
  const v2 = await addTemplateVersion(db, {orgId: 1, userId: 1, code: 'STD-JOINT', name: '標準の共同製作', body: {businesses: ['theatrical', 'home_video']}, reason: '事業を足す（架空）'});
  assert.deepEqual([Number(v1.version_no), v1.previous_id, Number(v2.version_no), Number(v2.previous_id)], [1, null, 2, Number(v1.id)]);
  const all = await readTemplates(db, 1);
  assert.deepEqual(all.map((x) => [x.code, x.versionNo, x.body.businesses.length]), [['STD-JOINT', 1, 1], ['STD-JOINT', 2, 2]]);
  assert.deepEqual(await readTemplates(db, 2), []);
  await rejects(db.run("UPDATE committee_term_templates SET name='x' WHERE id=?", [v1.id]), /immutable/);
  await rejects(db.run('DELETE FROM committee_term_templates WHERE id=?', [v1.id]), /immutable/);
  await rejects(db.run("INSERT INTO committee_term_templates(org_id,code,version_no,name,body_json,reason,created_by) VALUES(1,'STD-JOINT',5,'x','{}','x',1)"), /stale/);
});

test('FR-SETL-COMM-019 条件版の式を書いて読み戻せ、成功報酬の回収後は閾値に届く回の扱いが無いと入らない', async (t) => {
  const db = await openTestDb({t});
  const {term, partners} = await fictionalCommittee(db);
  const template = await addTemplateVersion(db, {orgId: 1, userId: 1, code: 'STD-JOINT', name: '標準の共同製作', body: {}, reason: '架空の種'});
  const businesses = [
    {code: 'theatrical', operatorPartnerId: partners.K, clauseReference: '第9条', steps: [{kind: 'expense', label: '宣伝費'}, {kind: 'agent_fee', rateBps: 2000, base: 'income'}]},
    {code: 'home_video', operatorPartnerId: partners.SELF, clauseReference: '第11条', steps: [{kind: 'expense', label: '必要経費'}, {kind: 'secondary_royalty', holderRole: 'original', deductExpenses: true}, {kind: 'agent_fee', rateBps: 3000, base: 'remaining'}]},
  ];
  const committeeSteps = [
    {kind: 'overhead', label: '振込手数料'},
    {kind: 'manager_fee', recipientPartnerId: partners.K, rateBps: 500, base: 'remaining'},
    {kind: 'success_fee', recipientPartnerId: partners.K, rateBps: 1200, thresholdKind: 'total_budget', mode: 'excess', crossingRule: null},
  ];
  const budgetLines = [{item: 'production', amountYen: 70000000, taxBasis: 'ex_tax'}, {item: 'pa', amountYen: 25000000, taxBasis: 'ex_tax'}, {item: 'contingency', amountYen: 5000000, taxBasis: 'ex_tax'}];
  await saveTermFormula(db, {orgId: 1, userId: 1, termVersionId: term, templateId: Number(template.id), businesses, committeeSteps, budgetLines});
  const read = await readTermFormula(db, 1, term);
  assert.equal(read.templateId, Number(template.id));
  assert.deepEqual(read.businesses, businesses);
  assert.deepEqual(read.committeeSteps, committeeSteps);
  assert.deepEqual(read.budgetLines.map((l) => l.amountYen), [70000000, 25000000, 5000000]);
  assert.deepEqual((await readTermFormula(db, 2, term)).businesses, []);
  await rejectsConstraint(db.run(`INSERT INTO committee_term_committee_steps(org_id,term_version_id,step_no,kind,recipient_partner_id,rate_bps,threshold_kind,success_mode,created_by)
    VALUES(1,?,9,'success_fee',1,500,'investment_total','after_recoup',1)`, [term]));
  await rejects(db.run('DELETE FROM committee_term_business_steps WHERE term_version_id=?', [term]), /immutable/);
});

test('FR-SETL-COMM-019 FR-SETL-COMM-013 日程の版と回だけの変更を読み、回の式に渡せる（同じ回×項目は後の行が効く）', async (t) => {
  const db = await openTestDb({t});
  const {contract} = await fictionalCommittee(db);
  const phases = [
    {tier: 'to_members', fromYear: 1, toYear: 2, closeMonths: [2, 5, 8, 11], reportOffsetMonths: 2, payFrom: 'report', payOffsetMonths: 1, carryUnderYen: 10000, holidayRule: 'previous_business_day'},
    {tier: 'to_members', fromYear: 3, toYear: null, closeMonths: [8], reportOffsetMonths: 2, payFrom: 'report', payOffsetMonths: 1, carryUnderYen: 10000, holidayRule: 'previous_business_day'},
  ];
  await addScheduleVersion(db, {orgId: 1, userId: 1, contractId: contract, effectiveFrom: '2031-01-01', baseKind: 'release', baseDate: '2031-05-01', reason: '架空の契約の別紙', phases});
  await addRoundOverride(db, {orgId: 1, userId: 1, contractId: contract, tier: 'to_members', closeOn: '2031-11-30', field: 'pay_on', valueOn: '2032-02-20', reason: '架空の連絡1'});
  await addRoundOverride(db, {orgId: 1, userId: 1, contractId: contract, tier: 'to_members', closeOn: '2031-11-30', field: 'pay_on', valueOn: '2032-02-18', reason: '架空の連絡2'});
  const schedule = await readSchedule(db, 1, contract, '2031-12-01');
  assert.deepEqual(schedule.phases, phases);
  assert.equal(schedule.overrides.length, 1);
  const rounds = roundsFor({baseDate: schedule.baseDate, phases: schedule.phases, tier: 'to_members', untilDate: '2032-03-31', overrides: schedule.overrides});
  assert.deepEqual(rounds.map((r) => [r.closeOn, r.payOn]), [['2031-05-31', '2031-08-29'], ['2031-08-31', '2031-11-28'], ['2031-11-30', '2032-02-18'], ['2032-02-29', '2032-05-31']]);
  assert.equal(await readSchedule(db, 1, contract, '2030-12-31'), null);
  assert.equal(await readSchedule(db, 2, contract, '2031-12-01'), null);
  await rejectsConstraint(db.run("INSERT INTO committee_round_overrides(org_id,contract_id,tier,close_on,field,value_on,reason,created_by) VALUES(1,?,'to_members','2031-11-30','skip','2032-01-01','x',1)", [contract]));
  await rejects(db.run('DELETE FROM committee_round_overrides WHERE contract_id=?', [contract]), /immutable/);
});

// 架空の委員会の2回分（test/committee-ledger-model.test.mjs と同じ数字。相手は取引先の ID）
function rounds(p) {
  const MEMBERS = [{partnerId: p.K, shareBps: 5000}, {partnerId: p.L, shareBps: 2500}, {partnerId: p.SELF, shareBps: 1250}, {partnerId: p.M, shareBps: 1250}];
  const roy = (holderRole, rateBps, deductExpenses) => ({kind: 'secondary_royalty', holderRole, rateBps, deductExpenses});
  const fee = (rateBps, base, counterparty) => ({kind: 'agent_fee', rateBps, base, counterparty});
  const lanes = (n) => n === 1 ? [
    {key: 'theatrical', incomeYen: 92500000, steps: [{kind: 'expense', amountYen: 24000000, item: '宣伝費'}, {kind: 'expense', amountYen: -24000000, item: 'P&A出資金充当'}, fee(2000, 'income', p.K)]},
    {key: 'home_video', incomeYen: 10000000, steps: [{kind: 'expense', amountYen: 2000000, item: '必要経費'}, roy('original', 375, true), roy('director', 150, false), roy('screenplay', 150, false), fee(3000, 'remaining', p.SELF)]},
    {key: 'internet', incomeYen: 30000000, steps: [roy('original', 300, true), roy('director', 150, false), roy('screenplay', 150, false), fee(2000, 'income', p.K)]},
    {key: 'tv', incomeYen: 4000000, steps: [roy('original', 400, true), roy('director', 200, false), roy('screenplay', 200, false), fee(2000, 'income', p.L)]},
  ] : [
    {key: 'theatrical', incomeYen: 200000, steps: [fee(2000, 'income', p.K)]},
    {key: 'home_video', incomeYen: 400000, steps: [roy('original', 375, true), roy('director', 150, false), roy('screenplay', 150, false), fee(3000, 'remaining', p.SELF)]},
    {key: 'internet', incomeYen: 2000000, steps: [roy('original', 300, true), roy('director', 150, false), roy('screenplay', 150, false), fee(2000, 'income', p.K)]},
    {key: 'tv', incomeYen: 1500000, steps: [roy('original', 400, true), roy('director', 200, false), roy('screenplay', 200, false), fee(2000, 'income', p.L)]},
  ];
  const steps = (oh) => [{kind: 'overhead', amountYen: oh, item: '振込手数料'}, {kind: 'manager_fee', rateBps: 500, base: 'remaining', counterparty: p.K},
    {kind: 'success_fee', rateBps: 1200, thresholdYen: 100000000, mode: 'excess', counterparty: p.K}];
  const r1 = calcRound({businesses: lanes(1), committeeSteps: steps(3000), members: MEMBERS});
  const r2 = calcRound({businesses: lanes(2), committeeSteps: steps(1000), members: MEMBERS, priorSuccessBaseYen: r1.committee.successBaseCumulativeYen});
  return [entriesFromRound(r1, {tier: 'to_members', closeOn: '2031-08-31'}), entriesFromRound(r2, {tier: 'to_members', closeOn: '2031-11-30'})];
}

test('FR-SETL-COMM-015 FR-SETL-COMM-016 FR-SETL-COMM-017 FR-SETL-COMM-019 台帳に2回分を足し、読み戻した行の和から収支報告書と累計が出る', async (t) => {
  const db = await openTestDb({t});
  const {contract, partners} = await fictionalCommittee(db);
  const [e1, e2] = rounds(partners);
  await appendLedgerRound(db, {orgId: 1, userId: 1, contractId: contract, tier: 'to_members', closeOn: '2031-08-31', sourceKind: 'computed', entries: e1});
  await appendLedgerRound(db, {orgId: 1, userId: 1, contractId: contract, tier: 'to_members', closeOn: '2031-11-30', sourceKind: 'computed', entries: e2});
  const entries = await readLedger(db, 1, contract, 'to_members');
  assert.equal(entries.length, e1.length + e2.length);
  const s = statement(entries, {closeOn: '2031-11-30', investmentTotalYen: 100000000});
  assert.deepEqual(s.D, {prior: 99044150, current: 2606066, cumulative: 101650216});
  assert.deepEqual(s.costs.success_fee, {prior: 0, current: 225029, cumulative: 225029});
  assert.deepEqual(cumulativeBy(entries, {section: 'member_distribution', closeOn: '2031-11-30'}).get(partners.SELF), {prior: 12380519, current: 325758, cumulative: 12706277});
  assert.deepEqual(cumulativeBy(entries, {section: 'secondary_royalty', closeOn: '2031-11-30', key: (r) => r.holderRole}).get('original'), {prior: 1360000, current: 135000, cumulative: 1495000});
  assert.deepEqual(await readLedger(db, 2, contract, 'to_members'), []);
  await rejects(db.run('UPDATE committee_ledger_entries SET amount_yen=0 WHERE contract_id=?', [contract]), /immutable/);
});

test('FR-SETL-COMM-019 同じ回は二重に足せず、取り消してから足し直せる。取消の行は符号違いでなければ入らない', async (t) => {
  const db = await openTestDb({t});
  const {contract, partners} = await fictionalCommittee(db);
  const [e1] = rounds(partners);
  const args = {orgId: 1, userId: 1, contractId: contract, tier: 'to_members', closeOn: '2031-08-31', sourceKind: 'received', entries: e1};
  await appendLedgerRound(db, args);
  await assert.rejects(appendLedgerRound(db, args), /すでにあります/);
  const reversed = await reverseLedgerRound(db, {orgId: 1, userId: 1, contractId: contract, tier: 'to_members', closeOn: '2031-08-31', reason: '幹事の訂正版が届いた（架空）'});
  assert.equal(reversed, e1.length);
  const afterReverse = await readLedger(db, 1, contract, 'to_members');
  assert.equal(afterReverse.reduce((acc, r) => acc + r.amountYen, 0), 0);
  await appendLedgerRound(db, args);
  assert.deepEqual(statement(await readLedger(db, 1, contract, 'to_members'), {closeOn: '2031-08-31', investmentTotalYen: 100000000}).D.current, 99044150);
  // 足し直した回の行（取り消していない行）を、額をずらして取り消そうとする
  const one = (await readLedger(db, 1, contract, 'to_members')).filter((r) => r.section === 'income' && r.reversesId === null && r.business === 'tv').at(-1);
  await rejects(db.run(`INSERT INTO committee_ledger_entries(org_id,contract_id,tier,close_on,business_code,section,amount_yen,source_kind,reverses_id,reason,created_by)
    VALUES(1,?,'to_members','2031-08-31','tv','income',?,'manual',?,'x',1)`, [contract, -(one.amountYen - 1), one.id]), /mismatch/);
});
