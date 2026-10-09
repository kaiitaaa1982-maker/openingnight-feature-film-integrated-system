// 提案資料の画面の部品を文字列に描いて確かめる（JSX は esbuild で変換する。DOM は使わない）。
// 壊れたら: SVOD の提案期間を開始月＞終了月にして 400 になると入力欄ごと消えて画面から直せない・提案先の選択肢が全取引先の並びに戻る。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function renderer() {
  const {build} = await import('esbuild');
  const result = await build({
    stdin: {
      contents: "import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {SvodConditions, svodPartnerOptions} from './src/sales-ops/ProposalsPage.jsx'; import {FormField} from './src/ui/FormField.jsx';\n"
        + 'export const conditions = (props) => renderToStaticMarkup(React.createElement(SvodConditions, props));\n'
        + 'export const select = (props) => renderToStaticMarkup(React.createElement(FormField, {type: "select", label: "提案先", value: "", onChange: () => {}, ...props}));\n'
        + 'export {svodPartnerOptions};',
      resolveDir: appDir, loader: 'jsx', sourcefile: 'proposals-ui-entry.jsx',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', logLevel: 'silent', loader: {'.css': 'empty'},
  });
  const dir = mkdtempSync(join(tmpdir(), 'on-proposals-ui-'));
  const file = join(dir, 'proposals-ui.cjs');
  writeFileSync(file, result.outputFiles[0].text);
  try { return createRequire(import.meta.url)(file); } finally { rmSync(dir, {recursive: true, force: true}); }
}

const noop = () => {};
const error = Object.assign(new Error('提案期間の終了月が開始月より前です'), {status: 400, kind: 'validation'});

test('SVOD の提案期間: 400 で読めなくても、開始月・終了月の欄と「期間を既定に戻す」を出す（最初の読み込みで失敗して提案先の一覧が無くても）', async () => {
  const {conditions} = await renderer();
  const first = conditions({form: null, from: '2027-12', to: '2027-09', partnerParam: null, statusMode: 'all', error, onRetry: noop, set: noop, setPeriod: noop});
  assert.match(first, /提案期間（開始月）/);
  assert.match(first, /提案期間（終了月）/);
  assert.match(first, /value="2027-12"/, '打った値を欄に残す');
  assert.match(first, /期間を既定に戻す/);
  assert.doesNotMatch(first, /提案先<\/label>/, '提案先の一覧が無いときは提案先の欄は出さない');
  const later = conditions({form: {from: '2026-10', to: '2027-09', partner: {id: 2}, partners: [{id: 2, name: '配信A（架空）', svodContracts: 3, group: 'svod'}, {id: 5, name: '書房（架空）', svodContracts: 0, group: 'other'}]},
    from: '2027-12', to: '2027-09', partnerParam: '2', statusMode: 'all', error, onRetry: noop, set: noop, setPeriod: noop});
  assert.match(later, /提案先/);
  assert.match(later, /value="2027-12"/);
  assert.match(later, /期間を既定に戻す/);
  // 読めているときは「期間を既定に戻す」を出さない
  assert.doesNotMatch(conditions({form: {from: '2026-10', to: '2027-09', partner: null, partners: []}, from: '', to: '', partnerParam: null, statusMode: 'all', error: null, onRetry: noop, set: noop, setPeriod: noop}), /期間を既定に戻す/);
});

test('提案先の選択肢は見出し（SVOD の契約がある・配信・その他）でまとめ、明細0件は「全作品が新規」と書く。見出しの無い選択肢は今までどおり', async () => {
  const {select, svodPartnerOptions} = await renderer();
  const options = svodPartnerOptions([{id: 2, name: '配信A（架空）', svodContracts: 3, group: 'svod'}, {id: 3, name: '配信C（架空）', svodContracts: 1, group: 'svod'},
    {id: 4, name: '配信B（架空）', svodContracts: 0, group: 'platform'}, {id: 5, name: '書房（架空）', svodContracts: 0, group: 'other'}]);
  const html = select({options});
  assert.match(html, /<optgroup label="SVOD の契約がある取引先"><option value="2">配信A（架空）（SVOD の明細 3件）<\/option><option value="3">/);
  assert.match(html, /<optgroup label="配信の取引先（SVOD の契約なし）"><option value="4">配信B（架空）（SVOD の契約なし・全作品が新規）<\/option><\/optgroup>/);
  assert.match(html, /<optgroup label="その他の取引先">/);
  const plain = select({options: [{value: '1', label: '一'}, {value: '2', label: '二'}]});
  assert.doesNotMatch(plain, /optgroup/);
  assert.match(plain, /<option value="1">一<\/option><option value="2">二<\/option>/);
});
