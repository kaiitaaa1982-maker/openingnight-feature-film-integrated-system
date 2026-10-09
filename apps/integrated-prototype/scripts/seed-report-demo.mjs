#!/usr/bin/env node
// 帳票センター（年間売上・MG売上報告・ロイヤリティ報告書）を画面で確かめるための架空データを投入する。
// 使い方: node scripts/seed-report-demo.mjs --db <一時DBのパス>
// ・--db の指定は必須（既定のローカルDB data/integrated.sqlite へは書かない）。本番のD1・設定・秘密値は読まない。
// ・APIを通して登録するので、検証・権限・監査は画面から登録したときと同じ。
// ・2回実行しても重複しない（取引先コード DEMO-PF-A があれば何もしない）。名称はすべて架空。
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';

export async function seedReportDemo(db) {
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (path, body) => {
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    const data = await response.json();
    if (response.status >= 300 || data.ok === false) throw new Error(`${path}: ${response.status} ${data.error || JSON.stringify(data)}`);
    return data;
  };
  if (await db.get("SELECT 1 FROM partners WHERE code='DEMO-PF-A'")) return {skipped: true};
  const work = await db.get("SELECT w.id, w.project_id FROM works w WHERE w.code='WRK-DEMO'") || await db.get('SELECT id, project_id FROM works WHERE org_id=1 ORDER BY id LIMIT 1');
  const products = await db.all("SELECT id, sku FROM products WHERE org_id=1 AND sku IN ('SKU-DIGI','SKU-PACK') ORDER BY sku");
  const digital = products.find((p) => p.sku === 'SKU-DIGI')?.id;
  const pack = products.find((p) => p.sku === 'SKU-PACK')?.id;
  if (!work || !digital || !pack) throw new Error('架空の作品 WRK-DEMO と商品 SKU-DIGI・SKU-PACK が必要です');

  const partner = async (code, name, kind) => (await call('/partners', {code, name, kind, region: '全国'})).id;
  const platformA = await partner('DEMO-PF-A', '配信プラットフォームA（架空）', 'platform');
  const storeB = await partner('DEMO-SH-B', '販売店B（架空）', 'retailer');
  const holderC = await partner('DEMO-RH-C', '権利元C（架空）', 'agency');
  const supplier = await call('/mg/suppliers', {code: 'SUP-DEMO-D', name: '権利元D（架空・仕入先）', note: '帳票デモ用の架空データ'});

  // 売上（今年度と前年度の同じ月。計上月＝販売月）
  const plan = [
    ['2025-06', platformA, digital, 'digital', 180000], ['2025-07', platformA, digital, 'digital', 210000], ['2025-08', storeB, pack, 'package', 90000],
    ['2026-05', platformA, digital, 'digital', 240000], ['2026-06', platformA, digital, 'digital', 320000], ['2026-07', platformA, digital, 'digital', 280000],
    ['2026-07', storeB, pack, 'package', 120000], ['2026-08', platformA, digital, 'digital', 260000], ['2026-08', storeB, pack, 'package', 75000],
  ];
  const reports = [];
  for (const [month, partnerId, productId, kind, amount] of plan) {
    const key = `DEMO-${month}-${partnerId === platformA ? 'A' : 'B'}`;
    await call('/sales', {workId: work.id, report_key: key, kind, partner_id: partnerId, product_id: productId, period_from: `${month}-01`, period_to: `${month}-28`,
      recognition_basis_id: 1, sales_month: month, basis_reason: '架空の報告（帳票デモ）', description: `${kind === 'digital' ? '配信' : 'パッケージ'}売上 ${month}`,
      quantity: Math.round(amount / 500), amount_ex_tax: amount, tax_amount: amount / 10, amount_inc_tax: amount + amount / 10});
    reports.push({key, partnerId});
  }
  const reportRows = (await call(`/reports?workId=${work.id}`)).rows;
  const reportId = (key) => reportRows.find((row) => row.report_key === key).id;

  // ロイヤリティ: 権利元Cへの手数料型（配信A）と、MG型（販売店B）の保留の例
  const commission = await call('/settlement/contracts', {workId: work.id, contractCode: 'DEMO-ROY-C', title: '配信の権利許諾（架空）', contractType: 'commission', holderPartnerId: holderC, terms: {platformRateBps: 3000, agencyFeeBps: 1000}});
  const mgRoyalty = await call('/settlement/contracts', {workId: work.id, contractCode: 'DEMO-ROY-MG', title: 'パッケージのMG許諾（架空）', contractType: 'mg', holderPartnerId: holderC, mgContractYen: 150000, terms: {platformRateBps: 0, agencyFeeBps: 0, recoupBasis: 'platform_net'}});
  for (const {key, partnerId} of reports) {
    const contract = partnerId === platformA ? commission : mgRoyalty;
    await call('/settlement/links', {reportId: reportId(key), workId: work.id, contractId: contract.contractId, termVersionId: contract.versionId, reportBasis: partnerId === platformA ? 'gross' : 'net'});
  }
  await call('/rights-reports/payments', {settlementContractId: commission.contractId, partnerId: holderC, amountYen: 250000, paidOn: '2026-07-31', reference: 'DEMO-PAY-2026-07', reason: '架空の支払（帳票デモ）'});
  const second = await call('/rights-reports/payments', {settlementContractId: commission.contractId, partnerId: holderC, amountYen: 120000, paidOn: '2026-08-31', reference: 'DEMO-PAY-2026-08', reason: '架空の支払（帳票デモ）'});
  await call('/rights-reports/payments', {settlementContractId: commission.contractId, partnerId: holderC, amountYen: 120000, paidOn: '2026-09-05', reference: 'DEMO-PAY-2026-08-VOID', reason: '架空の取消（金額誤り）', reversesEventId: second.id});

  // MG: 受取MG（配信Aから保証1,000,000円）と支払MG（権利元Dへ保証500,000円）
  const phases = [{startsOn: '2026-05-01', endsOn: '2027-04-30', intervalMonths: 3, firstCloseOn: '2026-07-31', reportOffsetMonths: 1, reportDay: 28, payOffsetMonths: 2, payDay: 28}];
  const incoming = await call('/mg/contracts', {direction: 'incoming', code: 'DEMO-MGI-A', title: '配信Aの最低保証（架空）', partnerId: platformA, contractDate: '2026-04-15', contractSourceReference: 'DEMO-CONTRACT-MGI-A',
    mgAmountYen: 1000000, startsOn: '2026-05-01', endsOn: '2027-04-30', mode: 'cross', reason: '架空条件（帳票デモ）', sourceReference: 'DEMO-TERMS-MGI-A',
    products: [{productId: digital, evaluationYen: 700000}, {productId: pack, evaluationYen: 300000}], phases});
  const outgoing = await call('/mg/contracts', {direction: 'outgoing', code: 'DEMO-MGO-D', title: '権利元Dへの最低保証（架空）', supplierId: supplier.supplierId, contractDate: '2026-04-20', contractSourceReference: 'DEMO-CONTRACT-MGO-D',
    mgAmountYen: 500000, startsOn: '2026-05-01', endsOn: '2027-04-30', mode: 'cross', reason: '架空条件（帳票デモ）', sourceReference: 'DEMO-TERMS-MGO-D',
    products: [{productId: digital, evaluationYen: 500000}], phases});
  const ledger = [
    [incoming.versionId, digital, '2026-06', 400000, 400000, 0, 0], [incoming.versionId, pack, '2026-07', 150000, 150000, 0, 0],
    [incoming.versionId, digital, '2026-08', 600000, 450000, 150000, 150000],
    [outgoing.versionId, digital, '2026-07', 200000, 200000, 0, 0], [outgoing.versionId, digital, '2026-08', 180000, 180000, 0, 0],
  ];
  let n = 0;
  for (const [termVersionId, productId, month, eligible, applied, overage, recognized] of ledger) {
    n += 1;
    await call('/mg/ledger', {termVersionId, productId, periodFrom: `${month}-01`, periodTo: `${month}-28`, accountingMonth: month, sourceReference: `DEMO-MG-LEDGER-${n}`,
      reportedEligibleYen: eligible, appliedRecoupYen: applied, reportedOverageYen: overage, recognizedYen: recognized, status: 'reviewed', acknowledgement: true, confirmationReason: '架空データ（帳票デモ）の手入力値'});
  }
  return {skipped: false, sales: plan.length, mgLedger: ledger.length, payments: 3};
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const index = process.argv.indexOf('--db');
  const target = index > 0 ? process.argv[index + 1] : null;
  if (!target) {
    console.error('投入先のDBを --db で指定してください（例: --db C:/temp/demo.sqlite）。既定のローカルDBへは書きません。');
    process.exit(2);
  }
  if (resolve(target).toLowerCase().endsWith(resolve('data/integrated.sqlite').toLowerCase()) && !process.argv.includes('--allow-main-db')) {
    console.error('data/integrated.sqlite への投入は --allow-main-db を付けたときだけ行います。');
    process.exit(2);
  }
  const db = new LocalDatabase(resolve(target));
  try {
    const result = await seedReportDemo(db);
    console.log(result.skipped ? '帳票デモのデータは投入済みです（何もしませんでした）' : `投入しました: 売上 ${result.sales}件・MG台帳 ${result.mgLedger}行・支払記録 ${result.payments}件`);
  } finally {
    db.close();
  }
}
