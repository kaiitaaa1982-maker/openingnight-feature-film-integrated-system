// 受託制作の契約の版の入力の画面（src/planning/contract-production/ContractProductionPanel.jsx。行動指標の計画 #3「受託費率は案件の編集の1項目」）を、
// 実際の受け口（createApp）と試験の DB に通して確かめる。画面の部品は esbuild で変換して文字列に描く（DOM は使わない）。応答は差し替えない。
// 期待値は要件 docs/requirements/revenue/contract-work.md の FR-REV-CWORK-035（受託費率 1000〜1500 bps・既定 1000、受託費＝総製作費×受託費率の truncate を
// 整数円で版に残す、制作予備費と混ぜない、財務の権限のある案件だけ）と、kpi-scenario-forecast.md の FR-REV-KPI-006 から持ってくる。
// 壊れたら: 範囲の外の受託費率が黙って既定の 10% で登録される・400 の理由が受託費率の欄に出ない・受託費が制作予備費と区別されずに出る・
// 制作担当や財務の権限の無い人に総製作費と受託費の欄が出る。架空のデータだけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {createApi} from '../src/ui/api-client.mjs';
import * as planning from '../src/planning/planning-store.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let bundled;
async function screen() {
  if (bundled) return bundled;
  const {build} = await import('esbuild');
  const result = await build({
    stdin: {
      contents: "import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {ContractVersionEditor, ContractProductionPanel, loadContractProjects, loadContractVersions, submitContractVersion} from './src/planning/contract-production/ContractProductionPanel.jsx';\n"
        + "import {formFromVersion} from './src/planning/contract-production/contract-version-form-model.mjs';\n"
        + 'export const editor = (props) => renderToStaticMarkup(React.createElement(ContractVersionEditor, {onSelectProject: () => {}, onChange: () => {}, onSubmit: () => {}, onRetry: () => {}, ...props}));\n'
        + 'export const panel = (props) => renderToStaticMarkup(React.createElement(ContractProductionPanel, props));\n'
        + 'export {loadContractProjects, loadContractVersions, submitContractVersion, formFromVersion};',
      resolveDir: appDir, loader: 'jsx', sourcefile: 'contract-production-ui-entry.jsx',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', logLevel: 'silent', loader: {'.css': 'empty'},
  });
  const dir = mkdtempSync(join(tmpdir(), 'on-contract-production-ui-'));
  const file = join(dir, 'contract-production-ui.cjs');
  writeFileSync(file, result.outputFiles[0].text);
  try { bundled = createRequire(import.meta.url)(file); } finally { rmSync(dir, {recursive: true, force: true}); }
  return bundled;
}

const ADMIN = 1;
const createProject = (db, overrides = {}) => planning.createProject(db, 1, {
  code: 'FICT-CW-UI', title: '架空の制作受託（画面）', projectType: 'contract_production', earningType: 'contract_work', baseAmountYen: null, revenueRateBps: null,
  counterpartyName: null, keyPerson: null, startedOn: null, planningFolder: null, note: null, stage: null, ...overrides,
}, {createdBy: ADMIN});

// 画面と同じ request（api-client）を、ログインした利用者の cookie つきで試験の app に向ける。POST の数を数える
async function asUser(app, email) {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const posts = [];
  const request = createApi({fetchImpl: (url, init = {}) => {
    if (init.method === 'POST') posts.push(url);
    return app.request(url, {...init, headers: {...init.headers, cookie}});
  }});
  return {request, posts};
}

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// FormField の欄（label の for と input の id）を、ラベルの文字から引いて、その欄のかたまり（.on-field）の HTML を返す
function fieldBlock(html, label) {
  const at = html.indexOf(`<span>${label}</span>`);
  assert.notEqual(at, -1, `欄「${label}」が無い`);
  const start = html.lastIndexOf('<div class="on-field', at);
  const end = html.indexOf('<div class="on-field', at);
  return html.slice(start, end === -1 ? undefined : end);
}

const THREE = [{month: '2026-05', sharePercent: '33.33'}, {month: '2026-09', sharePercent: '33.34'}, {month: '2027-01', sharePercent: '33.33'}];

test('FR-REV-CWORK-035 FR-REV-KPI-006 受託費率の欄: 範囲の外の率は受け口の項目ごとの 400 を受託費率の欄の直下に出して版を足さず、正しい率で足した版は受託費を制作予備費と別の自社の売上として出す', async (t) => {
  const {editor, loadContractProjects, loadContractVersions, submitContractVersion, formFromVersion} = await screen();
  const db = await openTestDb({t});
  const id = await createProject(db);
  await createProject(db, {code: 'FICT-ACQ-UI', title: '架空の買付（画面）', projectType: 'acquisition', earningType: 'acquisition'});
  const app = createApp({db, mode: 'local'});
  const {request, posts} = await asUser(app, 'admin@openingnight.invalid');

  // 選べるのは型「受託制作」の案件だけ（買付と、型の無い既存の案件は出ない）。版はまだ無く、欄は既定の 10%
  const projects = await loadContractProjects(request);
  assert.deepEqual(projects, [{value: String(id), label: 'FICT-CW-UI｜架空の制作受託（画面）'}]);
  assert.deepEqual(await loadContractVersions(request, id), []);
  const empty = editor({projects, projectId: String(id), versions: [], form: formFromVersion(null)});
  assert.match(text(empty), /契約の版はまだありません/);
  assert.match(text(empty), /第1版を足す/);
  assert.match(fieldBlock(empty, '受託費率（%）'), /value="10"/);
  assert.match(fieldBlock(empty, '受託費率（%）'), /既定 10%。案件ごとに 10〜15% の範囲で決めます/);
  assert.match(text(empty), /受託費＝総製作費×受託費率（1円未満は切り捨て）は自社の売上（純額）で、制作予備費とは別の値です（ここでは制作予備費を足しません）/);

  // 16% は受け口が項目 markupBps の 400 で断る。理由は受託費率の欄の直下に出て、版は足されない
  const form16 = {budget: '52,364,117', ratePercent: '16', milestones: THREE, contractReference: 'FICT/契約書/架空_画面.pdf', note: ''};
  const rejected = await submitContractVersion(request, {projectId: id, form: form16, versions: []});
  assert.equal(posts.length, 1, '範囲の外の率は画面で止めずに受け口へ送る');
  assert.equal(rejected.added, null);
  assert.deepEqual(Object.keys(rejected.fieldErrors), ['markupBps']);
  assert.match(rejected.fieldErrors.markupBps, /受託費率は 1000〜1500 の整数の bp（10〜15%）で入れてください/);
  assert.deepEqual([rejected.notice.tone, rejected.notice.message], ['error', '契約の版の入力を確かめてください']);
  assert.deepEqual(await loadContractVersions(request, id), []);
  const shown = editor({projects, projectId: String(id), versions: [], form: form16, fieldErrors: rejected.fieldErrors, notice: rejected.notice});
  const rateField = fieldBlock(shown, '受託費率（%）');
  assert.match(rateField, /aria-invalid="true"/);
  assert.match(rateField, /class="on-field-error">受託費率は 1000〜1500 の整数の bp（10〜15%）で入れてください</);
  assert.doesNotMatch(fieldBlock(shown, '総製作費（税別）'), /aria-invalid/);
  assert.match(text(shown), /受託費率は 10〜15% の範囲で入れてください（範囲の外は登録できません）/);
  assert.match(shown, /role="alert"/);

  // 空の受託費率は送らない（受け口は空を既定 10% にするので、黙って既定で登録しない）
  const blank = await submitContractVersion(request, {projectId: id, form: {...form16, ratePercent: ''}, versions: []});
  assert.equal(posts.length, 1);
  assert.match(blank.fieldErrors.markupBps, /受託費率を入れてください/);

  // 節目の割合の和が 100% でない版は、節目の項目の 400 を節目の欄の上に出す
  const shares = await submitContractVersion(request, {projectId: id, form: {...form16, ratePercent: '12.5', milestones: [{month: '2026-05', sharePercent: '99.99'}]}, versions: []});
  assert.match(shares.fieldErrors.milestones, /節目の割合の和を 10000 bp（100%）にしてください（いまは 9999）/);
  assert.match(editor({projects, projectId: String(id), versions: [], form: form16, fieldErrors: shares.fieldErrors}), /class="on-field-error">節目の割合の和を 10000 bp/);

  // 12.5% で第1版を足す。受託費は 52,364,117×12.5% の truncate＝6,545,514 円で版に残る
  const added = await submitContractVersion(request, {projectId: id, form: {...form16, ratePercent: '12.5'}, versions: []});
  assert.deepEqual([added.added, added.fieldErrors, added.notice.tone, added.reload], [1, {}, 'ok', true]);
  assert.equal(added.notice.message, '第1版を足しました（受託費 ￥6,545,514）');
  const versions = await loadContractVersions(request, id);
  assert.deepEqual(versions.map((v) => [v.versionNo, v.budgetYen, v.markupBps, v.feeYen, v.complete, v.contractReference]), [[1, 52364117, 1250, 6545514, true, 'FICT/契約書/架空_画面.pdf']]);
  const saved = editor({projects, projectId: String(id), versions, form: formFromVersion(versions.at(-1))});
  // いまの契約: 受託費は自社の売上（純額）として、総製作費と別の値で出る。節目ごとの制作費（入金の予定）と受託費の和はそれぞれ総製作費・受託費
  assert.match(text(saved), /第1版 （いま使う版） 総製作費 ￥52,364,117（税別）・受託費率 12.5% ・ 受託費 ￥6,545,514 （自社の売上・純額）/);
  assert.match(text(saved), /2026年5月 33.33% ￥17,452,960 ￥2,181,620/);
  assert.match(text(saved), /2027年1月 33.33% ￥17,452,960 ￥2,181,620/);
  assert.match(text(saved), /第2版を足す/);
  assert.match(fieldBlock(saved, '受託費率（%）'), /value="12.5"/);
  assert.match(text(saved), /受託費（自社の売上・純額）: 総製作費 ￥52,364,117 × 12.5% ＝ ￥6,545,514/);
  assert.doesNotMatch(text(saved), /制作予備費 ￥/, '制作予備費の額を受託費に足して出さない');

  // 古い画面（版の無い一覧のまま）からの書き込みは 409 で断り、入力を残して読み直す
  const stale = await submitContractVersion(request, {projectId: id, form: {...form16, ratePercent: '11'}, versions: []});
  assert.deepEqual([stale.added, stale.reload, stale.notice.error.status], [null, true, 409]);
  assert.equal((await loadContractVersions(request, id)).length, 1);
});

test('FR-REV-CWORK-035 制作担当・財務の権限の無い編集担当・別の組織には受託費率の欄を出さず、案件の編集の権限が付いた編集担当には出す', async (t) => {
  const {panel, loadContractProjects} = await screen();
  const db = await openTestDb({t});
  const id = await createProject(db);
  await db.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,3,'edit')", [id]);
  const app = createApp({db, mode: 'local'});
  // 制作担当は、案件に編集の権限が付いていても選択肢が無く（受け口は 403）、画面は何も描かない
  const production = await asUser(app, 'production@openingnight.invalid');
  assert.deepEqual(await loadContractProjects(production.request), []);
  let called = 0;
  assert.equal(panel({request: () => { called += 1; return Promise.resolve({}); }, role: 'production'}), '');
  assert.equal(called, 0);
  // 編集担当は、案件の編集の権限が無い・制作の権限だけのあいだは選択肢が無い
  const editor = await asUser(app, 'editor@openingnight.invalid');
  assert.deepEqual(await loadContractProjects(editor.request), []);
  await db.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,2,'production')", [id]);
  assert.deepEqual(await loadContractProjects(editor.request), []);
  await db.run("UPDATE project_memberships SET permission='edit' WHERE org_id=1 AND project_id=? AND user_id=2", [id]);
  assert.deepEqual(await loadContractProjects(editor.request), [{value: String(id), label: 'FICT-CW-UI｜架空の制作受託（画面）'}]);
  // 別の組織の利用者には出さない
  const outsider = await asUser(app, 'outsider@other.invalid');
  assert.deepEqual(await loadContractProjects(outsider.request), []);
  // 403 でない失敗（サーバーの障害）は隠さずに投げる（画面は理由と再試行を出す）
  const failing = createApi({fetchImpl: async () => new Response(JSON.stringify({ok: false, error: 'x'}), {status: 500, headers: {'content-type': 'application/json'}})});
  await assert.rejects(loadContractProjects(failing), (error) => error.status === 500 && error.kind === 'server');
});
