// シナリオの比較（段A）の画面（src/revenue/scenario/ScenarioCompare.jsx ほか）を、実際の API の応答で文字列に描いて確かめる（JSX は esbuild で変換。DOM は使わない）。
// 応答は、架空の種（scripts/seed-all-demo.mjs の売上・営業基幹・PL・BS・作品マスタ・シナリオの比較の節）を白紙の DB に入れ、POST /api/revenue/scenarios/compare から取る。
// 期待値は応答の値と、計画（会社ルートの plans/2026-10-09-sales-producer-kpi.md の A-3「段A の不変条件」・「出資の回収」）から持ってくる。
// 壊れたら: 画面の KPI・出資の回収が応答とずれる、目標額なしで目標に依る値が出る、差額が負の行が「未達」と出る・赤になる、
// 目標額の入力欄が自動補完される・名前を持つ（ブラウザの保存・フォームの自動入力に残る）・例の額を出す・「…として登録」と書く、data-ready が古い応答に付く
// （入力を変えたあと・送信中・誤りのあとも印が残る）、入口が代表モードの11画面に混ざる・制作担当に見える、目標額が URL・localStorage に出る、
// 上部の要約がカスタムでなく標準の値を出す、シナリオの列に来期へ持ち越す見込と作り手へ渡る額が無い、閲覧用のプレビューで「保存できません」と出る。
import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {openTestDb} from './test-db.mjs';
import {seedAllDemo} from '../scripts/seed-all-demo.mjs';
import {createApp} from '../src/app.mjs';
import {initialForm, withDiscovery, buildCompareRequest, addToCustom, setIn} from '../src/revenue/scenario/scenario-form-model.mjs';
import {REPRESENTATIVE_PAGES, hiddenPagesForRole, menuGroups, navItem, viewModeHiddenPages, slugOf, pageOfSlug} from '../src/shell/nav-model.mjs';
import {SALES_PAGES} from '../src/navigation.mjs';
import {useScenarioCompare} from '../src/revenue/scenario/use-scenario-compare.mjs';
import {isPreviewRefusal} from '../src/revenue/scenario/scenario-view-model.mjs';
import {createApi} from '../src/ui/api-client.mjs';
import {createSnapshotFetch} from '../src/preview/snapshot-client.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(appDir, 'test/fixtures/scenario/compare-request.json'), 'utf8'));
// 目標額は架空の値（種・fixture・golden には持たない）。before で、目標額なしの応答の標準の分布から作り、10%点と90%点のあいだに置く（不規則な桁）。
// 分布の外に置くと、届く確率がどのシナリオでも 100% か 0% になり、確率・候補の前後・逆算の表示の取り違えを試験が見分けられない
let TARGETS;

async function renderer() {
  const {build} = await import('esbuild');
  const result = await build({
    stdin: {
      contents: "import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {ScenarioCompareView, CompareFailure} from './src/revenue/scenario/ScenarioCompare.jsx';\n"
        + "import {CandidatesPanel, ReversePanel, DetailPanel, TornadoPanel, RecoveryTable, KpiCards} from './src/revenue/scenario/ScenarioResults.jsx';\n"
        + 'const panels = {candidates: CandidatesPanel, reverse: ReversePanel, detail: DetailPanel, tornado: TornadoPanel, recovery: RecoveryTable, kpi: KpiCards, failure: CompareFailure};\n'
        + 'export const view = (props) => renderToStaticMarkup(React.createElement(ScenarioCompareView, props));\n'
        + 'export const panel = (name, props) => renderToStaticMarkup(React.createElement(panels[name], props));\n',
      resolveDir: appDir, loader: 'jsx', sourcefile: 'scenario-compare-ui-entry.jsx',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', logLevel: 'silent', loader: {'.css': 'empty'},
  });
  const dir = mkdtempSync(join(tmpdir(), 'on-scenario-ui-'));
  const file = join(dir, 'scenario-ui.cjs');
  writeFileSync(file, result.outputFiles[0].text);
  try { return createRequire(import.meta.url)(file); } finally { rmSync(dir, {recursive: true, force: true}); }
}

let app, cookie, db, opportunityIds, ui;
const post = async (body) => {
  const response = await app.request('/api/revenue/scenarios/compare', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(body)});
  return {status: response.status, body: await response.json()};
};
// 画面の入力（form）→ 要求の本文 → API の応答
const respond = async (form) => {
  const built = buildCompareRequest(form);
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  const {status, body} = await post(built.body);
  assert.equal(status, 200, JSON.stringify(body));
  return body;
};

let form, response, noTargetResponse, noTargetForm;
before(async (t) => {
  db = await openTestDb({t});
  await seedAllDemo(db, {only: ['sales', 'eigyo', 'plbs', 'masters', 'scenario']});
  app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'demo-admin@openingnight.invalid'})});
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  ui = await renderer();
  opportunityIds = new Map((await db.all('SELECT id, name FROM sales_opportunities ORDER BY id')).map((row) => [row.name, row.id]));

  // 画面と同じ手順: 商談を指定しない要求で商談の一覧を読み、既定の指定を作ってから、期間・締めた月・目標額を入れて送る
  const seed = initialForm({currentMonth: '2026-10', fiscalStartMonth: 4});
  const discovery = await respond(seed);
  const discovered = withDiscovery(seed, discovery);
  noTargetForm = {...discovered, period: fixture.request.period, closedMonth: fixture.request.closedMonth, targets: {selfYen: '', companyYen: ''}};
  noTargetResponse = await respond(noTargetForm);
  const {p10Yen, p50Yen} = noTargetResponse.scenarios.standard.quantiles;
  TARGETS = {selfYen: p50Yen + 784321, companyYen: p10Yen + 951987};
  form = {...noTargetForm, targets: {selfYen: String(TARGETS.selfYen), companyYen: String(TARGETS.companyYen)}};
  response = await respond(form);
});

const props = (patch = {}) => ({form, response, hash: response.sourceHash, errors: [], loading: false, error: null, ...patch});
// 要素の data-metric と、その正確な値（data-yen・data-bps）。最初の1件
const metric = (html, name, kind = 'yen') => {
  const match = new RegExp(`data-metric="${name}"(?: data-${kind}="(-?\\d+)")?`).exec(html);
  return match === null ? undefined : match[1] === undefined ? null : Number(match[1]);
};
const count = (html, pattern) => (html.match(pattern) || []).length;
const section = (html, name) => {
  const start = html.indexOf(`data-section="${name}"`);
  assert.ok(start >= 0, name);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
};

test('画面の最初の読み込みで、商談の一覧と作品→稼ぎ方の対応から、商談ごとの指定の既定が入る（作品の稼ぎ方が1つだけの商談だけ）', () => {
  const list = response.opportunityList;
  assert.equal(list.length, 9);
  const specs = form.opportunities;
  assert.deepEqual(specs.map((row) => row.id), list.map((row) => row.id));
  const name = (id) => list.find((row) => row.id === id).name;
  const sourceOf = (n) => specs.find((row) => row.id === opportunityIds.get(Object.entries(fixture.seed.opportunityNames).find(([key]) => Number(key) === n)[1])).source;
  assert.equal(sourceOf(1), 'consignment', name(opportunityIds.get(fixture.seed.opportunityNames['1'])));
  assert.equal(sourceOf(3), 'acquisition');
  assert.equal(sourceOf(5), 'own_investment');
  // 作品が委員会の契約を持つ W4 は委員会、複数の稼ぎ方に重なる作品は指定しない
  assert.ok(specs.every((row) => row.source === '' || ['consignment', 'acquisition', 'own_investment', 'committee'].includes(row.source)));
});

test('KPI 4枚: 期待値・実績＋確度加重・会社の売上・目標との差・達成率・届く確率・期末2か月の入金予定・作り手と権利元へ渡る額が、応答の値そのもの', async () => {
  const html = ui.view(props());
  const s = response.scenarios.standard;
  assert.equal(count(html, /class="sc-kpi"/g), 4);
  for (const id of ['expected', 'reach', 'cash', 'creators']) assert.match(html, new RegExp(`data-kpi="${id}"`));
  assert.equal(metric(html, 'expected'), s.expectedYen);
  assert.equal(metric(html, 'actual-plus-weighted'), s.actualPlusWeightedYen ?? s.actualYen + s.weightedYen);
  assert.equal(metric(html, 'expected-sales'), s.expectedSalesYen);
  // 目標との差・達成率・届く確率は、送った目標額の応答の値
  assert.equal(metric(html, 'gap-self'), s.expectedYen - TARGETS.selfYen);
  assert.equal(metric(html, 'gap-company'), s.expectedYen - TARGETS.companyYen);
  assert.equal(metric(html, 'achievement-self', 'bps'), response.targetView.self.scenarios.standard.achievementBps);
  assert.equal(metric(html, 'reach-self', 'bps'), response.targetView.self.scenarios.standard.reachBps);
  assert.equal(metric(html, 'reach-company', 'bps'), response.targetView.company.scenarios.standard.reachBps);
  assert.equal(metric(html, 'p10'), s.quantiles.p10Yen);
  assert.equal(metric(html, 'p50'), s.quantiles.p50Yen);
  assert.equal(metric(html, 'p90'), s.quantiles.p90Yen);
  assert.equal(metric(html, 'cash-last-two'), s.cash.lastTwoMonthsYen);
  assert.equal(metric(html, 'cash-slip-out'), s.cash.slipOutYen);
  assert.equal(metric(html, 'creators-total'), response.creators.totalYen, '第4枚＝販売委託の権利元の取り分の和');
  assert.equal(response.creators.totalYen, 3600000);
  // 表示は円の桁区切り・符号つきの差
  assert.match(html, new RegExp(`>${s.expectedYen.toLocaleString('ja-JP')}円<`));
  assert.match(html, /本人の目標との差/);
  assert.match(html, /会社の目標との差/);
});

test('試験の目標額は分布の中: 届く確率はどのシナリオでも 0% と 100% のあいだで、行動の候補で動く（崩れると、確率と候補の表示の取り違えを見分けられない）', () => {
  for (const name of ['self', 'company']) {
    const view = response.targetView[name];
    for (const key of ['standard', 'optimistic', 'pessimistic', 'custom']) {
      const bps = view.scenarios[key].reachBps;
      assert.ok(bps > 0 && bps < 10000, `${name} ${key}: ${bps}bp`);
    }
    assert.ok(view.candidates.some((row) => row.reachAfterBps !== row.reachBeforeBps), `${name}: 候補で確率が動く`);
  }
});

test('目標額なしの応答では、差・達成率・届く確率を出さず、入れ方を案内する（期待値と10・50・90%点は出る）', () => {
  const html = ui.view(props({form: noTargetForm, response: noTargetResponse, hash: noTargetResponse.sourceHash}));
  assert.equal(Object.hasOwn(noTargetResponse, 'targetView'), false);
  assert.equal(metric(html, 'gap-self'), undefined);
  assert.equal(metric(html, 'achievement-self', 'bps'), undefined);
  assert.equal(metric(html, 'reach-self', 'bps'), undefined);
  assert.match(html, /目標額を入れると、差と達成率を出します/);
  assert.match(html, /目標額を入れると確率を出します/);
  assert.equal(metric(html, 'expected'), noTargetResponse.scenarios.standard.expectedYen);
  assert.equal(metric(html, 'p50'), noTargetResponse.scenarios.standard.quantiles.p50Yen);
  // 目標額の有無で期待値は変わらない（目標は期待値に依らない）
  assert.equal(noTargetResponse.scenarios.standard.expectedYen, response.scenarios.standard.expectedYen);
});

test('出資の回収: KPI の直下に出資案件ごとの行と合計。差額が負の行は「回収待ち」で、「未達」と書かず赤にもしない。出資額0円の行は回収率を出さない', () => {
  const html = ui.view(props());
  // 位置: KPI 4枚の直下（シナリオの横並びより前）
  const kpi = html.indexOf('class="sc-kpis"');
  const recovery = html.indexOf('data-section="investment-recovery"');
  const columns = html.indexOf('data-section="scenario-columns"');
  assert.ok(kpi >= 0 && kpi < recovery && recovery < columns, 'KPI → 出資の回収 → シナリオの横並び');
  const part = section(html, 'investment-recovery');
  const rows = response.scenarios.standard.investmentRecovery.rows;
  assert.equal(count(part, /<tr data-work=/g), rows.length);
  assert.equal(count(part, /data-row="total"/g), 1);
  const awaiting = rows.filter((row) => row.diffYen !== null && row.diffYen < 0).length;
  const recovered = rows.filter((row) => row.diffYen !== null && row.diffYen >= 0).length;
  assert.ok(awaiting > 0 && recovered > 0, '回収待ちと回収済みの両方の行が出る種');
  assert.equal(count(part, /data-status="awaiting"/g), awaiting + (response.scenarios.standard.investmentRecovery.total.status === 'awaiting' ? 1 : 0));
  assert.equal(count(part, /data-status="recovered"/g), recovered);
  assert.match(part, /回収待ち/);
  // 状態の語（行の印）に「未達」は無い。説明文が「未達ではありません」と書くのはよい
  const statuses = [...part.matchAll(/class="sc-status[^"]*">([^<]*)</g)].map((m) => m[1]);
  assert.ok(statuses.length > 0);
  assert.deepEqual([...new Set(statuses)].sort(), ['回収待ち', '回収済み', '未確定'].filter((label) => statuses.includes(label)).sort());
  assert.ok(!statuses.includes('未達'));
  assert.doesNotMatch(part, /color:\s*(red|var\(--bad\))/, '負の額を赤にしない（スタイルで色を付けない）');
  // 全期間の累計の差額（行ごと）と合計は応答の値
  const total = response.scenarios.standard.investmentRecovery.total;
  assert.equal(metric(part, 'recovery-total-diff'), total.diffYen);
  assert.equal(metric(part, 'recovery-total-investment'), total.investmentYen);
  assert.equal(metric(part, 'recovery-total-revenue'), total.revenueYen);
  assert.equal(metric(part, 'recovery-total-rate', 'bps'), total.recoveryRateBps);
  for (const key of ['standard', 'optimistic', 'pessimistic', 'custom']) {
    assert.equal(metric(part, `recovery-total-projected-${key}`), response.scenarios[key].investmentRecovery.total.projectedDiffYen, `${key} の期末の見込みの差額`);
  }
  // 自社出資の作品（W3）の行: 出資額 4,000,000・収益（作品の入金）2,200,000・差額 -1,800,000・回収率 55%
  const own = rows.find((row) => row.title === '坂の上の写真館（架空）');
  assert.deepEqual([own.investmentYen, own.revenueYen, own.diffYen, own.recoveryRateBps, own.status], [4000000, 2200000, -1800000, 5500, 'awaiting']);
  const ownRow = new RegExp(`<tr data-work="${own.workId}"[^>]*>[\\s\\S]*?</tr>`).exec(part)[0];
  assert.match(ownRow, /回収待ち/);
  assert.equal(metric(ownRow, 'diff'), -1800000);
  assert.equal(metric(ownRow, 'rate', 'bps'), 5500);
  assert.equal(metric(ownRow, 'projected-standard'), own.projectedDiffYen);
  // 出資額 0 円の行（委員会の作品で払込が無い）は回収率を出さない
  const zero = rows.find((row) => row.kind === 'committee' && row.investmentYen === 0);
  if (zero) assert.equal(metric(new RegExp(`<tr data-work="${zero.workId}"[^>]*>[\\s\\S]*?</tr>`).exec(part)[0], 'rate', 'bps'), null);
  // 税込・参考の印と、近似の注記
  assert.match(part, /税込・参考/);
  assert.match(part, /自社出資の出資額は、払込の月を持たないため期間より前に払った扱いで、期間内の出資は0円です/);
  assert.doesNotMatch(part, /期首に引いた/);
  // 収益の基準の印は行ごと（自社出資は税込、製作委員会は計上）。合計の行は両方を足すので「税込と計上の混在」
  assert.match(ownRow, /data-basis="税込">収益 税込</);
  const committeeRow = rows.find((row) => row.kind === 'committee' && row.diffYen !== null);
  assert.match(new RegExp(`<tr data-work="${committeeRow.workId}"[^>]*>[\\s\\S]*?</tr>`).exec(part)[0], /data-basis="計上">収益 計上</);
  assert.match(/<tr data-row="total"[\s\S]*?<\/tr>/.exec(part)[0], /data-basis="税込と計上の混在">収益 税込と計上の混在</);
  // KPI の期待値の注: 自社出資の粗利だけが税込の入金から出ていて、出資額は期間より前に払った扱いで引かない
  assert.match(html.slice(kpi, recovery), /自社出資の粗利だけは、期間内の税込の入金（参考）です。出資額は期間より前に払った扱いで引いていません/);
});

test('注記の帯: 仮置き・税込・未接続・買付候補の面談・保存なしの語と、段A にないものを出す', () => {
  const html = ui.view(props());
  for (const text of ['確度と率は仮置き', '入金は税込・未確定（参考）', '制作受託は未接続（0円で埋めない）', '買付候補の面談は数えていない', '保存・採用なし（要求の本文で計算）']) assert.match(html, new RegExp(text.replace(/[()（）]/g, '.')), text);
  assert.match(html, /段A にないもの（段B で作ります）/);
  assert.match(html, /基準 計上（税抜）固定/);
  // 保存・採用のボタンを出さない
  assert.doesNotMatch(html, />(保存|採用|保存して計画に採用|第\d+版に戻す)</);
});

test('目標額の入力欄: 自動補完を切り、名前（name）を持たない。フォーム全体も自動補完しない', () => {
  const html = ui.view(props());
  const conditions = /<form class="sc-conditions"[\s\S]*?<\/form>/.exec(html)[0];
  assert.match(conditions, /autoComplete="off"|autocomplete="off"/i);
  assert.equal(count(conditions, / name="/g), 0, '入力欄に name を付けない（ブラウザの保存・フォームの自動入力に残らない）');
  const yenInputs = conditions.match(/<input[^>]*placeholder="金額"[^>]*>/g);
  assert.equal(yenInputs.length, 2, '目標（本人）と目標（会社）');
  for (const input of yenInputs) assert.match(input, /autoComplete="off"|autocomplete="off"/i);
  // 画面全体の入力欄（商談ごとの指定・標準の値）も、数の入力は自動補完しない
  const numeric = (html.match(/<input[^>]*type="text"[^>]*>/g) || []);
  assert.ok(numeric.length > 10);
  for (const input of numeric) assert.match(input, /autoComplete="off"|autocomplete="off"/i, input);
  assert.equal(count(html, /<(input|select)[^>]* name="/g), 0, '画面のどの入力欄にも name を付けない');
  // 入れた目標額は入力欄の値としてだけ出る（要素の属性の value）
  assert.match(conditions, new RegExp(`value="${TARGETS.selfYen}"`));
});

test('目標額は URL・ブラウザの保存・フォームの自動入力に載せない（画面の部品のコードに、それらへ書く処理が無い）', () => {
  const dir = join(appDir, 'src/revenue/scenario');
  const files = readdirSync(dir).filter((name) => /^(ScenarioCompare|ScenarioInputs|ScenarioResults)\.jsx$|^scenario-(form|view)-model\.mjs$|^use-scenario-compare\.mjs$/.test(name));
  assert.equal(files.length, 6);
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|location\.(href|search|hash)|URLSearchParams|BroadcastChannel/, `${name}: 画面の外へ値を書く処理`);
    assert.doesNotMatch(text, /registerUnsaved/, `${name}: 未保存の登録（入力欄の内容を外枠へ渡す）`);
    // URL の条件へ書くのはタブの選択（Tabs の urlKey）だけ。setParam で値を書かない
    assert.doesNotMatch(text, /setParam\s*\(/, `${name}`);
  }
  const tabs = readFileSync(join(dir, 'ScenarioResults.jsx'), 'utf8');
  assert.equal((tabs.match(/urlKey=/g) || []).length, 1);
  assert.match(tabs, /urlKey="sctab"/);
});

test('data-ready: 画面が読んだ応答の sourceHash と一致したときだけ付く。印の値は応答の sourceHash', () => {
  const ready = ui.view(props());
  assert.match(ready, new RegExp(`data-source-hash="${response.sourceHash}"`));
  assert.match(ready, new RegExp(`data-ready="${response.sourceHash}"`));
  const notReady = ui.view(props({hash: null, loading: true}));
  assert.match(notReady, new RegExp(`data-source-hash="${response.sourceHash}"`), '表示中の応答の hash は常に出す');
  assert.doesNotMatch(notReady, /data-ready/);
  assert.match(notReady, /aria-busy="true"/);
  assert.match(notReady, /sc-layout is-stale/, '送信中は前の結果を薄く出す');
  assert.match(notReady, /計算しています/);
  assert.doesNotMatch(ui.view(props({hash: null})), /data-ready/);
  // 応答が無い間は結果を出さない（読み込み中）
  const loading = ui.view(props({response: null, hash: null}));
  assert.doesNotMatch(loading, /data-ready|sc-kpis/);
  assert.match(loading, /読み込んでいます/);
  // 入力に誤りがあれば、どこを直すかを出し、結果は前の計算のまま（data-ready なし）
  const invalid = ui.view(props({hash: null, errors: [{field: 'stageProbabilityBps.lead', message: '確度（見込み）は0%以上100%以下の数で入れてください'}]}));
  assert.match(invalid, /入力を確かめてください/);
  assert.match(invalid, /確度（見込み）は0%以上100%以下/);
  assert.doesNotMatch(invalid, /data-ready/);
});

test('サーバーの誤り（権限・入力）は画面の上に出し、再試行を添える。結果があれば前の結果は残す', () => {
  const html = ui.view(props({hash: null, error: Object.assign(new Error('シナリオの比較は財務の画面です（制作担当は見られません）'), {name: 'ApiError', kind: 'forbidden', status: 403})}));
  assert.match(html, /シナリオの比較は財務の画面です（制作担当は見られません）/);
  assert.match(html, /もう一度計算する/);
  assert.match(html, /role="alert"/);
});

test('シナリオの横並び: 標準・楽観・悲観・カスタムの列に同じ項目を出し、標準比と動かした前提を添える。確率は全部の案件で数える旨を書く', () => {
  const html = ui.view(props());
  const part = section(html, 'scenario-columns');
  for (const key of ['standard', 'optimistic', 'pessimistic', 'custom']) assert.match(part, new RegExp(`data-scenario="${key}"`));
  assert.match(part, /標準比/);
  assert.match(part, /窓口の売上の倍率 115%/);
  assert.match(part, /標準と同じ|提案→契約の率 35%/);
  assert.match(part, /確率は全部の案件で数えます/);
  // 列ごとの期待値は応答の値
  for (const key of ['standard', 'optimistic', 'pessimistic', 'custom']) {
    const column = new RegExp(`<article class="sc-col" data-scenario="${key}">[\\s\\S]*?</article>`).exec(part)[0];
    assert.equal(metric(column, 'expected'), response.scenarios[key].expectedYen, key);
    assert.equal(metric(column, 'gap-self'), response.targetView.self.scenarios[key].gapYen, key);
  }
  // 表示するシナリオの切り替え（押している状態を aria-pressed で示す）。1つだけ表示のときはその列を外せない
  const only = ui.view(props({visible: {standard: true, optimistic: false, pessimistic: false, custom: false}}));
  const onlyPart = section(only, 'scenario-columns');
  assert.equal(count(onlyPart, /<article class="sc-col"/g), 1);
  assert.match(onlyPart, /data-cols="1"/);
  assert.match(onlyPart, /aria-pressed="true" disabled=""[^>]*>標準</, '最後の1つは外せない');
});

test('分布のグラフ: シナリオごとの折れ線と目標の縦線を描き、同じ値を「目標に届く確率」の表にも出す（グラフだけに頼らない）', () => {
  const html = ui.view(props());
  const part = section(html, 'distribution');
  assert.equal(count(part, /<polyline /g), 4);
  assert.match(part, /目標（本人）/);
  assert.match(part, /目標（会社）/);
  assert.match(part, /role="img"/);
  for (const key of ['standard', 'optimistic', 'pessimistic', 'custom']) {
    assert.equal(metric(part, `reach-self-${key}`, 'bps'), response.targetView.self.scenarios[key].reachBps);
    assert.equal(metric(part, `reach-company-${key}`, 'bps'), response.targetView.company.scenarios[key].reachBps);
  }
  // 目標額なしでは縦線を描かない
  const none = section(ui.view(props({form: noTargetForm, response: noTargetResponse, hash: noTargetResponse.sourceHash})), 'distribution');
  assert.doesNotMatch(none, /sc-target/);
  assert.match(none, /目標額を入れると出ます/);
});

test('前提の効き・行動の候補・届くには・明細: 応答の値を出し、候補は「カスタムに入れる」。入れた候補は「取り消す」に変わる', () => {
  const tornado = ui.panel('tornado', {response});
  assert.equal(count(tornado, /<li data-key=/g), response.tornado.length);
  assert.match(tornado, /確かめる: /);
  assert.equal(count(tornado, /確かめる: /g), 3, '上位3つに確かめる手段');

  const candidates = ui.panel('candidates', {response, form, onAdd() {}, onRemove() {}, onFocusInputs() {}});
  assert.equal(count(candidates, /data-candidate=/g), response.candidates.length);
  assert.equal(count(candidates, />カスタムに入れる</g), response.candidates.length, 'ボタンの文字（読み上げの名前は別に持つ）');
  assert.doesNotMatch(candidates, />取り消す</);
  assert.match(candidates, /カスタムの入力へ/);
  for (const row of response.targetView.self.candidates) {
    const cell = new RegExp(`<tr data-candidate="${row.source}:${row.step}">[\\s\\S]*?</tr>`).exec(candidates)[0];
    assert.equal(metric(cell, 'candidate-reach-self', 'bps'), row.reachAfterBps);
  }
  // 1件入れた候補だけ「取り消す」（カスタムの件数が標準+1件以上）
  const added = addToCustom(form, 'acquisition', 'meeting', 100);
  const after = ui.panel('candidates', {response, form: added, onAdd() {}, onRemove() {}, onFocusInputs() {}});
  assert.equal(count(after, />取り消す</g), 1);
  assert.match(new RegExp('<tr data-candidate="acquisition:meeting">[\\s\\S]*?</tr>').exec(after)[0], />取り消す</);
  assert.equal(count(after, />カスタムに入れる</g), response.candidates.length - 1);

  const reverse = ui.panel('reverse', {response});
  assert.match(reverse, /data-target="self"/);
  assert.match(reverse, /data-target="company"/);
  assert.match(reverse, /期待値で届く/);
  assert.match(ui.panel('reverse', {response: noTargetResponse}), /目標額を入れると/);

  const detail = ui.panel('detail', {response});
  assert.equal(count(detail, /<tr data-source=/g), 5 + response.actionActuals.bySource.length, '稼ぎ方別の5行と行動の実績の行');
  assert.match(detail, /期待値に入れていない商談/);
  assert.equal(count(detail, /data-opportunity=/g), response.scenarios.standard.opportunities.length);
  assert.match(detail, /<ul class="sc-sub-list" data-list="excluded">/);
  assert.equal(metric(detail, 'contracts-total'), null, '件数の要素はあるが、data-yen（金額）は持たない');
  assert.match(detail, new RegExp(`data-metric="contracts-total">${response.actionActuals.total.contract}件`));
  assert.match(detail, /MG 残（参考・未控除）/);
  assert.match(detail, /需給の曲線の元/);
});

test('右の前提パネル: カスタムの行動と市場の前提のスライダーに、標準と目盛り（悲観・標準・楽観）を出し、換算率は動かさない条件として別に出す', () => {
  const moved = setIn(setIn(form, ['custom', 'assumptions', 'proposalToContractBps'], '35'), ['custom', 'actions', 'consignment:meeting'], '6');
  const html = ui.view(props({form: moved}));
  const custom = /<section class="sc-panel" aria-labelledby="sc-custom-title"[\s\S]*?<\/section>/.exec(html)[0];
  assert.equal(count(custom, /type="range"/g), 3 + 5, '行動3つと市場の前提5つ');
  assert.match(custom, /id="sc-custom-first"/);
  assert.equal(count(custom, /変えた/g), 2);
  assert.match(custom, /悲観 20%／標準 30%／楽観 40%/);
  assert.match(custom, /交渉の条件（動かさない）/);
  assert.match(custom, /販売委託の面談（行動）: 20%/);
  assert.doesNotMatch(custom, /<input[^>]*type="range"[^>]*aria-label="[^"]*換算率/, '換算率のスライダーは無い');
  // 標準に戻す: カスタムが空なら押せない
  assert.match(/<button[^>]*>標準の値に戻す<\/button>/.exec(ui.view(props()))[0], /disabled=""/);
  assert.doesNotMatch(/<button[^>]*>標準の値に戻す<\/button>/.exec(html)[0], /disabled/);
  // 標準の値と商談ごとの指定は折りたたみ（仮置きの印つき）
  assert.match(html, /<details class="sc-panel sc-fold" data-panel="standard">/);
  assert.match(html, /標準の値を直す（仮置き）/);
  assert.match(html, /商談ごとの指定（仮置き）/);
  assert.equal(count(html, /<tr data-opportunity=/g) >= response.opportunityList.length, true);
});

test('入口: 全表示の売上基幹（計上）に出て、代表モードの11画面は増えない。制作担当には出さない。URL の slug で開ける', () => {
  assert.ok(SALES_PAGES.includes('シナリオの比較'));
  assert.equal(REPRESENTATIVE_PAGES.length, 11);
  assert.ok(!REPRESENTATIVE_PAGES.includes('シナリオの比較'));
  assert.ok(viewModeHiddenPages('representative').has('シナリオの比較'), '代表モードのメニューから外れる');
  assert.ok(!viewModeHiddenPages('all').has('シナリオの比較'));
  assert.ok(menuGroups('sales', 'uriage').some((group) => group.items.some((item) => item.page === 'シナリオの比較')));
  assert.ok(hiddenPagesForRole('production').has('シナリオの比較'), '財務の画面。制作担当には出さない');
  assert.ok(!hiddenPagesForRole('admin').has('シナリオの比較'));
  assert.ok(!hiddenPagesForRole('editor').has('シナリオの比較'));
  assert.equal(navItem('シナリオの比較').scope, 'company');
  assert.equal(slugOf('シナリオの比較'), 'scenario-compare');
  assert.equal(pageOfSlug('scenario-compare'), 'シナリオの比較');
});

// ---------- 確かめの指摘の直し（2026-10-10）: 要約・4枚目・表示中のシナリオ・目標額の欄・プレビュー・状態の配線 ----------

const SUMMARY = /<div class="sc-summary"[\s\S]*?<\/div>/;
const columnOf = (html, key) => new RegExp(`<article class="sc-col" data-scenario="${key}">[\\s\\S]*?</article>`).exec(html)[0];

test('上部に固定する要約: カスタムの期待値と目標（本人）に届く確率と、それぞれの標準比が応答の値。標準の値を出さず、目標額なしは案内、会社の目標だけなら会社の確率', async () => {
  // カスタムを動かした応答（標準と同じ値だと、標準とカスタムのどちらを出しても見分けられない）
  const moved = setIn(setIn(form, ['custom', 'assumptions', 'proposalToContractBps'], '35'), ['custom', 'actions', 'consignment:meeting'], '6');
  const movedResponse = await respond(moved);
  const standard = movedResponse.scenarios.standard;
  const custom = movedResponse.scenarios.custom;
  assert.notEqual(custom.expectedYen, standard.expectedYen);
  const html = ui.view(props({form: moved, response: movedResponse, hash: movedResponse.sourceHash}));
  const bar = SUMMARY.exec(html)[0];
  assert.match(bar, /data-summary="custom"/);
  assert.ok(html.indexOf('data-summary="custom"') < html.indexOf('class="sc-kpis"'), '.sc-main の先頭（KPI より前）');
  assert.equal(metric(bar, 'summary-expected'), custom.expectedYen);
  assert.equal(metric(bar, 'summary-expected-delta'), custom.expectedYen - standard.expectedYen);
  const self = movedResponse.targetView.self.scenarios;
  assert.equal(metric(bar, 'summary-reach', 'bps'), self.custom.reachBps);
  assert.equal(metric(bar, 'summary-reach-delta', 'bps'), self.custom.reachBps - self.standard.reachBps);
  assert.match(bar, /本人の目標に届く確率/);
  assert.match(bar, /仮置きの率から/);
  // KPI 4枚は標準の値のまま（要約の id は別。覆わない）
  assert.equal(metric(html.slice(html.indexOf('class="sc-kpis"')), 'expected'), standard.expectedYen);

  const none = ui.view(props({form: noTargetForm, response: noTargetResponse, hash: noTargetResponse.sourceHash}));
  const noneBar = SUMMARY.exec(none)[0];
  assert.equal(metric(noneBar, 'summary-expected'), noTargetResponse.scenarios.custom.expectedYen);
  assert.equal(metric(noneBar, 'summary-reach', 'bps'), undefined);
  assert.match(noneBar, /目標額を入れると出ます/);

  const companyForm = {...form, targets: {selfYen: '', companyYen: String(TARGETS.companyYen)}};
  const companyResponse = await respond(companyForm);
  const companyBar = SUMMARY.exec(ui.view(props({form: companyForm, response: companyResponse, hash: companyResponse.sourceHash})))[0];
  assert.match(companyBar, /会社の目標に届く確率/);
  assert.equal(metric(companyBar, 'summary-reach', 'bps'), companyResponse.targetView.company.scenarios.custom.reachBps);
});

test('要約は画面の上に貼り付く（グリッドの子では貼り付く余地がないので、.sc-main は縦の flex）', () => {
  const css = readFileSync(join(appDir, 'src/revenue/scenario/scenario-compare.css'), 'utf8');
  assert.match(css, /\.sc-summary\{[^}]*position:sticky/);
  assert.match(css, /\.sc-main\{[^}]*display:flex;flex-direction:column/);
});

test('シナリオの列: 入金の枚に来期へ持ち越す粗利の見込（列ごとの値）、4枚目に作り手・権利元へ渡る額（シナリオでは動かない旨）を出し、どの列も同じ4枚', () => {
  const part = section(ui.view(props()), 'scenario-columns');
  const carry = new Set();
  for (const key of ['standard', 'optimistic', 'pessimistic', 'custom']) {
    const column = columnOf(part, key);
    assert.equal(count(column, /class="sc-mini"/g), 4, `${key}: 同じ4枚`);
    for (const id of ['expected', 'reach', 'cash', 'creators']) assert.match(column, new RegExp(`data-kpi="${id}"`), `${key} ${id}`);
    assert.equal(metric(column, 'next-period-profit'), response.scenarios[key].nextPeriodProfitYen, `${key} の来期へ持ち越す粗利の見込`);
    carry.add(response.scenarios[key].nextPeriodProfitYen);
    assert.equal(metric(column, 'creators-total'), response.creators.totalYen, `${key} の作り手・権利元へ渡る額`);
    assert.match(column, /シナリオでは動きません/);
  }
  assert.ok(carry.size > 1, '来期へ持ち越す見込はシナリオごとに変わる値（同じなら、標準の値を全部の列に出しても見分けられない）');
});

test('出資の回収: 期末の見込みの差額の列は表示中のシナリオの数だけ。出資額・収益・差額・回収率の列は切り替えに関わらず出る', () => {
  const all = section(ui.view(props()), 'investment-recovery');
  const heads = (html) => [...html.matchAll(/<th scope="col">(標準|楽観|悲観|カスタム)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads(all), ['標準', '楽観', '悲観', 'カスタム']);
  assert.match(all, /colSpan="4"[^>]*>期末の見込みの差額/);
  assert.match(all, /colSpan="11"/, '案件の見出しの行は 5＋列の数＋2');

  const visible = {standard: true, optimistic: false, pessimistic: false, custom: true};
  const some = section(ui.view(props({visible})), 'investment-recovery');
  assert.deepEqual(heads(some), ['標準', 'カスタム']);
  assert.match(some, /colSpan="2"[^>]*>期末の見込みの差額/);
  assert.match(some, /colSpan="9"/);
  const rows = response.scenarios.standard.investmentRecovery.rows;
  assert.equal(count(some, /data-metric="projected-custom"/g), rows.length);
  assert.equal(count(some, /data-metric="projected-optimistic"/g) + count(some, /data-metric="projected-pessimistic"/g), 0);
  assert.equal(metric(some, 'recovery-total-projected-standard'), response.scenarios.standard.investmentRecovery.total.projectedDiffYen);
  assert.equal(metric(some, 'recovery-total-projected-custom'), response.scenarios.custom.investmentRecovery.total.projectedDiffYen);
  assert.equal(metric(some, 'recovery-total-projected-optimistic'), undefined);
  // 出資額と収益の差額（収益−出資額）と回収率は、表示するシナリオに依らない
  const total = response.scenarios.standard.investmentRecovery.total;
  assert.match(some, /<th scope="col">差額<\/th>/);
  assert.match(some, /<th scope="col">回収率<\/th>/);
  assert.equal(metric(some, 'recovery-total-diff'), total.diffYen);
  assert.equal(metric(some, 'recovery-total-rate', 'bps'), total.recoveryRateBps);
  // 画面全体でも、横並びの切り替えが出資の回収の表に届く
  const only = section(ui.view(props({visible: {standard: true, optimistic: false, pessimistic: false, custom: false}})), 'investment-recovery');
  assert.deepEqual(heads(only), ['標準']);
});

test('目標額の入力欄: 例の額を placeholder に書かず（丸い額の比から人件費の倍率を連想させない）、保存しないので「…として登録」と案内しない', () => {
  const conditions = /<form class="sc-conditions"[\s\S]*?<\/form>/.exec(ui.view(props()))[0];
  const placeholders = [...conditions.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(placeholders.filter((text) => text === '金額').length, 2, '目標（本人）と目標（会社）');
  // 月の欄の例（例: 2026-09）は額ではない。額は、桁区切りの数か5桁以上の数
  for (const text of placeholders) assert.doesNotMatch(text, /\d{1,3}(,\d{3})+|\d{5,}/, `額を書かない: ${text}`);
  // 入れた値が整っていない（下の桁まで不規則な額）ときも、登録の案内は出ない
  assert.equal(form.targets.selfYen, String(TARGETS.selfYen));
  assert.notEqual(TARGETS.selfYen % 1000, 0);
  assert.doesNotMatch(conditions, /として登録/);
});

test('閲覧用のプレビュー: 計算の POST が断られたら、保存の失敗とは別の文で知らせ、再試行は添えない。権限の 403 などは今までどおり', async () => {
  // プレビューの実物の流れ（記録だけで動く fetch → api-client → 画面の誤り）
  const request = createApi({fetchImpl: createSnapshotFetch({responses: new Map(), base: 'http://localhost/'})});
  const refused = await request('/revenue/scenarios/compare', {method: 'POST', body: {}}).then(() => null, (error) => error);
  assert.ok(refused, 'プレビューは POST を断る');
  assert.equal(isPreviewRefusal(refused), true);
  const panel = ui.panel('failure', {error: refused, onRetry() {}, retryLabel: 'もう一度計算する'});
  const full = ui.view(props({hash: null, error: refused}));
  for (const html of [panel, full]) {
    assert.match(html, /閲覧用のプレビューでは、この画面は計算できません/);
    assert.doesNotMatch(html, /プレビューでは保存できません/);
    assert.doesNotMatch(html, /もう一度計算する/);
  }
  assert.doesNotMatch(panel, /role="alert"/);
  // 最初の読み込みの誤りも同じ文（ScenarioCompare の bootError は同じ部品で描く）
  const forbidden = Object.assign(new Error('シナリオの比較は財務の画面です'), {name: 'ApiError', kind: 'forbidden', status: 403, body: {ok: false, error: 'シナリオの比較は財務の画面です'}});
  assert.equal(isPreviewRefusal(forbidden), false);
  assert.equal(isPreviewRefusal({status: 500, body: {preview: 'read-only'}}), false);
  assert.equal(isPreviewRefusal(null), false);
  const ordinary = ui.panel('failure', {error: forbidden, onRetry() {}, retryLabel: 'もう一度計算する'});
  assert.match(ordinary, /シナリオの比較は財務の画面です/);
  assert.match(ordinary, /role="alert"/);
});

// ---- 状態の配線（use-scenario-compare.mjs）: 本物の React で入力を変えて、data-ready の印が付く・外れる条件を確かめる ----
// 判定の関数（readyHash）は scenario-view-model.test.mjs。ここは、応答を描いたあとに hash を覚える配線と、入力が変わったあと・送信中・誤りのあいだ印を外す配線。
// 壊れたら（例: hash を shown.response.sourceHash にそのまま渡す）: 入力を変えて新しい応答が届くまでのあいだも、古い応答の印が付いたままになる。

const COMPARE = '/revenue/scenarios/compare';
const wait = (ms = 10) => new Promise((done) => setTimeout(done, ms));
async function waitFor(check, what, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await wait(10);
  }
  assert.fail(`待っても起きなかった: ${what}`);
}

// 本物の API を呼び、計算の応答だけ止める・失敗させる request
function gatedRequest() {
  const gate = {hold: false, fail: null, waiters: [], sent: 0, release() { for (const done of gate.waiters.splice(0)) done(); }};
  const request = async (path, {method = 'GET', body, signal} = {}) => {
    if (path === COMPARE) {
      gate.sent += 1;
      if (gate.hold) await new Promise((done) => { gate.waiters.push(done); });
      if (gate.fail) throw gate.fail;
    }
    const response = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal});
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), {name: 'ApiError', kind: 'server', status: response.status, body: data});
    return data;
  };
  return {gate, request};
}

async function mountHook(request) {
  globalThis.window = {event: undefined, addEventListener() {}, removeEventListener() {}, HTMLIFrameElement: class {}};
  const React = (await import('react')).default;
  const {createRoot} = await import('react-dom/client');
  const out = {};
  function Harness() {
    out.state = useScenarioCompare({request, debounceMs: 30});
    return null;
  }
  const doc = {nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null};
  const container = {nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc, addEventListener() {}, removeEventListener() {}, set textContent(value) {}};
  const root = createRoot(container);
  root.render(React.createElement(Harness));
  return {out, unmount: async () => { root.unmount(); await wait(50); delete globalThis.window; }};
}

test('data-ready の配線: 応答を描いたあとに付き、入力を変えると新しい応答が届くまで外れ、誤りのあいだも付かず、入力が直ると新しい応答の hash で付く', async () => {
  const {gate, request} = gatedRequest();
  const h = await mountHook(request);
  try {
    await waitFor(() => h.out.state?.hash, '最初の応答の印');
    const first = h.out.state.shown.response.sourceHash;
    assert.equal(h.out.state.hash, first, '印の値は表示中の応答の sourceHash');
    assert.equal(h.out.state.loading, false);
    assert.equal(h.out.state.error, null);

    // 入力を変える（計算の応答は止めておく）。表示中の応答は前のままでも、今の入力のものではないので印は付けない
    gate.hold = true;
    h.out.state.update((f) => setIn(f, ['targets', 'selfYen'], String(TARGETS.selfYen)));
    await waitFor(() => h.out.state.loading, '送信中');
    assert.equal(h.out.state.shown.response.sourceHash, first, '表示中の応答はまだ前のもの');
    assert.equal(h.out.state.hash, null, '入力が変わって送信中のあいだは印を外す');
    gate.hold = false;
    gate.release();
    await waitFor(() => h.out.state.hash, '新しい応答の印');
    const second = h.out.state.shown.response.sourceHash;
    assert.notEqual(second, first, '目標額が入ると応答（sourceHash）が変わる');
    assert.equal(h.out.state.hash, second, '印の値は新しい応答の sourceHash');
    assert.equal(h.out.state.shown.response.targetView.self.targetYen, TARGETS.selfYen);

    // 計算の誤り: 前の結果は残るが、印は付かない。もう一度計算すると付く
    gate.fail = new Error('計算できませんでした');
    h.out.state.update((f) => setIn(f, ['targets', 'selfYen'], String(TARGETS.selfYen + 1)));
    await waitFor(() => h.out.state.error, '計算の誤り');
    assert.equal(h.out.state.shown.response.sourceHash, second, '前の結果は残す');
    assert.equal(h.out.state.hash, null, '誤りのあいだは印を外す');
    assert.equal(h.out.state.loading, false);
    gate.fail = null;
    h.out.state.retryCompare();
    await waitFor(() => h.out.state.hash, '計算し直したあとの印');
    assert.equal(h.out.state.error, null);
    assert.equal(h.out.state.shown.response.targetView.self.targetYen, TARGETS.selfYen + 1);

    // 入力の誤り（本文を作れない）: 送らず、印を外す。直すと新しい応答で付く
    const sent = gate.sent;
    h.out.state.update((f) => setIn(f, ['targets', 'selfYen'], 'あ'));
    await waitFor(() => h.out.state.errors.length > 0, '入力の誤り');
    assert.equal(h.out.state.hash, null);
    assert.equal(h.out.state.loading, false);
    await wait(120);
    assert.equal(gate.sent, sent, '誤りのある入力は送らない');
    h.out.state.update((f) => setIn(f, ['targets', 'selfYen'], String(TARGETS.selfYen)));
    await waitFor(() => h.out.state.hash, '入力が直ったあとの印');
    assert.equal(h.out.state.hash, h.out.state.shown.response.sourceHash);

    // 表示するシナリオの切り替え（応答のあるシナリオだけが対象）
    assert.deepEqual(h.out.state.visible, {standard: true, optimistic: true, pessimistic: true, custom: true});
    h.out.state.toggle('optimistic');
    await waitFor(() => h.out.state.visible.optimistic === false, '切り替え');
    assert.equal(h.out.state.visible.standard, true);
  } finally { await h.unmount(); }
});
