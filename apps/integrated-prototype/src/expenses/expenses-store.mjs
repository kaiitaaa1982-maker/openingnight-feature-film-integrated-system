// 経費（expenses）の領域の DB の読み書き。いまは制作費の版（移行 0016。フェーズ1の仕様書 #5。要件 docs/requirements/expenses/production-cost.md）を置く。
// SQL と組織（org_id）の絞り込みと batch だけを持ち、出資の記録の選び方・入力の判定・登録できる人は model
// （production-cost/production-cost-model.mjs）、権限の確かめは受け口（production-cost/production-cost-routes.mjs）に任せる。
// 作品（works）・作品の費用の版（work_finance_versions）・委員会の契約と条件版（committee_*）・取引先（partners）は、まだ領域フォルダへ
// 移していない古い形の表なので、ここから直接読む（docs/rules/architecture.md の「ほかの領域の表」）。
// 書き込みは文を返す関数（*Statements）を1回の batch で書き、同じ batch で audit_log に1行残す（金額は残さない。docs/rules/logging.md）
import {allIn} from '../sql-in.mjs';

const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';
const VERSION_COLUMNS = `version_no,source_kind,amount_yen,tax_basis,production_part_yen,pa_part_yen,work_finance_revision,committee_term_version_id,
  contract_reference,contract_signed_on,counterparty_partner_id,contract_amount_yen,contract_tax_basis,tax_conversion,added_yen,burden_type,note,created_by,created_at`;
const VERSION_INSERT = `INSERT INTO production_cost_versions(org_id,work_id,version_no,source_kind,amount_yen,tax_basis,production_part_yen,pa_part_yen,
    work_finance_revision,committee_term_version_id,contract_reference,contract_signed_on,counterparty_partner_id,contract_amount_yen,contract_tax_basis,tax_conversion,
    added_yen,burden_type,note,created_by)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

// ---------- 作品と取引先（古い形の表） ----------

// 組織の作品（無ければ null）。受け口が作品の案件で財務の権限を確かめる
export async function readWork(db, orgId, workId) {
  return db.get('SELECT id,project_id,code,title FROM works WHERE org_id=? AND id=?', [orgId, workId]);
}

// 組織の取引先（無ければ null）。契約の相手を書く前に組織の中にあるかを確かめる（docs/rules/dialect.md の「参照先が無い」）
export async function readPartner(db, orgId, partnerId) {
  return db.get('SELECT id,code,name FROM partners WHERE org_id=? AND id=?', [orgId, partnerId]);
}

// ---------- 出資の記録 ----------

// 作品の出資の記録: 作品の費用の最新の版（無ければ null）と、作品の委員会の契約ごとの最新の条件版の製作費総額・出資額の合計・出資の行の数
// （条件版の無い契約は term_version_id が null）。どれを制作費にするかは model の investmentSource が決める
export async function readInvestmentRecords(db, orgId, workId) {
  const [finance, committees] = await Promise.all([
    db.get(`SELECT revision,own_investment_yen,own_investment_tax_basis,own_investment_status,committee_term_version_id FROM work_finance_versions
      WHERE org_id=? AND work_id=? ORDER BY revision DESC LIMIT 1`, [orgId, workId]),
    db.all(`SELECT c.id AS contract_id,t.id AS term_version_id,t.version_no,f.production_cost_yen AS funding_yen,
        (SELECT COALESCE(SUM(i.amount_yen),0) FROM committee_term_investments i WHERE i.org_id=t.org_id AND i.term_version_id=t.id) AS investment_total_yen,
        (SELECT COUNT(*) FROM committee_term_investments i WHERE i.org_id=t.org_id AND i.term_version_id=t.id) AS investment_count
      FROM committee_contracts c
      LEFT JOIN committee_term_versions t ON t.org_id=c.org_id AND t.contract_id=c.id
        AND t.version_no=(SELECT MAX(x.version_no) FROM committee_term_versions x WHERE x.org_id=c.org_id AND x.contract_id=c.id)
      LEFT JOIN committee_term_funding f ON f.org_id=t.org_id AND f.term_version_id=t.id
      WHERE c.org_id=? AND c.work_id=? ORDER BY c.id`, [orgId, workId]),
  ]);
  const num = (value) => (value === null || value === undefined ? null : Number(value));
  return {
    finance: finance ?? null,
    committees: committees.map((r) => ({contractId: Number(r.contract_id), termVersionId: num(r.term_version_id), versionNo: num(r.version_no),
      fundingYen: num(r.funding_yen), investmentTotalYen: Number(r.investment_total_yen), investmentCount: Number(r.investment_count)})),
  };
}

// ---------- 制作費の版 ----------

// 作品の版の全部（版の番号の順）
export async function readProductionCostVersions(db, orgId, workId) {
  return db.all(`SELECT ${VERSION_COLUMNS} FROM production_cost_versions WHERE org_id=? AND work_id=? ORDER BY version_no`, [orgId, workId]);
}

// 作品ごとの最新の版（その時点の制作費）。版の無い作品は行が無い（「制作費の版なし」。0円で埋めない）。
// 作品別収支（フェーズ1 #6b）と会社の入口の例外（#15）が読む
export async function readLatestProductionCosts(db, orgId, workIds) {
  return allIn(db, `SELECT v.work_id,${VERSION_COLUMNS.split(',').map((c) => `v.${c.trim()}`).join(',')} FROM production_cost_versions v
    WHERE v.org_id=? AND v.work_id IN (:in)
      AND v.version_no=(SELECT MAX(x.version_no) FROM production_cost_versions x WHERE x.org_id=v.org_id AND x.work_id=v.work_id)`,
  {before: [orgId], ids: workIds, sortBy: (a, b) => Number(a.work_id) - Number(b.work_id)});
}

// 版を1つ足す文（版の行と変更の記録 audit_log の1行。1回の batch で書く）。version は model の normalize*VersionInput の value。
// 版の番号（versionNo）がほかの書き込みに先を越されていれば、DB の production_cost_versions_sequence が断る
export function productionCostVersionStatements(orgId, workId, version, {createdBy}) {
  const contract = version.contract ?? {};
  const addition = version.addition ?? {};
  return [
    {sql: VERSION_INSERT, params: [orgId, workId, version.versionNo, version.sourceKind, version.amountYen, version.taxBasis,
      version.breakdown?.productionYen ?? null, version.breakdown?.paYen ?? null, version.workFinanceRevision ?? null, version.committeeTermVersionId ?? null,
      contract.reference ?? null, contract.signedOn ?? null, contract.counterpartyPartnerId ?? null, contract.amountYen ?? null, contract.taxBasis ?? null,
      contract.taxConversion ?? null, addition.addedYen ?? null, addition.burdenType ?? null, version.note ?? null, createdBy]},
    {sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'production_cost_version', `${workId}:${version.versionNo}`,
      JSON.stringify({workId, versionNo: version.versionNo, sourceKind: version.sourceKind})]},
  ];
}

// 書く時点で作品に出資の記録（作品の費用の最新の版の自社の出資額か、委員会の契約）があれば、同じ batch を止める文（transaction_guards の
// CHECK が断る。isGuardViolation で見分ける）。契約書から手で入れる版（FR-EXP-PCOST-039）を、読んだあとに入った出資の記録と並べないため
export function noInvestmentRecordGuard(orgId, workId) {
  return {sql: `INSERT INTO transaction_guards(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM committee_contracts c WHERE c.org_id=? AND c.work_id=?)
    OR EXISTS(SELECT 1 FROM work_finance_versions f WHERE f.org_id=? AND f.work_id=? AND f.own_investment_yen IS NOT NULL
      AND f.revision=(SELECT MAX(x.revision) FROM work_finance_versions x WHERE x.org_id=f.org_id AND x.work_id=f.work_id))`,
  params: [orgId, workId, orgId, workId]};
}

// 版を足す。guards は版の行より先に流す止めの文（noInvestmentRecordGuard など）
export async function addProductionCostVersion(db, orgId, workId, version, {createdBy, guards = []}) {
  await db.batch([...guards, ...productionCostVersionStatements(orgId, workId, version, {createdBy})]);
  return version.versionNo;
}
