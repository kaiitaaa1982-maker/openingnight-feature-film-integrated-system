// 香盤のデモへの入口とデモ資料の出し分け（WP1-A・B9）。
// ・GET /api/session/org-features は、自分の有効な所属の範囲だけで「香盤のデモがある組織」「売上集計シートを採用済みの組織」を返し、
//   返すのは組織の id と名前だけ（他の組織の作品・列の中身は返さない）。所属していない組織・見られない案件の作品は出さない
// ・今の組織・別の組織・どこにも無い のときの入口、組織を切り替えたあとの行き先、URL の作品が今の組織に無いときの知らせ
// ・デモ資料は今の組織に合うサンプルの組を先に出し、数字のIDの正常取込CSVは IDが正しい組織でだけ出す
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {
  KOUBAN_DEMO_CODE, KOUBAN_DEMO_DESTINATION, koubanDemoPlace, destinationAfterOrgChange, orderedSampleSets, fixtureIdsValid, scriptToOpen, SAMPLE_SETS,
  koubanPlaceNote, scriptButtonState, showKoubanDemoEntry, afterOrgChangeOptions,
} from '../src/demo-guide.mjs';
import {resolveWork, missingWorkNotice} from '../src/shell/context.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));

// ---------- API ----------
const login = (f, email) => f.login(email);
async function fixture({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  // 組織3（デモ・管理者）・組織4（デモあり・所属なし）・組織5（デモあり・編集担当で案件の権限なし）・組織6（デモあり・編集担当で案件の権限あり）
  // 組織7（採用済み・制作担当）。利用者1（admin@…）は組織1の管理者でもある
  // 準備の行は1回の batch（1つのトランザクション）で入れる。文は ; で分ける（値に ; は無い）
  const seed = `
    INSERT INTO organizations(id,code,name) VALUES (3,'DEMO-SALES','架空データ（デモ）'),(4,'DEMO-OTHER','架空の他社（架空）'),(5,'DEMO-E1','架空の編集先A（架空）'),(6,'DEMO-E2','架空の編集先B（架空）'),(7,'DEMO-P1','架空の制作先（架空）');
    INSERT INTO schema_meta(org_id,version) VALUES (3,1),(4,1),(5,1),(6,1),(7,1);
    INSERT INTO memberships(org_id,user_id,role) VALUES (3,1,'admin'),(5,1,'editor'),(6,1,'editor'),(7,1,'production'),(4,4,'admin');
    INSERT INTO projects(id,org_id,code,title,status) VALUES (30,3,'DEMO-PD','架空連続ドラマ（架空）','active'),(40,4,'DEMO-PX','架空の他社作品（架空）','active'),
      (50,5,'DEMO-PE1','架空の編集先作品A（架空）','active'),(60,6,'DEMO-PE2','架空の編集先作品B（架空）','active'),(70,7,'DEMO-PP','架空の制作先作品（架空）','active');
    INSERT INTO works(id,org_id,project_id,code,title,format) VALUES (30,3,30,'${KOUBAN_DEMO_CODE}','ふくろう堂の返却期限（架空）','series'),(31,3,30,'DEMO-W01','架空作品1（架空）','film'),
      (40,4,40,'${KOUBAN_DEMO_CODE}','他社の同じコード（架空）','series'),(50,5,50,'${KOUBAN_DEMO_CODE}','編集先Aのデモ（架空）','series'),(60,6,60,'${KOUBAN_DEMO_CODE}','編集先Bのデモ（架空）','series'),
      (70,7,70,'DEMO-W99','制作先の作品（架空）','film');
    INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES (6,60,1,'edit');
  `;
  await db.batch(seed.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => ({sql})));
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const call = async (cookie, path, body) => {
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')};
  };
  return {db, app, login, call};
}

test('所属組織の案内: 香盤のデモは見られる組織だけ・売上集計シートは採用済みで財務の画面を使える組織だけを、id と名前だけで返す', async (t) => {
  const f = await fixture({t});
  const admin = await login(f, 'admin@openingnight.invalid');
  // 組織7（制作担当）と組織3（管理者）で売上集計シートの列を採用しておく（組織3は管理者として、組織7は直接の記録で）
  const switched = await f.call(admin, '/session/org', {orgId: 3});
  assert.equal(switched.status, 200);
  const inOrg3 = `${admin}; ${switched.cookie.split(';')[0]}`;
  assert.equal((await f.call(inOrg3, '/sales-sheet/columns/adopt', {reason: '架空データの確認'})).status, 201);
  await f.db.run("INSERT INTO memberships(org_id,user_id,role) VALUES (7,2,'admin')");
  const inOrg7 = await f.call(await login(f, 'editor@openingnight.invalid'), '/session/org', {orgId: 7});
  assert.equal(inOrg7.status, 200);
  const editor7 = `${await login(f, 'editor@openingnight.invalid')}; ${inOrg7.cookie.split(';')[0]}`;
  assert.equal((await f.call(editor7, '/sales-sheet/columns/adopt', {reason: '架空データの確認'})).status, 201);

  const out = await f.call(admin, '/session/org-features');
  assert.equal(out.status, 200);
  assert.equal(out.data.currentOrgId, 1);
  // 組織3（管理者）・組織6（案件の権限あり）だけ。組織4（所属なし）・組織5（案件の権限なし）は出さない
  assert.deepEqual(out.data.koubanDemo, [{id: 3, name: '架空データ（デモ）'}, {id: 6, name: '架空の編集先B（架空）'}]);
  // 組織7は採用済みだが、利用者1はそこで制作担当なので出さない
  assert.deepEqual(out.data.salesSheet, [{id: 3, name: '架空データ（デモ）'}]);
  for (const org of [...out.data.koubanDemo, ...out.data.salesSheet]) assert.deepEqual(Object.keys(org).sort(), ['id', 'name'], '作品・列などの中身は返さない');
  assert.doesNotMatch(JSON.stringify(out.data), /ふくろう堂|編集先B のデモ|DEMO-D78|column/);

  // 別組織の人（組織2だけ）には何も出ない。組織4の管理者（outsider）は組織4だけ
  const outsider = await f.call(await login(f, 'outsider@other.invalid'), '/session/org-features');
  assert.equal(outsider.status, 200);
  assert.deepEqual(outsider.data.salesSheet, []);
  await f.db.run("UPDATE memberships SET active=0 WHERE org_id=3 AND user_id=1");
  assert.deepEqual((await f.call(admin, '/session/org-features')).data.koubanDemo, [{id: 6, name: '架空の編集先B（架空）'}], '無効にした所属は数えない');
  assert.equal((await f.app.request('/api/session/org-features')).status, 401, 'ログインしていなければ読めない');
});

// ---------- 入口の決まり ----------
test('香盤のデモの場所: 今の組織にあればそこ、無ければ所属する別の組織、どこにも無ければ none', () => {
  const works = [{id: 7, code: 'WRK-DEMO', title: '風のあとさき'}];
  assert.equal(koubanDemoPlace({works, currentOrgId: 1, locations: [{id: 3, name: '架空データ（デモ）'}]}).kind, 'other');
  assert.deepEqual(koubanDemoPlace({works, currentOrgId: 1, locations: [{id: 3, name: '架空データ（デモ）'}]}).org, {id: 3, name: '架空データ（デモ）'});
  const here = koubanDemoPlace({works: [...works, {id: 23, code: KOUBAN_DEMO_CODE, title: 'ふくろう堂'}], currentOrgId: 3, locations: [{id: 3, name: 'x'}]});
  assert.equal(here.kind, 'here');
  assert.equal(here.work.id, 23);
  assert.equal(koubanDemoPlace({works, currentOrgId: 3, locations: [{id: 3, name: '今の組織'}]}).kind, 'none', '今の組織は「別の組織」に数えない');
  assert.equal(koubanDemoPlace({works, currentOrgId: 1, locations: []}).kind, 'none');
});

test('組織を切り替えたあとの行き先: 作品コードで新しい組織の作品IDを引いて香盤タブへ。無ければホームと知らせ', () => {
  const works = [{id: 31, code: 'DEMO-W01'}, {id: 23, code: KOUBAN_DEMO_CODE}];
  assert.deepEqual(destinationAfterOrgChange(KOUBAN_DEMO_DESTINATION, works), {page: '制作', params: {tab: 'kouban'}, workId: 23, missing: false});
  assert.deepEqual(destinationAfterOrgChange(KOUBAN_DEMO_DESTINATION, [{id: 1, code: 'WRK-DEMO'}]), {page: 'ホーム', params: {}, workId: null, missing: true, workCode: KOUBAN_DEMO_CODE});
  assert.equal(destinationAfterOrgChange(null, works), null);
  assert.deepEqual(destinationAfterOrgChange({page: '帳票センター', params: {report: 'sales-sheet'}}, works), {page: '帳票センター', params: {report: 'sales-sheet'}, workId: null, missing: false});
});

test('URL の作品が今の組織に無いときは最初の作品に直し、黙らずに知らせる（作品を読み込む前は判定しない）', () => {
  const works = [{id: 1, title: '風のあとさき'}, {id: 5, title: '別の作品'}];
  assert.deepEqual(resolveWork(5, works), {workId: 5, missing: null});
  assert.deepEqual(resolveWork(23, works), {workId: 1, missing: 23});
  assert.deepEqual(resolveWork(null, works), {workId: 1, missing: null}, '作品の指定が無いだけなら知らせない');
  assert.deepEqual(resolveWork(23, []), {workId: null, missing: null}, '作品を読み込む前');
  // 所属が2組織以上（上部の「組織」の切替が出ている）なら切替を案内し、1組織だけならリンクを送った人に確かめるよう書く
  const text = missingWorkNotice(23, '風のあとさき', {canSwitchOrg: true});
  assert.match(text, /指定の作品（作品ID 23）は、いまの組織で開ける作品にありません/);
  assert.match(text, /上部の「組織」で切り替え/);
  assert.match(text, /いまは「風のあとさき」を表示しています/);
  const single = missingWorkNotice(23, '風のあとさき', {canSwitchOrg: false});
  assert.doesNotMatch(single, /上部の「組織」/);
  assert.match(single, /リンクを送った人/);
  assert.doesNotMatch(missingWorkNotice(23), /上部の「組織」/, '既定は切替を案内しない'); 
});

test('香盤のデモの場所の文・台本のボタン・制作の画面の入口・切替後の移り方', () => {
  // 問い合わせに失敗したときは「どの組織にもありません」と言い切らない
  assert.match(koubanPlaceNote({kind: 'none', loaded: true, failed: true}).text, /確かめられませんでした/);
  assert.doesNotMatch(koubanPlaceNote({kind: 'none', loaded: true, failed: true}).text, /どの組織にもありません/);
  assert.match(koubanPlaceNote({kind: 'none', loaded: true}).text, /どの組織にもありません/);
  assert.equal(koubanPlaceNote({kind: 'none', loaded: false}), null);
  assert.equal(koubanPlaceNote({kind: 'other', org: {id: 3}}), null);
  // 台本のボタン: 読み込み中・0件・失敗・原本あり
  assert.deepEqual(scriptButtonState(null), {disabled: true, label: '取り込んだ台本を読み込んでいます…'});
  assert.match(scriptButtonState({rows: []}).label, /取り込んだ台本はまだありません/);
  assert.equal(scriptButtonState({rows: []}).disabled, true);
  assert.deepEqual(scriptButtonState({error: true}), {disabled: true, label: '取り込んだ台本を読み込めませんでした', retry: true});
  const ok = scriptButtonState({rows: [{id: 11, file_name: 'ep08-junbi.pdf', commit_id: null}, {id: 10, file_name: 'ep07-kettei.pdf', commit_id: 4}]});
  assert.deepEqual([ok.disabled, ok.script.id, ok.label], [false, 10, '取り込んだ台本を開く（ep07-kettei.pdf）']);
  // 制作の画面: シーンの有無によらず、別の組織・別の作品のデモへの入口を出す。今の作品がデモ・どこにも無いときは出さない
  assert.equal(showKoubanDemoEntry({place: {kind: 'other', org: {id: 3}}, workId: 1}), true);
  assert.equal(showKoubanDemoEntry({place: {kind: 'here', work: {id: 23}}, workId: 1}), true);
  assert.equal(showKoubanDemoEntry({place: {kind: 'here', work: {id: 23}}, workId: 23}), false);
  assert.equal(showKoubanDemoEntry({place: {kind: 'none'}, workId: 1}), false);
  // 組織を切り替えたあとの移り方: 作品が決まる行き先はその作品、決まらない行き先は作品を外す
  assert.deepEqual(afterOrgChangeOptions({workId: 23}), {workId: 23, replace: true, force: true});
  assert.deepEqual(afterOrgChangeOptions({workId: null}), {clearWork: true, replace: true, force: true});
});

test('取り込んだ台本を開く: 登録済みの原本のうち最初に取り込んだもの', () => {
  const rows = [{id: 12, file_name: 'ep08-kettei.pdf', commit_id: 5}, {id: 11, file_name: 'ep08-junbi.pdf', commit_id: null}, {id: 10, file_name: 'ep07-kettei.pdf', commit_id: 4}];
  assert.equal(scriptToOpen(rows).file_name, 'ep07-kettei.pdf');
  assert.equal(scriptToOpen([{id: 3, file_name: 'a.pdf', commit_id: null}, {id: 2, file_name: 'b.pdf', commit_id: null}]).file_name, 'b.pdf');
  assert.equal(scriptToOpen([]), null);
});

// ---------- サンプルの組 ----------
const FIXTURE_MASTER = {partners: [{id: 1, code: 'PT-CINEMA'}, {id: 2, code: 'PT-DIGITAL'}, {id: 3, code: 'PT-STORE'}], products: [{id: 1, sku: 'SKU-DIGI'}, {id: 2, sku: 'SKU-PACK'}]};
test('デモ資料のサンプルの組: 今の組織に合う組を先に。数字のIDの正常取込CSVは、IDとコードが合う組織だけ', () => {
  const demo = orderedSampleSets({works: [{id: 31, code: 'DEMO-W01'}, {id: 23, code: KOUBAN_DEMO_CODE}], partners: [{id: 5, code: 'DEMO-SELF'}, {id: 2, code: 'DEMO-PF-B'}], products: [{id: 1, sku: 'DEMO-W01-THR'}]});
  assert.deepEqual(demo.map((row) => [row.set.id, row.matches, row.showCanonical]), [['demo-sales', true, false], ['fixture', false, false]]);
  const fixtureOrg = orderedSampleSets({works: [{id: 1, code: 'WRK-DEMO'}], ...FIXTURE_MASTER});
  assert.deepEqual(fixtureOrg.map((row) => [row.set.id, row.matches, row.showCanonical]), [['fixture', true, true], ['demo-sales', false, false]]);
  const neither = orderedSampleSets({works: [{id: 9, code: 'OTHER'}]});
  assert.deepEqual(neither.map((row) => [row.set.id, row.matches]), [['demo-sales', false], ['fixture', false]]);
  // 取引先2のコードが違えば（別の組織で番号がずれている）出さない
  assert.equal(fixtureIdsValid({...FIXTURE_MASTER, partners: [{id: 2, code: 'DEMO-PF-B'}, {id: 3, code: 'PT-STORE'}]}), false);
  // DEMO-SALES 用の組には正常取込CSVが無く、取引先・報告の種類・見出し行・作品の決め方・要修正の行・期待値を持つ
  const set = SAMPLE_SETS.find((row) => row.id === 'demo-sales');
  for (const sample of set.samples) {
    assert.equal(sample.canonical, undefined);
    assert.deepEqual(sample.steps.map(([label]) => label), ['取引先', '報告の種類', '見出し行', '作品の決め方', '要修正の行']);
    assert.match(sample.steps.find(([label]) => label === '作品の決め方')[1], /商品コードの列で作品ごとに分ける/);
  }
  assert.match(set.samples[0].expected, /正常9行・6作品。正味売上の合計 2,287,040円/);
  assert.match(set.samples[1].expected, /正常7行・5作品。正味数量 1,449、正味額の合計 640,580円/);
});

// ---------- 画面（DOM は使わず文字列に描く。JSX は esbuild で変換） ----------
async function renderer() {
  const {build} = await import('esbuild');
  const result = await build({
    stdin: {
      contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
        import DemoSamples, {ScriptCard} from './src/DemoSamples.jsx'; import {KoubanDemoEntry} from './src/DemoGuide.jsx';
        export const demo = (props) => renderToStaticMarkup(React.createElement(DemoSamples, props));
        export const scriptCard = (props) => renderToStaticMarkup(React.createElement(ScriptCard, props));
        export const entry = (props) => renderToStaticMarkup(React.createElement(KoubanDemoEntry, props));`,
      resolveDir: appDir, loader: 'jsx', sourcefile: 'demo-guide-entry.jsx',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', logLevel: 'silent', loader: {'.css': 'empty'},
  });
  const dir = mkdtempSync(join(tmpdir(), 'on-demo-guide-'));
  const file = join(dir, 'demo-guide.cjs');
  writeFileSync(file, result.outputFiles.find((out) => out.path.endsWith('.js') || !out.path.endsWith('.css')).text);
  try { return createRequire(import.meta.url)(file); } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('デモ資料の画面: 組織の名前と、合う組のサンプル（取引先・見出し行・作品の決め方・期待値）を先に出し、DEMO-SALES では正常取込CSVを出さない', async () => {
  const {demo, entry} = await renderer();
  const html = demo({onNavigate: () => {}, works: [{id: 31, code: 'DEMO-W01', title: '架空作品1'}], partners: [{id: 5, code: 'DEMO-PF-B'}], products: [], currentOrgId: 3, currentOrgName: '架空データ（デモ）'});
  assert.match(html, /表示中の組織: <b>架空データ（デモ）<\/b>/);
  const first = html.indexOf('架空データ（デモ）DEMO-SALES 用'), second = html.indexOf('手元用の初期データ（WRK-DEMO）用');
  assert.ok(first > 0 && second > first, 'DEMO-SALES 用が先');
  assert.match(html, /demo-sales-streaming-sample\.xlsx/);
  assert.match(html, /架空配信B・都度課金（架空）（DEMO-PF-B）/);
  assert.match(html, /商品コードの列で作品ごとに分ける（列「品番」）/);
  assert.doesNotMatch(html, /canonical\.csv/, '数字のIDの正常取込CSVは出さない');
  assert.match(html, /この組織には対応するマスタがありません/);
  // 従来の組織（WRK-DEMO・IDも合う）では正常取込CSVを出す
  const legacy = demo({onNavigate: () => {}, works: [{id: 1, code: 'WRK-DEMO'}], ...FIXTURE_MASTER, currentOrgId: 1, currentOrgName: 'オープニングナイト試作チーム'});
  assert.ok(legacy.indexOf('手元用の初期データ（WRK-DEMO）用') < legacy.indexOf('架空データ（デモ）DEMO-SALES 用'));
  assert.match(legacy, /streaming-platform-canonical\.csv/);
  // 別の組織にある香盤のデモ: 案内の文と「組織を切り替えて香盤のデモを開く」
  const other = entry({place: {kind: 'other', org: {id: 3, name: '架空データ（デモ）'}}, onNavigate: () => {}, onSwitchOrg: async () => true});
  assert.match(other, /香盤のデモは組織「架空データ（デモ）」にあります。/);
  assert.match(other, /<button type="button">組織を切り替えて香盤のデモを開く<\/button>/);
  const here = entry({place: {kind: 'here', work: {id: 23, title: 'ふくろう堂の返却期限'}}, onNavigate: () => {}, label: '香盤のデモを開く'});
  assert.match(here, /香盤のデモを開く（ふくろう堂の返却期限）/);
  assert.equal(entry({place: {kind: 'none'}}), '');
});

test('デモ資料の台本のカード: 組織の問い合わせに失敗しても「どこにも無い」と言い切らず再読込を出す。原本0件・失敗のときは「読み込んでいます…」のままにしない', async () => {
  const {scriptCard} = await renderer();
  const failed = scriptCard({place: {kind: 'none', loaded: true, failed: true, retry: () => {}}, scripts: null, onNavigate: () => {}});
  assert.doesNotMatch(failed, /どの組織にもありません/);
  assert.match(failed, /確かめられませんでした/);
  assert.match(failed, />再読込<\/button>/);
  const here = {kind: 'here', work: {id: 23, title: 'ふくろう堂の返却期限'}};
  const empty = scriptCard({place: here, scripts: {rows: []}, onNavigate: () => {}});
  assert.doesNotMatch(empty, /読み込んでいます…/);
  assert.match(empty, /取り込んだ台本はまだありません/);
  const error = scriptCard({place: here, scripts: {error: true}, onNavigate: () => {}, onRetryScripts: () => {}});
  assert.doesNotMatch(error, /読み込んでいます…/);
  assert.match(error, /もう一度読み込む/);
});

test('main.jsx の配線: 切替に「切替後に開く画面」を渡せ、組織を変えるときは作品IDを持ち込まない', () => {
  const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /async function switchOrg\(orgId, \{ after = null \} = \{\}\)/);
  assert.match(main, /const loaded = await refreshAll\(\{ orgTransition: true \}\);\s*if \(loaded && after\) openAfterOrgChange\(after, loaded\);/);
  assert.match(main, /navigate\("ホーム", \{\}, \{ force: true, clearWork: true \}\)/);
  assert.match(main, /<DemoSamples [^\n]*onSwitchOrg=\{switchOrg\} \/>/);
  assert.match(main, /<ProductionWorkspace [^\n]*?onSwitchOrg=\{switchOrg\} \/>/);
  assert.match(main, /nav\.missingWork && <UiNotice tone="warn" message=\{missingWorkNotice\(/);
  assert.match(main, /canSwitchOrg: orgs\.length >= 2 && !orgsError/, '組織の切替が出ている人にだけ切替を案内する');
  assert.match(main, /afterOrgChangeOptions\(target\)/);
  const production = readFileSync(new URL('../src/ProductionWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(production, /showKoubanDemoEntry\(\{place: koubanDemo, workId\}\)/);
  assert.match(production, /showKoubanDemo && scenes\.length > 0 && <KoubanDemoEntry/, 'シーンがあるときもマスター香盤の見出しに入口を出す');
});
