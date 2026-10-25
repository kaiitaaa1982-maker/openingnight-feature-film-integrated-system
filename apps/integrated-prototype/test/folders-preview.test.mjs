// フォルダ画面の見本（src/revenue/folders/）。架空の固定データで、木・12か月のマス・置く見せかけを確かめる。
// 壊れたら: 54フォルダが崩れる、販売管理以外が開く、マスの1字が欠ける、同じファイル名で原本が増える、
// 代表モードや mode local 以外のメニューに出る、見本の印（folders-preview）が消える。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {SALES_PAGES} from '../src/navigation.mjs';
import {REPRESENTATIVE_PAGES, environmentHiddenPages, hiddenPagesForRole, menuGroups, navItem, slugOf, pageOfSlug, viewModeHiddenPages} from '../src/shell/nav-model.mjs';
import {
  CELL_MARKS, CLOSED_MESSAGE, LEDGER_COUNT, OPEN_CODE, PREVIEW_SOURCE, SORT_TITLE,
  beginDrop, finishDrop, ledgerFolders, loadSalesReportYear, previewSalesReportYear, selectCell,
} from '../src/revenue/folders/folders-preview-model.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date('2026-10-18T03:00:00Z');

function marksOf(board) {
  return new Set(board.rows.flatMap((row) => row.cells.map((cell) => cell.code)));
}

async function renderer() {
  const {build} = await import('esbuild');
  const result = await build({
    stdin: {
      contents: "import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {FoldersView, FoldersClosed} from './src/revenue/folders/Folders.jsx';\n"
        + 'export const view = (props) => renderToStaticMarkup(React.createElement(FoldersView, props));\n'
        + 'export const closed = () => renderToStaticMarkup(React.createElement(FoldersClosed));\n',
      resolveDir: appDir, loader: 'jsx', sourcefile: 'folders-preview-entry.jsx',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', logLevel: 'silent', loader: {'.css': 'empty'},
  });
  const dir = mkdtempSync(join(tmpdir(), 'on-folders-ui-'));
  const file = join(dir, 'folders-ui.cjs');
  writeFileSync(file, result.outputFiles[0].text);
  try { return createRequire(import.meta.url)(file); } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('見本の年度は計上月の12か月で、2社のマスに8つの状況が全部出る', () => {
  const board = previewSalesReportYear({today: TODAY});
  assert.equal(board.source, PREVIEW_SOURCE);
  assert.equal(loadSalesReportYear({today: TODAY}).source, PREVIEW_SOURCE);
  assert.equal(board.fiscalYear, 2026);
  assert.deepEqual(board.months, ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04']);
  assert.equal(board.rows.length, 2);
  for (const row of board.rows) assert.equal(row.cells.length, 12, row.partner);
  assert.deepEqual([...marksOf(board)].sort(), Object.keys(CELL_MARKS).sort());
  const review = board.rows[0].cells[1];
  assert.equal(review.code, 'review');
  assert.notEqual(review.month, review.recognitionMonth, '対象月と計上月を併記する');
  assert.match(board.rows[0].cells[2].mark, /^途 \d+\/\d+$/);
  assert.equal(board.rows[1].cells[0].mark, '超');
});

test('台帳は54。開くのは販売管理だけ。名前が仕様に無い行は未確認', () => {
  const folders = ledgerFolders();
  assert.equal(folders.length, LEDGER_COUNT);
  assert.deepEqual(folders.filter((folder) => folder.openable).map((folder) => folder.code), [OPEN_CODE]);
  assert.equal(folders.find((folder) => folder.code === 'F07').name, '販売管理');
  assert.equal(folders.find((folder) => folder.code === 'F08').name, 'ロイヤリティ報告');
  assert.equal(folders.filter((folder) => folder.source === 'unverified').length, 52);
  assert.equal(CLOSED_MESSAGE, '今回は開けません');
});

test('置くと読取中になり、見本は要確認で止まる。同じ名前は増えない', () => {
  const board = previewSalesReportYear({today: TODAY});
  const before = board.rows[0].files.length;
  const empty = board.rows[0].cells.find((cell) => cell.code === 'missing');
  const selected = selectCell(board, {rowId: board.rows[0].id, month: empty.month});
  const started = beginDrop(selected, {rowId: board.rows[0].id, fileName: 'kakuu-new.xlsx'});
  assert.equal(started.effect.code, 'reading');
  assert.equal(started.board.rows[0].cells.find((cell) => cell.month === empty.month).code, 'reading');
  assert.equal(started.board.rows[0].files.length, before);
  const done = finishDrop(started.board);
  assert.equal(done.pending, null);
  assert.equal(done.rows[0].cells.find((cell) => cell.month === empty.month).code, 'review');
  assert.equal(done.rows[0].files.length, before + 1);
  assert.equal(done.rows[0].files[0].judgment.label, '要確認');
  const again = beginDrop(done, {rowId: board.rows[0].id, fileName: 'kakuu-new.xlsx'});
  assert.equal(again.effect.code, 'duplicate');
  assert.equal(again.effect.label, '受済');
  assert.equal(again.board.rows[0].files.length, before + 1);
  const known = beginDrop(board, {rowId: board.rows[0].id, fileName: board.rows[0].files[0].name});
  assert.equal(known.effect.code, 'duplicate');
  assert.equal(known.board.rows[0].files.length, before);
});

test('入口は計上のフォルダ。代表モードと、ローカル以外のメニューには出ない', () => {
  assert.ok(SALES_PAGES.includes('フォルダ'));
  assert.equal(slugOf('フォルダ'), 'folders');
  assert.equal(pageOfSlug('folders'), 'フォルダ');
  assert.equal(navItem('フォルダ').localOnly, true);
  assert.equal(navItem('フォルダ').scope, 'company');
  assert.ok(!REPRESENTATIVE_PAGES.includes('フォルダ'));
  assert.ok(viewModeHiddenPages('representative').has('フォルダ'));
  assert.ok(hiddenPagesForRole('production').has('フォルダ'));
  assert.ok(!hiddenPagesForRole('admin').has('フォルダ'));
  assert.ok(menuGroups('sales', 'uriage').some((group) => group.items.some((item) => item.page === 'フォルダ')));
  assert.ok(environmentHiddenPages('worker').has('フォルダ'));
  assert.ok(environmentHiddenPages(null).has('フォルダ'));
  assert.equal(environmentHiddenPages('local').size, 0);
});

test('画面の文言はマスの1字と短いラベル。句点の文は出さない', async () => {
  const ui = await renderer();
  const board = previewSalesReportYear({today: TODAY});
  const html = ui.view({board, closedMessage: CLOSED_MESSAGE, dropEffect: {code: 'reading', label: '読', title: '読取中'}});
  assert.match(html, /data-preview-source="folders-preview"/);
  assert.match(html, /販売管理/);
  assert.match(html, /売上報告書/);
  assert.match(html, /2026年度/);
  assert.match(html, new RegExp(SORT_TITLE));
  assert.equal((html.match(/data-folder-code="/g) || []).length, 54);
  assert.match(html, /今回は開けません/);
  assert.match(html, /data-drop-effect="reading"/);
  assert.match(html, />読取中</);
  for (const mark of ['済', '未', '超', '読', '要', '途 2/6', '替', '消']) assert.match(html, new RegExp(mark.replace('/', '\\/')));
  const visible = html.replace(/\s(?:title|aria-label)="[^"]*"/g, '').replace(/<[^>]+>/g, '');
  assert.equal(visible.includes('。'), false, visible.slice(0, 200));
  const closed = ui.closed();
  assert.match(closed, /今回は開けません/);
  assert.match(closed, /data-folders-open="false"/);
});
