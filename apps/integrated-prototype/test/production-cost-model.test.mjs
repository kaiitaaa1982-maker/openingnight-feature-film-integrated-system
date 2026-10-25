// 制作費の版の純関数（src/expenses/production-cost/production-cost-model.mjs。フェーズ1の仕様書 #5）を、DB を使わずに確かめる。
// 期待値は要件 docs/requirements/expenses/production-cost.md の FR-EXP-PCOST-002・003・008・015・019・022・023・039 と受け入れシナリオ 2・8・9・16・18 から持ってくる
import test from 'node:test';
import assert from 'node:assert/strict';
import {INVESTMENT_SOURCE_MESSAGES, TAX_REVIEW_NOTES, investmentSource, isCalendarDate, normalizeContractVersionInput, normalizeInvestmentVersionInput,
  productionCostAccess, productionCostStatus} from '../src/expenses/production-cost/production-cost-model.mjs';

const finance = (overrides = {}) => ({revision: 3, own_investment_yen: 100000000, own_investment_tax_basis: 'ex_tax', own_investment_status: 'confirmed', committee_term_version_id: null, ...overrides});
const committee = (overrides = {}) => ({contractId: 7, termVersionId: 21, versionNo: 2, fundingYen: 100000000, investmentTotalYen: 100000000, investmentCount: 2, ...overrides});

test('FR-EXP-PCOST-002 FR-EXP-PCOST-003 FR-EXP-PCOST-022 出資額から作る元は、確定した自社の出資額か、出資の合計が製作費総額と合う委員会の最新の条件版のどちらか1つだけで、推測で選ばない', () => {
  // 自社の出資額（作品の費用の最新の版）。区分は作品の費用の版の区分（税抜）を写す
  assert.deepEqual(investmentSource({finance: finance()}), {ok: true, hasRecord: true, kind: 'own_investment', amountYen: 100000000, taxBasis: 'ex_tax', workFinanceRevision: 3});
  // 委員会の条件版。区分を持たないので「不明」
  assert.deepEqual(investmentSource({committees: [committee()]}), {ok: true, hasRecord: true, kind: 'committee', amountYen: 100000000, taxBasis: 'unknown', committeeTermVersionId: 21});
  // 委員会の条件版を参照する作品の費用の版（自社の出資額は空）は、委員会の側から作る
  assert.equal(investmentSource({finance: finance({own_investment_yen: null, own_investment_status: 'unknown', committee_term_version_id: 21}), committees: [committee()]}).kind, 'committee');
  const reason = (input) => { const r = investmentSource(input); return [r.ok, r.reason, r.hasRecord]; };
  // 出資の記録が無い（作品の費用の版が無い・自社の出資額が空）なら、契約書から入れられる
  assert.deepEqual(reason({}), [false, 'no_record', false]);
  assert.deepEqual(reason({finance: finance({own_investment_yen: null, own_investment_status: 'unknown'})}), [false, 'no_record', false]);
  // 見込み（シナリオ2）・0円・両方ある・委員会が2つ・委員会の額が無い・合わないときは作らない（出資の記録はある）
  assert.deepEqual(reason({finance: finance({own_investment_status: 'estimated'})}), [false, 'not_confirmed', true]);
  assert.deepEqual(reason({finance: finance({own_investment_yen: 0})}), [false, 'zero_investment', true]);
  assert.deepEqual(reason({finance: finance(), committees: [committee()]}), [false, 'ambiguous', true]);
  assert.deepEqual(reason({committees: [committee(), committee({contractId: 8, termVersionId: 22})]}), [false, 'ambiguous', true]);
  assert.deepEqual(reason({committees: [committee({termVersionId: null, versionNo: null, fundingYen: null, investmentTotalYen: 0, investmentCount: 0})]}), [false, 'committee_unfunded', true]);
  assert.deepEqual(reason({committees: [committee({fundingYen: null})]}), [false, 'committee_unfunded', true]);
  assert.deepEqual(reason({committees: [committee({investmentTotalYen: 0, investmentCount: 0})]}), [false, 'committee_unfunded', true]);
  assert.deepEqual(reason({committees: [committee({investmentTotalYen: 99999999})]}), [false, 'committee_mismatch', true]);
  assert.deepEqual(reason({committees: [committee({fundingYen: 0, investmentTotalYen: 0})]}), [false, 'zero_investment', true]);
  for (const key of ['no_record', 'ambiguous', 'not_confirmed', 'zero_investment', 'committee_unfunded', 'committee_mismatch']) assert.ok(INVESTMENT_SOURCE_MESSAGES[key], key);
});

test('FR-EXP-PCOST-008 読めるのは管理者と財務の権限のある編集担当、登録できるのは管理者と、財務の権限がありその作品にプロデューサーの役目を持つ人（役割と役目の両方）', () => {
  const access = (input) => { const r = productionCostAccess(input); return [r.read, r.register]; };
  assert.deepEqual(access({role: 'admin'}), [true, true]);
  assert.deepEqual(access({role: 'editor', financeProject: true, workRoles: ['producer']}), [true, true]);
  assert.deepEqual(access({role: 'editor', financeProject: true, workRoles: ['line_producer', 'production_staff']}), [true, false]);
  assert.deepEqual(access({role: 'editor', financeProject: true}), [true, false]);
  // 役目があっても財務の権限（案件の編集の権限）が無ければ読めも登録もできない
  assert.deepEqual(access({role: 'editor', financeProject: false, workRoles: ['producer']}), [false, false]);
  // 制作担当は、プロデューサーの役目があっても登録できない（シナリオ8）
  assert.deepEqual(access({role: 'production', financeProject: true, workRoles: ['producer']}), [false, false]);
  assert.deepEqual(access({}), [false, false]);
});

test('FR-EXP-PCOST-003 FR-EXP-PCOST-015 作品の制作費の状態は3値で、版が無ければ unregistered、税の区分が不明の版は tax_unknown', () => {
  assert.equal(productionCostStatus(null), 'unregistered');
  assert.equal(productionCostStatus({tax_basis: 'unknown'}), 'tax_unknown');
  assert.equal(productionCostStatus({taxBasis: 'unknown'}), 'tax_unknown');
  assert.equal(productionCostStatus({tax_basis: 'ex_tax'}), 'registered');
});

test('FR-EXP-PCOST-002 FR-EXP-PCOST-019 出資額から作る版は額を出資の記録から読み、内訳は和が版の額のときだけ持ち、根拠に会計の専門家の確認の前の仮置きを残す', () => {
  const own = investmentSource({finance: finance()});
  const ok = normalizeInvestmentVersionInput({breakdown: {productionYen: 80000000, paYen: 20000000}, note: ' 架空のメモ '}, own);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.value, {versionNo: 1, sourceKind: 'investment', amountYen: 100000000, taxBasis: 'ex_tax', workFinanceRevision: 3, committeeTermVersionId: null,
    breakdown: {productionYen: 80000000, paYen: 20000000}, contract: null, addition: null, note: `${TAX_REVIEW_NOTES.own_investment}。架空のメモ`});
  const fromCommittee = normalizeInvestmentVersionInput({}, investmentSource({committees: [committee()]})).value;
  assert.deepEqual([fromCommittee.taxBasis, fromCommittee.workFinanceRevision, fromCommittee.committeeTermVersionId, fromCommittee.breakdown, fromCommittee.note],
    ['unknown', null, 21, null, TAX_REVIEW_NOTES.committee]);
  const fields = (input) => normalizeInvestmentVersionInput(input, own).errors.map((e) => e.field);
  assert.deepEqual(fields({amountYen: 100000000}), ['amountYen']);
  assert.deepEqual(fields({breakdown: {productionYen: 80000000, paYen: 20000001}}), ['breakdown']);
  assert.deepEqual(fields({breakdown: {productionYen: 80000000}}), ['breakdown.paYen']);
  assert.deepEqual(fields({breakdown: {productionYen: -1, paYen: 100000001}}), ['breakdown.productionYen']);
  assert.deepEqual(fields({breakdown: [1, 2]}), ['breakdown']);
  assert.deepEqual(fields({note: 'あ'.repeat(401)}), ['note']);
  assert.throws(() => normalizeInvestmentVersionInput({}, investmentSource({})), /出資の記録の選び方/);
});

test('FR-EXP-PCOST-039 FR-EXP-PCOST-023 契約書から入れる版は契約書の参照・締結日・相手・額が要り、税込の契約は税抜に戻した額（契約書の額以下）と戻し方が要る', () => {
  const base = {contractReference: ' FICT-CONTRACT-001 ', signedOn: '2026-08-20', counterpartyPartnerId: 1, contractAmountYen: 30000000, contractTaxBasis: 'ex_tax'};
  const exTax = normalizeContractVersionInput(base);
  assert.equal(exTax.ok, true, JSON.stringify(exTax.errors));
  assert.deepEqual(exTax.value, {versionNo: 1, sourceKind: 'contract', amountYen: 30000000, taxBasis: 'ex_tax', workFinanceRevision: null, committeeTermVersionId: null, breakdown: null,
    contract: {reference: 'FICT-CONTRACT-001', signedOn: '2026-08-20', counterpartyPartnerId: 1, amountYen: 30000000, taxBasis: 'ex_tax', taxConversion: null}, addition: null, note: null});
  const incTax = normalizeContractVersionInput({...base, contractAmountYen: 33000000, contractTaxBasis: 'inc_tax', exTaxAmountYen: 30000000, taxConversion: '税込 ÷ 1.10（架空）'});
  assert.deepEqual([incTax.ok, incTax.value.amountYen, incTax.value.taxBasis, incTax.value.contract.amountYen, incTax.value.contract.taxConversion], [true, 30000000, 'ex_tax', 33000000, '税込 ÷ 1.10（架空）']);
  const fields = (input) => normalizeContractVersionInput(input).errors.map((e) => e.field);
  assert.deepEqual(fields({}), ['contractReference', 'signedOn', 'counterpartyPartnerId', 'contractAmountYen', 'contractTaxBasis']);
  assert.deepEqual(fields({...base, contractTaxBasis: 'inc_tax'}), ['exTaxAmountYen', 'taxConversion']);
  assert.deepEqual(fields({...base, contractTaxBasis: 'inc_tax', exTaxAmountYen: 30000001, taxConversion: '架空'}), ['exTaxAmountYen']);
  assert.deepEqual(fields({...base, exTaxAmountYen: 29999999}), ['exTaxAmountYen']);
  assert.deepEqual(fields({...base, taxConversion: '架空'}), ['taxConversion']);
  assert.deepEqual(fields({...base, contractAmountYen: 1000.5}), ['contractAmountYen']);
  assert.deepEqual(fields({...base, counterpartyPartnerId: '1'}), ['counterpartyPartnerId']);
  assert.deepEqual(fields({...base, breakdown: {productionYen: 20000000, paYen: 10000001}}), ['breakdown']);
  assert.deepEqual(fields({...base, contractReference: 'x'.repeat(501)}), ['contractReference']);
});

test('締結日は暦にある YYYY-MM-DD の日付だけ', () => {
  for (const ok of ['2026-08-20', '2028-02-29', '2026-12-31']) assert.equal(isCalendarDate(ok), true, ok);
  for (const ng of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-8-20', '２０２６-08-20', '', null, 20260820]) assert.equal(isCalendarDate(ng), false, String(ng));
});
