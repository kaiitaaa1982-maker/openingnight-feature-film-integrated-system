import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import React from 'react';
import {readOnlyRequest, readOnlyPreview, canvasBackTarget, READ_ONLY_MESSAGE} from '../src/design-preview.mjs';
import {LocalShellProvider, createLocalShell} from '../src/shell/context.mjs';
import {objects, screenFiles, screenSources} from '../src/design-model.mjs';

const h = React.createElement;

test('確認専用の request は GET だけを通し、書き込みは送らずに日本語の理由で断る', async () => {
  const calls = [];
  const base = async (path, options = {}) => { calls.push([path, options.method || 'GET']); return {ok: true}; };
  const safe = readOnlyRequest(base);
  assert.equal(safe.readOnly, true);
  assert.deepEqual(await safe('/er'), {ok: true});
  assert.deepEqual(await safe('/er', {method: 'head'}), {ok: true});
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'post']) {
    await assert.rejects(() => safe('/proposals/suggest', {method, body: '{}'}), (error) => {
      assert.equal(error.name, 'ApiError');
      assert.equal(error.kind, 'forbidden');
      assert.equal(error.message, READ_ONLY_MESSAGE);
      return true;
    });
  }
  assert.deepEqual(calls, [['/er', 'GET'], ['/er', 'head']], '書き込みは元の request に届かない');
});

test('プレビューの画面は、入れ子の部品・slot の props まで request と画面移動を差し替える', () => {
  const real = async () => ({});
  const safe = readOnlyRequest(real);
  const navigate = () => 'moved';
  function Screen() { return null; }
  function Slot() { return null; }
  const tree = h(LocalShellProvider, {readOnly: true},
    h('div', {className: 'stack'},
      h('section', {key: 'bar'}, h('button', {onClick: navigate}, '移動')),
      h(Screen, {key: 'screen', request: real, onNavigate: navigate, reload: navigate, workView: h(Slot, {request: real, onSelect: navigate})}),
      [h(Screen, {key: 'a', request: real}), h(Screen, {key: 'b'})]));
  const out = readOnlyPreview(tree, {request: safe});
  const div = out.props.children;
  const [section, screen, list] = div.props.children;
  assert.equal(section.type, 'section');
  assert.equal(section.props.children.props.onClick, navigate, 'DOM 要素の props は変えない（押せないのは inert と fieldset で止める）');
  assert.equal(screen.props.request, safe);
  assert.notEqual(screen.props.onNavigate, navigate);
  assert.equal(screen.props.onNavigate(), undefined);
  assert.notEqual(screen.props.reload, navigate);
  assert.equal(screen.props.workView.props.request, safe, 'slot に入れた部品にも届く');
  assert.notEqual(screen.props.workView.props.onSelect, navigate);
  assert.equal(screen.key, 'screen', 'key を保つ');
  assert.ok(Array.isArray(list));
  assert.equal(list[0].props.request, safe);
  assert.equal(list[0].key, 'a');
  assert.ok(!('request' in list[1].props), '持っていない props は足さない');

  assert.equal(readOnlyPreview(tree, {}), tree, 'request が無ければそのまま');
  const already = readOnlyPreview(h(Screen, {request: real}), {request: safe});
  assert.equal(already.props.request, safe, '確認専用の request を二重に包まない');
});

test('LocalShellProvider の中の画面は URL を書き換えず、条件は内部の状態だけで持つ', () => {
  const shell = createLocalShell({initialParams: {status: 'pending'}});
  assert.equal(shell.readOnly, true);
  assert.equal(shell.getParam('status'), 'pending');
  shell.setParam('status', 'all');
  assert.equal(shell.getParam('status'), 'all');
  shell.setParam('status', null);
  assert.equal(shell.getParam('status', 'x'), 'x');
  assert.equal(shell.navigate('帳票センター'), undefined);
});

test('設計キャンバスの「戻る」は、実在する別の画面から来たときだけ出す', () => {
  const known = new Set(['ER', '設計・定義', 'ホーム']);
  const isKnownPage = (page) => known.has(page);
  assert.equal(canvasBackTarget('ER', {isKnownPage}), 'ER');
  assert.equal(canvasBackTarget(' 設計・定義 ', {isKnownPage}), '設計・定義');
  assert.equal(canvasBackTarget('設計キャンバス', {isKnownPage: () => true}), null);
  assert.equal(canvasBackTarget('存在しない画面', {isKnownPage}), null);
  assert.equal(canvasBackTarget('', {isKnownPage}), null);
  assert.equal(canvasBackTarget(null, {isKnownPage}), null);
});

test('画面ごとのコード一覧は実在するファイルだけを指し、先頭が screenSources と一致する', () => {
  for (const [page, files] of Object.entries(screenFiles)) {
    assert.ok(files.length > 0, page);
    assert.equal(screenSources[page], files[0], page);
    for (const file of files) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${page}: ${file}`);
  }
  assert.equal(screenSources['原本取り込み'], 'src/import/SalesImportWizard.jsx');
  assert.equal(screenSources['台本・香盤'], 'src/Workflow.jsx');
  assert.equal(screenSources['商品・営業'], 'src/sales-ops/PipelineBoard.jsx');
  assert.equal(screenSources['帳票センター'], 'src/reports/ReportCatalog.jsx');
  assert.ok(screenFiles['番販・放送'].includes('src/broadcast/BroadcastApprovals.jsx'));
  assert.ok(screenFiles['帳票センター'].includes('src/reports/ProgressMatrix.jsx'));
  assert.ok(screenFiles['MG契約・台帳'].includes('src/mg-ledger-import.mjs'));
  assert.ok(screenFiles['制作'].includes('src/FieldOperations.jsx'));
  assert.equal(screenSources.ER, 'src/admin/ErPage.jsx');
  assert.equal(screenSources['チーム'], 'src/admin/TeamPage.jsx');
  assert.equal(screenSources['拡張項目'], 'src/admin/ExtensionsPage.jsx');
});

test('業務のまとまりの説明は金額の呼び名をそろえ、新しい表（帳票の発行・受領・取引先の版・年度・一括登録）を含む', () => {
  const mg = objects.find((object) => object.id === 'mg');
  assert.match(mg.meaning, /分配金は当期の消化対象で/);
  assert.doesNotMatch(mg.meaning, /MG消化対象額/);
  const all = new Set(objects.flatMap((object) => object.tables));
  for (const name of ['report_issuances', 'report_issuance_voids', 'expected_reports', 'expected_report_closures', 'partner_profile_versions', 'fiscal_settings', 'bulk_import_previews', 'bulk_import_batches']) {
    assert.ok(all.has(name), name);
  }
  const source = readFileSync(new URL('../src/design-model.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /テーブルへ移動しました|業務概念と画面/, '選択の知らせは業務の言葉にする');
});
