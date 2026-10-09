import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {detectEncoding, decodeText, ENCODING_LABELS} from '../src/import/text-decode.mjs';
import {parseCsv} from '../src/csv.mjs';

// Excel の「CSV（コンマ区切り）」で保存したときと同じ Shift_JIS（cp932）のバイト列。半角カナと丸数字（機種依存文字）を含む。
const SJIS_HEX = '8dec956943442c8fa49569bab0c4de2c90b396a194848fe30d0a57524b2d44454d4f2c534b552d444947492c3336373530300d0a89cb8bf387402cc3bdc42c2d310d0a';
const EXPECTED = '作品CD,商品ｺｰﾄﾞ,正味売上\r\nWRK-DEMO,SKU-DIGI,367500\r\n架空①,ﾃｽﾄ,-1\r\n';

test('Shift_JIS のCSVを判定し、半角カナ・丸数字を含めて文字化けせずに読む', () => {
  const bytes = Uint8Array.from(Buffer.from(SJIS_HEX, 'hex'));
  assert.equal(detectEncoding(bytes), 'shift_jis');
  const {text, encoding} = decodeText(bytes);
  assert.equal(encoding, 'shift_jis');
  assert.equal(text, EXPECTED);
  assert.equal(text.includes('�'), false, '置換文字が混ざらない');
  const rows = parseCsv(text);
  assert.deepEqual(Object.keys(rows[0].values), ['作品CD', '商品ｺｰﾄﾞ', '正味売上']);
  assert.equal(rows[1].values['作品CD'], '架空①');
  assert.equal(ENCODING_LABELS[encoding], 'Shift_JIS（Excel の既定のCSV）');
});

test('BOM付きUTF-8 は BOM を除いて読み、見出しの先頭に BOM が残らない', () => {
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from(EXPECTED, 'utf8')]);
  assert.equal(detectEncoding(bytes), 'utf-8-bom');
  const {text, encoding} = decodeText(bytes);
  assert.equal(encoding, 'utf-8-bom');
  assert.equal(text, EXPECTED);
  assert.equal(text.charCodeAt(0), '作'.charCodeAt(0));
  assert.equal(ENCODING_LABELS[encoding], 'UTF-8（BOM付き）');
});

test('BOMなしUTF-8 はそのまま UTF-8 として読む（Shift_JIS と取り違えない）', () => {
  const bytes = new TextEncoder().encode(EXPECTED);
  assert.equal(detectEncoding(bytes), 'utf-8');
  assert.equal(decodeText(bytes).text, EXPECTED);
  assert.equal(detectEncoding(new TextEncoder().encode('report id,net sales\n1,100\n')), 'utf-8', '英数字だけのファイルも UTF-8');
});

test('公開しているデモのCSV（BOM付きUTF-8）を判定どおりに読める', () => {
  const bytes = readFileSync(new URL('../public/demo-fixtures/streaming-platform-sample.csv', import.meta.url));
  const {text, encoding} = decodeText(bytes);
  assert.equal(encoding, 'utf-8-bom');
  assert.match(text.split(/\r?\n/)[1], /^"作品CD","商品ｺｰﾄﾞ"/);
});

test('UTF-8 でも Shift_JIS でも読めないバイト列は、日本語の理由で止める', () => {
  assert.throws(() => decodeText(Uint8Array.from([0x81, 0x20, 0xff, 0xfe])), /文字コードを判定できません/);
});
