// 1通の見本（src/revenue/folders/SourceReview.jsx）。架空の5通で、判定・数字・例外・閉じた全行を確かめる。
// 壊れたら: 数字が合っているのに赤になる、読めない値があるのに登録が押せる、全行が開いたまま、
// 代表モードの URL で中身が出る、人が読む通に金額が出る。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {int} from '../src/ui/format.mjs';
import {linkedCsv, linkedXlsx} from '../src/revenue/folders/folders-preview-export.mjs';
import {
  REVIEW_KINDS, canCommitVoid, exportState, judgmentText, linkedMatches, linkedTotals, loadReview, loadSalesReportYear,
  numbersOk, previewHidden, registerState, reviews, voidBlock,
} from '../src/revenue/folders/folders-preview-model.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date('2026-10-18T03:00:00Z');
const SECTION_ORDER = ['judgment', 'numbers', 'exceptions', 'rows', 'history', 'export', 'actions'];

function visibleText(html) {
  return html.replace(/\s(?:title|aria-label)="[^"]*"/g, '').replace(/<[^>]+>/g, '');
}

function shell(viewMode, file) {
  return {
    viewMode,
    getParam: (key) => (key === 'file' ? file : null),
    setParam: () => {},
    navigate: () => {},
  };
}

async function renderer() {
  const {build} = await import('esbuild');
  const result = await build({
    stdin: {
      contents: "import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {Folders, FoldersView} from './src/revenue/folders/Folders.jsx'; import {SourceReview} from './src/revenue/folders/SourceReview.jsx'; import {ShellProvider} from './src/shell/context.mjs';\n"
        + 'export const review = (item, finance = true) => renderToStaticMarkup(React.createElement(SourceReview, {review: item, finance, sampling: item.sampled ? "match" : "", onBack: () => {}}));\n'
        + 'export const page = (value) => renderToStaticMarkup(React.createElement(ShellProvider, {value}, React.createElement(Folders)));\n'
        + 'export const year = (board) => renderToStaticMarkup(React.createElement(FoldersView, {board, onOpen: () => {}}));\n',
      resolveDir: appDir, loader: 'jsx', sourcefile: 'folders-review-entry.jsx',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', logLevel: 'silent', loader: {'.css': 'empty'},
  });
  const dir = mkdtempSync(join(tmpdir(), 'on-folders-review-'));
  const file = join(dir, 'folders-review.cjs');
  writeFileSync(file, result.outputFiles[0].text);
  try { return createRequire(import.meta.url)(file); } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('見本は判定5種。数字が合う通は緑、合わない通は差、税込は税抜と税額の和', () => {
  assert.deepEqual(reviews().map((item) => item.kind), REVIEW_KINDS);
  assert.equal(loadReview('preview-auto').kind, 'auto');
  assert.equal(loadReview('missing'), null);
  const auto = loadReview('preview-auto');
  const human = loadReview('preview-human');
  const record = loadReview('preview-record');
  assert.equal(numbersOk(auto), true);
  assert.equal(numbersOk(record), true);
  assert.equal(numbersOk(human), false);
  assert.equal(numbersOk(loadReview('preview-shape')), false);
  assert.equal(numbersOk(loadReview('preview-read')), false);
  for (const item of [auto, human, record]) {
    const ex = item.figures.find((row) => row.label === '税抜');
    const tax = item.figures.find((row) => row.label === '税額');
    const inc = item.figures.find((row) => row.label === '税込');
    assert.equal(ex.left + tax.left, inc.left, item.kind);
    assert.equal(ex.right + tax.right, inc.right, item.kind);
  }
  const ex = human.figures.find((row) => row.label === '税抜');
  assert.equal(ex.tone, 'bad');
  assert.equal(ex.diff, -20000);
  const rows = human.figures.find((row) => row.label === '件数');
  assert.equal(rows.tone, 'ok');
  assert.equal(rows.left, rows.right + rows.extra);
  assert.equal(human.exceptions.filter((item) => item.status === 'missing').length, 2);
  assert.equal(record.exceptions.some((item) => item.status === 'missing'), false);
  assert.equal(record.exceptions.some((item) => item.status === 'inferred'), true);
});

test('登録は、読めない値・形が違う・人が読む・登録済みでは押せない', () => {
  assert.deepEqual(registerState(loadReview('preview-record')), {enabled: true, label: '登録', reason: ''});
  assert.equal(registerState(loadReview('preview-human')).enabled, false);
  assert.equal(registerState(loadReview('preview-human')).reason, '読めない');
  assert.equal(registerState(loadReview('preview-shape')).enabled, false);
  assert.equal(registerState(loadReview('preview-read')).enabled, false);
  assert.equal(registerState(loadReview('preview-read')).reason, '要読');
  assert.deepEqual(registerState(loadReview('preview-auto')), {enabled: false, label: '登録済み', reason: '登録済み'});
  assert.equal(judgmentText(loadReview('preview-auto').judgment), '✓ 確定 12/12');
  assert.equal(judgmentText(loadReview('preview-human').judgment), '! 要確認 2');
  assert.equal(judgmentText(loadReview('preview-record').judgment), '! 実績 8/30');
  assert.equal(judgmentText(loadReview('preview-shape').judgment), '✕ 形違い 2');
  assert.equal(judgmentText(loadReview('preview-read').judgment), '人 要読');
  assert.equal(previewHidden('representative'), true);
  assert.equal(previewHidden('all'), false);
  assert.equal(previewHidden(undefined), false);
});

test('画面は判定・数字・例外・閉じた全行の順。例外は左右に同じ印がある', async () => {
  const ui = await renderer();
  const html = {};
  for (const item of reviews()) html[item.kind] = ui.review(item);
  for (const kind of REVIEW_KINDS) {
    let at = -1;
    for (const name of SECTION_ORDER) {
      const next = html[kind].indexOf(`data-section="${name}"`);
      assert.ok(next > at, `${kind} ${name}`);
      at = next;
    }
    for (const fold of ['rows', 'history', 'export']) {
      const tag = html[kind].match(new RegExp(`<details[^>]*data-fold="${fold}"[^>]*>`));
      assert.ok(tag, `${kind} ${fold}`);
      assert.equal(tag[0].includes('open'), false, tag[0]);
    }
    assert.equal(visibleText(html[kind]).includes('。'), false, kind);
    assert.match(html[kind], new RegExp(`data-review-kind="${kind}"`));
  }
  assert.match(html.auto, /folders-figure is-ok/);
  assert.match(html.auto, new RegExp(`${int(360000)}円`));
  assert.match(html.auto, /data-register="off"/);
  assert.match(html.auto, />登録済み</);
  assert.match(html.auto, /data-exceptions="0"/);
  assert.match(html.human, /folders-figure is-bad/);
  assert.match(html.human, /folders-figure is-ok/);
  assert.match(html.human, /data-register="off"/);
  assert.match(html.human, /data-exception="total"[^>]*data-side="left"/);
  assert.match(html.human, /data-exception="total"[^>]*data-side="right"/);
  assert.match(html.human, /data-exception="work"[^>]*data-side="left"/);
  assert.match(html.human, /読めない/);
  assert.match(html.human, /補った・要確認/);
  assert.match(html.record, /data-register="on"/);
  assert.match(html.record, /補った・要確認/);
  assert.match(html.shape, /data-action="wizard"/);
  assert.match(html.shape, /売上金額/);
  assert.match(html.shape, /data-register="off"/);
  assert.match(html.read, /data-values="false"/);
  assert.match(html.read, /要読/);
  assert.equal(html.read.includes('￥'), false);
  assert.equal(html.read.includes('¥'), false);
  assert.match(html.auto, /data-export="csv"/);
  assert.match(html.auto, /data-export-enabled="true"/);
  assert.match(html.auto, /data-export-count="4"/);
  assert.match(html.auto, /data-export-ex="360000"/);
  assert.match(html.auto, /data-action="void"/);
  assert.match(html.auto, /data-fold="history"/);
  assert.deepEqual([...html.auto.matchAll(/data-history="([^"]+)"/g)].map((match) => match[1]), ['受け取り', '読み取り', '検査', '判定', '登録']);
  assert.match(html.auto, /2026-10-02 09:12/);
  assert.equal(html.auto.includes('data-history="取消"'), false);
  assert.match(html.human, /data-history="判定"/);
  assert.equal(html.human.includes('data-history="登録"'), false);
  assert.match(html.human, /data-export-lock="未登録"/);
  const registered = html.auto.match(/<button[^>]*data-register="off"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.equal((registered.match(/登録済み/g) || []).length, 1);
  assert.equal(registered.includes('folders-visually-hidden'), false);
  const blocked = html.human.match(/<button[^>]*data-register="off"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.match(blocked, /folders-visually-hidden[\s\S]*読めない/);
  assert.match(html.auto, /data-sampling="match"/);
  assert.match(html.auto, /data-sampling-saved="match"/);
  assert.match(html.auto, /合っていた/);
});

test('請求済みは理由を出して取り消せず、財務が無いと表を出さない。代表の URL は別', async () => {
  const ui = await renderer();
  const billed = ui.review(loadReview('preview-billed'));
  assert.match(billed, /data-billed="true"/);
  assert.match(billed, /data-void="billed"/);
  assert.match(billed, /請求済みのため取り消せません/);
  assert.match(billed, /差額の報告で直します（未実装）/);
  assert.equal(visibleText(billed).includes('。'), false);
  assert.match(billed.match(/<button[^>]*data-action="void"[^>]*>/)[0], /disabled/);
  assert.equal(billed.includes('data-history="取消"'), false);
  const locked = ui.review(loadReview('preview-auto'), false);
  assert.match(locked, /data-finance="off"/);
  assert.match(locked, /data-export-enabled="false"/);
  assert.match(locked, /data-export-lock="財務"/);
  assert.match(locked, /全作品の財務権限が要る/);
  assert.equal(locked.includes('data-export-count'), false);
  assert.equal(locked.includes('見本-1'), false);
  assert.match(locked.match(/<button[^>]*data-export="csv"[^>]*>/)[0], /disabled/);
  assert.match(locked.match(/<button[^>]*data-export="xlsx"[^>]*>/)[0], /disabled/);
  assert.equal(visibleText(locked).includes('。'), false);
});

test('年度の原本から5通を開け、抜き取りに確定の1通が出る。代表モードの URL では中身が出ない', async () => {
  const ui = await renderer();
  const board = loadSalesReportYear({today: TODAY});
  const year = ui.year(board);
  for (const id of ['preview-auto', 'preview-human', 'preview-record', 'preview-shape', 'preview-read']) {
    assert.match(year, new RegExp(`data-review="${id}"`));
  }
  assert.match(year, /抜き取り/);
  assert.equal(visibleText(year).includes('。'), false);
  const opened = ui.page(shell('all', 'preview-human'));
  assert.match(opened, /data-review-kind="human"/);
  assert.equal(opened.includes('folders-months'), false);
  const unknown = ui.page(shell('all', 'no-such-file'));
  assert.match(unknown, /data-unknown-file="true"/);
  assert.equal(unknown.includes('data-review-kind'), false);
  const closed = ui.page(shell('representative', 'preview-auto'));
  assert.match(closed, /data-folders-open="false"/);
  assert.match(closed, /今回は開けません/);
  assert.equal(closed.includes('架空配信'), false);
  assert.equal(closed.includes('data-review-kind'), false);
  assert.equal(closed.includes('✓'), false);
  assert.match(year, /data-review="preview-billed"/);
  assert.match(year, /請求済/);
});

test('落とした表は画面の行数と税抜の和に一致し、行番号がある。財務が無いと押せない。請求済みは取り消せない', () => {
  const auto = loadReview('preview-auto');
  const record = loadReview('preview-record');
  const billed = loadReview('preview-billed');
  assert.equal(linkedMatches(auto), true);
  assert.equal(linkedTotals(auto).count, 4);
  assert.equal(linkedTotals(auto).ex, 360000);
  assert.deepEqual([...linkedTotals(auto).lines], ['2', '3', '4', '5']);
  assert.equal(linkedMatches(record), true);
  assert.equal(linkedTotals(record).count, 3);
  assert.equal(linkedTotals(record).ex, 210000);
  assert.equal(linkedMatches(billed), true);
  assert.equal(linkedTotals(billed).ex, 80000);
  assert.equal(exportState(auto, {finance: true}).enabled, true);
  assert.equal(exportState(auto, {finance: false}).reason, '財務');
  assert.equal(exportState(loadReview('preview-human'), {finance: true}).reason, '未登録');
  assert.equal(exportState(record, {finance: true, registered: true}).enabled, true);
  assert.equal(canCommitVoid({reason: '', fix: 'type'}), false);
  assert.equal(canCommitVoid({reason: '   ', fix: 'type'}), false);
  assert.equal(canCommitVoid({reason: '取り違え', fix: ''}), false);
  assert.equal(canCommitVoid({reason: '取り違え', fix: 'source'}), true);
  assert.equal(voidBlock(auto), null);
  assert.equal(voidBlock(billed).lead, '請求済みのため取り消せません');
  assert.equal(voidBlock(billed).rest, '差額の報告で直します（未実装）');
  const csv = linkedCsv(auto.linkedHeaders, auto.linkedRows).replace(/^\uFEFF/, '');
  const lines = csv.trim().split(/\r?\n/);
  assert.equal(lines.length, 5);
  const headers = lines[0].split(',');
  const ex = headers.indexOf('税抜');
  const lineNo = headers.indexOf('行');
  assert.equal(lines.slice(1).reduce((sum, line) => sum + Number(line.split(',')[ex]), 0), 360000);
  assert.deepEqual(lines.slice(1).map((line) => line.split(',')[lineNo]), ['2', '3', '4', '5']);
  const xlsx = Buffer.from(linkedXlsx(auto.linkedHeaders, auto.linkedRows));
  assert.equal(xlsx.readUInt32LE(0), 0x04034b50);
  const files = unzipStore(xlsx);
  assert.match(files['xl/worksheets/sheet1.xml'], /<v>120000<\/v>/);
  assert.match(files['xl/worksheets/sheet1.xml'], /<v>80000<\/v>/);
  assert.match(files['xl/worksheets/sheet1.xml'], /<v>40000<\/v>/);
  assert.equal((files['xl/worksheets/sheet1.xml'].match(/<row /g) || []).length, 5);
  assert.match(files['[Content_Types].xml'], /spreadsheetml\.sheet\.main\+xml/);
});

function unzipStore(buf) {
  const files = {};
  let offset = 0;
  while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8);
    const size = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extra = buf.readUInt16LE(offset + 28);
    const name = buf.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
    const start = offset + 30 + nameLen + extra;
    assert.equal(method, 0, name);
    files[name] = buf.slice(start, start + size).toString('utf8');
    offset = start + size;
  }
  return files;
}
