#!/usr/bin/env node
// 指標マスタ（行動指標の計画 段B #9）の架空の種を、1つの組織に入れる。種は test/fixtures/kpi-metrics/seed.json（申し送りの仮置きの値。状態は仮置き。J-13）。
//   1. 細目の段（企画メモ・条件書など。ontology の「行動の段」）を、行動のステップの参照表（組織に依らない）に無いものだけ足す
//   2. 指標マスタの最初の版（役×稼ぎ方×段の対応と状態）を、その組織に版が1つも無いときだけ足す
//   3. 設定の行（段の率・1件の時間・1件の額など）を、変数×範囲の版がまだ無いものだけ版1で足す（ある行は上書きしない。値が種と違えば件数と鍵を返す）
// 何度流しても増えない。store（src/planning/planning-store.mjs・src/revenue/revenue-store.mjs）を通して書き、入力は model の読み取りを通す。
// seed-all-demo.mjs の手順にはまだ入れていない（段B の種をまとめる #15 で寄せる。フェーズ1 #23a の種の「行動」の行と同じ設定の行を持つため）。
// 使い方: node scripts/seed-kpi-metrics-demo.mjs --db <SQLiteのパス> [--org DEMO-SALES] [--user demo-admin@openingnight.invalid]
//   data/integrated.sqlite へは --allow-main-db を付けたときだけ書く。本番の D1・Cloudflare・設定・秘密値には触れない
import {readFileSync} from 'node:fs';
import {resolve, dirname, basename} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import * as revenue from '../src/revenue/revenue-store.mjs';
import {normalizeMetricMasterInput} from '../src/revenue/metrics/metric-master-model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const KPI_METRICS_SEED_PATH = resolve(here, '../test/fixtures/kpi-metrics/seed.json');
export const readKpiMetricsSeed = (path = KPI_METRICS_SEED_PATH) => JSON.parse(readFileSync(path, 'utf8'));

const slotKey = (s) => [s.variableKey, s.scope, s.earningType ?? '', s.step ?? '', s.projectId ?? '', s.channelCode ?? ''].join('|');

// 手順1の細目の段だけを、行動のステップの参照表（組織に依らない）に無いものだけ足す（親が違う同じコードがあれば止める。数え方が黙って変わるため）。
// 営業の活動の取り込み（行動指標の計画 段B #10。src/revenue/yojitsu/activity-import-routes.mjs）は、提案を細目の段「取引先への提案」で取り込むので、
// 指標マスタを入れない DB でもこの関数で細目の段を足せる。返り値: {added, existing}
export async function seedDetailSteps(db, {seed = readKpiMetricsSeed()} = {}) {
  if (seed.fictional !== true) throw new Error('指標マスタの種は架空（fictional: true）だけを入れます');
  const existing = new Map((await planning.listActionSteps(db)).map((s) => [s.code, s]));
  const steps = {added: 0, existing: 0};
  for (const s of seed.steps) {
    const found = existing.get(s.code);
    if (found) {
      if ((found.parent_code ?? null) !== s.parent) throw new Error(`段 ${s.code} の親が種（${s.parent}）と違います（${found.parent_code ?? 'なし'}）`);
      steps.existing += 1;
      continue;
    }
    await planning.addActionStep(db, {code: s.code, label: s.label, parentCode: s.parent, sortOrder: s.sortOrder});
    steps.added += 1;
  }
  return steps;
}

export async function seedKpiMetrics(db, {orgId, createdBy, seed = readKpiMetricsSeed(), log = () => {}}) {
  if (seed.fictional !== true) throw new Error('指標マスタの種は架空（fictional: true）だけを入れます');
  // 1. 細目の段（参照表）
  const steps = await seedDetailSteps(db, {seed});
  // 2. 指標マスタの最初の版
  const metricMaster = {added: false, versionNo: null};
  const versions = await revenue.readMetricMaster(db, orgId, {history: true});
  if (versions.length) metricMaster.versionNo = Math.max(...versions.map((v) => v.versionNo));
  else {
    const n = normalizeMetricMasterInput({previousVersionNo: 0, createdOn: seed.createdOn, basis: seed.metricMaster.basis, chains: seed.metricMaster.chains},
      {earningTypes: await planning.listEarningTypes(db), actionSteps: await planning.listActionSteps(db)});
    if (!n.ok) throw new Error(`指標マスタの種が読めません: ${JSON.stringify(n.errors)}`);
    metricMaster.versionNo = await revenue.addMetricMasterVersion(db, orgId, n.value, {createdBy});
    metricMaster.added = true;
  }
  // 3. 設定の行（変数×範囲の版がまだ無いものだけ）
  const effective = new Map((await revenue.readEffectiveSettings(db, orgId)).map((s) => [slotKey(s), s]));
  const settings = {added: 0, existing: 0, differing: []};
  for (const s of seed.settings) {
    const found = effective.get(slotKey(s));
    if (found) {
      settings.existing += 1;
      if (found.value.kind !== s.value.kind || found.value.value !== s.value.value) settings.differing.push(slotKey(s));
      continue;
    }
    await revenue.addSettingVersion(db, orgId, {variableKey: s.variableKey, scope: s.scope, earningType: s.earningType ?? null, step: s.step ?? null,
      projectId: null, channelCode: null, previousVersionNo: 0, value: s.value, status: s.status, basis: s.basis ?? null}, {createdBy});
    settings.added += 1;
  }
  log(`指標マスタの種: 細目の段 ${steps.added} 件を足した（${steps.existing} 件はあった）・指標マスタ 第${metricMaster.versionNo}版${metricMaster.added ? 'を足した' : 'があった'}・`
    + `設定の行 ${settings.added} 件を足した（${settings.existing} 件はあり、うち種と違う値 ${settings.differing.length} 件）`);
  return {steps, metricMaster, settings};
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = arg('--db');
  if (!path) { console.error('--db <SQLiteのパス> を渡してください'); process.exit(2); }
  if (basename(path) === 'integrated.sqlite' && !process.argv.includes('--allow-main-db')) {
    console.error('data/integrated.sqlite へは --allow-main-db を付けたときだけ書きます'); process.exit(2);
  }
  const db = new LocalDatabase(resolve(path));
  const org = await db.get('SELECT id FROM organizations WHERE code=?', [arg('--org', 'DEMO-SALES')]);
  const user = await db.get('SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=? AND m.org_id=?',
    [arg('--user', 'demo-admin@openingnight.invalid'), org?.id ?? null]);
  if (!org || !user) { console.error('組織か利用者が見つかりません（先に seed-all-demo.mjs で架空の組織を作ってください）'); process.exit(1); }
  await seedKpiMetrics(db, {orgId: Number(org.id), createdBy: Number(user.id), log: console.log});
}
