// 売上の4区分（自社作品の流通売上・買付の手数料・販売委託の手数料・受託制作）を案件の型・稼ぎ方・契約から導き、入金の行を4区分と
// 稼ぎ方別に集計する純関数（フェーズ1の仕様書 #10b。要件 FR-REV-YOJITSU-022・025・044、FR-REV-CWORK-036）。
// 4区分は表にも列にも持たず、読むたびに導く（U-9 の答え「案件・契約から導く」。D-039 の 2026-10-09 の追記4）。手で選ばせない。
// 対応は要件 docs/requirements/revenue/project-cashflow-forecast-actual.md の「稼ぎ方×案件の型×売上の4区分の対応表」が正本。
// DB・時刻・環境変数を読まない（docs/rules/architecture.md）。売上＝入金×使う売上率は料率の額として行ごとに truncate（FR-REV-YOJITSU-004）
import {signedRateAmount} from '../../royalty/royalty-model.mjs';
import {effectiveRevenueRate} from '../../planning/project/project-model.mjs';

// 4区分（D-039 の 2026-10-09 の追記4 の並び）
export const REVENUE_CLASSES = Object.freeze([
  Object.freeze({code: 'own_distribution', label: '自社作品の流通売上'}),
  Object.freeze({code: 'acquisition_fee', label: '買付の手数料'}),
  Object.freeze({code: 'consignment_fee', label: '販売委託の手数料'}),
  Object.freeze({code: 'contract_production', label: '受託制作'}),
]);

// 稼ぎ方（参照表 earning_types のコード）から4区分への対応表。買付は契約で分かれる（MG つき＝買付の手数料、買い切り＝自社作品の流通売上）。
// provisional は要件の要確認の仮の置き場（製作委員会の自社の分配は要確認3、買い切りは要確認12）。決まったら false にする
const CLASS_BY_EARNING_TYPE = Object.freeze({
  consignment: {code: 'consignment_fee', provisional: false},
  own_investment: {code: 'own_distribution', provisional: false},
  committee: {code: 'own_distribution', provisional: true},
  contract_work: {code: 'contract_production', provisional: false},
});
const ACQUISITION_CLASS = Object.freeze({
  mg: {code: 'acquisition_fee', provisional: false},
  buyout: {code: 'own_distribution', provisional: true},
});

// 買付の契約の形。MG の分配契約（settlement_contracts.contract_type='mg'）があれば MG つき、無くて作品の費用の最新の版に買付額
// （work_finance_versions.sales_rights_purchase_yen）があれば買い切り、どちらも無ければ分からない（null。契約前の案件）。
// 見分け方は行動指標の計画の段A の源泉4（J-9 (c)「買い切り＝mg の契約が無い」）と同じ。evidence は store の readAcquisitionEvidence の行
export function acquisitionTermsOf(evidence) {
  if (!evidence) return null;
  if (Number(evidence.mg_contracts) > 0) return 'mg';
  if (Number(evidence.purchase_works) > 0) return 'buyout';
  return null;
}

// 稼ぎ方と買付の契約の形から4区分を導く。決まらないときは code を null にして理由を返す（0 や既定の区分で埋めない）
export function revenueClassOf({earningTypeCode, acquisitionTerms = null}) {
  const result = (rule, reason = null) => ({code: rule?.code ?? null, provisional: rule?.provisional ?? false, reason});
  if (!earningTypeCode) return result(null, 'no_earning_type');
  if (earningTypeCode === 'acquisition') {
    const rule = acquisitionTerms ? ACQUISITION_CLASS[acquisitionTerms] : null;
    return rule ? result(rule) : result(null, 'acquisition_terms_unknown');
  }
  const rule = CLASS_BY_EARNING_TYPE[earningTypeCode];
  return rule ? result(rule) : result(null, 'earning_type_unmapped');
}

// 案件ごとの4区分と使う売上率。inputs は store の readRevenueClassInputs の返り値
// （projects: readProjectClassifications の行、earningTypes、defaultRates、contractVersions、acquisitionEvidence）。
// 返り値は案件 ID → {projectId, code, title, projectType, earningType, revenueClass, provisional, classReason, rate} の Map
export function revenueClassBases({projects, earningTypes, defaultRates, contractVersions, acquisitionEvidence}) {
  const types = new Map(earningTypes.map((e) => [e.code, e]));
  const defaults = new Map(defaultRates.map((d) => [d.earning_type, d]));
  const contracts = new Map(contractVersions.map((v) => [Number(v.project_id), v]));
  const evidence = new Map(acquisitionEvidence.map((e) => [Number(e.project_id), e]));
  const out = new Map();
  for (const project of projects) {
    const projectId = Number(project.id);
    const earningType = project.earning_type ? types.get(project.earning_type) ?? null : null;
    const acquisitionTerms = project.earning_type === 'acquisition' ? acquisitionTermsOf(evidence.get(projectId)) : null;
    const revenueClass = revenueClassOf({earningTypeCode: earningType?.code ?? null, acquisitionTerms});
    const rate = effectiveRevenueRate({project, earningType, defaultRate: earningType ? defaults.get(earningType.code) ?? null : null,
      contractVersion: contracts.get(projectId) ?? null, acquisitionTerms});
    out.set(projectId, {
      projectId, code: project.code, title: project.title, projectType: project.project_type ?? null, earningType: earningType?.code ?? null,
      acquisitionTerms, revenueClass: revenueClass.code, provisional: revenueClass.provisional, classReason: revenueClass.reason, rate,
    });
  }
  return out;
}

const add = (bucket, inflowYen, revenueYen) => {
  bucket.lineCount += 1;
  bucket.inflowYen += inflowYen;
  if (revenueYen !== null) bucket.revenueYen = (bucket.revenueYen ?? 0) + revenueYen;
};
const group = (map, key, make) => {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
};

// 入金の行を4区分と稼ぎ方別に集計する。lines は {projectId（結べなければ null）, categoryCode（区分マスタのコード）, amountYen（入金の額。
// 手数料・取り分を引く前の額。取消は負の額）}、bases は revenueClassBases の Map、categories は区分マスタの行（code・direction・counts_as_revenue）、
// earningTypes は稼ぎ方の参照表の行（並び順）。売上＝入金×使う売上率（行ごとに truncate。制作受託は受託費率で純額。J-14 (a)）。
// 使う率は bases の1つの率（制作受託は最新の契約の版の受託費率）を、入金日に依らず案件のすべての行に当てる。率を改めた版のあとは過去の入金の
// 売上も変わる。入金日の時点の版を当てるかは要件の要確認14（フェーズ1 #14b で決める）。
// 売上に入れない行は理由ごとに excluded に出す（案件不明・売上の元にならない区分〈支援金〉・出金・区分マスタに無い区分・稼ぎ方の無い案件・
// 使う率が決まらない案件）。率が決まり区分の決まらない行（契約の分からない買付）は unclassified に出し、稼ぎ方別には入れる。
// 4区分の売上の和＋unclassified の売上の和＝稼ぎ方別の売上の和（totals）。行の無い区分・稼ぎ方の売上は 0 でなく null
export function summarizeRevenueClasses(lines, {bases, categories, earningTypes}) {
  const categoryByCode = new Map(categories.map((c) => [c.code, c]));
  const classes = new Map(REVENUE_CLASSES.map((c) => [c.code, {code: c.code, label: c.label, lineCount: 0, provisionalLineCount: 0, inflowYen: 0, revenueYen: null}]));
  const byEarningType = new Map(earningTypes.map((e) => [e.code, {code: e.code, label: e.label, lineCount: 0, inflowYen: 0, revenueYen: null}]));
  const excluded = new Map();
  const unclassified = new Map();
  // 売上に入れない行は理由×案件ごとに件数と額（出金の行は出金の額）だけを出す
  const exclude = (reason, projectId, amountYen) => {
    const bucket = group(excluded, `${reason}\u0000${projectId ?? ''}`, () => ({reason, projectId, lineCount: 0, amountYen: 0}));
    bucket.lineCount += 1;
    bucket.amountYen += amountYen;
  };
  for (const [index, line] of lines.entries()) {
    const amount = line?.amountYen;
    if (!Number.isSafeInteger(amount)) throw new Error(`入金の行 ${index} の額は整数の円で渡します: ${amount}`);
    const projectId = line.projectId ?? null;
    const category = categoryByCode.get(line.categoryCode);
    if (!category) { exclude('category_unregistered', projectId, amount); continue; }
    if (category.direction !== 'in') { exclude('outflow', projectId, amount); continue; }
    if (Number(category.counts_as_revenue) !== 1) { exclude('not_revenue', projectId, amount); continue; }
    const basis = projectId === null ? null : bases.get(Number(projectId));
    if (!basis) { exclude('unknown_project', projectId, amount); continue; }
    if (!basis.earningType) { exclude('no_earning_type', basis.projectId, amount); continue; }
    if (basis.rate.bps === null) { exclude(basis.rate.reason, basis.projectId, amount); continue; }
    const revenue = signedRateAmount(amount, basis.rate.bps);
    const earning = byEarningType.get(basis.earningType);
    if (!earning) throw new Error(`稼ぎ方の参照表に無い稼ぎ方です: ${basis.earningType}`);
    add(earning, amount, revenue);
    if (!basis.revenueClass) {
      add(group(unclassified, basis.projectId, () => ({projectId: basis.projectId, reason: basis.classReason, lineCount: 0, inflowYen: 0, revenueYen: null})), amount, revenue);
      continue;
    }
    const bucket = classes.get(basis.revenueClass);
    add(bucket, amount, revenue);
    if (basis.provisional) bucket.provisionalLineCount += 1;
  }
  const sum = (rows) => rows.reduce((total, row) => total + (row.revenueYen ?? 0), 0);
  const classRows = [...classes.values()];
  const earningRows = [...byEarningType.values()];
  const unclassifiedRows = [...unclassified.values()];
  return {
    classes: classRows,
    earningTypes: earningRows,
    unclassified: unclassifiedRows,
    excluded: [...excluded.values()],
    totals: {classesRevenueYen: sum(classRows), unclassifiedRevenueYen: sum(unclassifiedRows), earningTypesRevenueYen: sum(earningRows)},
  };
}
