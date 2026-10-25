// 台本の読み取り（python/extract_document.py）が返す「出どころ」の試験。
// ・シーンごとの出どころ（source: 頁と柱の枠）、項目ごとの状態と理由（fields）、当てた変換の決まり（scriptMeta.rulesApplied）。
// ・期待値は、要件（docs/requirements/production/script-structuring.md）の決まりと、架空の台本PDFの元データ
//   demo-fixtures/kouban/kouban-demo.json・その組み方（demo-fixtures/generate_script_pdfs.py）から出す。読み取りの出力からは作らない。
// ・柱の位置は、読み取り（Python の pypdf）とは別の読み方として pdf.js（pdfjs-dist）で取り、読み取りが返す枠と比べる。
// ・横書きの頁・/Rotate のある頁は、この試験の中で手で組んだ小さなPDF（埋め込まない日本語の CID フォント）で確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {extractDocument} from '../src/local-extractor.mjs';

const python = process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const source = JSON.parse(await readFile(new URL('../demo-fixtures/kouban/kouban-demo.json', import.meta.url), 'utf8'));
const SCRIPTS = new URL('../public/demo-fixtures/scripts/', import.meta.url);
const PDFJS = new URL('../node_modules/pdfjs-dist/', import.meta.url);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const nfkc = (text) => text.normalize('NFKC');
const DRAFTS = source.episodes.flatMap((episode) => episode.drafts.map((draft) => ({...draft, episode})));
const draftOf = (file) => DRAFTS.find((draft) => draft.file === file);

const extractBytes = (name, bytes) => extractDocument({name, base64: Buffer.from(bytes).toString('base64'), pythonPath: python, timeoutMs: 60_000});
const fixtures = new Map();
const extract = (file) => {
  if (!fixtures.has(file)) fixtures.set(file, readFile(new URL(file, SCRIPTS)).then((bytes) => extractBytes(file, bytes)));
  return fixtures.get(file);
};

// ---------- 元データから出す期待値 ----------
// 原本の柱の並び（generate_script_pdfs.py の組み方）。決定稿は柱の列の上にシーン番号の数字、準備稿は「◯」＋柱で番号が無い。
// 準備稿だけ第22・23場を載せず、最初のシーンの後に「◯メインタイトル」を置く
function headingsOf(draft) {
  const scenes = draft.episode.scenes.filter((scene) => !(draft.kind === '準備稿' && [22, 23].includes(scene.no)));
  const rows = scenes.map((scene) => ({head: scene.head, scene}));
  if (draft.style === 'glyph') rows.splice(1, 0, {head: 'メインタイトル', scene: null});
  return rows;
}
// シーン番号: 柱に番号があればその番号、無ければ順番（話数-番号）
const sceneNoOf = (draft, rows, index) => `${draft.episode.no}-${draft.style === 'numbered' ? rows[index].scene.no : index + 1}`;
// 柱の末尾の時間帯（元データの柱が使う書き方だけ）
const TIME = {夜: 'N', 朝: 'D', 翌朝: 'D', 夕: 'DN'};
const timeOf = (head) => TIME[head.match(/（([^（）]+)）$/)?.[1]] ?? null;

// 要件の決まりで、柱の並びから場所と昼夜を出す。「同・」は直前の場所の「・」より前で補い（FR-PROD-STRUCT-004）、
// 昼夜の無い「同・」は直前のシーンに昼夜があれば引き継ぐ（FR-PROD-STRUCT-005）
function expectedScenes(draft) {
  const rows = headingsOf(draft);
  let previous = null;
  return rows.map((row, index) => {
    const own = timeOf(row.head);
    const written = row.head.replace(/（(?:夜|朝|翌朝|夕)）$/, '');
    const same = /^同・(.*)$/.exec(written);
    const inheritFrom = !own && same && previous?.dayNight ? previous : null;
    const scene = {
      sceneNo: sceneNoOf(draft, rows, index), head: row.head, truth: row.scene,
      place: same && previous ? `${previous.place.split('・')[0]}・${same[1]}` : written,
      placeBefore: same && previous ? previous.place : null,
      dayNight: own ?? inheritFrom?.dayNight ?? null, timeRead: Boolean(own), inheritedFrom: inheritFrom?.sceneNo ?? null,
      speaks: Boolean(row.scene?.lines.some(([kind]) => kind === '台' || kind === 'M')),
    };
    previous = scene;
    return scene;
  });
}

// ---------- pdf.js で読む柱の位置 ----------
// pdf.js は資料のフォルダの末尾に「/」を求める（Windows のパスの末尾の「\」では断る）
const pdfjsFolder = (name) => `${fileURLToPath(new URL(name, PDFJS)).replace(/[\\/]+$/, '')}/`;
async function pdfPages(bytes) {
  const task = pdfjs.getDocument({data: new Uint8Array(bytes), cMapUrl: pdfjsFolder('cmaps/'), cMapPacked: true,
    standardFontDataUrl: pdfjsFolder('standard_fonts/'), isEvalSupported: false, useSystemFonts: false, verbosity: 0});
  const doc = await task.promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const [left, bottom, right, top] = page.view;
      const content = await page.getTextContent();
      const items = content.items.filter((item) => item.str?.trim()).map((item) => ({
        str: item.str, vertical: item.dir === 'ttb', x: item.transform[4], y: item.transform[5], width: item.width, height: item.height,
        size: Math.hypot(item.transform[2], item.transform[3]),
        ascent: content.styles[item.fontName]?.ascent ?? 0.88, descent: content.styles[item.fontName]?.descent ?? -0.12,
      }));
      pages.push({page: n, left, bottom, width: right - left, height: top - bottom, items});
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

// 柱を右の列から順に探す。決定稿は「縦書きの文字列の上に、数字だけの横書き」の列、準備稿は「◯」で始まる1文字ずつの列
function pdfHeadings(pages, style) {
  const found = [];
  for (const page of pages) {
    const here = [];
    if (style === 'numbered') {
      for (const item of page.items.filter((it) => it.vertical)) {
        const number = page.items.find((it) => !it.vertical && /^\d+$/.test(it.str.trim()) && Math.abs(it.x - item.x) < item.size && it.y > item.y && it.y - item.y < 3 * item.size);
        if (number) here.push({page: page.page, x: item.x, text: item.str, number: number.str.trim(), items: [item, number]});
      }
    } else {
      const columns = new Map();
      for (const item of page.items) {
        const key = Math.round(item.x * 100);
        if (!columns.has(key)) columns.set(key, []);
        columns.get(key).push(item);
      }
      for (const items of columns.values()) {
        items.sort((a, b) => b.y - a.y);
        const text = items.map((it) => it.str).join('');
        if (text.startsWith('◯')) here.push({page: page.page, x: items[0].x, text, items});
      }
    }
    found.push(...here.sort((a, b) => b.x - a.x));
  }
  return found;
}

// 頁の座標（原点は左下）→ 頁に対する割合（原点は左上）
const fraction = (page, x, y) => ({x: (x - page.left) / page.width, y: 1 - (y - page.bottom) / page.height});
const inside = (box, point) => point.x >= box.left && point.x <= box.left + box.width && point.y >= box.top && point.y <= box.top + box.height;
// 文字列の占める範囲の四隅（頁の座標）。縦書きは列の中心線から左右に半分ずつ（width）、最初の字の上端から下へ height。
// 横書きは左端から width、ベースラインからフォントの descent・ascent（pdf.js の styles）まで
function corners(item) {
  const [x0, x1, y0, y1] = item.vertical
    ? [item.x - item.width / 2, item.x + item.width / 2, item.y - item.height, item.y]
    : [item.x, item.x + item.width, item.y + item.descent * item.size, item.y + item.ascent * item.size];
  return [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
}
// 柱の文字の占める範囲を、上下左右に1字分ずつ広げた範囲（枠が柱から大きくはみ出していないことを見る）
function roomAround(page, items) {
  const points = items.flatMap(corners);
  const pad = Math.max(...items.map((it) => it.size));
  const a = fraction(page, Math.min(...points.map(([x]) => x)) - pad, Math.max(...points.map(([, y]) => y)) + pad);
  const b = fraction(page, Math.max(...points.map(([x]) => x)) + pad, Math.min(...points.map(([, y]) => y)) - pad);
  return {left: a.x, top: a.y, right: b.x, bottom: b.y};
}
const verticalPage = (page) => page.items.some((it) => it.vertical)
  || page.items.some((a) => page.items.some((b) => b !== a && Math.abs(a.x - b.x) < 0.01 && Math.abs(Math.abs(a.y - b.y) - a.size) < 0.01));

// ---------- 手で組む小さなPDF（reportlab を使わない） ----------
// 日本語は埋め込まない CID フォント（UniJIS-UCS2。横書き H・縦書き V）で書く。runs: [{x, y, text, vertical}]
const ucs2 = (text) => [...text].map((ch) => ch.codePointAt(0).toString(16).padStart(4, '0')).join('');
function scriptPdf(pages, {width = 420, height = 595, size = 11, cropBox = null} = {}) {
  const fonts = [
    ['HeiseiKakuGo-W5', 'UniJIS-UCS2-H', '/Flags 4 /FontBBox [-92 -250 1010 922] /Ascent 752 /Descent -221 /CapHeight 737 /StemV 114'],
    ['HeiseiMin-W3', 'UniJIS-UCS2-V', '/Flags 6 /FontBBox [-123 -257 1001 910] /Ascent 723 /Descent -241 /CapHeight 709 /StemV 69'],
  ];
  const bodies = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${9 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  fonts.forEach(([name, encoding, metrics], i) => {
    const at = 3 + 3 * i;
    bodies.push(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /${encoding} /DescendantFonts [${at + 1} 0 R] >>`,
      `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /DW 1000 /FontDescriptor ${at + 2} 0 R >>`,
      `<< /Type /FontDescriptor /FontName /${name} ${metrics} /ItalicAngle 0 >>`);
  });
  pages.forEach((page, i) => {
    const stream = page.runs.map((run) => `BT /${run.vertical ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${run.x} ${run.y} Tm <${ucs2(run.text)}> Tj ET`).join('\n');
    bodies.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}]${cropBox ? ` /CropBox [${cropBox.join(' ')}]` : ''} /Rotate ${page.rotate || 0} /Resources << /Font << /F1 3 0 R /F2 6 0 R >> >> /Contents ${10 + 2 * i} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = bodies.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const column = (x, text) => ({x, y: 520, text, vertical: true});
// 横書きの1頁（柱は ○）
const HORIZONTAL_PDF = scriptPdf([{runs: ['第5話', '○港（夜）', '春川「来たか」', '○同・倉庫', '店主「遅いぞ」'].map((text, i) => ({x: 72, y: 760 - 24 * i, text}))}], {width: 595, height: 842});
// 横書きの表紙1頁と縦書きの本文2頁（3頁目だけ /Rotate 90）。本文のどの頁も列が5本に満たない
const ROTATED_PDF = scriptPdf([
  {runs: [{x: 150, y: 400, text: '第5話　決定稿'}]},
  {runs: [column(380, '○港（夜）'), column(358, '春川「来たか」'), column(336, '○同・倉庫'), column(314, '店主「遅いぞ」')]},
  {rotate: 90, runs: [column(380, '○灯台（朝）'), column(358, '春川「着いた」')]},
]);

// テキストの台本（○の柱。番号は無い）。3-1 港（夜）、3-2 同・倉庫、3-3 灯台（昼夜なし）、3-4 場所の無い柱、3-5 化けた字、3-6 黒味・タイトル、3-7 台詞の混ざった柱
const TXT_SCRIPT = ['第3話 決定稿', '', '○港（夜）', '春川「来たか」', '○同・倉庫', '店主「遅いぞ」', '○灯台', '波の音だけが聞こえる。',
  '○（夜）', '春川「ここはどこだ」', '○ふく]ろう堂', '千尋「いらっしゃい」', '○メインタイトル', '○路地裏　千尋「遅いぞ」店主「待て', '足音が遠ざかる。'].join('\n');
const extractTxt = () => extractBytes('variants.txt', Buffer.from(TXT_SCRIPT));

const SPEAKERS = 'セリフの話者から（ト書きだけの人物は入らない）';
const NO_SPEAKERS = 'セリフの話者がいない';
const READ_TIME = {status: 'read', reason: '柱の末尾の時間帯'};
const NO_TIME = {status: 'missing', reason: '柱に昼夜が無い'};
const inherited = (sceneNo) => ({status: 'inferred', reason: `柱に昼夜が無いので、直前のシーン（${sceneNo}）の昼夜を引き継いだ`});
const samePlace = (before) => ({status: 'inferred', reason: `「同・」を直前の場所「${before}」で補った`});
const validBox = (box) => Boolean(box) && [box.left, box.top, box.width, box.height].every(Number.isFinite)
  && box.left >= 0 && box.top >= 0 && box.width > 0 && box.height > 0 && box.left + box.width <= 1 + 1e-9 && box.top + box.height <= 1 + 1e-9;

function assertField(field, label) {
  assert.deepEqual(Object.keys(field).sort(), ['reason', 'status'], label);
  assert.ok(['read', 'inferred', 'missing'].includes(field.status), `${label}: ${field.status}`);
  assert.ok(field.reason === null || (typeof field.reason === 'string' && field.reason.length > 0 && [...field.reason].length <= 60), `${label}: ${field.reason}`);
}

// ---------- 試験 ----------
test('FR-PROD-STRUCT-002 縦書きの台本PDF3本の全シーンで、頁と柱の枠（柱の上の番号を含む）が pdf.js で読んだ柱の文字を囲み、隣の列と余白の文字を含まない', async () => {
  for (const draft of DRAFTS) {
    const bytes = await readFile(new URL(draft.file, SCRIPTS));
    const [result, pages] = await Promise.all([extract(draft.file), pdfPages(bytes)]);
    const rows = headingsOf(draft);
    const headings = pdfHeadings(pages, draft.style);
    // pdf.js の読みで見つけた柱が、元データの柱と同じ並びであること（この試験の読み方の確かめ）
    assert.deepEqual(headings.map((h) => nfkc(h.text)), rows.map((row) => nfkc(draft.style === 'glyph' ? `◯${row.head}` : row.head)), draft.file);
    if (draft.style === 'numbered') assert.deepEqual(headings.map((h) => h.number), rows.map((row) => String(row.scene.no)), draft.file);
    assert.equal(result.scenes.length, rows.length, draft.file);
    headings.forEach((heading, index) => {
      const scene = result.scenes[index];
      const label = `${draft.file} ${scene.sceneNo}（${rows[index].head}）`;
      assert.ok(Number.isInteger(scene.source?.page) && scene.source.page >= 1 && scene.source.page <= pages.length, label);
      assert.equal(scene.source.page, heading.page, `${label}: 柱のある頁`);
      const {box} = scene.source;
      assert.ok(validBox(box), `${label}: ${JSON.stringify(box)}`);
      const page = pages[heading.page - 1];
      for (const item of heading.items) {
        for (const [x, y] of corners(item)) assert.ok(inside(box, fraction(page, x, y)), `${label}: 「${item.str}」の隅 (${x}, ${y}) が枠 ${JSON.stringify(box)} の外`);
      }
      const room = roomAround(page, heading.items);
      assert.ok(box.left >= room.left && box.top >= room.top && box.left + box.width <= room.right && box.top + box.height <= room.bottom,
        `${label}: 枠 ${JSON.stringify(box)} が柱から1字分より大きくはみ出している ${JSON.stringify(room)}`);
      for (const item of page.items.filter((it) => !heading.items.includes(it))) {
        assert.ok(!inside(box, fraction(page, item.x, item.y)), `${label}: 柱でない「${item.str}」が枠の中`);
      }
    });
  }
});

test('FR-PROD-STRUCT-002 /CropBox のある頁の柱の枠は、pdf.js が描く範囲（CropBox と MediaBox の重なり）に対する割合で、柱の文字を囲む', async () => {
  const runs = [column(380, '○港（夜）'), column(358, '春川「来たか」'), column(336, '○同・倉庫'), column(314, '店主「遅いぞ」')];
  // MediaBox の内側・MediaBox からはみ出す・左右の片側だけ重なる CropBox
  for (const cropBox of [[30, 40, 400, 580], [-60, -80, 480, 700], [200, -20, 520, 595]]) {
    const bytes = scriptPdf([{runs}], {cropBox});
    const [result, [page]] = await Promise.all([extractBytes('cropped.pdf', bytes), pdfPages(bytes)]);
    const heads = page.items.filter((item) => item.str.startsWith('○'));
    assert.deepEqual(result.scenes.map((scene) => scene.location), ['港', '港・倉庫'], JSON.stringify(cropBox));
    heads.forEach((head, index) => {
      const {box} = result.scenes[index].source;
      assert.ok(validBox(box), `${cropBox}: ${JSON.stringify(box)}`);
      for (const [x, y] of corners(head)) assert.ok(inside(box, fraction(page, x, y)), `${cropBox}: 「${head.str}」の隅 (${x}, ${y}) が枠 ${JSON.stringify(box)} の外`);
      const room = roomAround(page, [head]);
      assert.ok(box.left >= room.left && box.left + box.width <= room.right, `${cropBox}: 枠 ${JSON.stringify(box)} が柱から1字分より大きくはみ出している`);
    });
  }
});

test('FR-PROD-STRUCT-002 テキストの台本は出どころが null、横書きのPDFの頁と /Rotate のある頁は枠が null で頁だけを返す', async () => {
  const txt = await extractTxt();
  assert.equal(txt.scenes.length, 7);
  for (const scene of txt.scenes) assert.equal(scene.source, null, scene.sceneNo);

  const horizontal = await extractBytes('horizontal.pdf', HORIZONTAL_PDF);
  assert.deepEqual(horizontal.scenes.map((scene) => [scene.location, scene.source]), [['港', {page: 1, box: null}], ['港・倉庫', {page: 1, box: null}]]);

  const rotated = await extractBytes('rotated.pdf', ROTATED_PDF);
  assert.equal(rotated.scriptMeta.orientation, 'vertical');
  assert.deepEqual(rotated.scenes.map((scene) => [scene.location, scene.source?.page]), [['港', 2], ['港・倉庫', 2], ['灯台', 3]]);
  assert.ok(validBox(rotated.scenes[0].source.box) && validBox(rotated.scenes[1].source.box), JSON.stringify(rotated.scenes.map((scene) => scene.source)));
  assert.deepEqual(rotated.scenes[2].source, {page: 3, box: null});
});

test('FR-PROD-STRUCT-003 シーン番号・場所・昼夜・出演者・頁ごとに状態と60字以内の理由を返し、テキストの台本では頁の項目を返さない', async () => {
  for (const draft of DRAFTS) {
    const result = await extract(draft.file);
    const expected = expectedScenes(draft);
    assert.equal(result.scenes.length, expected.length, draft.file);
    result.scenes.forEach((scene, index) => {
      const want = expected[index];
      const label = `${draft.file} ${want.sceneNo}（${want.head}）`;
      assert.equal(scene.sceneNo, want.sceneNo, label);
      assert.deepEqual(Object.keys(scene.fields).sort(), ['cast', 'dayNight', 'location', 'pageEighths', 'sceneNo'], label);
      for (const [key, field] of Object.entries(scene.fields)) assertField(field, `${label} ${key}`);
      assert.deepEqual(scene.fields.sceneNo, {status: 'read', reason: draft.style === 'numbered' ? '柱の番号' : '番号の無い柱なので、順番で振った'}, label);
      assert.deepEqual(scene.fields.cast, {status: 'read', reason: want.speaks ? SPEAKERS : NO_SPEAKERS}, label);
      assert.deepEqual(scene.fields.pageEighths, {status: 'read', reason: '柱から次の柱までの列の数で計算'}, label);
      assert.deepEqual(scene.fields.dayNight, want.timeRead ? READ_TIME : want.inheritedFrom ? inherited(want.inheritedFrom) : NO_TIME, label);
      if (want.placeBefore) assert.deepEqual(scene.fields.location, samePlace(want.placeBefore), label);
      else if (want.head === 'メインタイトル') {
        assert.equal(scene.fields.location.status, 'inferred', label);
        assert.match(scene.fields.location.reason, /撮影しない見出し/, label);
      } else assert.deepEqual(scene.fields.location, {status: 'read', reason: null}, label);
    });
  }

  const txt = await extractTxt();
  assert.deepEqual(txt.scenes.map((scene) => scene.sceneNo), ['3-1', '3-2', '3-3', '3-4', '3-5', '3-6', '3-7']);
  for (const scene of txt.scenes) {
    assert.deepEqual(Object.keys(scene.fields).sort(), ['cast', 'dayNight', 'location', 'sceneNo'], scene.sceneNo);
    for (const [key, field] of Object.entries(scene.fields)) assertField(field, `${scene.sceneNo} ${key}`);
    assert.deepEqual(scene.fields.sceneNo, {status: 'read', reason: '番号の無い柱なので、順番で振った'}, scene.sceneNo);
  }
  const [harbor, , lighthouse, nowhere, garbled, title, mixed] = txt.scenes;
  assert.deepEqual([harbor.location, harbor.fields.location, harbor.fields.dayNight, harbor.fields.cast], ['港', {status: 'read', reason: null}, READ_TIME, {status: 'read', reason: SPEAKERS}]);
  assert.deepEqual([lighthouse.fields.cast, lighthouse.fields.dayNight], [{status: 'read', reason: NO_SPEAKERS}, NO_TIME]);
  assert.deepEqual([nowhere.location, nowhere.fields.location], ['', {status: 'missing', reason: '柱から場所を読めなかった'}]);
  assert.equal(garbled.fields.location.status, 'inferred');
  assert.match(garbled.fields.location.reason, /文字が化けている/);
  assert.equal(title.fields.location.status, 'inferred');
  assert.match(title.fields.location.reason, /撮影しない見出し/);
  assert.equal(mixed.fields.location.status, 'inferred');
  assert.match(mixed.fields.location.reason, /台詞が混ざっている/);

  // 縦書きで1頁の列の数が分からない（どの頁も列が5本に満たない）ときは頁を計算できない。横書きは行の数で計算する
  const rotated = await extractBytes('rotated.pdf', ROTATED_PDF);
  for (const scene of rotated.scenes) assert.deepEqual([scene.pageEighths, scene.fields.pageEighths], [null, {status: 'missing', reason: '頁を計算できなかった'}], scene.sceneNo);
  const horizontal = await extractBytes('horizontal.pdf', HORIZONTAL_PDF);
  for (const scene of horizontal.scenes) {
    assert.ok(scene.pageEighths >= 1, scene.sceneNo);
    assert.deepEqual(scene.fields.pageEighths, {status: 'read', reason: '柱から次の柱までの行の数で計算'}, scene.sceneNo);
  }
});

test('FR-PROD-STRUCT-004 「同・奥の書庫」は直前の場所「ふくろう堂・店内」で補った値になり、理由に補う前の直前の場所が入る', async () => {
  const draft = draftOf('fukurodo-ep08-kettei.pdf');
  // 元データ: 第8話の第2場は「ふくろう堂・店内（夜）」、第3場は「同・奥の書庫」
  assert.deepEqual(draft.episode.scenes.slice(1, 3).map((scene) => scene.head), ['ふくろう堂・店内（夜）', '同・奥の書庫']);
  const result = await extract(draft.file);
  const at = (sceneNo) => result.scenes.find((scene) => scene.sceneNo === sceneNo);
  assert.deepEqual([at('8-2').location, at('8-2').fields.location], ['ふくろう堂・店内', {status: 'read', reason: null}]);
  assert.equal(at('8-3').location, 'ふくろう堂・奥の書庫');
  assert.deepEqual(at('8-3').fields.location, {status: 'inferred', reason: '「同・」を直前の場所「ふくろう堂・店内」で補った'});
  // 3本のすべての「同・」の柱で、場所は直前の場所の「・」より前で補い、理由に補う前の直前の場所が入る
  let count = 0;
  for (const other of DRAFTS) {
    const scenes = (await extract(other.file)).scenes;
    expectedScenes(other).forEach((want, index) => {
      if (!want.placeBefore) return;
      count += 1;
      assert.deepEqual([scenes[index].location, scenes[index].fields.location], [want.place, samePlace(want.placeBefore)], `${other.file} ${want.sceneNo}`);
    });
  }
  assert.equal(count, 5 + 4 + 4, '同・の柱は第7話の決定稿に5つ、第8話の決定稿・準備稿に4つずつ');
});

test('FR-PROD-STRUCT-004 「同」で始まる場所の名前（同窓会会場）は「同・」として補わず、区切りのある「同　」だけを補う', async () => {
  const text = ['第3話 決定稿', '', '○港（夜）', '春川「来たか」', '○同窓会会場', '千尋「久しぶり」', '○同　ロビー', '店主「こちらへ」'].join('\n');
  const result = await extractBytes('dousoukai.txt', Buffer.from(text));
  assert.deepEqual(result.scenes.map((scene) => [scene.sceneNo, scene.location, scene.fields.location.status, scene.dayNight, scene.fields.dayNight.status]), [
    ['3-1', '港', 'read', 'N', 'read'],
    ['3-2', '同窓会会場', 'read', null, 'missing'],
    ['3-3', '同窓会会場・ロビー', 'inferred', null, 'missing'],
  ]);
  assert.equal(result.scenes[2].fields.location.reason, '「同・」を直前の場所「同窓会会場」で補った');
  assert.deepEqual(result.scriptMeta.rulesApplied.filter((rule) => ['same-place', 'inherit-day-night'].includes(rule.id)).map((rule) => `${rule.id}:${rule.count}`), ['same-place:1']);
});

test('FR-PROD-STRUCT-004 区切りが半角の中黒（･）・ラテン文字の中点（·）の「同」の柱も補い、直前の場所もその中黒より前を引き継いで「・」でつなぐ', async () => {
  const text = ['第6話 決定稿', '', '○ふくろう堂·店内（夜）', '千尋「閉めるよ」', '○同･奥の書庫', '蓮見「まだ」', '○同·階段', '千尋「待って」'].join('\n');
  const result = await extractBytes('dots.txt', Buffer.from(text));
  assert.deepEqual(result.scenes.map((scene) => [scene.sceneNo, scene.location, scene.fields.location.status, scene.dayNight, scene.fields.dayNight.status]), [
    ['6-1', 'ふくろう堂·店内', 'read', 'N', 'read'],
    ['6-2', 'ふくろう堂・奥の書庫', 'inferred', 'N', 'inferred'],
    ['6-3', 'ふくろう堂・階段', 'inferred', 'N', 'inferred'],
  ]);
  assert.equal(result.scenes[1].fields.location.reason, '「同・」を直前の場所「ふくろう堂·店内」で補った');
});

test('FR-PROD-STRUCT-004 先頭の柱が「同・」で直前の場所が無いときは、補えないことを印にして場所は原本のまま返す', async () => {
  const text = ['第4話 決定稿', '', '○同・倉庫', '店主「遅いぞ」', '○港（夜）', '春川「来たか」'].join('\n');
  const result = await extractBytes('first-same.txt', Buffer.from(text));
  assert.deepEqual(result.scenes.map((scene) => [scene.sceneNo, scene.location, scene.fields.location.status]), [['4-1', '同・倉庫', 'inferred'], ['4-2', '港', 'read']]);
  assert.equal(result.scenes[0].fields.location.reason, '「同・」の柱だが直前の場所が無い（原本で確かめる）');
  assert.equal(result.scriptMeta.rulesApplied.some((rule) => rule.id === 'same-place'), false);
});

test('FR-PROD-STRUCT-005 昼夜の無い「同・」の柱は直前のシーンの昼夜を引き継いだ補った値になり、直前に昼夜が無い柱と「同・」でない柱は空の読めない値になる', async () => {
  const ep8 = await extract('fukurodo-ep08-kettei.pdf');
  const at = (sceneNo) => ep8.scenes.find((scene) => scene.sceneNo === sceneNo);
  assert.deepEqual([at('8-2').dayNight, at('8-2').fields.dayNight], ['N', READ_TIME]);                 // ふくろう堂・店内（夜）
  assert.deepEqual([at('8-3').dayNight, at('8-3').fields.dayNight], ['N', inherited('8-2')]);          // 同・奥の書庫
  assert.deepEqual([at('8-9').dayNight, at('8-9').fields.dayNight], [null, NO_TIME]);                  // 同・書斎（直前の 8-8 蓮見の仕事場・玄関 に昼夜が無い）
  assert.deepEqual([at('8-28').dayNight, at('8-28').fields.dayNight], ['N', READ_TIME]);               // 同・表（夜）は柱の値
  // 引き継いだ昼夜を、続く「同・」がさらに引き継ぐ（第7話: 7-2 ふくろう堂・表（夜）→ 7-3 同・店内 → 7-4 同・奥の書庫）
  const ep7 = await extract('fukurodo-ep07-kettei.pdf');
  assert.deepEqual(ep7.scenes.slice(1, 4).map((scene) => [scene.sceneNo, scene.dayNight, scene.fields.dayNight]),
    [['7-2', 'N', READ_TIME], ['7-3', 'N', inherited('7-2')], ['7-4', 'N', inherited('7-3')]]);
  // 引き継いだ昼夜は、元データの昼夜（dn）と合う
  for (const draft of DRAFTS) {
    const scenes = (await extract(draft.file)).scenes;
    expectedScenes(draft).forEach((want, index) => {
      if (scenes[index].fields.dayNight.status === 'inferred') assert.equal(scenes[index].dayNight, want.truth.dn, `${draft.file} ${want.sceneNo}`);
    });
  }
  // 「同・」でない柱で昼夜が無いシーンは空のまま（テキストの台本の「○灯台」）。「○同・倉庫」は直前の「○港（夜）」から引き継ぐ
  const txt = await extractTxt();
  assert.deepEqual(txt.scenes.slice(0, 3).map((scene) => [scene.location, scene.dayNight, scene.fields.dayNight]),
    [['港', 'N', READ_TIME], ['港・倉庫', 'N', inherited('3-1')], ['灯台', null, NO_TIME]]);
});

const RULES = [
  ['vertical-columns', '縦書きの列を、右の列から順に組み直した'],
  ['trailing-time', '柱の末尾の（夜）・（昼）などを昼夜にした'],
  ['same-place', '「同・」は直前の場所の続きとして補った'],
  ['inherit-day-night', '「同・」の柱に昼夜が無いときは、直前のシーンの昼夜を引き継いだ'],
  ['speaker-cast', 'セリフの話者を出演者にした'],
  ['order-number', '番号の無い柱に、順番で番号を振った'],
  ['page-eighths', '柱から次の柱までの量で、頁（1/8）を計算した'],
];
const rulesOf = (counts) => RULES.filter(([id]) => counts[id] > 0).map(([id, label]) => ({id, label, count: counts[id]}));

test('FR-PROD-STRUCT-009 当てた変換の決まりを決まった順に、当てたシーン（縦書きの組み直しは頁）の数とともに返し、0件の決まりは返さない', async () => {
  for (const draft of DRAFTS) {
    const bytes = await readFile(new URL(draft.file, SCRIPTS));
    const [result, pages] = await Promise.all([extract(draft.file), pdfPages(bytes)]);
    const expected = expectedScenes(draft);
    const want = rulesOf({
      'vertical-columns': pages.filter(verticalPage).length,
      'trailing-time': expected.filter((scene) => scene.timeRead).length,
      'same-place': expected.filter((scene) => scene.placeBefore).length,
      'inherit-day-night': expected.filter((scene) => scene.inheritedFrom).length,
      'speaker-cast': expected.filter((scene) => scene.speaks).length,
      'order-number': draft.style === 'glyph' ? expected.length : 0,
      'page-eighths': expected.length,
    });
    assert.deepEqual(result.scriptMeta.rulesApplied, want, draft.file);
    // 数は、シーンごとの状態と出演者とも合う
    const count = (id) => result.scriptMeta.rulesApplied.find((rule) => rule.id === id)?.count ?? 0;
    const fields = result.scenes.map((scene) => scene.fields);
    assert.equal(count('trailing-time'), fields.filter((f) => f.dayNight.status === 'read').length, draft.file);
    assert.equal(count('same-place'), fields.filter((f) => f.location.reason?.startsWith('「同・」')).length, draft.file);
    assert.equal(count('inherit-day-night'), fields.filter((f) => f.dayNight.status === 'inferred').length, draft.file);
    assert.equal(count('speaker-cast'), result.scenes.filter((scene) => scene.cast.length).length, draft.file);
    assert.equal(count('page-eighths'), result.scenes.filter((scene) => scene.pageEighths >= 1).length, draft.file);
  }
  // 第8話の決定稿: 同・4つ（うち昼夜を引き継ぐのは 8-3 だけ）、台詞のある26シーン、14頁。番号のある柱なので order-number は入らない
  const ep8 = await extract('fukurodo-ep08-kettei.pdf');
  assert.deepEqual(ep8.scriptMeta.rulesApplied.map((rule) => [rule.id, rule.count]),
    [['vertical-columns', 14], ['trailing-time', 14], ['same-place', 4], ['inherit-day-night', 1], ['speaker-cast', 26], ['page-eighths', 28]]);
  // テキストの台本: 縦書きの組み直しと頁の計算は当てない
  const txt = await extractTxt();
  assert.deepEqual(txt.scriptMeta.rulesApplied, rulesOf({'trailing-time': 2, 'same-place': 1, 'inherit-day-night': 1, 'speaker-cast': 4, 'order-number': 7}));
  // 横書きのPDFは縦書きの組み直しを当てない。横書きの表紙＋縦書き2頁のPDFは、組み直した頁の数（3頁のうち2頁）。頁を計算できなければ page-eighths は入らない
  const horizontal = await extractBytes('horizontal.pdf', HORIZONTAL_PDF);
  assert.deepEqual(horizontal.scriptMeta.rulesApplied, rulesOf({'trailing-time': 1, 'same-place': 1, 'inherit-day-night': 1, 'speaker-cast': 2, 'order-number': 2, 'page-eighths': 2}));
  const rotated = await extractBytes('rotated.pdf', ROTATED_PDF);
  assert.deepEqual(rotated.scriptMeta.rulesApplied, rulesOf({'vertical-columns': 2, 'trailing-time': 2, 'same-place': 1, 'inherit-day-night': 1, 'speaker-cast': 3, 'order-number': 3}));
});
