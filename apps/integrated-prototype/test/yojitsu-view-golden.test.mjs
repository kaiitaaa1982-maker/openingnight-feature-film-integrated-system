// 予実の4段の受け口（GET /api/revenue/yojitsu。src/revenue/yojitsu/yojitsu-routes.mjs）に架空の種と入金の確認の請求・入金を入れ、応答が golden
// （test/fixtures/yojitsu/expected.json の「予実の整数」。種から独立に計算した整数の期待値で、Excel の値と端数の決まりの範囲で合うことは golden.py と
// yojitsu-golden-fixture.test.mjs が確かめる）と不一致0であることを確かめる（フェーズ1の仕様書 #14 の受け入れ基準: 目標・行動の件数と達成率・計画・
// 着地・確度加重・実績・達成率・進み）。あわせて、入金ベース固定（accrual は 400）、SQL ≤ 10、目標に由来する値を本人以外に返さないこと、
// 値の無いセルが 0 でなく null であることを確かめる。期待値の出どころは要件 FR-REV-YOJITSU-002・006・007・016・017・028・033・038・042 と golden。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {recordStageChange} from '../src/planning/planning-store.mjs';
import {addForecastVersionWithUnusedLine, loadYojitsuSeed, yojitsuGolden, yojitsuSeed, SEED_OWNER, STEP_CODE} from './yojitsu-view-fixture.mjs';

const golden = yojitsuGolden();
const ints = golden.予実の整数;

// golden の行の鍵 → 応答の行の鍵
function apiKey(key, earningCode) {
  const [head, tail] = key.split('/');
  const fixed = {目標本人: 'target_self', 目標会社: 'target_company', 計画: 'plan', 率計画: 'plan_rate', 着地: 'landing', 率着計: 'landing_progress', 加重: 'weighted',
    実績: 'actual', 率実計: 'actual_progress', 率実績: 'actual_rate', 入金: 'inflow', 不明入金: 'inflow_unlinked'};
  if (!tail) return fixed[head];
  if (head === '行動目標') return `action_target:${STEP_CODE[tail]}`;
  if (head === '行動実績') return `action_actual:${STEP_CODE[tail]}`;
  if (head === '行動率') return `action_rate:${STEP_CODE[tail]}`;
  return `${fixed[head]}:${earningCode.get(tail)}`;
}

// DB の入口の呼び出しを数える（all・get・run は1本、batch・readBatch は文の数）
function countingDb(db) {
  const counter = {n: 0};
  const proxy = new Proxy(db, {get(target, prop) {
    const value = target[prop];
    if (typeof value !== 'function') return value;
    if (['all', 'get', 'run'].includes(prop)) return (...args) => { counter.n += 1; return value.apply(target, args); };
    if (['batch', 'readBatch'].includes(prop)) return (statements, ...rest) => { counter.n += statements.length; return value.call(target, statements, ...rest); };
    return value.bind(target);
  }});
  return {db: proxy, counter};
}

async function setup(t) {
  const raw = await openTestDb({t});
  const seeded = await loadYojitsuSeed(raw);
  const {db, counter} = countingDb(raw);
  const app = createApp({db, mode: 'local'});
  async function as(email) {
    const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(login.status, 200, email);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return async (path) => {
      const before = counter.n;
      const res = await app.request(path, {headers: {cookie}});
      return {status: res.status, body: await res.json(), sql: counter.n - before};
    };
  }
  return {raw, seeded, as};
}

test('FR-REV-YOJITSU-038 FR-REV-YOJITSU-042 FR-REV-YOJITSU-007 FR-REV-YOJITSU-013 FR-REV-YOJITSU-016 FR-REV-YOJITSU-017 FR-REV-YOJITSU-028 FR-REV-YOJITSU-031 FR-REV-YOJITSU-032 FR-REV-YOJITSU-033 架空の種で予実の4段を開くと golden の予実の整数と不一致0で、入金ベース固定・SQL は10本以内', async (t) => {
  const {seeded, raw, as} = await setup(t);
  const owner = await as(SEED_OWNER);
  const baseline = (await owner('/api/session')).sql; // 認証（セッションと所属）の文
  const res = await owner('/api/revenue/yojitsu');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const view = res.body;
  // 要件は10本以内（N+1 無し）。いまは10本（読み取りの一括の9文と目標の読み取り関数の1文）で、減らす直しでは落ちない。0本は数え方の誤り
  const sql = res.sql - baseline;
  assert.ok(sql >= 1 && sql <= 10, `予実の受け口の SQL（認証を除く）が ${sql} 本（10本以内。いまの形は10本）`);
  assert.deepEqual([view.basis, view.basisLabel, view.taxLabel], ['cash', '入金ベース固定', '税別']);
  assert.match(view.sourceHash, /^[0-9a-f]{64}$/);
  // データの時点は読んだ入金の最後の入金日（種の入金は 2026-11 の自動で一致した入金）
  const lastReceived = (await raw.get('SELECT MAX(received_on) AS d FROM billing_receipts WHERE org_id=1')).d;
  assert.deepEqual([view.dataAsOf.label, view.dataAsOf.at], ['最後の入金', lastReceived]);
  assert.ok(lastReceived.startsWith('2026-11'));
  assert.deepEqual(view.months, ints.月.map((m) => `${m}-01`));
  assert.deepEqual(view.periods.map((p) => `${p.yearNo}年目`), ints.期間);
  assert.deepEqual(view.conditions.find((c) => c.key === 'scenario').value, 'good');
  assert.deepEqual(view.checks.filter((c) => !c.ok), []);
  // 4段と稼ぎ方ごとの行: 月・1〜5年目・5年通算が golden と同じ（値の無いセルは null で、0 で埋めていない）
  const rows = new Map(view.rows.map((r) => [r.key, r]));
  let nullCells = 0;
  for (const g of ints.行) {
    const key = apiKey(g.鍵, seeded.earningCode);
    const row = rows.get(key);
    assert.ok(row, `${g.鍵}（${key}）が応答に無い`);
    assert.deepEqual(row.months, g.月, `${g.鍵} の月`);
    assert.deepEqual(row.periods, g.期間, `${g.鍵} の期間`);
    assert.equal(row.total, g.通算, `${g.鍵} の通算`);
    assert.deepEqual(row.hiddenYears, [], `${g.鍵}: 持ち主には隠さない`);
    nullCells += [...row.months, ...row.periods].filter((v) => v === null).length;
  }
  assert.ok(nullCells > 0, '値の無いセルが null で返る');
  assert.equal(rows.get('target_self').unit, 'yen');
  assert.equal(rows.get('action_target:meeting').monthUnit, 'count_x100');
  // 行動の表（稼ぎ方×ステップ×期間）と行動の上の表
  const types = new Map(view.action.earningTypes.map((e) => [e.earningType, e]));
  for (const g of ints.行動) {
    const e = types.get(seeded.earningCode.get(g.稼ぎ方));
    const p = e.periods.find((x) => `${x.yearNo}年目` === g.期間);
    const step = STEP_CODE[g.ステップ];
    assert.deepEqual([p.planYen, p.targets[step], p.actuals[step], p.rates[step]], [g.計画の額, g.目標件数, g.実績件数, g.達成率bp], `${g.稼ぎ方} ${g.ステップ} ${g.期間}`);
  }
  for (const g of ints.行動の上の表) {
    const e = types.get(seeded.earningCode.get(g.稼ぎ方));
    assert.deepEqual([e.unitAmountYen, e.revenueRateBps, e.unitRevenueYen, e.toProposalBps, e.toContractBps],
      [g['1件あたりの額'], g.売上率bp, g['1件の売上'], g['面談→提案bp'], g['提案→契約bp']], g.稼ぎ方);
    assert.equal(e.provisional, true, `${g.稼ぎ方}: 仮置きの率`);
  }
  assert.ok(view.notes.some((n) => n.code === 'basis_cash_fixed') && view.notes.some((n) => n.code === 'provisional'));
  // 入金は全部が請求どおり（自動で一致した119件）なので未確定は無く、売上率の決まらない案件も無い
  assert.equal(seeded.receipts.count, 119);
  assert.ok(rows.get('inflow_unsettled').months.every((v) => v === null) && rows.get('inflow_unrated').months.every((v) => v === null));
  assert.ok(!view.notes.some((n) => ['unrated_projects', 'no_stage_projects', 'unsettled_receipts', 'scenario_unset', 'landing_probability_unset'].includes(n.code)));
  // 同じ入力で同じ hash。cash を付けても同じ応答
  const again = await owner('/api/revenue/yojitsu?basis=cash');
  assert.equal(again.status, 200);
  assert.equal(again.body.sourceHash, view.sourceHash);
  // 入金を1件取り消すと、取消日の月に負の額で入り、hash が変わる
  const receipt = await raw.get("SELECT r.id,r.received_on FROM billing_receipts r WHERE r.org_id=1 ORDER BY r.id LIMIT 1");
  await raw.run("INSERT INTO billing_receipt_reversals(org_id,receipt_id,reversed_on,reason,created_by) VALUES(1,?,'2026-12-03','架空の取消',?)", [receipt.id, seeded.owner]);
  const reversed = await owner('/api/revenue/yojitsu');
  const actualDec = reversed.body.rows.find((r) => r.key === 'actual').months[2];
  assert.ok(actualDec < 0, `取消の月（2026-12）の実績は負: ${actualDec}`);
  assert.equal(reversed.body.dataAsOf.at, '2026-12-03', 'データの時点は取消日も見る');
  assert.notEqual(reversed.body.sourceHash, view.sourceHash);
});

test('FR-REV-YOJITSU-002 FR-REV-YOJITSU-005 予実の受け口は basis を受けず、accrual（cash 以外）を受けたら 400 で、制作担当は案件への所属が edit でも 403', async (t) => {
  const {raw, seeded, as} = await setup(t);
  const owner = await as(SEED_OWNER);
  for (const q of ['accrual', 'ACCRUAL', 'both', '']) {
    const res = await owner(`/api/revenue/yojitsu?basis=${q}`);
    assert.equal(res.status, 400, q);
    assert.match(res.body.error, /入金ベース固定/);
  }
  const production = await as('production@openingnight.invalid');
  assert.equal((await production('/api/revenue/yojitsu')).status, 403);
  // 役割が制作担当なのに案件への所属が edit（役割と所属の整合しないデータ）でも、財務の権限の案件の有無でなく役割で断る
  const productionUser = "(SELECT id FROM users WHERE email='production@openingnight.invalid')";
  await raw.run(`UPDATE project_memberships SET permission='edit' WHERE org_id=1 AND project_id=1 AND user_id=${productionUser}`);
  await raw.run(`INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,${productionUser},'edit')`, [seeded.projectId.get('YJ-P01')]);
  const withEdit = await production('/api/revenue/yojitsu');
  assert.equal(withEdit.status, 403);
  assert.match(withEdit.body.error, /制作担当/);
  assert.equal(withEdit.body.rows, undefined);
});

test('FR-REV-YOJITSU-028 有効な最新の版にある「予測に使う＝いいえ」の行は、着地予測にも確度加重予測にも入らない', async (t) => {
  const {raw, seeded, as} = await setup(t);
  const owner = await as(SEED_OWNER);
  const pick = (body) => Object.fromEntries(['landing', 'weighted'].map((key) => {
    const row = body.rows.find((r) => r.key === key);
    return [key, [row.months, row.periods, row.total]];
  }));
  const before = await owner('/api/revenue/yojitsu');
  assert.equal(before.status, 200);
  // 着地に入る案件 YJ-P02（自社出資・契約済み）の版の行を写し、採用するシナリオ good・売上の元の区分「流通売上」・4段の月の中に「予測に使う＝いいえ」の行を足す
  const month = before.body.months[3];
  assert.equal(month, '2027-01-01');
  const line = {scenario: 'good', month, categoryId: seeded.categoryId.get('流通売上'), item: '架空の除外した流通の行', counterparty: null, amountYen: 7777777, status: 'provisional'};
  await addForecastVersionWithUnusedLine(raw, {projectId: seeded.projectId.get('YJ-P02'), owner: seeded.owner, line});
  const after = await owner('/api/revenue/yojitsu');
  assert.equal(after.status, 200);
  assert.deepEqual(pick(after.body), pick(before.body));
});

test('FR-REV-YOJITSU-019 FR-REV-YOJITSU-028 段階を変えた案件は最新の段階の確度で数え、見送りにした案件は着地予測と確度加重予測から外れる', async (t) => {
  const {raw, seeded, as} = await setup(t);
  const owner = await as(SEED_OWNER);
  const before = await owner('/api/revenue/yojitsu');
  assert.equal(before.status, 200);
  // 期待値は種から: 案件 YJ-P01（自社出資・売上率 100%・契約済み＝確度 100%）の有効な版（作った日の最も新しい版）の、採用するシナリオか単一で、
  // 売上の元の区分の、予測に使う行のうち4段の月の行の額の和。売上率も確度も 100% なので、この和がそのまま着地予測と確度加重予測に入っている
  const seed = yojitsuSeed();
  const project = seed.案件.find((p) => p.案件コード === 'YJ-P01');
  assert.deepEqual([project.段階, project.稼ぎ方, project.rate_bps], ['契約済み', '自社出資', 10000]);
  const rows = seed.予測.filter((f) => f.案件コード === 'YJ-P01');
  const latest = rows.reduce((on, f) => (f.作った日 > on ? f.作った日 : on), '');
  const revenue = new Set(seed.vocabulary.kubun.filter((k) => k.direction === '入金' && k.sales_source === 'はい').map((k) => k.name));
  const months = new Set(before.body.months);
  const p01Yen = rows.filter((f) => f.作った日 === latest && [seed.設定.採用シナリオ, '単一'].includes(f.シナリオ) && revenue.has(f.区分) && f.予測に使う === 'はい'
    && months.has(f.月)).reduce((sum, f) => sum + f['金額（円・税別）'], 0);
  assert.ok(p01Yen > 0);
  // 段階を 契約済み→見送り（確度 0）へ1回変える。段階の履歴は2行になり、案件の確度は最新の行の 0
  await recordStageChange(raw, 1, {projectId: seeded.projectId.get('YJ-P01'), stageCode: 'declined', previousStageCode: 'contracted', enteredOn: '2026-11-24',
    evidence: null, reason: '架空の見送りの理由', createdBy: seeded.owner});
  const after = await owner('/api/revenue/yojitsu');
  assert.equal(after.status, 200);
  const total = (body, key) => body.rows.find((r) => r.key === key).total;
  assert.deepEqual([total(after.body, 'landing'), total(after.body, 'weighted')], [total(before.body, 'landing') - p01Yen, total(before.body, 'weighted') - p01Yen]);
});

test('FR-REV-YOJITSU-006 FR-REV-YOJITSU-038 FR-REV-YOJITSU-037 持ち主でない管理者には、目標と目標に由来する値、第1版の計画とそれに由来する値が項目を残して null で返り、ほかは golden と同じ', async (t) => {
  const {seeded, as} = await setup(t);
  const admin = await as('admin@openingnight.invalid'); // 組織1の管理者（試作の行）。目標・計画の持ち主ではない
  const res = await admin('/api/revenue/yojitsu');
  assert.equal(res.status, 200);
  const rows = new Map(res.body.rows.map((r) => [r.key, r]));
  const allNull = (row) => [...row.months, ...row.periods, row.total].every((v) => v === null);
  // 目標（本人・会社）と、目標で割る比（計画の達成率・実績の達成率）は全部 null
  for (const key of ['target_self', 'target_company', 'plan_rate', 'actual_rate']) {
    assert.ok(allNull(rows.get(key)), key);
    assert.deepEqual(rows.get(key).hiddenYears, [1, 2, 3, 4, 5], key);
  }
  // 計画: 1年目は第2版（見える）、2〜5年目は第1版（本人だけ）。進み・行動の目標件数と達成率も同じ年目が null
  const g = new Map(ints.行.map((r) => [apiKey(r.鍵, seeded.earningCode), r]));
  const planDerived = ['plan', 'landing_progress', 'actual_progress', ...['meeting', 'proposal', 'contract'].flatMap((s) => [`action_target:${s}`, `action_rate:${s}`]),
    ...[...seeded.earningCode.values()].flatMap((e) => [`plan:${e}`, `actual_progress:${e}`])];
  for (const key of planDerived) {
    const row = rows.get(key);
    const want = g.get(key);
    assert.deepEqual(row.hiddenYears, [2, 3, 4, 5], key);
    assert.deepEqual(row.periods, [want.期間[0], null, null, null, null], key);
    assert.deepEqual(row.months, [...want.月.slice(0, 12), ...Array(48).fill(null)], key);
    assert.equal(row.total, null, `${key}: 通算は隠した年目を含むので null`);
  }
  // 実績・着地・確度加重・入金・行動の実績件数は本人以外にも見え、golden と同じ
  for (const key of ['landing', 'weighted', 'actual', 'inflow', 'action_actual:meeting', 'action_actual:proposal', 'action_actual:contract',
    ...[...seeded.earningCode.values()].flatMap((e) => [`landing:${e}`, `actual:${e}`])]) {
    assert.deepEqual([rows.get(key).months, rows.get(key).periods, rows.get(key).total], [g.get(key).月, g.get(key).期間, g.get(key).通算], key);
  }
  // 行動の表も第1版の年目は計画の額・目標件数・達成率が null（実績件数は見える）
  for (const e of res.body.action.earningTypes) {
    for (const p of e.periods.filter((x) => x.yearNo > 1)) {
      assert.deepEqual([p.hidden, p.planYen, Object.values(p.targets).every((v) => v === null), Object.values(p.rates).every((v) => v === null)], [true, null, true, true]);
    }
  }
  assert.ok(res.body.notes.some((n) => n.code === 'owner_only'));
  // 応答のどこにも、目標の額・月の額・第1版の計画の額が無い
  const text = JSON.stringify(res.body);
  const secret = [...['目標本人', '目標会社'].flatMap((k) => [...g.get(apiKey(k, seeded.earningCode)).期間, g.get(apiKey(k, seeded.earningCode)).月[0]]),
    ...g.get('plan').期間.slice(1), ...[...seeded.earningCode.values()].flatMap((e) => g.get(`plan:${e}`).期間.slice(1))];
  for (const v of secret) assert.ok(!new RegExp(`[^0-9]${v}[^0-9]`).test(text), `${v} が持ち主でない人に出る`);
  // 活動記録の行の中身（相手・したこと・成果物・次の一手）は記録した本人にだけ返す決まりで、4段は件数だけを返す（記録した人でない管理者にも中身が出ない）
  const seedActivities = yojitsuSeed().活動記録;
  for (const a of seedActivities) for (const v of [a.相手, a.したこと, a.成果物, a.次の一手].filter(Boolean)) assert.ok(!text.includes(v), `活動記録の中身「${v}」が出る`);
  // 持ち主と持ち主でない人の hash は違う（応答が違う）
  const owner = await as(SEED_OWNER);
  assert.notEqual((await owner('/api/revenue/yojitsu')).body.sourceHash, res.body.sourceHash);
});

test('FR-REV-YOJITSU-005 編集担当は財務の権限（所属が edit）のある案件の予測・入金・活動記録だけで4段を作り、権限の無い編集担当と別の組織には出さない', async (t) => {
  const {raw, seeded, as} = await setup(t);
  const editor = await as('editor@openingnight.invalid'); // 組織1の編集担当（試作の行）。試作の案件1だけが edit
  const none = await editor('/api/revenue/yojitsu');
  assert.equal(none.status, 200, '試作の案件1の edit があるので開ける（種の案件は見えない）');
  const rowsOf = (body) => new Map(body.rows.map((r) => [r.key, r]));
  assert.ok(['landing', 'weighted', 'actual', 'inflow', 'action_actual:meeting'].every((key) => rowsOf(none.body).get(key).months.every((v) => v === null)));
  // 自社出資の案件 YJ-P01 にだけ edit を付けると、その案件の入金だけが実績に入る
  const p01 = seeded.projectId.get('YJ-P01');
  await raw.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,2,'edit')", [p01]);
  const one = await editor('/api/revenue/yojitsu');
  const inflow = rowsOf(one.body).get('inflow');
  const want = (await raw.all(`SELECT SUM(l.amount_ex_tax) AS n FROM billing_receipt_allocations a JOIN billing_invoice_lines l ON l.org_id=a.org_id AND l.invoice_id=a.invoice_id
    WHERE a.org_id=1 AND l.project_id=?`, [p01]))[0].n;
  assert.equal(inflow.total, Number(want));
  assert.equal(rowsOf(one.body).get('actual').total, Number(want), '自社出資（売上率 100%）の実績は入金と同じ');
  assert.equal(one.body.conditions.find((c) => c.key === 'projectCount').value, 2);
  // 所属が production だけの編集担当は財務の権限の案件が無いので 403
  await raw.run("INSERT INTO users(id,email,display_name) VALUES(9,'yj-editor@openingnight.invalid','架空の編集担当（予実）')");
  await raw.run("INSERT INTO memberships(org_id,user_id,role) VALUES(1,9,'editor')");
  await raw.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,9,'production')", [p01]);
  const viewer = await as('yj-editor@openingnight.invalid');
  assert.equal((await viewer('/api/revenue/yojitsu')).status, 403);
  // 別の組織の管理者には、組織1の目標・計画・入金が出ない（組織2には期間も無い）
  const outsider = await as('outsider@other.invalid');
  const other = await outsider('/api/revenue/yojitsu');
  assert.equal(other.status, 200);
  assert.deepEqual([other.body.months, other.body.periods, other.body.rows.find((r) => r.key === 'actual').total], [[], [], null]);
});
