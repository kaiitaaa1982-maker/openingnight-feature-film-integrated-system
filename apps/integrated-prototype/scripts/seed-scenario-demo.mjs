#!/usr/bin/env node
// シナリオの比較（段A。計画は会社ルートの plans/2026-10-09-sales-producer-kpi.md の A-4）を画面で確かめるための架空データを、
// 組織 DEMO-SALES に足す。seed-all-demo.mjs の最後の節（売上・PL・BS・作品マスタの後）として流す。移行（表の追加）はしない。
//
// 画面を全部見る利用者: demo-admin@openingnight.invalid（架空のアドレス。公開版 README「架空データで動かす」の手順の利用者）。
// この利用者は DEMO-SALES の管理者（role=admin）で、組織の全案件の財務権限（permittedProjects(…, true)）を持つ。
// この種が足す案件（商談・won・委託契約の作品）はすべて案件 DEMO-SCN に入れ、この利用者の財務権限に入ることを流した後に確かめる。
// 段A は目標額を要求の本文で渡すので、この利用者なら全部見える（目標額・報酬・家賃補助はこの種に持たない）。
//
// 入れるもの（すべて既存の受け口を通す。直接 SQL で書かない。名前はすべて「架空」）:
// - 取引先6件・案件1件・作品4本（DEMO-SCN-W1 販売委託／W2 買付・買い切り／W3 自社出資／W4 製作委員会）と商品・配賦
// - 売上報告（2026-07・08。PL・BS の架空データの期間 2025-05〜2026-06 の後なので、既存の PL・BS の数字を変えない）
// - 委託契約（W1・手数料 20%）と報告の紐付け2件、紐付けない報告1件（未紐付け）
// - 作品マスタ（W2 の買付額・W3 の出資額・W4 の委員会の条件版）。作品マスタの節（seed-master-demo）が2回目に足さないよう4つの節と商品の仕様もここで入れる
// - 製作委員会（W4。自社の出資と払込、配信の売上から自社の取得額＝分配が立つ）と、W3 の請求と入金（回収額）
// - 商談9件（確度の違う3件・同じ作品×取引先の won 2件・lost 1件・額未定・源泉未指定・来期）と活動9件
// test/fixtures/scenario/compare-request.json の商談・売上・活動・W1〜W3 の額はこの種と同じ値（ID は DB が振る。名前で対応づける）。
//
// 使い方: node scripts/seed-scenario-demo.mjs --db <SQLiteのパス>（先に seed-all-demo.mjs の他の節を流しておく）
// ・--db の指定は必須。data/integrated.sqlite へは書かない。本番のD1・設定・秘密値には触れない。
// ・2回流しても増えない（案件 DEMO-SCN があれば何もしない）。API の登録は取り消せないので、途中で失敗したときは新しいDBファイルで流し直す。
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {SALES_DEMO} from './seed-sales-demo.mjs';

export const SCENARIO_DEMO = Object.freeze({
  projectCode: 'DEMO-SCN',
  marker: 'DEMO-SCN（架空）',
  adminEmail: SALES_DEMO.adminEmail,
  asOf: '2026-09-25',
});

const PARTNERS = [
  {key: 'PFD', code: 'DEMO-SCN-PF-D', name: '架空配信D（架空）', kind: 'platform'},
  {key: 'PFE', code: 'DEMO-SCN-PF-E', name: '架空配信E（架空）', kind: 'platform'},
  {key: 'SEL', code: 'DEMO-SCN-SEL', name: '架空パッケージ販売F（架空）', kind: 'retailer'},
  {key: 'OS', code: 'DEMO-SCN-OS', name: '架空海外セールスG（架空）', kind: 'agency'},
  {key: 'TV', code: 'DEMO-SCN-TV', name: '架空BS放送H（架空）', kind: 'other'},
  {key: 'RH', code: 'DEMO-SCN-RH', name: '権利元I（架空・販売委託の委託者）', kind: 'agency'},
];

const WORKS = [
  {key: 'W1', code: 'DEMO-SCN-W1', title: '灯の港（架空）', contract: 'distribution', contractTitle: '販売委託の契約（架空）'},
  {key: 'W2', code: 'DEMO-SCN-W2', title: '冬の観覧車（架空）', contract: 'acquisition', contractTitle: '買付の契約（架空・買い切り）', purchaseYen: 1200000},
  {key: 'W3', code: 'DEMO-SCN-W3', title: '坂の上の写真館（架空）', contract: 'investment', contractTitle: '自社出資の稟議（架空）', ownInvestmentYen: 4000000},
  {key: 'W4', code: 'DEMO-SCN-W4', title: '風の停車場（架空）', contract: 'investment', contractTitle: '製作委員会契約（架空）', release: '2026-06'},
];

const PRODUCTS = [
  {key: 'W1-DIG', work: 'W1', channel: 'digital', label: '配信'},
  {key: 'W1-SEL', work: 'W1', channel: 'package', label: 'DVD・BD（セル）'},
  {key: 'W2-DIG', work: 'W2', channel: 'digital', label: '配信'},
  {key: 'W3-OS', work: 'W3', channel: 'other', label: '海外配給権'},
  {key: 'W4-DIG', work: 'W4', channel: 'digital', label: '配信'},
];

// 売上報告（1通1行）。link は W1 の委託契約へ結ぶ報告
const SALES = [
  {key: 'DEMO-SCN-W1-D-2026-07', work: 'W1', partner: 'PFD', product: 'W1-DIG', kind: 'digital', month: '2026-07', amount: 1500000, link: true},
  {key: 'DEMO-SCN-W1-D-2026-08', work: 'W1', partner: 'PFD', product: 'W1-DIG', kind: 'digital', month: '2026-08', amount: 3000000, link: true},
  {key: 'DEMO-SCN-W1-F-2026-07', work: 'W1', partner: 'SEL', product: 'W1-SEL', kind: 'package', month: '2026-07', amount: 500000, link: false},
  {key: 'DEMO-SCN-W2-E-2026-07', work: 'W2', partner: 'PFE', product: 'W2-DIG', kind: 'digital', month: '2026-07', amount: 1850000},
  {key: 'DEMO-SCN-W3-G-2026-07', work: 'W3', partner: 'OS', product: 'W3-OS', kind: 'other', month: '2026-07', amount: 2000000},
  {key: 'DEMO-SCN-W4-D-2026-07', work: 'W4', partner: 'PFD', product: 'W4-DIG', kind: 'digital', month: '2026-07', amount: 3000000},
  {key: 'DEMO-SCN-W4-D-2026-08', work: 'W4', partner: 'PFD', product: 'W4-DIG', kind: 'digital', month: '2026-08', amount: 3000000},
];

// 商談（名前は test/fixtures/scenario/compare-request.json の seed.opportunityNames と同じ）。
// 同じ作品×取引先の won 2件は、close_date の遅い見放題（7/20）を先に登録する。DB の ID の順と close_date の順が逆になり、
// 売上を close_date 順に充てる（ID 順でない）ことを画面と golden で見分けられる
const OPPORTUNITIES = [
  {n: 1, work: 'W1', partner: 'PFD', name: 'DEMO-SCN-O1 架空配信Dへの配信許諾 見放題（架空）', stage: 'won', expected: 3000000, close: '2026-07-20'},
  {n: 2, work: 'W1', partner: 'PFD', name: 'DEMO-SCN-O2 架空配信Dへの配信許諾 先行レンタル（架空）', stage: 'won', expected: 4000000, close: '2026-07-03'},
  {n: 3, work: 'W2', partner: 'PFE', name: 'DEMO-SCN-O3 架空配信Eへの買付作品の提案（架空）', stage: 'lead', expected: 2500000, close: '2027-01-31'},
  {n: 4, work: 'W1', partner: 'SEL', name: 'DEMO-SCN-O4 架空パッケージ販売への委託作品の提案（架空）', stage: 'proposal', expected: 1925000, close: '2026-12-10'},
  {n: 5, work: 'W3', partner: 'OS', name: 'DEMO-SCN-O5 架空海外セールスへの自社出資作品の提案（架空）', stage: 'negotiation', expected: 1125000, close: '2026-11-30'},
  {n: 6, work: 'W2', partner: 'TV', name: 'DEMO-SCN-O6 架空BS放送への買付作品の提案（架空・失注）', stage: 'lost', expected: 900000, close: '2026-10-01'},
  {n: 7, work: 'W2', partner: 'SEL', name: 'DEMO-SCN-O7 架空パッケージ販売への買付作品の打診（架空・額未定）', stage: 'proposal', expected: null, close: '2026-12-20'},
  {n: 8, work: 'W3', partner: 'PFD', name: 'DEMO-SCN-O8 架空配信Dへの自社出資作品の打診（架空・源泉未指定）', stage: 'lead', expected: 600000, close: '2027-02-10'},
  {n: 9, work: 'W2', partner: 'TV', name: 'DEMO-SCN-O9 架空BS放送への買付作品の提案（架空・来期）', stage: 'proposal', expected: 800000, close: '2027-05-20'},
];

const ACTIVITIES = [
  {opportunity: 2, on: '2026-06-10', type: 'contact', summary: '架空配信Dと先行レンタルの条件の面談（架空）'},
  {opportunity: 2, on: '2026-06-25', type: 'proposal', summary: '先行レンタルの条件書を提案（架空）'},
  {opportunity: 1, on: '2026-07-08', type: 'contact', summary: '見放題の配信の面談（架空）'},
  {opportunity: 4, on: '2026-09-10', type: 'contact', summary: 'パッケージ販売の面談（架空）'},
  {opportunity: 4, on: '2026-09-24', type: 'proposal', summary: 'パッケージの販売計画を提案（架空）'},
  {opportunity: 3, on: '2026-09-18', type: 'contact', summary: '買付作品の配信の面談（架空）'},
  {opportunity: 5, on: '2026-08-05', type: 'negotiation', summary: '海外の条件の交渉（架空）'},
  {opportunity: 6, on: '2026-03-20', type: 'contact', summary: '放送の面談（架空・失注）'},
  {opportunity: 8, on: '2026-09-01', type: 'contact', summary: '自社出資作品の配信の打診（架空）'},
];

const COMMITTEE = {
  productionCostYen: 3000000,
  members: [['SELF', 6000, '幹事・出資', 1800000], ['HAI', 4000, '出資', 1200000]],
  payment: {paidOn: '2026-07-15', amountYen: 1800000},
};
const WINDOW_LABELS = {theatrical: '劇場（配給）', package: 'ビデオグラム', digital: '配信', broadcast: '放送', other: '海外・その他'};

const addMonths = (ym, n) => {
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};
const endOfMonth = (ym) => `${ym}-${String(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;

export async function seedScenarioDemo(db, {log = () => {}} = {}) {
  const org = await db.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode]);
  if (!org) throw new Error('先に売上の架空データ（seed-sales-demo）を入れてください');
  if (await db.get('SELECT 1 FROM projects WHERE org_id=? AND code=?', [org.id, SCENARIO_DEMO.projectCode])) return {skipped: true, orgId: org.id};
  const self = await db.get('SELECT id FROM partners WHERE org_id=? AND code=?', [org.id, 'DEMO-SELF']);
  const hai = await db.get('SELECT id FROM partners WHERE org_id=? AND code=?', [org.id, 'DEMO-INV-HAI']);
  const profile = await db.get('SELECT self_partner_id FROM org_profile_versions WHERE org_id=? ORDER BY version_no DESC LIMIT 1', [org.id]);
  if (!self || !hai || profile?.self_partner_id !== self.id) throw new Error('先に PL・BS の架空データ（seed-plbs-demo。自社の取引先 DEMO-SELF）を入れてください');

  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SCENARIO_DEMO.adminEmail})});
  if (login.status !== 200) throw new Error(`架空の管理者でログインできません（${login.status}）`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, payload) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const data = await response.json();
    if (response.status >= 300 || data.ok === false) throw new Error(`${method} ${path}: ${response.status} ${data.error || JSON.stringify(data).slice(0, 600)}`);
    return data;
  };
  const post = (path, payload) => call('POST', path, payload);
  const get = (path) => call('GET', path);
  const session = await get('/session');
  if (session.user.orgId !== org.id) throw new Error('架空の管理者が DEMO-SALES で入れていません');

  // 取引先・案件・作品・商品
  const partnerId = new Map([['SELF', self.id], ['HAI', hai.id]]);
  for (const p of PARTNERS) partnerId.set(p.key, (await post('/partners', {code: p.code, name: p.name, kind: p.kind, region: p.key === 'OS' ? '海外' : '全国'})).id);
  const projectId = (await post('/projects', {code: SCENARIO_DEMO.projectCode, title: 'シナリオの比較の架空ライン（架空）', status: 'active', budget_yen: 30000000})).id;
  const work = new Map();
  for (const w of WORKS) work.set(w.key, {...w, id: (await post('/works', {project_id: projectId, code: w.code, title: w.title, format: 'film'})).id});
  const product = new Map();
  for (const p of PRODUCTS) {
    const w = work.get(p.work);
    const id = (await post('/products', {sku: `${w.code}-${p.key.split('-')[1]}`, name: `${w.title.replace('（架空）', '')} ${p.label}（架空）`, channel: p.channel})).id;
    await post('/product-works', {productId: id, allocations: [{workId: w.id, allocationBps: 10000}]});
    product.set(p.key, id);
  }
  log(`取引先 ${PARTNERS.length}件・案件 ${SCENARIO_DEMO.projectCode}・作品 ${work.size}本・商品 ${product.size}件`);

  // 製作委員会（W4）: 調達ケース → 委員会契約（条件版・窓口・払込の節目）→ 自社の払込
  const w4 = work.get('W4');
  const intake = await post('/intakes', {workId: w4.id, caseCode: `${w4.code}-CMT`, title: `${w4.title} 製作委員会`, intakeType: 'committee',
    documents: [{title: `${w4.title} 製作委員会契約書`, reference: `架空の委員会契約書 ${w4.code}`, versionLabel: '第1版'}],
    participants: COMMITTEE.members.map(([key, bps, role, amount]) => ({partyKind: 'partner', partnerId: partnerId.get(key), role, investmentYen: amount, explicitShareBps: bps}))});
  const intakeCase = (await get(`/intakes?workId=${w4.id}`)).cases.find((row) => row.id === intake.caseId);
  const start = addMonths(w4.release, -1);
  const windows = Object.keys(WINDOW_LABELS).map((kind) => ({kind, label: WINDOW_LABELS[kind], windowPartnerId: self.id, route: 'via_manager', platformRateBps: 0,
    windowFeeBps: 1500, managerFeeBps: 500, feeOrder: 'window_first', windowFeeBasis: 'platform_net', managerFeeBasis: 'after_window'}));
  const committee = await post('/committee/contracts', {workId: w4.id, intakeCaseId: intake.caseId, documentId: intakeCase.documents[0].id, contractCode: `${w4.code}-C01`,
    title: `${w4.title} 製作委員会収支`, managerPartnerId: self.id, windows,
    phases: [{label: '半年ごと（6・12月締め）', startsOn: `${start}-01`, endsOn: endOfMonth(addMonths(start, 59)), firstCloseOn: endOfMonth('2026-06'), intervalMonths: 6,
      closeDay: 'eom', reportOffsetMonths: 1, reportDay: 'eom', paymentOffsetMonths: 2, paymentDay: 'eom', referenceType: 'release', referenceDate: `${w4.release}-01`}],
    funding: {productionCostYen: COMMITTEE.productionCostYen, investments: COMMITTEE.members.map(([key, , , amount]) => ({partnerId: partnerId.get(key), amountYen: amount}))},
    note: '架空の製作委員会の条件（シナリオの比較のデモ）'});
  const mine = (await get(`/committee-investments?workId=${w4.id}`)).rows.find((row) => row.latest && row.partnerId === self.id);
  if (!mine) throw new Error('委員会の自社の出資額が登録されていません');
  await post('/committee-investment-payments', {termVersionId: mine.termVersionId, partnerId: self.id, paidOn: COMMITTEE.payment.paidOn, amountYen: COMMITTEE.payment.amountYen,
    method: 'transfer', note: '出資金の払込（架空・シナリオの比較のデモ）'});

  // 作品マスタ（契約・費用・権利元・プロフィール）。買付額・自社出資の出資額・委員会の条件版をここで持つ
  const meta = {baseRevision: 0, source_reference: SCENARIO_DEMO.marker, reason: 'シナリオの比較の架空データ（架空）'};
  const money = (key, amount) => ({[`${key}_yen`]: amount, [`${key}_tax_basis`]: 'ex_tax', [`${key}_status`]: amount == null ? 'unknown' : 'estimated',
    [`${key}_as_of`]: amount == null ? null : '2026-06-30', [`${key}_evidence`]: amount == null ? null : 'DEMO-SCN-見積書（架空）'});
  for (const w of WORKS) {
    const id = work.get(w.key).id;
    await post(`/work-master/${id}/profile`, {...meta, series: null, label: '映像レーベル（架空）', production_category: w.key === 'W4' ? '委員会製作' : '自社製作',
      registration_state: 'confirmed', work_kind: 'work', internal_notes: 'シナリオの比較の検証用（架空）', primary_use: '配信（架空）', secondary_use: 'パッケージ（架空）'});
    await post(`/work-master/${id}/contracts`, {...meta, rows: [{contract_key: `${w.code}-K1`, title: w.contractTitle, kind: w.contract, signed_on: '2026-05-10', starts_on: '2026-06-01',
      ends_on: '2029-05-31', partner_id: partnerId.get(w.key === 'W1' ? 'RH' : w.key === 'W4' ? 'HAI' : 'OS'), document_reference: `${w.code}-契約書（架空）`},
    // 2本目は稼ぎ方の判定（買付＝acquisition）に響かない「その他」の覚書
    {contract_key: `${w.code}-K2`, title: '素材の貸与の覚書（架空）', kind: 'other', signed_on: '2026-05-20', starts_on: '2026-06-01', ends_on: '2029-05-31',
      partner_id: partnerId.get(w.key === 'W1' ? 'RH' : 'SELF'), document_reference: `${w.code}-覚書（架空）`}]});
    await post(`/work-master/${id}/rights`, {...meta, rows: [{partner_id: partnerId.get(w.key === 'W1' ? 'RH' : 'SELF'), role: '権利元', evidence: `${w.code}-契約書（架空）`},
      {name: `${w.title.replace('（架空）', '')}の原作者（架空）`, role: '原作者', rights_scope: '原作利用（架空）', evidence: `${w.code}-原作利用許諾（架空）`}]});
    await post(`/work-master/${id}/finance`, {...meta, committee_term_version_id: w.key === 'W4' ? committee.versionId : null,
      ...money('production_cost', w.ownInvestmentYen ?? null), ...money('promotion_budget', null), ...money('own_investment', w.ownInvestmentYen ?? null),
      ...money('sales_rights_purchase', w.purchaseYen ?? null)});
  }
  for (const [index, p] of PRODUCTS.entries()) {
    const id = product.get(p.key);
    await post(`/product-master/${id}`, {...meta, product_number: `DEMO-SCN-P-${p.key}`, jan_code: `00${String(99000000001 + index)}`, product_type: '映像商品', media: p.channel === 'package' ? 'Blu-ray' : 'デジタル',
      release_on: '2026-07-01', sales_end_on: '2029-05-31', publisher_partner_id: self.id, distributor_partner_id: null, label: '映像レーベル（架空）', sales_class: 'セル',
      disc_count: p.channel === 'package' ? 1 : null, disc_layer: null, audio: '日本語・ステレオ', subtitles: '日本語', video_quality: 'HD', runtime_minutes: 98,
      notes: 'シナリオの比較の検証用の仕様（架空）', ...money('price', p.channel === 'package' ? 4800 : null)});
  }

  // 売上報告（1通1行。計上月＝販売月）
  const reportId = new Map();
  for (const s of SALES) {
    const w = work.get(s.work);
    await post('/sales', {workId: w.id, report_key: s.key, kind: s.kind, partner_id: partnerId.get(s.partner), product_id: product.get(s.product),
      period_from: `${s.month}-01`, period_to: endOfMonth(s.month), recognition_basis_id: 1, sales_month: s.month, basis_reason: '架空の報告（シナリオの比較のデモ）',
      description: `${s.kind === 'digital' ? '配信' : s.kind === 'package' ? 'パッケージ' : '海外'}売上 ${s.month}（架空）`, quantity: 1,
      amount_ex_tax: s.amount, tax_amount: s.amount / 10, amount_inc_tax: s.amount + s.amount / 10});
    const row = await db.get("SELECT id FROM report_imports WHERE org_id=? AND work_id=? AND report_key=? AND status='active'", [org.id, w.id, s.key]);
    reportId.set(s.key, row.id);
  }

  // 販売委託（W1）: 委託者 RH との委託契約（手数料 20%）と、配信の報告2件の紐付け。パッケージの報告は紐付けない（未紐付け）
  const w1 = work.get('W1');
  const contract = await post('/settlement/contracts', {workId: w1.id, contractCode: 'DEMO-SCN-COM-W1', title: '販売委託の手数料（架空）', contractType: 'commission',
    holderPartnerId: partnerId.get('RH'), terms: {platformRateBps: 0, agencyFeeBps: 2000}});
  for (const s of SALES.filter((row) => row.link)) {
    await post('/settlement/links', {reportId: reportId.get(s.key), workId: w1.id, contractId: contract.contractId, termVersionId: contract.versionId, reportBasis: 'net'});
  }

  // 自社出資（W3）の回収: 海外の売上の請求と入金
  const w3 = work.get('W3');
  const {candidates} = await get(`/billing?workId=${w3.id}&asOf=${SCENARIO_DEMO.asOf}`);
  const billable = candidates.filter((row) => row.eligible);
  if (billable.length !== 1) throw new Error(`W3 の請求できる報告が1件ではありません（${billable.length}件）`);
  const invoice = await post('/billing/invoices', {workId: w3.id, reportIds: billable.map((row) => row.id), invoiceDate: '2026-08-05', dueDate: '2026-08-31',
    sourceAmountBasis: 'platform_net', note: '2026-07 計上分の請求（架空・シナリオの比較のデモ）'});
  await post('/billing/receipts', {partnerId: partnerId.get('OS'), receivedOn: '2026-08-31', amountYen: invoice.amountIncTax,
    allocations: [{invoiceId: invoice.invoiceId, amountYen: invoice.amountIncTax}], reference: 'DEMO-SCN-RCV-W3-2026-08-31', note: '振込入金（架空・シナリオの比較のデモ）'});

  // 商談と活動
  const opportunityId = new Map();
  for (const o of OPPORTUNITIES) {
    const w = work.get(o.work);
    opportunityId.set(o.n, (await post('/opportunities', {project_id: projectId, work_id: w.id, partner_id: partnerId.get(o.partner), name: o.name, stage: o.stage,
      expected_yen: o.expected, close_date: o.close})).id);
  }
  for (const a of ACTIVITIES) {
    const o = OPPORTUNITIES.find((row) => row.n === a.opportunity);
    await post('/sales-activities', {workId: work.get(o.work).id, opportunityId: opportunityId.get(a.opportunity), occurredOn: a.on, activityType: a.type, summary: a.summary});
  }

  // この利用者の財務権限に、種が足した案件が全部入っていること（財務権限で絞る一覧に全部の商談が出る）
  const visible = new Set((await get('/opportunities')).rows.map((row) => row.id));
  const missing = [...opportunityId.values()].filter((id) => !visible.has(id));
  if (missing.length) throw new Error(`${SCENARIO_DEMO.adminEmail} の財務権限で見えない商談があります: ${missing.join('・')}`);

  log(`委員会 1件（払込 ${COMMITTEE.payment.amountYen}円）・売上報告 ${SALES.length}通（委託の紐付け ${SALES.filter((row) => row.link).length}件）・請求と入金 各1件・商談 ${OPPORTUNITIES.length}件・活動 ${ACTIVITIES.length}件`);
  return {
    skipped: false, orgId: org.id, projectId,
    works: Object.fromEntries([...work.values()].map((w) => [w.code, w.id])),
    opportunities: Object.fromEntries(OPPORTUNITIES.map((o) => [o.name, opportunityId.get(o.n)])),
    activities: ACTIVITIES.length, reports: SALES.length,
  };
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const index = process.argv.indexOf('--db');
  const target = index > 0 ? process.argv[index + 1] : null;
  if (!target) {
    console.error('投入先のDBを --db で指定してください（例: --db C:/temp/demo-all.sqlite）。既定のローカルDBへは書きません。');
    process.exit(2);
  }
  if (resolve(target).toLowerCase() === fileURLToPath(new URL('../data/integrated.sqlite', import.meta.url)).toLowerCase()) {
    console.error('data/integrated.sqlite へは書きません。');
    process.exit(2);
  }
  const db = new LocalDatabase(resolve(target));
  try {
    const result = await seedScenarioDemo(db, {log: console.log});
    console.log(result.skipped ? 'シナリオの比較の架空データは投入済みです（何もしませんでした）' : `投入しました: ${JSON.stringify(result)}`);
  } finally {
    db.close();
  }
}
