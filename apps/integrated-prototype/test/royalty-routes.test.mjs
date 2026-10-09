import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {loadRoyaltyAccruals} from '../src/royalty/royalty-loader.mjs';

// 表のトリガーの拒否（RAISE）を、種類と文言で確かめる
const raised = (pattern) => (e) => e.dbError?.kind === 'raise' && pattern.test(e.message);

// 架空のデータだけを使う。売上は計上月2025年（今日より前）に置き、基準日を指定して状態を決める
async function fixture({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, payload, cookie = admin) => {
    const response = await app.request(`/api${path}`, {method: payload ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: payload ? JSON.stringify(payload) : undefined});
    return {status: response.status, data: await response.json()};
  };
  const ok = (r) => { assert.ok(r.status < 300 && r.data.ok !== false, JSON.stringify(r.data)); return r.data; };
  let n = 0;
  const sale = async (month, amount, {kind = 'digital', workId = 1, product = 1} = {}) => {
    n += 1;
    return ok(await req('/sales', {workId, report_key: `RY-${n}`, kind, description: `架空売上 ${n}`, quantity: 1, basis_reason: '架空の根拠', recognition_basis_id: 1,
      partner_id: 2, product_id: product, period_from: `${month}-01`, period_to: `${month}-28`, sales_month: month, amount_ex_tax: amount, tax_amount: amount / 10, amount_inc_tax: amount + amount / 10}));
  };
  await db.run("INSERT INTO partners(id,org_id,code,name,kind) VALUES(10,1,'PT-DIR','架空監督A','other'),(11,1,'PT-MUS','架空音楽出版','other'),(12,1,'PT-SCR','架空脚本家B','other')");
  const quarterly = {phases: [{startsMonth: '2025-01', cycleKind: 'quarterly', anchorMonth: 3, reportOffsetMonths: 1, reportDay: 'eom', paymentOffsetMonths: 2, paymentDay: 'eom'}]};
  const create = async (overrides = {}) => ok(await req('/royalty/agreements', {workId: 1, holderPartnerId: 10, category: 'director', agreementCode: 'RY-DIR-1', title: '架空の監督料契約',
    documentReference: '架空の契約書 第1版', term: {effectiveFrom: '2025-01', calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 1000, clauseReference: '第8条'}, schedule: quarterly, ...overrides}));
  return {db, app, req, ok, login, admin, sale, create, quarterly};
}

test('FR-SETL-STMT-002 FR-SETL-STMT-033 ロイヤリティ契約: 登録（条件版・サイクルつき）・一覧・入力の検査・重複・権限', async (t) => {
  const f = await fixture({t});
  const empty = await f.req('/royalty/agreements', {workId: 1});
  assert.equal(empty.status, 400);
  const fields = empty.data.details.errors.map((e) => e.field);
  for (const field of ['holderPartnerId', 'category', 'agreementCode', 'title', 'term.effectiveFrom', 'term.calcMethod', 'term.clauseReference', 'schedule.phases']) assert.ok(fields.includes(field), field);
  const created = await f.create();
  assert.ok(created.agreementId && created.termVersionId && created.scheduleVersionId);
  const dup = await f.req('/royalty/agreements', {workId: 1, holderPartnerId: 10, category: 'director', agreementCode: 'RY-DIR-1', title: 'x',
    term: {effectiveFrom: '2025-01', calcMethod: 'manual', clauseReference: 'x'}, schedule: f.quarterly});
  assert.equal(dup.status, 409);
  const late = await f.req('/royalty/agreements', {workId: 1, holderPartnerId: 10, category: 'music', agreementCode: 'RY-X', title: 'x',
    term: {effectiveFrom: '2025-01', calcMethod: 'manual', clauseReference: 'x'}, schedule: {phases: [{startsMonth: '2025-04', cycleKind: 'monthly'}]}});
  assert.equal(late.status, 400, 'サイクルは条件の適用開始以前から');
  const list = f.ok(await f.req('/royalty/agreements'));
  assert.equal(list.agreements.length, 1);
  const row = list.agreements[0];
  assert.equal(row.categoryLabel, '監督料');
  assert.equal(row.termText, '売上 × 10%');
  assert.equal(row.cycleText, '四半期（3・6・9・12月締め）');
  assert.equal(row.reportText, '翌月末');
  assert.equal(row.paymentText, '翌々月末');
  assert.equal(row.channelText, 'すべての流通');
  assert.equal(list.holders[0].name, '架空監督A');
  assert.equal(list.cyclePresets.length, 9);
  const production = await f.login('production@openingnight.invalid');
  assert.equal((await f.req('/royalty/agreements', null, production)).status, 403);
  assert.equal((await f.req('/royalty/periods', null, production)).status, 403);
  assert.equal((await f.req('/royalty/ledger?from=2025-01&to=2025-12', null, production)).status, 403);
  const outsider = await f.login('outsider@other.invalid');
  assert.equal(f.ok(await f.req('/royalty/agreements', null, outsider)).agreements.length, 0, '別組織には見えない');
  assert.equal((await f.req(`/royalty/agreements/${created.agreementId}`, null, outsider)).status, 404);
  const audit = await f.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type='royalty_agreement'");
  assert.equal(audit.n, 1);
});

test('FR-SETL-STMT-002 FR-SETL-STMT-049 条件版・サイクルの版: 適用開始の順・理由・重なりの検査と、表のトリガー', async (t) => {
  const f = await fixture({t});
  const {agreementId, termVersionId, scheduleVersionId} = await f.create();
  const before = await f.req(`/royalty/agreements/${agreementId}/terms`, {effectiveFrom: '2025-01', calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 1200, clauseReference: '覚書', reason: '料率の変更'});
  assert.equal(before.status, 400);
  const noReason = await f.req(`/royalty/agreements/${agreementId}/terms`, {effectiveFrom: '2025-07', calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 1200, clauseReference: '覚書'});
  assert.equal(noReason.status, 400);
  f.ok(await f.req(`/royalty/agreements/${agreementId}/terms`, {effectiveFrom: '2025-07', calcMethod: 'rate', baseKind: 'after_window_fee_and_expenses', windowFeeBps: 2000, rateBps: 1200,
    channels: ['digital', 'theatrical'], expenseCategories: ['宣伝費'], clauseReference: '覚書第2条', reason: '料率と基礎の変更'}));
  const overlap = await f.req(`/royalty/agreements/${agreementId}/schedules`, {reason: '変更', phases: [{startsMonth: '2025-01', cycleKind: 'monthly'}, {startsMonth: '2025-06', cycleKind: 'annual', anchorMonth: 6}]});
  assert.equal(overlap.status, 400);
  f.ok(await f.req(`/royalty/agreements/${agreementId}/schedules`, {reason: '半年から四半期へ', phases: [
    {startsMonth: '2025-01', endsMonth: '2025-03', cycleKind: 'semiannual', anchorMonth: 6}, {startsMonth: '2025-04', cycleKind: 'quarterly', anchorMonth: 3, reportOffsetMonths: 2, reportDay: '15'}]}));
  const detail = f.ok(await f.req(`/royalty/agreements/${agreementId}`));
  assert.equal(detail.terms.length, 2);
  assert.deepEqual(detail.terms[1].channels, ['digital', 'theatrical']);
  assert.deepEqual(detail.terms[1].expenseCategories, ['宣伝費']);
  assert.equal(detail.schedules.length, 2);
  assert.equal(detail.schedules[1].phases[1].reportText, '締め月の2か月後の15日');
  // 表のトリガー（アプリを通らない書き込みも止める）
  const raw = (sql, params, check) => assert.rejects(f.db.run(sql, params), check);
  await raw("INSERT INTO royalty_term_versions(org_id,agreement_id,version_no,effective_from,calc_method,clause_reference,created_by) VALUES(1,?,3,'2025-05','manual','x',1)", [agreementId], raised(/前の版より後の月/));
  await raw("INSERT INTO royalty_term_versions(org_id,agreement_id,version_no,effective_from,calc_method,clause_reference,created_by) VALUES(1,?,5,'2026-01','manual','x',1)", [agreementId], raised(/版番号が連続していません/));
  await raw('INSERT INTO royalty_term_channels(org_id,term_version_id,channel_group,created_by) VALUES(1,?,?,1)', [termVersionId, 'broadcast'], raised(/対象流通は、報告書で使われる前の最新の条件版にだけ/));
  await raw("INSERT INTO royalty_term_expense_categories(org_id,term_version_id,category,created_by) VALUES(1,?,'事務費',1)", [termVersionId], raised(/控除する経費の費目は、(?:報告書で使われる前の最新の|経費を差し引く基礎の)条件版にだけ登録できます/));
  await raw("INSERT INTO royalty_schedule_phases(org_id,schedule_version_id,starts_month,cycle_kind,created_by) VALUES(1,?,'2026-01','monthly',1)", [scheduleVersionId], raised(/最新のサイクルの版にだけ/));
  const latestSchedule = detail.schedules[1].id;
  await raw("INSERT INTO royalty_schedule_phases(org_id,schedule_version_id,starts_month,cycle_kind,created_by) VALUES(1,?,'2025-02','monthly',1)", [latestSchedule], raised(/期間が重なっています/));
  await raw("INSERT INTO royalty_schedule_phases(org_id,schedule_version_id,starts_month,cycle_kind,anchor_month,created_by) VALUES(1,?,'2030-01','monthly',3,1)", [latestSchedule], raised(/期間が重なっています/));
  await raw('UPDATE royalty_agreements SET title=? WHERE id=?', ['書き換え', agreementId], raised(/ロイヤリティ契約は変更できません/));
  await raw('DELETE FROM royalty_term_versions WHERE id=?', [termVersionId], raised(/条件版は削除できません/));
  await raw("INSERT INTO royalty_term_versions(org_id,agreement_id,version_no,effective_from,calc_method,base_kind,rate_bps,clause_reference,created_by) VALUES(1,?,3,'2026-01','rate','after_window_fee',100,'x',1)", [agreementId], (e) => e.dbError?.kind === 'check');
});

test('FR-SETL-STMT-008 FR-SETL-STMT-009 FR-SETL-STMT-010 FR-SETL-STMT-013 FR-SETL-STMT-018 FR-SETL-STMT-019 FR-SETL-STMT-023 FR-SETL-STMT-024 FR-SETL-STMT-025 FR-SETL-STMT-026 期間の一覧と一括作成: 古い順・確認必須・前の期間を飛ばさない・二重に作らない・報告と支払の記録で状態が進む', async (t) => {
  const f = await fixture({t});
  await f.create();
  for (const [month, amount] of [['2025-01', 100000], ['2025-02', 200000], ['2025-04', 300000], ['2025-06', 50000]]) await f.sale(month, amount);
  const periods = f.ok(await f.req('/royalty/periods?asOf=2025-08-15'));
  const byClose = Object.fromEntries(periods.periods.map((p) => [p.closeMonth, p]));
  assert.deepEqual(Object.keys(byClose).sort(), ['2025-03', '2025-06', '2025-09']);
  assert.equal(byClose['2025-03'].status, 'overdue');
  assert.equal(byClose['2025-03'].reportDueOn, '2025-04-30');
  assert.equal(byClose['2025-03'].payableYen, 30000);
  assert.equal(byClose['2025-06'].status, 'overdue');
  assert.equal(byClose['2025-06'].payableYen, 35000);
  assert.equal(byClose['2025-09'].status, 'open');
  assert.equal(byClose['2025-09'].statusLabel, '受付中');
  assert.equal(periods.creatable.count, 2);
  assert.equal(periods.creatable.payableYen, 65000);
  assert.ok(byClose['2025-03'].draft.checksOk);
  assert.equal(byClose['2025-03'].draft.inputHash.length, 64);
  assert.equal((await f.req('/royalty/statements/generate', {asOf: '2025-08-15'})).status, 400, '確認が必要');
  assert.equal((await f.req('/royalty/statements/generate', {asOf: '2999-01-01', confirmed: true})).status, 400, '基準日は今日以前');
  const skip = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-08-15', confirmed: true, keys: ['10:2025-06']}));
  assert.equal(skip.created.length, 0);
  assert.match(skip.skipped[0].reason, /前の期間/);
  const stale = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-08-15', confirmed: true, keys: ['10:2025-03'], expectedHashes: {'10:2025-03': 'x'.repeat(64)}}));
  assert.equal(stale.created.length, 0);
  assert.match(stale.skipped[0].reason, /変わりました/);
  // 一覧で見た下書きの照合値を渡す（2つ目の期間も、前の期間を作った後の照合値が一覧と一致する）
  const made = await f.req('/royalty/statements/generate', {asOf: '2025-08-15', confirmed: true,
    expectedHashes: {'10:2025-03': byClose['2025-03'].draft.inputHash, '10:2025-06': byClose['2025-06'].draft.inputHash}});
  assert.equal(made.status, 201);
  assert.deepEqual(made.data.created.map((c) => [c.closeMonth, c.payableYen]), [['2025-03', 30000], ['2025-06', 35000]]);
  const again = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-08-15', confirmed: true}));
  assert.equal(again.created.length, 0, '二重に作らない');
  const after = f.ok(await f.req('/royalty/periods?asOf=2025-08-15'));
  const q1 = after.periods.find((p) => p.closeMonth === '2025-03');
  assert.equal(q1.status, 'overdue', '作成済みでも報告期限を過ぎて報告の記録が無ければ期限超過');
  assert.ok(q1.statementId);
  const q2 = after.periods.find((p) => p.closeMonth === '2025-06');
  const detail = f.ok(await f.req(`/royalty/statements/${q2.statementId}`));
  assert.equal(detail.statement.carriedInYen, 0);
  assert.equal(detail.statement.previousStatementId, q1.statementId);
  assert.equal(detail.calculation.rows[0].prior.amountYen, 30000);
  assert.equal(detail.calculation.rows[0].current.amountYen, 35000);
  assert.equal(detail.calculation.rows[0].cumulative.amountYen, 65000);
  assert.ok(detail.calculation.checks.every((c) => c.value === 0));
  assert.equal(detail.statement.canVoid, true);
  const q1detail = f.ok(await f.req(`/royalty/statements/${q1.statementId}`));
  assert.equal(q1detail.statement.canVoid, false, '後の報告書があると取り消せない');
  // 報告と支払
  assert.equal((await f.req(`/royalty/statements/${q1.statementId}/events`, {kind: 'paid', occurredOn: '2025-05-20', amountYen: 30000})).status, 400, '識別番号が必要');
  assert.equal((await f.req(`/royalty/statements/${q1.statementId}/events`, {kind: 'paid', occurredOn: '2025-05-20', amountYen: 30001, reference: 'PAY-1'})).status, 400, '支払予定額を超えない');
  f.ok(await f.req(`/royalty/statements/${q1.statementId}/events`, {kind: 'reported', occurredOn: '2025-04-25'}));
  assert.equal((await f.req(`/royalty/statements/${q1.statementId}/events`, {kind: 'reported', occurredOn: '2025-04-26'})).status, 409);
  const reportedPeriods = f.ok(await f.req('/royalty/periods?asOf=2025-08-15'));
  assert.equal(reportedPeriods.periods.find((p) => p.closeMonth === '2025-03').status, 'reported');
  const pay = f.ok(await f.req(`/royalty/statements/${q1.statementId}/events`, {kind: 'paid', occurredOn: '2025-05-20', amountYen: 30000, reference: 'PAY-1'}));
  assert.equal(f.ok(await f.req('/royalty/periods?asOf=2025-08-15')).periods.find((p) => p.closeMonth === '2025-03').status, 'paid');
  assert.equal((await f.req(`/royalty/statements/${q1.statementId}/events`, {kind: 'reverse', eventId: pay.id})).status, 400, '取消は理由が必要');
  f.ok(await f.req(`/royalty/statements/${q1.statementId}/events`, {kind: 'reverse', eventId: pay.id, reason: '振込先の誤り', occurredOn: '2025-05-21'}));
  assert.equal((await f.req(`/royalty/statements/${q1.statementId}/events`, {kind: 'reverse', eventId: pay.id, reason: '二重'})).status, 409);
  const list = f.ok(await f.req('/royalty/statements?asOf=2025-08-15'));
  assert.equal(list.statements.length, 2);
  assert.equal(list.statements.find((s) => s.closeMonth === '2025-03').paidYen, 0);
  // 表のトリガー: 同じ権利者・締め月に2つ目の確定版、前期繰越の不一致、明細の和の不一致
  const insert = (holder, close, previous, carriedIn, version = 1) => f.db.run(`INSERT INTO royalty_statements(org_id,holder_partner_id,close_month,version_no,previous_statement_id,calculation_version,as_of,input_hash,calculation_json,
    royalty_yen,adjustment_yen,advance_recouped_yen,carried_in_yen,payable_yen,carried_out_yen,hold_count,line_count,created_by) VALUES(1,?,?,?,?,'royalty-cycle-v1','2025-08-15',?,'{}',0,0,0,?,?,0,0,0,1)`,
    [holder, close, version, previous, 'h'.repeat(64), carriedIn, carriedIn]);
  await assert.rejects(insert(10, '2025-06', q1.statementId, 0), raised(/作成済み/));
  await assert.rejects(insert(10, '2025-03', null, 0, 2), raised(/作成済み|後の締め月/));
  await assert.rejects(insert(10, '2025-09', q1.statementId, 0), raised(/前の報告書/));
  await assert.rejects(insert(10, '2025-09', q2.statementId, 5), raised(/前期繰越/));
  await assert.rejects(f.db.run("INSERT INTO royalty_statement_lines(org_id,statement_id,line_no,line_kind,agreement_id,accrual_month,amount_yen,created_by) VALUES(1,?,99,'accrual',1,'2025-01',1,1)", [q1.statementId]), raised(/行数/));
  await assert.rejects(f.db.run('UPDATE royalty_statements SET payable_yen=0 WHERE id=?', [q1.statementId]), raised(/確定版は変更できません/));
  await assert.rejects(f.db.run('DELETE FROM royalty_statement_events WHERE id=?', [pay.id]), raised(/記録は削除できません/));
});

test('FR-SETL-STMT-014 FR-SETL-STMT-016 FR-SETL-STMT-024 報告後の売上の追加は次の報告書に差額で入り、取消・作り直しは最新から順に（支払の記録があると取り消せない）', async (t) => {
  const f = await fixture({t});
  await f.create({term: {effectiveFrom: '2025-01', calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 1000, clauseReference: '第8条', minPaymentYen: 50000}});
  await f.sale('2025-02', 200000);
  f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-05-10', confirmed: true}));
  const first = f.ok(await f.req('/royalty/statements?asOf=2025-05-10')).statements[0];
  assert.equal(first.payableYen, 0, '下限5万円未満は繰り越し');
  assert.equal(first.carriedOutYen, 20000);
  await f.sale('2025-02', 100000); // 報告の後に届いた2月分
  await f.sale('2025-05', 400000);
  const preview = f.ok(await f.req('/royalty/statements/preview?holderId=10&closeMonth=2025-06&asOf=2025-07-10'));
  assert.equal(preview.preview, true);
  assert.equal(preview.canCreate, true);
  const revision = preview.statement.lines.find((line) => line.lineKind === 'revision');
  assert.equal(revision.accrualMonth, '2025-02');
  assert.equal(revision.amountYen, 10000);
  assert.equal(preview.statement.totals.carriedInYen, 20000);
  assert.equal(preview.statement.totals.payableYen, 20000 + 10000 + 40000);
  assert.equal((await f.req('/royalty/statements/preview?holderId=10&closeMonth=2025-03&asOf=2025-07-10')).data.preview, false, '作成済みは確定版を返す');
  f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-07-10', confirmed: true}));
  const statements = f.ok(await f.req('/royalty/statements?asOf=2025-07-10')).statements;
  const q2 = statements.find((s) => s.closeMonth === '2025-06');
  const q1 = statements.find((s) => s.closeMonth === '2025-03');
  assert.equal(q2.payableYen, 70000);
  assert.equal((await f.req(`/royalty/statements/${q1.id}/void`, {reason: '誤り'})).status, 409, '後の報告書があると取り消せない');
  f.ok(await f.req(`/royalty/statements/${q2.id}/events`, {kind: 'paid', occurredOn: '2025-08-20', amountYen: 70000, reference: 'PAY-Q2'}));
  assert.equal((await f.req(`/royalty/statements/${q2.id}/void`, {reason: '誤り'})).status, 409, '支払の記録があると取り消せない');
  const paid = f.ok(await f.req(`/royalty/statements/${q2.id}`)).statement.events[0];
  f.ok(await f.req(`/royalty/statements/${q2.id}/events`, {kind: 'reverse', eventId: paid.id, reason: '取消のため戻す', occurredOn: '2025-08-21'}));
  assert.equal((await f.req(`/royalty/statements/${q2.id}/void`, {})).status, 400, '理由が必要');
  f.ok(await f.req(`/royalty/statements/${q2.id}/void`, {reason: '計算条件の誤り'}));
  assert.equal((await f.req(`/royalty/statements/${q2.id}/events`, {kind: 'reported', occurredOn: '2025-08-01'})).status, 409, '取り消した報告書には記録しない');
  const reopened = f.ok(await f.req('/royalty/periods?asOf=2025-07-10')).periods.find((p) => p.closeMonth === '2025-06');
  assert.equal(reopened.statementId, null);
  assert.equal(reopened.status, 'pending');
  f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-07-10', confirmed: true, keys: ['10:2025-06']}));
  const withVoided = f.ok(await f.req('/royalty/statements?asOf=2025-07-10&includeVoided=1')).statements.filter((s) => s.closeMonth === '2025-06');
  assert.deepEqual(withVoided.map((s) => [s.versionNo, s.status]).sort(), [[1, 'voided'], [2, 'created']]);
});

test('FR-SETL-ACCR-013 実額の計上（取消つき）と、実額入力でない月の拒否', async (t) => {
  const f = await fixture({t});
  const {agreementId} = await f.create({holderPartnerId: 11, category: 'music', agreementCode: 'RY-MUS-1', title: '架空の音楽著作権料',
    term: {effectiveFrom: '2025-01', calcMethod: 'manual', clauseReference: '分配規程'}, schedule: {phases: [{startsMonth: '2025-01', cycleKind: 'semiannual', anchorMonth: 6}]}});
  const bad = await f.req('/royalty/manual-accruals', {agreementId, accrualMonth: '2024-12', amountYen: 1000, sourceReference: 'X', reason: 'x'});
  assert.equal(bad.status, 400, '条件版の前の月');
  const first = f.ok(await f.req('/royalty/manual-accruals', {agreementId, accrualMonth: '2025-03', amountYen: '12,345', sourceReference: '架空の分配明細 2025-03', reason: '分配明細の額'}));
  assert.equal((await f.req('/royalty/manual-accruals', {agreementId, accrualMonth: '2025-03', amountYen: 1, sourceReference: '架空の分配明細 2025-03', reason: '二重'})).status, 409);
  const april = f.ok(await f.req('/royalty/manual-accruals', {agreementId, accrualMonth: '2025-04', amountYen: 5000, sourceReference: '架空の分配明細 2025-04', reason: '分配明細の額'}));
  assert.equal((await f.req(`/royalty/manual-accruals/${first.id}/reverse`, {})).status, 400);
  f.ok(await f.req(`/royalty/manual-accruals/${first.id}/reverse`, {reason: '明細の差し替え'}));
  assert.equal((await f.req(`/royalty/manual-accruals/${first.id}/reverse`, {reason: '二重'})).status, 409);
  const detail = f.ok(await f.req(`/royalty/agreements/${agreementId}`));
  assert.equal(detail.manualAccruals.length, 3);
  assert.equal(detail.manualAccruals.find((m) => m.id === first.id).reversed, true);
  const accrued = Object.fromEntries(detail.accruals.map((a) => [a.accrualMonth, a.royaltyYen]));
  assert.deepEqual(accrued, {'2025-03': 0, '2025-04': 5000}, '取消した月は0（計上と取消の和）');
  await assert.rejects(f.db.run("INSERT INTO royalty_manual_accruals(org_id,agreement_id,accrual_month,amount_yen,source_reference,reason,reverses_entry_id,created_by) VALUES(1,?,'2025-04',-1,'x','x',?,1)", [agreementId, april.id]), raised(/一致しません/));
  await assert.rejects(f.db.run("INSERT INTO royalty_manual_accruals(org_id,agreement_id,accrual_month,amount_yen,source_reference,reason,reverses_entry_id,created_by) VALUES(1,?,'2025-03',-12345,'x','x',?,1)", [agreementId, first.id]), raised(/置き換えられません/), '取消済みの計上を二重に取り消さない');
  const rate = await f.create({agreementCode: 'RY-DIR-2'});
  assert.equal((await f.req('/royalty/manual-accruals', {agreementId: rate.agreementId, accrualMonth: '2025-03', amountYen: 1, sourceReference: 'x', reason: 'x'})).status, 400, '料率の月は実額を計上しない');
});

test('FR-SETL-STMT-009 FR-SETL-STMT-029 FR-SETL-STMT-030 イレギュラーの台帳: 保留・解除・締め月の変更・金額の調整・取消と、報告済みの月・締め済みの月の拒否', async (t) => {
  const f = await fixture({t});
  const {agreementId} = await f.create({schedule: {phases: [{startsMonth: '2025-01', cycleKind: 'monthly'}]}});
  for (const [month, amount] of [['2025-01', 100000], ['2025-02', 200000], ['2025-03', 300000]]) await f.sale(month, amount);
  const hold = f.ok(await f.req('/royalty/irregular-entries', {agreementId, kind: 'hold', accrualMonth: '2025-02', reason: '明細の確認中'}));
  assert.equal((await f.req('/royalty/irregular-entries', {agreementId, kind: 'hold', accrualMonth: '2025-02', reason: '二重'})).status, 409);
  assert.equal((await f.req('/royalty/irregular-entries', {agreementId, kind: 'release', accrualMonth: '2025-01', reason: 'x'})).status, 409, '保留していない月は解けない');
  assert.equal((await f.req('/royalty/irregular-entries', {holderPartnerId: 10, kind: 'hold', accrualMonth: '2025-02', reason: 'x'})).status, 400, '保留は契約を選ぶ');
  assert.equal((await f.req('/royalty/irregular-entries', {agreementId, kind: 'adjust_amount', closeMonth: '2025-03', reason: 'x'})).status, 400, '金額が必要');
  const adjust = f.ok(await f.req('/royalty/irregular-entries', {holderPartnerId: 10, kind: 'adjust_amount', closeMonth: '2025-03', amountYen: -3000, reason: '振込手数料の負担', sourceReference: '架空の合意メール'}));
  f.ok(await f.req('/royalty/irregular-entries', {agreementId, kind: 'note', reason: '権利者と電話で確認'}));
  f.ok(await f.req('/royalty/irregular-entries', {agreementId, kind: 'move_period', accrualMonth: '2025-03', closeMonth: '2025-05', reason: '協議で5月締めへ'}));
  f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-04-10', confirmed: true}));
  const list = f.ok(await f.req('/royalty/statements?asOf=2025-04-10')).statements;
  assert.deepEqual(list.map((s) => [s.closeMonth, s.royaltyYen, s.adjustmentYen]).sort(), [['2025-01', 10000, 0], ['2025-02', 0, 0], ['2025-03', 0, -3000]]);
  const feb = list.find((s) => s.closeMonth === '2025-02');
  assert.equal(feb.holdCount, 1);
  assert.equal((await f.req('/royalty/irregular-entries', {agreementId, kind: 'hold', accrualMonth: '2025-01', reason: 'x'})).status, 409, '報告済みの月は保留できない');
  assert.equal((await f.req('/royalty/irregular-entries', {holderPartnerId: 10, kind: 'adjust_amount', closeMonth: '2025-03', amountYen: 1, reason: 'x'})).status, 400, '作成済みの締め月には調整しない');
  f.ok(await f.req('/royalty/irregular-entries', {agreementId, kind: 'release', accrualMonth: '2025-02', reason: '確認済み'}));
  f.ok(await f.req(`/royalty/irregular-entries/${adjust.id}/reverse`, {reason: '合意の取り下げ'}));
  assert.equal((await f.req(`/royalty/irregular-entries/${adjust.id}/reverse`, {reason: '二重'})).status, 409);
  assert.equal((await f.req(`/royalty/irregular-entries/${hold.id}/reverse`, {})).status, 400);
  const periods = f.ok(await f.req('/royalty/periods?asOf=2025-06-10')).periods;
  const april = periods.find((p) => p.closeMonth === '2025-04');
  assert.equal(april.status, 'overdue', '報告期限（5月末）を過ぎている');
  assert.equal(april.royaltyYen, 20000, '保留を解いた2月は、次に作る報告書（4月締め）に遅れて入る');
  assert.equal(april.adjustmentYen, 3000, '報告済みの調整の取消は戻し');
  const may = periods.find((p) => p.closeMonth === '2025-05');
  assert.equal(may.royaltyYen, 30000, '5月締めへ移した3月');
  assert.equal(may.draft.totals.carriedInYen, april.carriedOutYen, '下書きどうしも繰越をつなぐ');
  const ledger = f.ok(await f.req('/royalty/ledger?from=2025-01&to=2025-06'));
  const kinds = ledger.irregular.map((r) => r.kindLabel);
  assert.ok(kinds.includes('保留にする') && kinds.includes('保留を解く') && kinds.includes('締め月の変更') && kinds.includes('記録だけ'));
  assert.ok(ledger.irregular.some((r) => r.reversed && r.kind === 'adjust_amount'));
  await assert.rejects(f.db.run("INSERT INTO royalty_irregular_entries(org_id,holder_partner_id,agreement_id,kind,accrual_month,reason,created_by) VALUES(1,11,?,'hold','2025-01','x',1)", [agreementId]), raised(/権利者/));
  await assert.rejects(f.db.run("INSERT INTO royalty_irregular_entries(org_id,holder_partner_id,kind,close_month,amount_yen,reason,reverses_entry_id,created_by) VALUES(1,10,'adjust_amount','2025-03',-2999,'x',?,1)", [adjust.id]), raised(/イレギュラーの記録は変更できません/));
});

test('FR-SETL-ACCR-012 FR-SETL-ACCR-023 FR-SETL-STMT-037 集計シート: 権利者×月・種別・作品・明細・経費の控除・保留、条件の検査と絞込', async (t) => {
  const f = await fixture({t});
  await f.create({term: {effectiveFrom: '2025-01', calcMethod: 'rate', baseKind: 'after_window_fee_and_expenses', windowFeeBps: 2000, rateBps: 1000, clauseReference: '第8条', expenseCategories: ['宣伝費'], advanceYen: 5000}});
  await f.create({holderPartnerId: 12, category: 'screenplay', agreementCode: 'RY-SCR-1', title: '架空の脚本料', term: {effectiveFrom: '2025-01', calcMethod: 'fixed_monthly', fixedAmountYen: 20000, clauseReference: '第3条'}});
  await f.sale('2025-01', 100000);
  await f.sale('2025-02', 50000);
  await f.db.run("INSERT INTO expenses(org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(1,1,1,'2025-01-10','2025-01','宣伝費','架空の広告',10000,1000,11000),(1,1,1,'2025-01-10','2025-01','事務費','架空',5000,500,5500)");
  assert.equal((await f.req('/royalty/ledger?from=2025-03&to=2025-01')).status, 400);
  assert.equal((await f.req('/royalty/ledger?from=2020-01&to=2025-12')).status, 400, '60か月まで');
  assert.equal((await f.req('/royalty/ledger?from=2025-01&to=2025-03&category=xyz')).status, 400);
  const ledger = f.ok(await f.req('/royalty/ledger?from=2025-01&to=2025-03'));
  const dir = ledger.byHolder.find((r) => r.holderName === '架空監督A');
  assert.equal(dir.months['2025-01'], 7000, '(100,000−20%−宣伝費10,000)×10%');
  assert.equal(dir.months['2025-02'], 4000);
  assert.equal(dir.recoupYen, 5000);
  assert.equal(dir.unpaidYen, 11000 - 5000);
  const scr = ledger.byHolder.find((r) => r.holderName === '架空脚本家B');
  assert.equal(scr.periodYen, 60000, '毎月定額×3か月');
  assert.equal(ledger.expenses.length, 1, '控除した費目だけ');
  assert.equal(ledger.expenses[0].amountYen, 10000);
  assert.ok(ledger.checks.every((c) => c.value === 0), JSON.stringify(ledger.checks));
  assert.equal(ledger.detail.length, 2 + 3);
  const only = f.ok(await f.req('/royalty/ledger?from=2025-01&to=2025-03&category=screenplay'));
  assert.equal(only.byHolder.length, 1);
  assert.equal(only.byHolder[0].holderName, '架空脚本家B');
  assert.equal(f.ok(await f.req('/royalty/ledger?from=2025-01&to=2025-03&holderId=10')).detail.length, 2);
});

test('FR-SETL-STMT-033 権限: 作品の財務権限のない契約を持つ権利者の報告書は扱えず、集計は権限のある契約だけ', async (t) => {
  const f = await fixture({t});
  await f.db.run("INSERT INTO projects(id,org_id,code,title,status) VALUES(3,1,'PRJ-SECRET','架空の別案件','active')");
  await f.db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(3,1,3,'WRK-SECRET','架空の別作品')");
  await f.create();
  await f.create({workId: 3, agreementCode: 'RY-DIR-SECRET', title: '架空の別作品の監督料'});
  await f.sale('2025-01', 100000);
  const editor = await f.login('editor@openingnight.invalid');
  const list = f.ok(await f.req('/royalty/agreements', null, editor));
  assert.equal(list.agreements.length, 1, '権限のある作品の契約だけ');
  assert.equal(list.holders[0].restricted, true);
  const periods = f.ok(await f.req('/royalty/periods?asOf=2025-05-01', null, editor));
  assert.ok(periods.periods.length > 0 && periods.periods.every((p) => p.restricted && p.draft === null), '一部の契約だけの下書きは出さない');
  assert.equal(periods.creatable.count, 0);
  assert.equal((await f.req('/royalty/statements/preview?holderId=10&closeMonth=2025-03&asOf=2025-05-01', null, editor)).status, 403);
  const gen = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-05-01', confirmed: true, keys: ['10:2025-03']}, editor));
  assert.equal(gen.created.length, 0);
  assert.match(gen.skipped[0].reason, /財務権限/);
  assert.equal((await f.req('/royalty/irregular-entries', {holderPartnerId: 10, kind: 'note', reason: 'x'}, editor)).status, 403);
  const ledger = f.ok(await f.req('/royalty/ledger?from=2025-01&to=2025-03', null, editor));
  assert.equal(ledger.partialHolders.length, 1);
  assert.ok(ledger.notes.length);
  const admin = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-05-01', confirmed: true}));
  assert.equal(admin.created.length, 1, '管理者は権利者の全契約で作れる');
  assert.equal((await f.req(`/royalty/statements/${admin.created[0].statementId}`, null, editor)).status, 403);
});

test('FR-SETL-STMT-027 ホームの作業キュー: ロイヤリティ報告書の作成待ち・期限超過（制作担当には出さない）', async (t) => {
  const f = await fixture({t});
  await f.create();
  await f.sale('2025-01', 100000);
  const queue = async (cookie) => (await f.app.request('/api/work-queue?today=2025-05-10', {headers: {cookie}})).json();
  const admin = await queue(f.admin);
  const item = admin.items.find((x) => x.id === 'royalty-periods');
  assert.equal(item.count, 1);
  assert.equal(item.page, 'ロイヤリティ作成');
  assert.equal(item.tone, 'bad');
  assert.match(item.rows[0].label, /架空監督A・2025年3月締め/);
  assert.match(item.rows[0].detail, /期限超過・報告期限 2025\/04\/30/);
  const production = await queue(await f.login('production@openingnight.invalid'));
  assert.ok(!production.items.some((x) => x.id === 'royalty-periods'));
});

test('FR-SETL-ACCR-014 FR-SETL-ACCR-026 委員会の月次収支が使う発生額の読み出し（計上月・保留は0円にしない）', async (t) => {
  const f = await fixture({t});
  await f.create({term: {effectiveFrom: '2025-01', calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 1000, clauseReference: '第8条', channels: ['rental']}});
  await f.create({holderPartnerId: 12, category: 'screenplay', agreementCode: 'RY-SCR-1', title: '架空の脚本料',
    term: {effectiveFrom: '2025-01', calcMethod: 'rate', baseKind: 'committee_income', rateBps: 500, clauseReference: '第4条'}});
  await f.sale('2025-01', 100000, {kind: 'package', product: 2});
  const ctx = f.app.ux;
  const identity = {org_id: 1, user_id: 1, role: 'admin'};
  const rows = await loadRoyaltyAccruals(f.db, identity, {workIds: [1], from: '2025-01', to: '2025-03'}, ctx);
  const dir = rows.find((r) => r.category === 'director');
  assert.equal(dir.royaltyYen, 0);
  assert.equal(dir.holdSalesYen, 100000, 'レンタルだけ対象で区分未確認のビデオグラムは保留');
  const scr = rows.find((r) => r.category === 'screenplay');
  assert.equal(scr.royaltyYen, null, '委員会の条件が無い作品の本委員会収入は計算できない');
  assert.equal(scr.holdSalesYen, 100000);
  assert.deepEqual(Object.keys(dir).slice(0, 9), ['agreementId', 'agreementCode', 'workId', 'holderPartnerId', 'holderName', 'category', 'accrualMonth', 'baseYen', 'royaltyYen']);
  assert.deepEqual(await loadRoyaltyAccruals(f.db, {...identity, role: 'production'}, {workIds: [1], from: '2025-01', to: '2025-03'}, ctx), []);
  assert.deepEqual(await loadRoyaltyAccruals(f.db, identity, {workIds: [2], from: '2025-01', to: '2025-03'}, ctx), []);
});
