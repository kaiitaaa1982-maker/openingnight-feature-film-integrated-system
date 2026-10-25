// 制作費の版（フェーズ1の仕様書 #5、移行 0016）を、DB の制約と store（src/expenses/expenses-store.mjs）と受け口
// （src/expenses/production-cost/production-cost-routes.mjs）で確かめる。期待値は要件 docs/requirements/expenses/production-cost.md の
// 受け入れシナリオ 1〜3・9・10・16・18 と FR-EXP-PCOST-001〜005・008・015・018〜023・039 から持ってくる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 受け口の 409（読んだあとにほかの画面が版を足した・出資の記録が変わった）は、受け口の DB に割り込む proxy（test/racing-db.mjs）で確かめる。
// 架空のデータだけを使う（組織1・2と利用者・試作の案件1と作品1・取引先1〜4は試作の行。作品と出資の記録は試験の中で足す）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind, isGuardViolation} from '../src/data-platform/db-errors.mjs';
import * as store from '../src/expenses/expenses-store.mjs';
import {investmentSource, normalizeContractVersionInput, normalizeInvestmentVersionInput, TAX_REVIEW_NOTES} from '../src/expenses/production-cost/production-cost-model.mjs';
import {pgUniqueViolation, racingBatchDb} from './racing-db.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const EDITOR = 2; // 組織1の編集担当（案件1に編集の権限。試作の行）
const DEMO_PROJECT = 1;
const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  if (message) assert.match(error.message, message);
  return true;
});
const raw = (db, sql, params = []) => db.run(sql, params);

// 架空の作品を足す（案件は既定で試作の案件1）
async function addWork(db, code, projectId = DEMO_PROJECT) {
  return Number((await db.get('INSERT INTO works(org_id,project_id,code,title) VALUES(1,?,?,?) RETURNING id', [projectId, code, `${code}（架空）`])).id);
}
// 作品の費用の版（自社の出資額だけ。ほかの額は未確認）。status が unknown なら額は無い
async function addFinance(db, workId, revision, {ownYen = null, status = 'unknown'} = {}) {
  await raw(db, `INSERT INTO work_finance_versions(org_id,work_id,revision,production_cost_tax_basis,production_cost_status,promotion_budget_tax_basis,promotion_budget_status,
      own_investment_yen,own_investment_tax_basis,own_investment_status,own_investment_as_of,own_investment_evidence,sales_rights_purchase_tax_basis,sales_rights_purchase_status,
      source_reference,reason,created_by)
    VALUES(1,?,?,'unknown','unknown','unknown','unknown',?,'ex_tax',?,?,?,'unknown','unknown','架空の出資の記録','架空の確認',1)`,
  [workId, revision, ownYen, status, ownYen === null ? null : '2026-09-01', ownYen === null ? null : '架空の出資契約']);
}
// 委員会の契約の条件版を1つ足す（term: {fundingYen, investments: [[取引先, 額]]}。fundingYen が null なら額の無い条件版）
async function addTerm(db, contract, versionNo, term) {
  const id = Number((await db.get("INSERT INTO committee_term_versions(org_id,contract_id,version_no,calculation_version,created_by) VALUES(1,?,?,'committee-v1',1) RETURNING id",
    [contract, versionNo])).id);
  if (term.fundingYen === null) return id;
  await raw(db, 'INSERT INTO committee_term_funding(org_id,term_version_id,production_cost_yen) VALUES(1,?,?)', [id, term.fundingYen]);
  for (const [order, [partnerId, amountYen]] of term.investments.entries()) {
    await raw(db, 'INSERT INTO committee_term_members(org_id,term_version_id,partner_id,share_bps,member_order) VALUES(1,?,?,?,?)', [id, partnerId, 5000, order + 1]);
    await raw(db, 'INSERT INTO committee_term_investments(org_id,term_version_id,partner_id,amount_yen) VALUES(1,?,?,?)', [id, partnerId, amountYen]);
  }
  return id;
}
// 作品の委員会の契約（調達の入口と契約書の行を含む）と、条件版（terms は addTerm の term の並び。版の番号は1から）
async function addCommittee(db, workId, code, terms) {
  const intake = Number((await db.get(`INSERT INTO rights_intake_cases(org_id,project_id,work_id,case_code,title,intake_type,created_by)
    VALUES(1,?,?,?,'架空の委員会','committee',1) RETURNING id`, [DEMO_PROJECT, workId, `${code}-I`])).id);
  const doc = Number((await db.get("INSERT INTO rights_intake_documents(org_id,intake_case_id,title,reference) VALUES(1,?,'架空の委員会契約','FICT-DOC') RETURNING id", [intake])).id);
  const contract = Number((await db.get(`INSERT INTO committee_contracts(org_id,project_id,work_id,intake_case_id,document_id,contract_code,title,created_by)
    VALUES(1,?,?,?,?,?,'架空の委員会',1) RETURNING id`, [DEMO_PROJECT, workId, intake, doc, code])).id);
  const termIds = [];
  for (const [index, term] of terms.entries()) termIds.push(await addTerm(db, contract, index + 1, term));
  return {contract, termIds};
}

async function appWithLogin(db) {
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const call = async (cookie, path, {method = 'GET', payload} = {}) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, ...(payload ? {'content-type': 'application/json'} : {})}, body: payload ? JSON.stringify(payload) : undefined});
    return {status: response.status, body: await response.json()};
  };
  return {login, call};
}
const path = (workId, entry = '') => `/expenses/works/${workId}/production-cost${entry ? `/${entry}` : ''}`;
const versionCount = async (db, workId) => Number((await db.get('SELECT COUNT(*) AS n FROM production_cost_versions WHERE org_id=1 AND work_id=?', [workId])).n);
const versionSql = `INSERT INTO production_cost_versions(org_id,work_id,version_no,source_kind,amount_yen,tax_basis,production_part_yen,pa_part_yen,work_finance_revision,
  committee_term_version_id,contract_reference,contract_signed_on,counterparty_partner_id,contract_amount_yen,contract_tax_basis,tax_conversion,added_yen,burden_type,note,created_by)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
// 版の行を直接足す（アプリを通さない書き込み）。v は列の上書き
const insertVersion = (db, workId, v) => raw(db, versionSql, [1, workId, v.versionNo ?? 1, v.sourceKind, v.amountYen, v.taxBasis ?? 'ex_tax', v.productionYen ?? null, v.paYen ?? null,
  v.workFinanceRevision ?? null, v.committeeTermVersionId ?? null, v.reference ?? null, v.signedOn ?? null, v.partnerId ?? null, v.contractAmountYen ?? null, v.contractTaxBasis ?? null,
  v.taxConversion ?? null, v.addedYen ?? null, v.burdenType ?? null, v.note ?? null, ADMIN]);
const contractRow = (overrides = {}) => ({sourceKind: 'contract', amountYen: 48000000, reference: 'FICT-CONTRACT-001', signedOn: '2026-08-20', partnerId: 1,
  contractAmountYen: 48000000, contractTaxBasis: 'ex_tax', ...overrides});

test('FR-EXP-PCOST-001 FR-EXP-PCOST-002 FR-EXP-PCOST-005 委員会の無い作品は、作品の費用の最新の版の確定した自社の出資額から版1が作られ、参照した版と記録した人が残る（額を手で写さない）', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-PC-OWN');
  await addFinance(db, work, 1, {ownYen: 98765432, status: 'estimated'});
  await addFinance(db, work, 2, {ownYen: 123456789, status: 'confirmed'});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const audits = () => db.all("SELECT user_id,action,entity_type,entity_id,detail_json FROM audit_log WHERE org_id=1 AND entity_type='production_cost_version' ORDER BY id");
  // 額を本文で渡しても受けない（出資の記録から読む）。断った書き込みは版も記録も残さない
  const typed = await call(admin, path(work, 'from-investment'), {method: 'POST', payload: {amountYen: 1}});
  assert.equal(typed.status, 400);
  assert.deepEqual(typed.body.details.map((e) => e.field), ['amountYen']);
  assert.equal(await versionCount(db, work), 0);
  const before = await call(admin, path(work));
  assert.equal(before.status, 200);
  assert.deepEqual([before.body.status, before.body.latest, before.body.investment.ready, before.body.investment.amountYen, before.body.registrable],
    ['unregistered', null, true, 123456789, {fromInvestment: true, fromContract: false}]);
  const added = await call(admin, path(work, 'from-investment'), {method: 'POST', payload: {note: '架空の確認メモ'}});
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual(added.body, {ok: true, workId: work, versionNo: 1, sourceKind: 'investment', investmentKind: 'own_investment', amountYen: 123456789, taxBasis: 'ex_tax', status: 'registered'});
  const read = await call(admin, path(work));
  assert.equal(read.body.status, 'registered');
  const latest = read.body.latest;
  // 版の額＝参照した出資額（差0円）。根拠は参照した作品の費用の版（第2版）で、記録した人と日時が残る。会計の専門家の確認の前の仮置きを根拠に残す
  assert.deepEqual([latest.versionNo, latest.sourceKind, latest.amountYen, latest.taxBasis, latest.investment, latest.contract, latest.breakdown, latest.createdBy],
    [1, 'investment', 123456789, 'ex_tax', {kind: 'own_investment', workFinanceRevision: 2, committeeTermVersionId: null}, null, null, ADMIN]);
  assert.equal(latest.note, `${TAX_REVIEW_NOTES.own_investment}。架空の確認メモ`);
  assert.match(latest.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(read.body.registrable, {fromInvestment: false, fromContract: false});
  // 変更の記録は版の番号と根拠の種類だけで、金額を残さない
  const logged = await audits();
  assert.deepEqual(logged.map((r) => [Number(r.user_id), r.action, r.entity_id, JSON.parse(r.detail_json)]),
    [[ADMIN, 'append', `${work}:1`, {workId: work, versionNo: 1, sourceKind: 'investment'}]]);
  assert.equal(/123456789/.test(logged[0].detail_json), false);
  // 最初の版がある作品には、もう出資額からも契約書からも最初の版を足さない（409。記録も増えない）
  const again = await call(admin, path(work, 'from-investment'), {method: 'POST', payload: {}});
  assert.equal(again.status, 409);
  assert.match(again.body.error, /最初の制作費の版はもうあります/);
  assert.equal((await audits()).length, 1);
});

test('FR-EXP-PCOST-003 見込み・未確認の出資額からは版を作らず、版の無い作品は「制作費の版なし」（unregistered）で額を 0円で埋めない。DB も確定した最新の出資額と違う版を断る', async (t) => {
  const db = await openTestDb({t});
  const estimated = await addWork(db, 'FICT-PC-EST');
  await addFinance(db, estimated, 1, {ownYen: 50000000, status: 'estimated'});
  const unknown = await addWork(db, 'FICT-PC-UNK');
  await addFinance(db, unknown, 1);
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const refused = await call(admin, path(estimated, 'from-investment'), {method: 'POST', payload: {}});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.details.reason, 'not_confirmed');
  const read = await call(admin, path(estimated));
  assert.deepEqual([read.body.status, read.body.latest, read.body.versions, read.body.investment.ready, read.body.investment.reason, read.body.investment.amountYen],
    ['unregistered', null, [], false, 'not_confirmed', undefined]);
  // 自社の出資額の無い作品（未確認）は出資の記録が無い。出資額から作れず、契約書からなら入れられる
  const none = await call(admin, path(unknown));
  assert.deepEqual([none.body.status, none.body.investment.hasRecord, none.body.investment.reason, none.body.registrable], ['unregistered', false, 'no_record', {fromInvestment: false, fromContract: true}]);
  assert.equal((await call(admin, path(unknown, 'from-investment'), {method: 'POST', payload: {}})).body.details.reason, 'no_record');
  // アプリを通さない書き込み: 見込みの出資額・確定より前の版・額の違う版・税の区分の違う版は、どれも DB が断る
  await rejects(insertVersion(db, estimated, {sourceKind: 'investment', amountYen: 50000000, workFinanceRevision: 1}), 'raise', /latest confirmed own investment/);
  await addFinance(db, estimated, 2, {ownYen: 60000000, status: 'confirmed'});
  await addFinance(db, estimated, 3, {ownYen: 70000000, status: 'confirmed'});
  await rejects(insertVersion(db, estimated, {sourceKind: 'investment', amountYen: 60000000, workFinanceRevision: 2}), 'raise', /latest confirmed own investment/);
  await rejects(insertVersion(db, estimated, {sourceKind: 'investment', amountYen: 69999999, workFinanceRevision: 3}), 'raise', /latest confirmed own investment/);
  await rejects(insertVersion(db, estimated, {sourceKind: 'investment', amountYen: 70000000, taxBasis: 'unknown', workFinanceRevision: 3}), 'raise', /latest confirmed own investment/);
  assert.equal(await versionCount(db, estimated), 0);
  // 最新の確定した額なら入る（受け口と同じ形）
  await insertVersion(db, estimated, {sourceKind: 'investment', amountYen: 70000000, workFinanceRevision: 3});
  assert.equal(await versionCount(db, estimated), 1);
  // 作品ごとの最新の版を読む store は、版の無い作品の行を返さない（0円の行で埋めない）
  const latest = await store.readLatestProductionCosts(db, 1, [estimated, unknown]);
  assert.deepEqual(latest.map((r) => [Number(r.work_id), Number(r.version_no), Number(r.amount_yen)]), [[estimated, 1, 70000000]]);
});

test('FR-EXP-PCOST-002 FR-EXP-PCOST-015 FR-EXP-PCOST-019 FR-EXP-PCOST-020 FR-EXP-PCOST-022 委員会作品は最新の条件版の出資額の合計（P&A を含む総額）が版の額になり、条件版に税の区分が無いので「不明」（tax_unknown）', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-PC-COM');
  // 第1版 8,000万円、第2版（追加出資で作り直した条件版）1億円。出資の合計＝製作費総額
  const {termIds} = await addCommittee(db, work, 'FICT-PC-COM-C', [
    {fundingYen: 80000000, investments: [[1, 50000000], [2, 30000000]]},
    {fundingYen: 100000000, investments: [[1, 60000000], [2, 40000000]]},
  ]);
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const before = await call(admin, path(work));
  assert.deepEqual([before.body.investment.kind, before.body.investment.amountYen, before.body.investment.taxBasis], ['committee', 100000000, 'unknown']);
  // 内訳（制作費 8,000万円・P&A 2,000万円）は和が版の額（出資の総額）でなければ断る
  const wrong = await call(admin, path(work, 'from-investment'), {method: 'POST', payload: {breakdown: {productionYen: 80000000, paYen: 19999999}}});
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body.details.map((e) => e.field), ['breakdown']);
  const half = await call(admin, path(work, 'from-investment'), {method: 'POST', payload: {breakdown: {productionYen: 100000000}}});
  assert.deepEqual([half.status, half.body.details.map((e) => e.field)], [400, ['breakdown.paYen']]);
  const added = await call(admin, path(work, 'from-investment'), {method: 'POST', payload: {breakdown: {productionYen: 80000000, paYen: 20000000}}});
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual([added.body.investmentKind, added.body.amountYen, added.body.taxBasis, added.body.status], ['committee', 100000000, 'unknown', 'tax_unknown']);
  const read = await call(admin, path(work));
  assert.equal(read.body.status, 'tax_unknown');
  assert.deepEqual([read.body.latest.investment, read.body.latest.breakdown, read.body.latest.note],
    [{kind: 'committee', workFinanceRevision: null, committeeTermVersionId: termIds[1]}, {productionYen: 80000000, paYen: 20000000}, TAX_REVIEW_NOTES.committee]);
  // アプリを通さない書き込み: 古い条件版・税抜と書いた版・内訳の和の違う版・内訳の片方だけの版は DB が断る
  const other = await addWork(db, 'FICT-PC-COM2');
  const {termIds: otherTerms} = await addCommittee(db, other, 'FICT-PC-COM2-C', [
    {fundingYen: 80000000, investments: [[1, 50000000], [2, 30000000]]}, {fundingYen: 100000000, investments: [[1, 60000000], [2, 40000000]]}]);
  await rejects(insertVersion(db, other, {sourceKind: 'investment', amountYen: 80000000, taxBasis: 'unknown', committeeTermVersionId: otherTerms[0]}), 'raise', /latest committee investment/);
  await rejects(insertVersion(db, other, {sourceKind: 'investment', amountYen: 100000000, taxBasis: 'ex_tax', committeeTermVersionId: otherTerms[1]}), 'raise', /latest committee investment/);
  await rejects(insertVersion(db, other, {sourceKind: 'investment', amountYen: 100000000, taxBasis: 'unknown', committeeTermVersionId: termIds[1]}), 'raise', /latest committee investment/);
  await rejects(insertVersion(db, other, {sourceKind: 'investment', amountYen: 100000000, taxBasis: 'unknown', committeeTermVersionId: otherTerms[1], productionYen: 80000000, paYen: 19999999}), 'check');
  await rejects(insertVersion(db, other, {sourceKind: 'investment', amountYen: 100000000, taxBasis: 'unknown', committeeTermVersionId: otherTerms[1], productionYen: 100000000}), 'check');
  // 出資の合計が製作費総額と合わない条件版からは作らない（受け口は 409、DB も断る）
  const mismatch = await addWork(db, 'FICT-PC-COM3');
  const {termIds: mismatchTerms} = await addCommittee(db, mismatch, 'FICT-PC-COM3-C', [{fundingYen: 90000000, investments: [[1, 50000000], [2, 30000000]]}]);
  assert.equal((await call(admin, path(mismatch, 'from-investment'), {method: 'POST', payload: {}})).body.details.reason, 'committee_mismatch');
  await rejects(insertVersion(db, mismatch, {sourceKind: 'investment', amountYen: 90000000, taxBasis: 'unknown', committeeTermVersionId: mismatchTerms[0]}), 'raise', /latest committee investment/);
  // 額の無い条件版しか無い委員会作品は、出資の記録がある（契約書からは入れない）が出資額から作れない
  const unfunded = await addWork(db, 'FICT-PC-COM4');
  await addCommittee(db, unfunded, 'FICT-PC-COM4-C', [{fundingYen: null}]);
  const unfundedRead = await call(admin, path(unfunded));
  assert.deepEqual([unfundedRead.body.investment.reason, unfundedRead.body.investment.hasRecord, unfundedRead.body.registrable], ['committee_unfunded', true, {fromInvestment: false, fromContract: false}]);
  assert.equal(await versionCount(db, other) + await versionCount(db, mismatch) + await versionCount(db, unfunded), 0);
});

test('FR-EXP-PCOST-004 FR-EXP-PCOST-005 FR-EXP-PCOST-018 版は作品ごとの連番で追加だけ。書き換え・削除・同じ番号の入れ直し・番号の飛ばしを DB が断り、追加の版は前の版の額＋追加額だけ', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-PC-SEQ');
  await addFinance(db, work, 1, {ownYen: 100000000, status: 'confirmed'});
  await insertVersion(db, work, {sourceKind: 'investment', amountYen: 100000000, workFinanceRevision: 1});
  const snapshot = async () => (await store.readProductionCostVersions(db, 1, work)).map((r) => [Number(r.version_no), r.source_kind, Number(r.amount_yen)]);
  assert.deepEqual(await snapshot(), [[1, 'investment', 100000000]]);
  // 書き換え・削除・同じ番号の入れ直し・番号の飛ばし（アプリを通さない書き込みでも）
  await rejects(raw(db, 'UPDATE production_cost_versions SET amount_yen=1 WHERE org_id=1 AND work_id=?', [work]), 'raise', /append-only/);
  await rejects(raw(db, 'DELETE FROM production_cost_versions WHERE org_id=1 AND work_id=?', [work]), 'raise', /append-only/);
  await rejects(insertVersion(db, work, {sourceKind: 'investment', amountYen: 100000000, workFinanceRevision: 1}), 'raise', /stale production cost version/);
  await rejects(insertVersion(db, work, {versionNo: 3, sourceKind: 'additional_contract', amountYen: 110000000, reference: 'FICT-ADD-1', signedOn: '2026-11-02', partnerId: 1,
    contractAmountYen: 10000000, contractTaxBasis: 'ex_tax', addedYen: 10000000, burdenType: 'investor_additional'}), 'raise', /stale production cost version/);
  // 追加の版（シナリオ6）: 超過 1,000万円を自社の追加出資で賄う追加の契約。版2＝版1＋追加額で、追加の契約の参照・締結日・相手・額・負担の種別が残る
  const addition = {versionNo: 2, sourceKind: 'additional_contract', amountYen: 110000000, reference: 'FICT-ADD-1', signedOn: '2026-11-02', partnerId: 1,
    contractAmountYen: 10000000, contractTaxBasis: 'ex_tax', addedYen: 10000000, burdenType: 'investor_additional'};
  await rejects(insertVersion(db, work, {...addition, amountYen: 110000001}), 'raise', /add the additional contract to the previous version/);
  await rejects(insertVersion(db, work, {...addition, taxBasis: 'unknown'}), 'raise', /add the additional contract to the previous version/);
  // 制作会社の自己負担では版を足さない（負担の種別は出資者の追加出資と借入だけ。FR-EXP-PCOST-025）。負担の種別の無い追加の版も断る
  await rejects(insertVersion(db, work, {...addition, burdenType: 'production_company'}), 'check');
  await rejects(insertVersion(db, work, {...addition, burdenType: null}), 'check');
  // 追加の版に契約書の参照が要る。出資額から作る版・契約書の版は版1だけ
  await rejects(insertVersion(db, work, {...addition, reference: null}), 'check');
  await rejects(insertVersion(db, work, {...addition, sourceKind: 'investment', amountYen: 100000000, reference: null, signedOn: null, partnerId: null, contractAmountYen: null, contractTaxBasis: null,
    addedYen: null, burdenType: null, workFinanceRevision: 1}), 'check');
  await rejects(insertVersion(db, work, contractRow({versionNo: 2})), 'check');
  assert.deepEqual(await snapshot(), [[1, 'investment', 100000000]]);
  await insertVersion(db, work, addition);
  // 借入（負担の種別に既定は無い）。税込の追加の契約は税抜に戻した額と戻し方が要る
  await rejects(insertVersion(db, work, {...addition, versionNo: 3, amountYen: 115000000, contractAmountYen: 5500000, contractTaxBasis: 'inc_tax', addedYen: 5000000, burdenType: 'borrowing'}), 'check');
  await insertVersion(db, work, {...addition, versionNo: 3, amountYen: 115000000, contractAmountYen: 5500000, contractTaxBasis: 'inc_tax', addedYen: 5000000, burdenType: 'borrowing',
    taxConversion: '税込 550万円 ÷ 1.10（架空）'});
  assert.deepEqual(await snapshot(), [[1, 'investment', 100000000], [2, 'additional_contract', 110000000], [3, 'additional_contract', 115000000]]);
  const rows = await store.readProductionCostVersions(db, 1, work);
  assert.deepEqual([rows[1].contract_reference, rows[1].contract_signed_on, Number(rows[1].counterparty_partner_id), Number(rows[1].added_yen), rows[1].burden_type],
    ['FICT-ADD-1', '2026-11-02', 1, 10000000, 'investor_additional']);
  // 版は作品ごと（別の作品は1から。契約ごとには持たない）。最新の版を作品ごとに読み、別の組織の受け口が渡した作品の ID は org_id で落ちる
  const second = await addWork(db, 'FICT-PC-SEQ2');
  await insertVersion(db, second, contractRow());
  const latest = await store.readLatestProductionCosts(db, 1, [second, work]);
  assert.deepEqual(latest.map((r) => [Number(r.work_id), Number(r.version_no), Number(r.amount_yen)]), [[work, 3, 115000000], [second, 1, 48000000]]);
  assert.deepEqual(await store.readLatestProductionCosts(db, 2, [work, second]), []);
  assert.deepEqual(await store.readProductionCostVersions(db, 2, work), []);
});

test('FR-EXP-PCOST-004 読んだあとにほかの画面が先に版1を足したら、受け口は 409 で版を足さない（SQLite・D1 の版の番号のトリガーと、PostgreSQL の同時の書き込みの主キーの違反のどちらも）', async (t) => {
  const db = await openTestDb({t});
  const {proxy, state} = racingBatchDb(db, /INSERT INTO production_cost_versions/);
  const {login, call} = await appWithLogin(proxy);
  const admin = await login('admin@openingnight.invalid');
  const contract = {contractReference: 'FICT-CONTRACT-RACE', signedOn: '2026-08-20', counterpartyPartnerId: 1, contractAmountYen: 30000000, contractTaxBasis: 'ex_tax'};
  const OTHER = '割り込んだ架空の版';
  // 割り込む書き込み: 受け口が版の一覧と出資の記録を読んだあとに、ほかの画面が同じ作品の版1を store で先に足す
  const fromInvestment = (workId) => async () => {
    const source = investmentSource(await store.readInvestmentRecords(db, 1, workId));
    await store.addProductionCostVersion(db, 1, workId, normalizeInvestmentVersionInput({note: OTHER}, source).value, {createdBy: ADMIN});
  };
  const fromContract = (workId) => async () => {
    await store.addProductionCostVersion(db, 1, workId, normalizeContractVersionInput({...contract, note: OTHER}).value, {createdBy: ADMIN});
  };
  // trigger: 書き込みが直列の SQLite・D1（と PGlite）では、版の番号のトリガーが stale の文で断る。
  // primaryKey: 本物の PostgreSQL で同時に足すと、両方のトリガーが番号の判定を通り、後の側が主キーの一意の違反（23505）で落ちる
  for (const loser of ['trigger', 'primaryKey']) {
    const own = await addWork(db, `FICT-PC-RACE-OWN-${loser}`);
    await addFinance(db, own, 1, {ownYen: 60000000, status: 'confirmed'});
    const free = await addWork(db, `FICT-PC-RACE-CON-${loser}`);
    for (const [workId, entry, payload, other] of [[own, 'from-investment', {}, fromInvestment], [free, 'from-contract', contract, fromContract]]) {
      state.race = other(workId);
      state.error = loser === 'primaryKey'
        ? pgUniqueViolation({table: 'production_cost_versions', constraint: 'production_cost_versions_pkey', columns: ['org_id', 'work_id', 'version_no'], values: [1, workId, 1]})
        : null;
      const res = await call(admin, path(workId, entry), {method: 'POST', payload});
      assert.equal(state.race, null, '割り込みが流れた');
      assert.deepEqual([res.status, res.body.error, res.body.dbError?.kind], [409, 'ほかの画面で制作費の版が足されました。読み直してください', loser === 'primaryKey' ? 'unique' : 'raise'],
        `${loser} ${entry}`);
      // 割り込んだ版だけが残り、変更の記録も割り込んだ1行だけ
      const rows = await store.readProductionCostVersions(db, 1, workId);
      assert.deepEqual(rows.map((r) => [Number(r.version_no), r.note.endsWith(OTHER)]), [[1, true]], `${loser} ${entry}`);
      const logged = await db.all("SELECT entity_id FROM audit_log WHERE org_id=1 AND entity_type='production_cost_version' AND entity_id=?", [`${workId}:1`]);
      assert.equal(logged.length, 1, `${loser} ${entry}`);
    }
  }
});

test('FR-EXP-PCOST-002 FR-EXP-PCOST-003 出資額を読んだあとに出資の記録が変わったら（作品の費用の版・委員会の条件版が足された）、受け口は 409 で版を足さず、読み直せば変わったあとの額で作れる', async (t) => {
  const db = await openTestDb({t});
  const {proxy, state} = racingBatchDb(db, /INSERT INTO production_cost_versions/);
  const {login, call} = await appWithLogin(proxy);
  const admin = await login('admin@openingnight.invalid');
  const own = await addWork(db, 'FICT-PC-MOVE-OWN');
  await addFinance(db, own, 1, {ownYen: 60000000, status: 'confirmed'});
  const committee = await addWork(db, 'FICT-PC-MOVE-COM');
  const {contract} = await addCommittee(db, committee, 'FICT-PC-MOVE-COM-C', [{fundingYen: 80000000, investments: [[1, 50000000], [2, 30000000]]}]);
  // 割り込む書き込み: 受け口が出資の記録を読んだあとに、自社の出資額を改めた作品の費用の版2（6,500万円）か、
  // 追加出資で作り直した委員会の条件版2（1億1,000万円）が入る。読んだ版は最新でなくなり、出資額の照合のトリガーが断る
  for (const [workId, race, amountYen] of [
    [own, () => addFinance(db, own, 2, {ownYen: 65000000, status: 'confirmed'}), 65000000],
    [committee, () => addTerm(db, contract, 2, {fundingYen: 110000000, investments: [[1, 66000000], [2, 44000000]]}), 110000000],
  ]) {
    state.race = race;
    const res = await call(admin, path(workId, 'from-investment'), {method: 'POST', payload: {}});
    assert.equal(state.race, null, '割り込みが流れた');
    assert.deepEqual([res.status, res.body.error, res.body.dbError?.kind], [409, '出資の記録が読んだあとに変わりました。読み直してください', 'raise'], `作品 ${workId}`);
    assert.equal(await versionCount(db, workId), 0);
    // 読み直して送れば、変わったあとの出資額で版1が作られる
    const retry = await call(admin, path(workId, 'from-investment'), {method: 'POST', payload: {}});
    assert.deepEqual([retry.status, retry.body.versionNo, retry.body.amountYen], [201, 1, amountYen], JSON.stringify(retry.body));
  }
  const logged = await db.all("SELECT entity_id FROM audit_log WHERE org_id=1 AND entity_type='production_cost_version' ORDER BY id");
  assert.deepEqual(logged.map((r) => r.entity_id), [`${own}:1`, `${committee}:1`]);
});

test('FR-EXP-PCOST-039 FR-EXP-PCOST-021 FR-EXP-PCOST-023 出資の記録が無い作品だけ契約書から入れられ、契約書の参照・締結日・相手・額の無い手入力は API も DB も断る。税込の契約は税抜に戻した額と戻し方が残る', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-PC-CON');
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const payload = {contractReference: 'FICT-CONTRACT-001', signedOn: '2026-08-20', counterpartyPartnerId: 1, contractAmountYen: 33000000, contractTaxBasis: 'inc_tax',
    exTaxAmountYen: 30000000, taxConversion: '税込 3,300万円 ÷ 1.10（架空）'};
  // 契約書の参照・締結日・相手・額の無い手入力（シナリオ16）と、税込で戻し方の無い手入力は 400。版も記録も残さない
  const missing = await call(admin, path(work, 'from-contract'), {method: 'POST', payload: {contractAmountYen: 30000000, contractTaxBasis: 'ex_tax'}});
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.details.map((e) => e.field), ['contractReference', 'signedOn', 'counterpartyPartnerId']);
  const noConversion = await call(admin, path(work, 'from-contract'), {method: 'POST', payload: {...payload, taxConversion: ''}});
  assert.deepEqual([noConversion.status, noConversion.body.details.map((e) => e.field)], [400, ['taxConversion']]);
  const tooLarge = await call(admin, path(work, 'from-contract'), {method: 'POST', payload: {...payload, exTaxAmountYen: 33000001}});
  assert.deepEqual([tooLarge.status, tooLarge.body.details.map((e) => e.field)], [400, ['exTaxAmountYen']]);
  const badDate = await call(admin, path(work, 'from-contract'), {method: 'POST', payload: {...payload, signedOn: '2026-02-30'}});
  assert.deepEqual([badDate.status, badDate.body.details.map((e) => e.field)], [400, ['signedOn']]);
  // 別の組織の取引先は相手にできない
  const foreign = await call(admin, path(work, 'from-contract'), {method: 'POST', payload: {...payload, counterpartyPartnerId: 4}});
  assert.deepEqual([foreign.status, foreign.body.details.map((e) => e.field)], [400, ['counterpartyPartnerId']]);
  assert.equal(await versionCount(db, work), 0);
  // 税込で契約した作品（シナリオ18）: 税抜に戻した額が版の額になり、戻し方が根拠に残る
  const added = await call(admin, path(work, 'from-contract'), {method: 'POST', payload});
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual(added.body, {ok: true, workId: work, versionNo: 1, sourceKind: 'contract', amountYen: 30000000, taxBasis: 'ex_tax', status: 'registered'});
  const read = await call(admin, path(work));
  assert.deepEqual([read.body.status, read.body.latest.amountYen, read.body.latest.taxBasis, read.body.latest.investment, read.body.latest.contract, read.body.latest.note],
    ['registered', 30000000, 'ex_tax', null,
      {reference: 'FICT-CONTRACT-001', signedOn: '2026-08-20', counterpartyPartnerId: 1, amountYen: 33000000, taxBasis: 'inc_tax', taxConversion: '税込 3,300万円 ÷ 1.10（架空）'}, null]);
  // 税抜の契約は契約書の額がそのまま版の額
  const exTax = await addWork(db, 'FICT-PC-CON2');
  const exTaxAdded = await call(admin, path(exTax, 'from-contract'), {method: 'POST', payload: {...payload, contractAmountYen: 30000000, contractTaxBasis: 'ex_tax', exTaxAmountYen: undefined, taxConversion: undefined}});
  assert.deepEqual([exTaxAdded.status, exTaxAdded.body.amountYen], [201, 30000000]);
  // 出資の記録がある作品は、契約書から入れられない（出資額の確定・見込み・委員会のどれでも 409）
  const own = await addWork(db, 'FICT-PC-CON-OWN');
  await addFinance(db, own, 1, {ownYen: 50000000, status: 'estimated'});
  const committee = await addWork(db, 'FICT-PC-CON-COM');
  await addCommittee(db, committee, 'FICT-PC-CON-COM-C', [{fundingYen: 80000000, investments: [[1, 50000000], [2, 30000000]]}]);
  for (const id of [own, committee]) {
    const refused = await call(admin, path(id, 'from-contract'), {method: 'POST', payload});
    assert.deepEqual([refused.status, refused.body.details.reason], [409, 'investment_recorded'], `作品 ${id}`);
    assert.equal(await versionCount(db, id), 0);
  }
  // 読んだあとに出資の記録が入ったら、同じ batch の止めの文が版を入れさせない
  const late = await addWork(db, 'FICT-PC-CON-LATE');
  await addFinance(db, late, 1, {ownYen: 40000000, status: 'confirmed'});
  const value = normalizeContractVersionInput({...payload}).value;
  await assert.rejects(store.addProductionCostVersion(db, 1, late, value, {createdBy: ADMIN, guards: [store.noInvestmentRecordGuard(1, late)]}), (error) => isGuardViolation(error));
  assert.equal(await versionCount(db, late), 0);
  // アプリを通さない書き込み: 契約書の参照・締結日・相手・額・税の区分のどれかが無い手入力、税込で戻し方の無い手入力、
  // 税抜の契約で額の違う手入力、税込の契約で額が契約書を超える手入力、税の区分が「不明」の手入力は、表の CHECK が断る（FR-EXP-PCOST-021）
  const manual = await addWork(db, 'FICT-PC-CON-DB');
  for (const overrides of [{reference: null}, {signedOn: null}, {partnerId: null}, {contractAmountYen: null}, {contractTaxBasis: null},
    {contractTaxBasis: 'inc_tax', contractAmountYen: 52800000}, {amountYen: 47999999}, {contractTaxBasis: 'inc_tax', contractAmountYen: 47999999, taxConversion: '架空'},
    {taxBasis: 'unknown'}, {signedOn: '2026-13-01'}, {workFinanceRevision: 1}]) {
    await rejects(insertVersion(db, manual, contractRow(overrides)), 'check', undefined);
  }
  // 版の額は整数の円だけ（小数・0円は断る）
  await rejects(insertVersion(db, manual, contractRow({amountYen: 0, contractAmountYen: 0})), 'check');
  await rejects(insertVersion(db, manual, contractRow({amountYen: 1000.5, contractAmountYen: 1000.5})), 'check');
  assert.equal(await versionCount(db, manual), 0);
  await insertVersion(db, manual, contractRow());
  assert.equal(await versionCount(db, manual), 1);
});

test('FR-EXP-PCOST-008 FR-EXP-PCOST-039 登録できるのは管理者だけ（プロデューサーの役目の表が無いあいだ）。編集担当は財務の権限のある作品を読めるが登録できず、制作担当・権限の無い作品・別の組織には返さない', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-PC-ACL');
  await addFinance(db, work, 1, {ownYen: 77777777, status: 'confirmed'});
  const free = await addWork(db, 'FICT-PC-ACL-FREE');
  const {login, call} = await appWithLogin(db);
  const contract = {contractReference: 'FICT-CONTRACT-ACL', signedOn: '2026-08-20', counterpartyPartnerId: 1, contractAmountYen: 30000000, contractTaxBasis: 'ex_tax'};
  // 編集担当（案件1に編集の権限）: 読めるが、プロデューサーの役目を確かめられないので登録できない（403。版も記録も残さない）
  const editor = await login('editor@openingnight.invalid');
  const editorRead = await call(editor, path(work));
  assert.equal(editorRead.status, 200);
  assert.deepEqual([editorRead.body.canRegister, editorRead.body.registrable, editorRead.body.investment.amountYen], [false, {fromInvestment: false, fromContract: false}, 77777777]);
  assert.equal((await call(editor, path(work, 'from-investment'), {method: 'POST', payload: {}})).status, 403);
  const editorContract = await call(editor, path(free, 'from-contract'), {method: 'POST', payload: contract});
  assert.equal(editorContract.status, 403);
  assert.match(editorContract.body.error, /管理者と、この作品にプロデューサーの役目を持つ人/);
  // 編集の権限の無い案件の作品は、編集担当にも読ませない（制作の権限だけでは財務の値を読めない）
  const otherProject = Number((await db.get("INSERT INTO projects(org_id,code,title) VALUES(1,'FICT-PC-PRJ','架空の案件') RETURNING id")).id);
  const outside = await addWork(db, 'FICT-PC-ACL-OUT', otherProject);
  assert.equal((await call(editor, path(outside))).status, 403);
  await raw(db, "INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,?,'production')", [otherProject, EDITOR]);
  assert.equal((await call(editor, path(outside))).status, 403);
  // 制作担当は、案件に編集の権限が付いていても読めも登録もできない
  const production = await login('production@openingnight.invalid');
  await raw(db, "INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,3,'edit')", [otherProject]);
  for (const id of [work, outside]) {
    assert.equal((await call(production, path(id))).status, 403);
    assert.equal((await call(production, path(id, 'from-investment'), {method: 'POST', payload: {}})).status, 403);
  }
  // 別の組織の管理者には、作品の有無も見せない（無い作品と同じ 403）。番号の読めない作品は 400
  const outsider = await login('outsider@other.invalid');
  const hidden = await call(outsider, path(work));
  assert.equal(hidden.status, 403);
  assert.equal(JSON.stringify(hidden.body).includes('77777777'), false);
  assert.deepEqual((await call(outsider, path(999999))).body, hidden.body);
  assert.equal((await call(outsider, path(work, 'from-investment'), {method: 'POST', payload: {}})).status, 403);
  const admin = await login('admin@openingnight.invalid');
  assert.equal((await call(admin, path('abc'))).status, 400);
  assert.equal(await versionCount(db, work) + await versionCount(db, free), 0);
  // 管理者は登録できる
  assert.equal((await call(admin, path(free, 'from-contract'), {method: 'POST', payload: contract})).status, 201);
  assert.equal((await call(admin, path(work, 'from-investment'), {method: 'POST', payload: {}})).status, 201);
  const logged = await db.all("SELECT user_id FROM audit_log WHERE org_id=1 AND entity_type='production_cost_version'");
  assert.deepEqual(logged.map((r) => Number(r.user_id)), [ADMIN, ADMIN]);
});
