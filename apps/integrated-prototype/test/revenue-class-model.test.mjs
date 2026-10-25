// 売上の4区分を案件の型・稼ぎ方・契約から導き、入金の行を4区分と稼ぎ方別に集計する純関数（フェーズ1の仕様書 #10b）。
// 期待値は要件 docs/requirements/revenue/project-cashflow-forecast-actual.md の「稼ぎ方×案件の型×売上の4区分の対応表」と
// FR-REV-YOJITSU-004・007・022・025・044、contract-work.md の FR-REV-CWORK-036 から持ってくる。DB を使わない
import test from 'node:test';
import assert from 'node:assert/strict';
import {REVENUE_CLASSES, acquisitionTermsOf, revenueClassBases, revenueClassOf, summarizeRevenueClasses} from '../src/revenue/revenue-class/revenue-class-model.mjs';
import {effectiveRevenueRate} from '../src/planning/project/project-model.mjs';

// 参照表 earning_types の行（移行 0012）と同じ形
const EARNING_TYPES = [
  {code: 'acquisition', label: '買付', project_type: 'acquisition', rate_source: 'project', sort_order: 1},
  {code: 'consignment', label: '販売委託', project_type: 'agency', rate_source: 'project', sort_order: 2},
  {code: 'own_investment', label: '自社出資', project_type: 'production', rate_source: 'project', sort_order: 3},
  {code: 'committee', label: '製作委員会', project_type: 'production', rate_source: 'project', sort_order: 4},
  {code: 'contract_work', label: '制作受託', project_type: 'contract_production', rate_source: 'contract', sort_order: 5},
];
const CATEGORIES = [
  {code: 'distribution_revenue', direction: 'in', counts_as_revenue: 1},
  {code: 'contract_revenue', direction: 'in', counts_as_revenue: 1},
  {code: 'crowdfunding_support', direction: 'in', counts_as_revenue: 0},
  {code: 'production_actual', direction: 'out', counts_as_revenue: 0},
];
const completeVersion = {project_id: 5, version_no: 2, markup_bps: 1250, milestone_count: 2, recorded_milestones: 2, share_total_bps: 10000};

test('FR-REV-YOJITSU-022 FR-REV-CWORK-036 売上の4区分は対応表どおりに稼ぎ方と契約から導き、決まらないときは区分を null にして理由を返す', () => {
  assert.deepEqual(REVENUE_CLASSES.map((c) => [c.code, c.label]), [
    ['own_distribution', '自社作品の流通売上'], ['acquisition_fee', '買付の手数料'], ['consignment_fee', '販売委託の手数料'], ['contract_production', '受託制作'],
  ]);
  // 対応表: 買付は MG つき＝買付の手数料・買い切り＝自社作品の流通売上（仮。要確認12）、販売委託＝販売委託の手数料、自社出資＝自社作品の流通売上、
  // 製作委員会＝自社作品の流通売上（自社の分配。仮。要確認3）、制作受託＝受託制作
  const table = [
    [{earningTypeCode: 'acquisition', acquisitionTerms: 'mg'}, {code: 'acquisition_fee', provisional: false, reason: null}],
    [{earningTypeCode: 'acquisition', acquisitionTerms: 'buyout'}, {code: 'own_distribution', provisional: true, reason: null}],
    [{earningTypeCode: 'consignment'}, {code: 'consignment_fee', provisional: false, reason: null}],
    [{earningTypeCode: 'own_investment'}, {code: 'own_distribution', provisional: false, reason: null}],
    [{earningTypeCode: 'committee'}, {code: 'own_distribution', provisional: true, reason: null}],
    [{earningTypeCode: 'contract_work'}, {code: 'contract_production', provisional: false, reason: null}],
  ];
  for (const [given, expected] of table) assert.deepEqual(revenueClassOf(given), expected, JSON.stringify(given));
  // 契約の分からない買付（契約前）・稼ぎ方の無い案件（現場受託・受託開発）・参照表に後から足した稼ぎ方は、区分を作らない
  assert.deepEqual(revenueClassOf({earningTypeCode: 'acquisition', acquisitionTerms: null}), {code: null, provisional: false, reason: 'acquisition_terms_unknown'});
  assert.deepEqual(revenueClassOf({earningTypeCode: null}), {code: null, provisional: false, reason: 'no_earning_type'});
  assert.deepEqual(revenueClassOf({earningTypeCode: 'fictional_new_type'}), {code: null, provisional: false, reason: 'earning_type_unmapped'});
  // 参照表の5つの稼ぎ方は、どれも区分に当たる（買付は契約の形がわかれば）
  for (const e of EARNING_TYPES) assert.notEqual(revenueClassOf({earningTypeCode: e.code, acquisitionTerms: 'mg'}).code, null, e.code);
});

test('FR-REV-YOJITSU-022 買付の契約の形は、MG の分配契約があれば MG つき、無くて買付額のある作品があれば買い切り、どちらも無ければ分からない', () => {
  assert.equal(acquisitionTermsOf({mg_contracts: 1, purchase_works: 1}), 'mg', 'MG の契約が先');
  assert.equal(acquisitionTermsOf({mg_contracts: '2', purchase_works: 0}), 'mg');
  assert.equal(acquisitionTermsOf({mg_contracts: 0, purchase_works: 1}), 'buyout');
  assert.equal(acquisitionTermsOf({mg_contracts: 0, purchase_works: 0}), null);
  assert.equal(acquisitionTermsOf(null), null);
});

test('FR-REV-YOJITSU-044 FR-REV-YOJITSU-020 使う売上率: 制作受託は最新の契約の版の受託費率（版が無い・節目が欠けた版は null と理由）、買い切りの買付は 10000', () => {
  const [acquisition, , , , contractWork] = EARNING_TYPES;
  const defaultRate = {earning_type: 'acquisition', version_no: 1, revenue_rate_bps: 2250, status: 'provisional'};
  const none = {revenue_rate_bps: null};
  assert.deepEqual(effectiveRevenueRate({project: none, earningType: contractWork, defaultRate: null, contractVersion: completeVersion}), {bps: 1250, source: 'contract', status: null, versionNo: 2, reason: null});
  assert.deepEqual(effectiveRevenueRate({project: none, earningType: contractWork, defaultRate: null, contractVersion: null}), {bps: null, source: 'contract', status: null, versionNo: null, reason: 'contract_version_unregistered'});
  assert.deepEqual(effectiveRevenueRate({project: none, earningType: contractWork, defaultRate: null, contractVersion: {...completeVersion, recorded_milestones: 1, share_total_bps: 6000}}),
    {bps: null, source: 'contract', status: null, versionNo: 2, reason: 'contract_version_incomplete'});
  // 制作受託は案件の売上率を使わない（DB も持たせない）
  assert.equal(effectiveRevenueRate({project: {revenue_rate_bps: 5000}, earningType: contractWork, defaultRate: null, contractVersion: completeVersion}).bps, 1250);
  // 買い切りの売上は権利売上そのもの（対応表の売上の数え方）。案件の値があればそれを先に使う。MG つき・契約の分からない買付は既定（窓口手数料率）
  assert.deepEqual(effectiveRevenueRate({project: none, earningType: acquisition, defaultRate, acquisitionTerms: 'buyout'}), {bps: 10000, source: 'buyout', status: null, versionNo: null, reason: null});
  assert.equal(effectiveRevenueRate({project: {revenue_rate_bps: 9000}, earningType: acquisition, defaultRate, acquisitionTerms: 'buyout'}).bps, 9000);
  assert.equal(effectiveRevenueRate({project: none, earningType: acquisition, defaultRate, acquisitionTerms: 'mg'}).bps, 2250);
  assert.equal(effectiveRevenueRate({project: none, earningType: acquisition, defaultRate, acquisitionTerms: null}).bps, 2250);
});

// 案件1〜6（架空）: 1 MG つきの買付、2 契約の分からない買付、3 自社出資、4 製作委員会、5 制作受託、6 受託開発（稼ぎ方なし）
function bases() {
  return revenueClassBases({
    projects: [
      {id: 1, code: 'F-1', title: '架空1', project_type: 'acquisition', earning_type: 'acquisition', revenue_rate_bps: 2000},
      {id: 2, code: 'F-2', title: '架空2', project_type: 'acquisition', earning_type: 'acquisition', revenue_rate_bps: null},
      {id: 3, code: 'F-3', title: '架空3', project_type: 'production', earning_type: 'own_investment', revenue_rate_bps: null},
      {id: 4, code: 'F-4', title: '架空4', project_type: 'production', earning_type: 'committee', revenue_rate_bps: null},
      {id: 5, code: 'F-5', title: '架空5', project_type: 'contract_production', earning_type: 'contract_work', revenue_rate_bps: null},
      {id: 6, code: 'F-6', title: '架空6', project_type: 'sw_contract', earning_type: null, revenue_rate_bps: null},
    ],
    earningTypes: EARNING_TYPES,
    defaultRates: [{earning_type: 'acquisition', version_no: 1, revenue_rate_bps: 2250, status: 'provisional'}, {earning_type: 'own_investment', version_no: 1, revenue_rate_bps: 6500, status: 'provisional'}],
    contractVersions: [completeVersion],
    acquisitionEvidence: [{project_id: 1, mg_contracts: 1, purchase_works: 0}, {project_id: 2, mg_contracts: 0, purchase_works: 0}],
  });
}

test('FR-REV-YOJITSU-022 FR-REV-YOJITSU-025 売上＝入金×使う売上率を行ごとに truncate し、4区分の和＋区分の決まらない分＝稼ぎ方別の和', () => {
  const lines = [
    {projectId: 1, categoryCode: 'distribution_revenue', amountYen: 1000001}, // 200,000.2 → 200,000（買付の手数料）
    {projectId: 1, categoryCode: 'distribution_revenue', amountYen: -10001}, // 取消: −2,000.2 → −2,000（0 の方へ。売上と符号違いの同じ丸め）
    {projectId: 2, categoryCode: 'distribution_revenue', amountYen: 30001}, // 契約の分からない買付: 既定 2250 で 6,750.225 → 6,750。区分は決まらない
    {projectId: 3, categoryCode: 'distribution_revenue', amountYen: 50003}, // 32,501.95 → 32,501（自社作品の流通売上）
    {projectId: 5, categoryCode: 'contract_revenue', amountYen: 7000007}, // 受託費率 12.5%: 875,000.875 → 875,000（受託制作。純額）
  ];
  const s = summarizeRevenueClasses(lines, {bases: bases(), categories: CATEGORIES, earningTypes: EARNING_TYPES});
  const revenue = (rows) => Object.fromEntries(rows.map((r) => [r.code, r.revenueYen]));
  assert.deepEqual(revenue(s.classes), {own_distribution: 32501, acquisition_fee: 198000, consignment_fee: null, contract_production: 875000});
  assert.deepEqual(revenue(s.earningTypes), {acquisition: 204750, consignment: null, own_investment: 32501, committee: null, contract_work: 875000});
  assert.deepEqual(s.unclassified, [{projectId: 2, reason: 'acquisition_terms_unknown', lineCount: 1, inflowYen: 30001, revenueYen: 6750}]);
  assert.deepEqual(s.totals, {classesRevenueYen: 1105501, unclassifiedRevenueYen: 6750, earningTypesRevenueYen: 1112251});
  assert.equal(s.totals.classesRevenueYen + s.totals.unclassifiedRevenueYen, s.totals.earningTypesRevenueYen);
  // 行の無い区分・稼ぎ方は 0 円でなく null（件数は 0）
  assert.deepEqual(s.classes.find((c) => c.code === 'consignment_fee'), {code: 'consignment_fee', label: '販売委託の手数料', lineCount: 0, provisionalLineCount: 0, inflowYen: 0, revenueYen: null});
});

test('FR-REV-YOJITSU-044 受託の売上は入金の行ごとの truncate で、節目を全部入金しても受託費より（行の数−1）円まで少なくなりうる（要確認13）', () => {
  // 総製作費 33,333,331・受託費率 10%（受託費 3,333,333）を 3333・3334・3333 bp の節目で入金する。節目の入金額は総製作費を最大剰余法で配った額
  const version = {project_id: 5, version_no: 1, markup_bps: 1000, milestone_count: 3, recorded_milestones: 3, share_total_bps: 10000};
  const b = revenueClassBases({
    projects: [{id: 5, code: 'F-5', title: '架空5', project_type: 'contract_production', earning_type: 'contract_work', revenue_rate_bps: null}],
    earningTypes: EARNING_TYPES, defaultRates: [], contractVersions: [version], acquisitionEvidence: [],
  });
  const lines = [11109999, 11113333, 11109999].map((amountYen) => ({projectId: 5, categoryCode: 'contract_revenue', amountYen}));
  assert.equal(lines.reduce((n, l) => n + l.amountYen, 0), 33333331);
  const s = summarizeRevenueClasses(lines, {bases: b, categories: CATEGORIES, earningTypes: EARNING_TYPES});
  // 1,110,999.9 → 1,110,999、1,111,333.3 → 1,111,333、1,110,999.9 → 1,110,999（和 3,333,331。受託費との差 2円＝行の数−1）
  assert.equal(s.classes.find((c) => c.code === 'contract_production').revenueYen, 3333331);
});

test('FR-REV-YOJITSU-007 FR-REV-YOJITSU-024 売上に入れない入金の行は理由ごとに件数と額を出し、4区分にも稼ぎ方別にも入れない', () => {
  const lines = [
    {projectId: null, categoryCode: 'distribution_revenue', amountYen: 111}, // 案件不明
    {projectId: 99, categoryCode: 'distribution_revenue', amountYen: 222}, // 読める案件に無い（権限の外・別の組織）
    {projectId: 3, categoryCode: 'crowdfunding_support', amountYen: 333}, // 支援金は売上に数えない
    {projectId: 5, categoryCode: 'production_actual', amountYen: 444}, // 出金
    {projectId: 3, categoryCode: 'no_such_category', amountYen: 555}, // 区分マスタに無い
    {projectId: 6, categoryCode: 'distribution_revenue', amountYen: 666}, // 稼ぎ方の無い案件（受託開発）
    {projectId: 4, categoryCode: 'distribution_revenue', amountYen: 777}, // 製作委員会の既定の率が無い
    {projectId: 4, categoryCode: 'distribution_revenue', amountYen: 888},
  ];
  const s = summarizeRevenueClasses(lines, {bases: bases(), categories: CATEGORIES, earningTypes: EARNING_TYPES});
  assert.deepEqual(s.excluded, [
    {reason: 'unknown_project', projectId: null, lineCount: 1, amountYen: 111},
    {reason: 'unknown_project', projectId: 99, lineCount: 1, amountYen: 222},
    {reason: 'not_revenue', projectId: 3, lineCount: 1, amountYen: 333},
    {reason: 'outflow', projectId: 5, lineCount: 1, amountYen: 444},
    {reason: 'category_unregistered', projectId: 3, lineCount: 1, amountYen: 555},
    {reason: 'no_earning_type', projectId: 6, lineCount: 1, amountYen: 666},
    {reason: 'default_unregistered', projectId: 4, lineCount: 2, amountYen: 1665},
  ]);
  assert.deepEqual(s.totals, {classesRevenueYen: 0, unclassifiedRevenueYen: 0, earningTypesRevenueYen: 0});
  assert.ok(s.classes.every((c) => c.revenueYen === null && c.lineCount === 0));
  // 整数でない額は 0 にも丸めにもせず止める
  for (const bad of [1.5, '100', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => summarizeRevenueClasses([{projectId: 3, categoryCode: 'distribution_revenue', amountYen: bad}], {bases: bases(), categories: CATEGORIES, earningTypes: EARNING_TYPES}), /整数の円/, String(bad));
  }
});
