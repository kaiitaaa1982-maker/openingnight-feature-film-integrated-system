#!/usr/bin/env node
// 架空データ（組織 DEMO-SALES）の売上明細の流通の分類を、旧区分（theatrical・tvod など）から流通マスタの流通ID（H001・D004 など）へ付け替える。
// 設計: docs/platform/team-development/demo-entry-and-sales-sheet-findability.md §3「流通IDの分類し直し」。
// ・2026-09-25 に本番へ入れた架空データは、seed-sales-demo.mjs が流通の分類を旧区分（精算方式は未確認）で入れていた。
//   新しく作る DB は seed-sales-demo.mjs が最初から流通マスタの ID で分類するので、この節は何もしない。
// ・対象は DEMO-SALES の売上明細のうち、最新の分類が旧区分（流通マスタに無いコード）で、seed が入れた分類（理由が seed の目印）のものだけ。
//   利用者が画面で分類し直した明細・分類の無い明細（レンタル／セル未確認のまま残した明細など）には触れない。
// ・付け替えは画面と同じ分類の登録（POST /api/report-center/classifications）で新しい版を足す。保存済みの版は書き換えない。
//   地域・サービス名はそのまま引き継ぎ、流通IDと精算方式は seed-sales-demo.mjs の demoDistributionOf（新しい DB と同じ対応）で決める。
// ・新しい版の理由に目印（RECLASSIFY_REASON）を入れる。付け替えた明細は最新の分類が流通マスタの ID になるので、2回目は対象が無く何もしない。
// ・金額は変わらない（ロイヤリティ・委員会・PL・BS などの流通の区分は、旧区分と付け替えた流通IDで同じ区分になる）。確かめ方は
//   test/demo-distribution-reclassify.test.mjs。
// 使い方: node scripts/seed-sales-distribution.mjs --db <SQLiteのパス>（ふだんは scripts/seed-all-demo.mjs の流す順の2番目で流れる）
// ・--db の指定は必須。data/integrated.sqlite へは --allow-main-db を付けたときだけ書く。本番のD1・設定・秘密値は読まない。
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {SALES_DEMO, DEMO_CLASSIFY_REASON, demoDistributionOf} from './seed-sales-demo.mjs';

export const RECLASSIFY_REASON = '架空データ: 流通マスタの流通IDで分類し直し（2026-09-26 代表の指示）';

// 付け替えの対象（最新の分類が旧区分で、seed が入れた分類）と、付け替え先。対応の無い明細があれば unknown に入れる
export async function reclassifyTargets(db, orgId) {
  const rows = await db.all(`SELECT s.id AS sale_id, s.amount_ex_tax, s.description, w.code AS work_code, r.report_key,
      d.version_no, d.distribution_code, d.territory, d.service_name, d.settlement_method
    FROM sale_lines s
    JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    JOIN works w ON w.org_id=s.org_id AND w.id=s.work_id
    JOIN sale_distribution_versions d ON d.org_id=s.org_id AND d.sale_id=s.id
      AND d.version_no=(SELECT MAX(x.version_no) FROM sale_distribution_versions x WHERE x.org_id=s.org_id AND x.sale_id=s.id)
    LEFT JOIN distribution_master m ON m.code=d.distribution_code
    WHERE s.org_id=? AND m.code IS NULL AND d.reason=?
    ORDER BY s.id`, [orgId, DEMO_CLASSIFY_REASON.legacy]);
  const targets = [];
  const unknown = [];
  for (const row of rows) {
    const to = demoDistributionOf(row.distribution_code, {amount: row.amount_ex_tax, workCode: row.work_code});
    if (to) targets.push({...row, to});
    else unknown.push(row);
  }
  return {targets, unknown};
}

export async function reclassifyDemoSalesDistribution(db, {log = () => {}} = {}) {
  const org = await db.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode]);
  if (!org) return {skipped: true, reason: `組織 ${SALES_DEMO.orgCode} がありません`, reclassified: 0};
  const {targets, unknown} = await reclassifyTargets(db, org.id);
  // 対応の無い旧区分が1つでもあれば、1件も書かずに止める（途中まで付け替えた状態を残さない）
  if (unknown.length) {
    const codes = [...new Set(unknown.map((row) => row.distribution_code))].join('、');
    throw new Error(`流通マスタの流通IDに対応の無い旧区分があります（${codes}・${unknown.length}行）。seed-sales-demo.mjs の DEMO_DISTRIBUTION を確かめてください`);
  }
  if (!targets.length) return {skipped: true, orgId: org.id, reclassified: 0};

  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
  if (login.status !== 200) throw new Error(`架空の管理者でログインできません（${login.status}）`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = async (path, payload) => {
    const response = await app.request(`/api${path}`, {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(payload)});
    const data = await response.json();
    if (response.status >= 300 || data.ok === false) throw new Error(`POST ${path}: ${response.status} ${data.error || JSON.stringify(data).slice(0, 600)}`);
    return data;
  };
  const session = await (await app.request('/api/session', {headers: {cookie}})).json();
  if (session.user?.orgId !== org.id) throw new Error(`架空の管理者が ${SALES_DEMO.orgCode} で入れていません`);

  const byCode = {};
  for (const row of targets) {
    await post('/report-center/classifications', {saleId: row.sale_id, distributionCode: row.to.code, baseVersion: row.version_no, territory: row.territory ?? '',
      serviceName: row.service_name ?? '', settlementMethod: row.to.settlementMethod, reason: RECLASSIFY_REASON});
    const key = `${row.distribution_code}→${row.to.code}`;
    byCode[key] = (byCode[key] || 0) + 1;
  }
  log(`売上明細の流通の分類 ${targets.length}行を流通マスタの流通IDへ付け替え（${Object.entries(byCode).map(([key, n]) => `${key} ${n}行`).join('・')}）`);
  return {skipped: false, orgId: org.id, reclassified: targets.length, byCode};
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : null;
  };
  const target = option('--db');
  if (!target) {
    console.error('対象のDBを --db で指定してください（例: --db C:/temp/demo-sales.sqlite）。既定のローカルDBへは書きません。');
    process.exit(2);
  }
  const mainDb = fileURLToPath(new URL('../data/integrated.sqlite', import.meta.url));
  if (resolve(target).toLowerCase() === resolve(mainDb).toLowerCase() && !process.argv.includes('--allow-main-db')) {
    console.error('data/integrated.sqlite への書き込みは --allow-main-db を付けたときだけ行います。');
    process.exit(2);
  }
  const db = new LocalDatabase(resolve(target));
  try {
    const result = await reclassifyDemoSalesDistribution(db, {log: (message) => console.log(`  ${message}`)});
    if (result.skipped) console.log(`付け替える明細はありません（${result.reason || '旧区分のままの明細なし'}）`);
    else console.log(`付け替えました: ${result.reclassified}行`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
