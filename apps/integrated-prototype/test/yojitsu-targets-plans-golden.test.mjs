// 架空の種（test/fixtures/yojitsu/seed.json）の期間・目標・計画・採用の記録・行動の設定を移行 0014 の表に入れ、store の読み取り関数
// （src/revenue/revenue-store.mjs の readTargets・readPlans・readEffectiveSettings）で読んだ値が、golden（expected.json。フェーズ1 #23c）の
// 目標・計画の行・予実の目標と計画の行・行動の上の表と一致することを確かめる（フェーズ1の仕様書 #11 の受け入れ基準）。
// 月の値は年÷12 を整数で均等に割り端数は最後の月（FR-REV-YOJITSU-010）。golden の月の額は丸めない小数（Excel の式）なので、
// 最後の月より前は golden の小数の切り捨て、12か月の合計は年の額と同じことを見る。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import {monthlyAmounts, normalizeTargetInput, periodMonths} from '../src/revenue/yojitsu/yojitsu-model.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/yojitsu/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
const seed = read('seed.json');
const golden = read('expected.json');
const OWNER = 'demo-admin@openingnight.invalid'; // 種の目標・計画の持ち主（行動指標の計画 A-4 の利用者。架空のアドレス）
const EDITOR = 2; // 組織1の編集担当（試作の行）。持ち主でない人

// 種の語 → 表の語
const KIND = {本人: 'self', 会社: 'company'};
const SCOPE = {全体: 'all', 制作の取り分: 'production_share'};
const UNIT = {期間の合計: 'period_total', 毎月: 'monthly'};
const BASIS = {額: 'amount', '人件費×倍率': 'labor_cost_multiple'};
const STATUS = {確認済み: 'confirmed', 監督申告: 'director_reported', 報道値: 'press_reported', 仮置き: 'provisional'};
const STEP = {面談: 'meeting', 提案: 'proposal'};
// 0.3 のような小数の率を、文字のまま bp に読む（浮動小数を掛けない）
const ratioToBps = (ratio) => {
  const [whole, fraction = ''] = String(ratio).split('.');
  assert.ok(/^\d+$/.test(whole) && /^\d{0,4}$/.test(fraction), `率 ${ratio} は bp で表せない`);
  return Number(whole) * 10000 + Number(fraction.padEnd(4, '0'));
};

// 種を入れる。目標・計画の行は架空（fictional）なので状態は仮置き。持ち主は A-4 の利用者（組織1の管理者として足す）
async function load(db) {
  const owner = Number((await db.get("INSERT INTO users(email,display_name) VALUES(?, '架空デモ管理者') RETURNING id", [OWNER])).id);
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(1,?,'admin')", [owner]);
  const by = {createdBy: owner};
  await store.definePeriods(db, 1, seed.設定.期間.map((p, i) => ({yearNo: i + 1, startsOn: p.始め})), by);
  const periods = await store.listPeriods(db, 1);
  const periodId = new Map(periods.map((p) => [`${p.yearNo}年目`, p.id]));
  for (const t of [...seed.目標].sort((a, b) => a.版 - b.版)) {
    assert.equal(t.fictional, true);
    assert.equal(t.owner_user_email, OWNER);
    const n = normalizeTargetInput({periodId: periodId.get(t.期間), previousVersionNo: t.版 - 1, kind: KIND[t.目標の種類], scope: SCOPE[t.稼ぎ方],
      unit: UNIT[t.単位], basisKind: BASIS[t.target_basis], amountYen: t['目標額（円）'], status: 'provisional', decidedOn: t.決めた日,
      decidedBy: t.決めた人, basis: t.根拠, ownerUserId: owner});
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    await store.addTargetVersion(db, 1, n.value, by);
  }
  const earningCode = new Map((await planning.listEarningTypes(db)).map((e) => [e.label, e.code]));
  const made = new Set();
  for (const a of [...seed.plan_adoptions].sort((x, y) => x.adopted_on.localeCompare(y.adopted_on) || x.version_no - y.version_no)) {
    const key = `${a.period}|${a.version_no}`;
    if (made.has(key)) {
      await store.adoptPlanVersion(db, 1, {periodId: periodId.get(a.period), versionNo: a.version_no, adoptedOn: a.adopted_on}, by);
      continue;
    }
    const rows = seed.計画.filter((p) => p.期間 === a.period && p.版 === a.version_no);
    assert.ok(rows.length && rows.every((p) => p.fictional === true && p.owner_user_email === OWNER));
    await store.addPlanVersion(db, 1, {periodId: periodId.get(a.period), previousVersionNo: a.version_no - 1, ownerUserId: owner, status: 'provisional',
      basis: rows[0].根拠, createdOn: rows[0].作った日, adoptedOn: a.adopted_on,
      amounts: rows.map((p) => ({earningType: earningCode.get(p.稼ぎ方), amountYen: p['計画額（円・税別）']}))}, by);
    made.add(key);
  }
  // 行動の上の表（K-19）: 1件あたりの額と2つの率は設定の行。稼ぎ方の既定の売上率は earning_type_rate_versions（制作受託は受託の契約の版の率で、ここには無い）
  for (const r of seed.行動) {
    const earningType = earningCode.get(r.稼ぎ方);
    const status = STATUS[r.状態];
    await store.addSettingVersion(db, 1, {variableKey: 'unit_amount', scope: 'earning_type', earningType, previousVersionNo: 0,
      value: {kind: 'yen', value: r['1件あたりの額（円・税別）']}, status, basis: r['1件あたりの中身']}, by);
    for (const [step, column] of [['面談', '面談→提案の率'], ['提案', '提案→契約の率']]) {
      await store.addSettingVersion(db, 1, {variableKey: 'conversion_rate', scope: 'earning_type_step', earningType, step: STEP[step], previousVersionNo: 0,
        value: {kind: 'bps', value: ratioToBps(r[column])}, status}, by);
    }
  }
  await store.addSettingVersion(db, 1, {variableKey: 'landing_probability', scope: 'all', previousVersionNo: 0,
    value: {kind: 'bps', value: ratioToBps(seed.設定.着地確度)}, status: 'provisional'}, by);
  const earningTypes = await planning.listEarningTypes(db);
  for (const v of seed.vocabulary.earning_types) {
    const type = earningTypes.find((e) => e.label === v.name);
    if (type.rate_source !== 'project') continue;
    await planning.addRevenueRateVersion(db, 1, {earningType: type.code, revenueRateBps: v.default_sales_rate_bps, status: STATUS[v.rate_status], basis: v.rate_basis, createdBy: owner});
  }
  return {owner, periods, earningCode};
}

// 月の値が golden の月の額（年÷12 の小数）と合うか: 最後の月より前は小数の切り捨て、12か月の合計は年の額
function assertMonths(months, annual, goldenMonth, label) {
  assert.equal(months.length, 12, label);
  assert.equal(months.reduce((a, b) => a + b, 0), annual, `${label}: 12か月の合計`);
  assert.ok(Math.abs(goldenMonth * 12 - annual) < 1e-4, `${label}: golden の月の額が年÷12 でない`);
  for (let i = 0; i < 11; i += 1) assert.equal(months[i], Math.floor(goldenMonth), `${label}: ${i + 1}か月目`);
  assert.ok(months[11] - Math.floor(goldenMonth) >= 0 && months[11] - Math.floor(goldenMonth) < 12, `${label}: 最後の月は端数だけ多い`);
}

test('FR-REV-YOJITSU-008 FR-REV-YOJITSU-010 架空の種の目標の版を入れて読むと、golden の目標の行（版・種類・期間・年の額・月の額・有効）と一致する', async (t) => {
  const db = await openTestDb({t});
  const {owner} = await load(db);
  const targets = await store.readTargets(db, 1, {viewerUserId: owner, history: true});
  const expected = golden['目標・計画'].目標;
  assert.equal(targets.length, expected.length);
  for (const g of expected) {
    const row = targets.find((r) => `${r.yearNo}年目` === g.期間 && r.kind === KIND[g.目標の種類] && r.scope === SCOPE[g.稼ぎ方] && r.versionNo === g.版);
    assert.ok(row, `${g.目標ID} が読めない`);
    assert.equal(g.fictional, true);
    assert.equal(g.owner_user_email, OWNER);
    assert.deepEqual([row.unit, row.resolution, row.amountYen, row.effective, row.isOwner], [UNIT[g.単位], 'amount', g.年の額, g.状態 === '有効', true], g.目標ID);
    assertMonths(monthlyAmounts(row.amountYen, row.unit), g.年の額, g.月の額, g.目標ID);
  }
});

test('FR-REV-YOJITSU-011 FR-REV-YOJITSU-012 架空の種の計画の版と採用の記録を入れて読むと、golden の計画の行（版・期間・稼ぎ方・年の額・月の額・有効）と一致する', async (t) => {
  const db = await openTestDb({t});
  const {owner, earningCode} = await load(db);
  const plans = await store.readPlans(db, 1, {viewerUserId: owner, history: true});
  const expected = golden['目標・計画'].計画;
  assert.equal(plans.flatMap((p) => p.amounts).length, expected.length);
  for (const g of expected) {
    const version = plans.find((p) => `${p.yearNo}年目` === g.期間 && p.versionNo === g.版);
    assert.ok(version, `${g.計画ID} の版が読めない`);
    const line = version.amounts.find((a) => a.earningType === earningCode.get(g.稼ぎ方));
    assert.deepEqual([line?.amountYen, version.effective, version.isOwner], [g.年の額, g.状態 === '有効', true], g.計画ID);
    assert.equal(g.fictional, true);
    assert.equal(g.owner_user_email, OWNER);
    assertMonths(monthlyAmounts(line.amountYen, 'period_total'), g.年の額, g.月の額, g.計画ID);
  }
  // 1年目は第2版、2〜5年目は第1版が有効（期間ごとの最新の採用の記録）
  assert.deepEqual(plans.filter((p) => p.effective).map((p) => [p.yearNo, p.versionNo]), [[1, 2], [2, 1], [3, 1], [4, 1], [5, 1]]);
});

test('FR-REV-YOJITSU-009 FR-REV-YOJITSU-010 有効な目標と計画が、golden の予実の目標（本人・会社）と計画（合計・稼ぎ方ごと）の行の期間と月の値に一致する', async (t) => {
  const db = await openTestDb({t});
  const {owner, periods, earningCode} = await load(db);
  const targets = await store.readTargets(db, 1, {viewerUserId: owner});
  const plans = await store.readPlans(db, 1, {viewerUserId: owner});
  const rows = new Map(golden.予実.行.map((r) => [r.鍵, r]));
  const months = golden.月; // 'YYYY-MM' の61か月
  const series = new Map(); // 鍵 → {期間名: 年の額, 月: 'YYYY-MM' → 月の値}
  const put = (key, period, annual) => {
    if (!series.has(key)) series.set(key, {years: {}, months: new Map()});
    const s = series.get(key);
    s.years[`${period.yearNo}年目`] = annual;
    monthlyAmounts(annual, 'period_total').forEach((value, i) => s.months.set(periodMonths(period.startsOn)[i].slice(0, 7), value));
  };
  for (const period of periods) {
    for (const [key, kind] of [['目標本人', 'self'], ['目標会社', 'company']]) {
      const row = targets.find((r) => r.periodId === period.id && r.kind === kind && r.scope === 'all');
      put(key, period, row.amountYen);
    }
    const plan = plans.find((p) => p.periodId === period.id);
    put('計画', period, plan.totalYen);
    for (const name of golden.稼ぎ方) put(`計画/${name}`, period, plan.amounts.find((a) => a.earningType === earningCode.get(name)).amountYen);
  }
  const lastMonths = new Set(periods.map((p) => periodMonths(p.startsOn)[11].slice(0, 7))); // 端数を寄せる各年目の最後の月
  for (const [key, s] of series) {
    const g = rows.get(key);
    assert.ok(g && g.fictional === true, `${key} が golden に無いか fictional の印が無い`);
    for (const [name, annual] of Object.entries(s.years)) assert.equal(annual, g.期間[name], `${key} ${name}`);
    assert.equal(Object.values(s.years).reduce((a, b) => a + b, 0), g.期間['5年通算'], `${key} 5年通算`);
    months.forEach((ym, i) => {
      const value = s.months.get(ym);
      if (g.月[i] === null) { assert.equal(value, undefined, `${key} ${ym}: 期間の外`); return; }
      // 年÷12 の小数（golden）と、整数で割って端数を最後の月に寄せた値の差は 0〜11 円（最後の月より前は小数の切り捨て）
      const diff = value - Math.floor(g.月[i]);
      assert.ok(diff >= 0 && diff < 12, `${key} ${ym}: ${value} と ${g.月[i]}`);
      if (!lastMonths.has(ym)) assert.equal(diff, 0, `${key} ${ym}`);
    });
  }
  // 行動の表の「計画の額」も有効な計画の稼ぎ方ごとの額（#14 が目標件数を逆算する元）
  for (const g of golden.行動.目標件数と実績件数) {
    const plan = plans.find((p) => `${p.yearNo}年目` === g.期間);
    assert.equal(plan.amounts.find((a) => a.earningType === earningCode.get(g.稼ぎ方)).amountYen, g.計画の額, `${g.稼ぎ方} ${g.ステップ} ${g.期間}`);
  }
});

test('FR-REV-YOJITSU-014 FR-REV-YOJITSU-020 K-19 行動の1件あたりの額と2つの率は設定の行から、既定の売上率は earning_type_rate_versions から読め、golden の行動の上の表と一致する', async (t) => {
  const db = await openTestDb({t});
  const {earningCode} = await load(db);
  const settings = await store.readEffectiveSettings(db, 1);
  const rates = new Map((await planning.readEffectiveRevenueRates(db, 1)).map((r) => [r.earning_type, Number(r.revenue_rate_bps)]));
  for (const g of golden.行動.上の表) {
    const code = earningCode.get(g.稼ぎ方);
    const unit = settings.find((s) => s.variableKey === 'unit_amount' && s.earningType === code);
    const rate = (step) => settings.find((s) => s.variableKey === 'conversion_rate' && s.earningType === code && s.step === step);
    assert.deepEqual([unit.value, unit.status], [{kind: 'yen', value: g['1件あたりの額']}, STATUS[g.状態]], g.稼ぎ方);
    assert.deepEqual(rate('meeting').value, {kind: 'bps', value: ratioToBps(g['面談→提案の率'])}, g.稼ぎ方);
    assert.deepEqual(rate('proposal').value, {kind: 'bps', value: ratioToBps(g['提案→契約の率'])}, g.稼ぎ方);
    // 売上率は設定の行に無く、案件の売上率を使う稼ぎ方は earning_type_rate_versions の最新の版（制作受託は受託の契約の版。#10b）
    assert.ok(!settings.some((s) => s.earningType === code && /rate/.test(s.variableKey) && s.variableKey !== 'conversion_rate'));
    if (code !== 'contract_work') assert.equal(rates.get(code), ratioToBps(g.売上率), g.稼ぎ方);
    else assert.equal(rates.has(code), false);
  }
  const landing = settings.find((s) => s.variableKey === 'landing_probability');
  assert.deepEqual([landing.scope, landing.value], ['all', {kind: 'bps', value: ratioToBps(golden.設定.着地確度)}]);
});

test('FR-REV-YOJITSU-006 架空の種で、持ち主でない人には目標の額と第1版を指す期間の計画の額が null で返り、第2版を指す1年目の計画は golden と同じ額が返る', async (t) => {
  const db = await openTestDb({t});
  const {earningCode} = await load(db);
  const targets = await store.readTargets(db, 1, {viewerUserId: EDITOR, history: true});
  assert.equal(targets.length, golden['目標・計画'].目標.length);
  assert.ok(targets.every((r) => r.resolution === 'owner_only' && r.amountYen === null));
  const plans = await store.readPlans(db, 1, {viewerUserId: EDITOR});
  const expectedY1 = golden.予実.行.find((r) => r.鍵 === '計画').期間['1年目'];
  for (const p of plans) {
    if (p.yearNo === 1) {
      assert.deepEqual([p.versionNo, p.visibility, p.totalYen], [2, 'visible', expectedY1]);
      for (const name of golden.稼ぎ方) {
        assert.equal(p.amounts.find((a) => a.earningType === earningCode.get(name)).amountYen, golden.予実.行.find((r) => r.鍵 === `計画/${name}`).期間['1年目']);
      }
    } else {
      assert.deepEqual([p.versionNo, p.visibility, p.totalYen], [1, 'owner_only', null], `${p.yearNo}年目`);
      assert.ok(p.amounts.every((a) => a.amountYen === null));
    }
  }
  const text = JSON.stringify(plans) + JSON.stringify(targets);
  for (const g of golden['目標・計画'].目標) assert.ok(!text.includes(String(g.年の額)), `${g.目標ID} の額が持ち主でない人に出る`);
});
