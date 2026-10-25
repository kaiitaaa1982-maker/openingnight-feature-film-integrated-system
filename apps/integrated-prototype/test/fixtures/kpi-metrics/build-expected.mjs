#!/usr/bin/env node
// 指標マスタ（行動指標の計画 段B #9）の golden を、src を import せずに作る生成スクリプト。
// 種（seed.json）の対応と設定の行から、読み取り（src/revenue/revenue-store.mjs の readMetricMaster・readEffectiveSettings と
// metric-master-model.mjs の attachStepSettings）が返すはずの形を、ここで別に書いた決まりで作る:
// - 役の並びは ontology の「行動の段」の順（プロデューサー → 営業（仕入れ）→ 営業（売り））、稼ぎ方の並びは移行 0012 の earning_types の並び
// - 段は seq の順で、畳む先は細目なら親のステップ、親の無い段（提案・契約）はそれ自身
// - 段の率と1件の時間は、設定の行のうち範囲が稼ぎ方×ステップで稼ぎ方×段が同じ行の値。無ければ null
// - 設定の行は変数×範囲ごとに1行（種はどれも版1）
// 使い方: node test/fixtures/kpi-metrics/build-expected.mjs [--check]（--check は書かずに expected.json と比べ、違えば終了コード1）
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SEED_PATH = resolve(here, 'seed.json');
export const EXPECTED_PATH = resolve(here, 'expected.json');

// 役（ontology の「行動の段」の役の列の順）と、表示の絞りのまとまり（申し送り §画面1 の「全部・プロデューサー・営業」）
const ROLES = [['producer', 'producer'], ['sales_sourcing', 'sales'], ['sales_selling', 'sales']];
// 稼ぎ方の並びと利益の源泉（D-039 の 2026-10-10 の追記。移行 0012 の earning_types の行と同じ値をここで別に書く）
const EARNING_TYPES = [['acquisition', 4], ['consignment', 5], ['own_investment', 2], ['committee', 3], ['contract_work', 1]];
// 集計の3ステップ（移行 0012 の action_steps の親の無い行）
const TOP_STEPS = ['meeting', 'proposal', 'contract'];

export function buildExpected(seed, seedText) {
  const parentOf = new Map(seed.steps.map((s) => [s.code, s.parent]));
  const foldOf = (code) => (TOP_STEPS.includes(code) ? code : parentOf.get(code));
  const setting = (variableKey, earningType, step) =>
    seed.settings.find((s) => s.variableKey === variableKey && s.scope === 'earning_type_step' && s.earningType === earningType && s.step === step)?.value.value ?? null;
  const roleOrder = new Map(ROLES.map(([code], i) => [code, i]));
  const earningOrder = new Map(EARNING_TYPES.map(([code], i) => [code, i]));
  const chains = [...seed.metricMaster.chains]
    .sort((a, b) => roleOrder.get(a.role) - roleOrder.get(b.role) || earningOrder.get(a.earningType) - earningOrder.get(b.earningType))
    .map((chain) => {
      const steps = chain.steps.map((s, i) => ({seq: i + 1, step: s.step, foldsTo: foldOf(s.step), status: s.status,
        conversionBps: setting('conversion_rate', chain.earningType, s.step), hoursX100: setting('step_hours', chain.earningType, s.step)}));
      const folded = {};
      for (const s of steps) folded[s.foldsTo] = (folded[s.foldsTo] ?? 0) + 1;
      return {role: chain.role, roleGroup: ROLES.find(([code]) => code === chain.role)[1], earningType: chain.earningType,
        profitSource: EARNING_TYPES.find(([code]) => code === chain.earningType)[1], steps, folded};
    });
  const roleGroups = {};
  for (const chain of chains) {
    roleGroups[chain.roleGroup] ??= [];
    if (!roleGroups[chain.roleGroup].includes(chain.earningType)) roleGroups[chain.roleGroup].push(chain.earningType);
  }
  const key = (s) => [s.variableKey, s.scope, s.earningType ?? '', s.step ?? ''].join('|');
  const settings = seed.settings.map((s) => ({variableKey: s.variableKey, scope: s.scope, earningType: s.earningType ?? null, step: s.step ?? null,
    value: s.value, status: s.status, versionNo: 1})).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return {
    fictional: true,
    notice: '架空データ。seed.json から build-expected.mjs が作った golden（src を読まない）。個人の額（計画の K2-12）を持たない',
    generator: 'build-expected.mjs',
    seedSha256: createHash('sha256').update(seedText.replace(/\r\n/g, '\n')).digest('hex'),
    metricMaster: {versionNo: 1, stepCount: chains.reduce((n, c) => n + c.steps.length, 0), chains},
    roleGroups,
    detailSteps: seed.steps.map((s) => ({code: s.code, foldsTo: s.parent})),
    settings,
  };
}

export function expectedText() {
  const seedText = readFileSync(SEED_PATH, 'utf8');
  return `${JSON.stringify(buildExpected(JSON.parse(seedText), seedText), null, 2)}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = expectedText();
  if (process.argv.includes('--check')) {
    const current = readFileSync(EXPECTED_PATH, 'utf8').replace(/\r\n/g, '\n');
    if (current !== text) { console.error('expected.json が seed.json から作った golden と違います'); process.exit(1); }
    console.log('expected.json は seed.json から作った golden と同じ');
  } else {
    writeFileSync(EXPECTED_PATH, text);
    console.log(`expected.json を書いた（段 ${JSON.parse(text).metricMaster.stepCount}・設定の行 ${JSON.parse(text).settings.length}）`);
  }
}
