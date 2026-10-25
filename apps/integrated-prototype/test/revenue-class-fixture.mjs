// 売上の4区分の架空データ（test/fixtures/yojitsu/revenue-classes.json）を、試験の DB に入れる部品（フェーズ1 #10b）。
// 案件・稼ぎ方の既定の売上率・区分マスタ・受託制作の契約の版は store（planning-store.mjs）で入れる。買付の契約の形を見分ける材料
// （作品・MG の分配契約・作品の費用の版の買付額）は、ほかの領域の古い形の表なので、試験の準備として SQL で入れる。
// 返り値の lines は fixture の入金の行の案件のキーを案件の ID に置き換えたもの（summarizeRevenueClasses に渡す形）。架空のデータだけを使う
import {readFileSync} from 'node:fs';
import * as planning from '../src/planning/planning-store.mjs';
import {normalizeContractVersionInput} from '../src/planning/contract-production/contract-production-model.mjs';

export const REVENUE_CLASS_FIXTURE_PATH = new URL('./fixtures/yojitsu/revenue-classes.json', import.meta.url);

export function loadRevenueClassFixture() {
  return JSON.parse(readFileSync(REVENUE_CLASS_FIXTURE_PATH, 'utf8'));
}

// orgId の組織に入れる。holderPartnerId は MG の分配契約の権利元（その組織の取引先）。createdBy はその組織の利用者
export async function seedRevenueClassFixture(db, {orgId = 1, createdBy = 1, holderPartnerId = 1, fixture = loadRevenueClassFixture()} = {}) {
  for (const [index, c] of fixture.categories.entries()) {
    await planning.addCashflowCategory(db, orgId, {code: c.code, label: c.label, direction: c.direction, countsAsRevenue: c.countsAsRevenue, sortOrder: index + 1});
  }
  for (const r of fixture.defaultRates) {
    await planning.addRevenueRateVersion(db, orgId, {earningType: r.earningType, revenueRateBps: r.revenueRateBps, status: r.status, basis: r.basis, createdBy});
  }
  const projectIds = new Map();
  for (const p of fixture.projects) {
    const id = await planning.createProject(db, orgId, {
      code: p.code, title: p.title, projectType: p.projectType, earningType: p.earningType, baseAmountYen: null, revenueRateBps: p.revenueRateBps,
      counterpartyName: null, keyPerson: null, startedOn: null, planningFolder: null, note: null, stage: null,
    }, {createdBy});
    projectIds.set(p.key, id);
    for (const w of p.works ?? []) {
      const work = await db.get('INSERT INTO works(org_id,project_id,code,title) VALUES(?,?,?,?) RETURNING id', [orgId, id, w.code, w.title]);
      const workId = Number(work.id);
      if (w.settlement) {
        await db.run(`INSERT INTO settlement_contracts(org_id,project_id,work_id,contract_code,title,contract_type,holder_partner_id,mg_contract_yen,created_by)
          VALUES(?,?,?,?,?,?,?,?,?)`, [orgId, id, workId, w.settlement.contractCode, `${w.title}の分配契約`, w.settlement.contractType, holderPartnerId, w.settlement.mgContractYen ?? null, createdBy]);
      }
      // 作品の費用の版を第1版から順に入れる（null の版は買付額が空で、状態は「不明」）
      for (const [index, purchaseYen] of (w.purchaseYenByRevision ?? []).entries()) {
        const known = purchaseYen !== null;
        await db.run(`INSERT INTO work_finance_versions(org_id,work_id,revision,production_cost_tax_basis,production_cost_status,promotion_budget_tax_basis,promotion_budget_status,
            own_investment_tax_basis,own_investment_status,sales_rights_purchase_yen,sales_rights_purchase_tax_basis,sales_rights_purchase_status,
            sales_rights_purchase_as_of,sales_rights_purchase_evidence,source_reference,reason,created_by)
          VALUES(?,?,?,'unknown','unknown','unknown','unknown','ex_tax','unknown',?,?,?,?,?,'架空の参照','架空の登録',?)`,
        [orgId, workId, index + 1, purchaseYen, known ? 'ex_tax' : 'unknown', known ? 'confirmed' : 'unknown', known ? '2026-04-01' : null, known ? '架空の買付の契約書' : null, createdBy]);
      }
    }
    let previousVersionNo = 0;
    for (const v of p.contractVersions ?? []) {
      const input = normalizeContractVersionInput({...v, previousVersionNo});
      if (!input.ok) throw new Error(`fixture の契約の版が読めません: ${JSON.stringify(input.errors)}`);
      previousVersionNo = await planning.addContractVersion(db, orgId, id, input.value, {createdBy});
    }
  }
  const lines = fixture.lines.map((line) => ({projectId: line.project === null ? null : projectIds.get(line.project), categoryCode: line.category, amountYen: line.amountYen}));
  return {projectIds, lines, fixture};
}
