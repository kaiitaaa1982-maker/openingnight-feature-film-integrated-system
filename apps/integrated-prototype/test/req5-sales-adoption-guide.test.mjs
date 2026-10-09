import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {transformSync} from 'esbuild';
import {ADDITIONAL_SHEET_COLUMNS} from '../src/sales-sheet/column-registry.mjs';

// JSXだけ文字列から変換し、依存の解決はNodeに任せる（親ディレクトリを探索するbundleは不要）。
const hooks = registerHooks({load(url, context, nextLoad) {
  if (url.endsWith('.css')) return {format: 'module', source: '', shortCircuit: true};
  if (url.endsWith('.jsx')) return {format: 'module', source: transformSync(readFileSync(new URL(url), 'utf8'), {loader: 'jsx', format: 'esm'}).code, shortCircuit: true};
  return nextLoad(url, context);
}});
let AdoptionGuide, AdditionalAdoptionGuide;
try { ({AdoptionGuide, AdditionalAdoptionGuide} = await import('../src/sales-sheet/SalesSheet.jsx')); } finally { hooks.deregister(); }
const catalog = {adopted: true, canAdmin: true, additionalPending: 28, admins: [], additionalColumns: ADDITIONAL_SHEET_COLUMNS.map((c) => ({key: c.column_key, label: c.label, groupLabel: c.group_key}))};
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

for (const setKey of ['additional', 'all_plus']) {
  test(`${setKey}: 未採用の管理者に一覧・取り消せないこと・監査・理由・採用ボタンを表示する`, () => {
    const html = render(AdditionalAdoptionGuide, {catalog, setKey});
    assert.match(html, /追加の列がまだ採用されていません/);
    assert.match(html, /採用する列の一覧を見る（28列）/);
    for (const column of catalog.additionalColumns) assert.ok(html.includes(column.label), column.label);
    assert.match(html, /採用は取り消せません。/);
    assert.match(html, /採用した人・日時・理由は監査の記録に残ります/);
    assert.match(html, /追加の列を採用する理由/);
    assert.match(html, /<button type="button" disabled="">追加の列を採用する<\/button>/);
  });
  test(`${setKey}: 管理者以外には管理者の名前と依頼案内だけを表示する`, () => {
    const html = render(AdditionalAdoptionGuide, {catalog: {...catalog, canAdmin: false, admins: ['管理者A（架空）', '管理者B（架空）']}, setKey});
    assert.match(html, /この組織の管理者（管理者A（架空）・管理者B（架空））に、追加の列の採用を依頼してください。/);
    assert.doesNotMatch(html, /<button|<input/);
    const noContact = render(AdditionalAdoptionGuide, {catalog: {...catalog, canAdmin: false}, setKey});
    assert.match(noContact, /組織の管理者に、追加の列の採用を依頼してください。/);
  });
}

test('理由があれば採用可能、閲覧専用・処理中・空白の理由では採用できない', () => {
  const props = {catalog, additional: true, reason: '確認用（架空）'};
  assert.match(render(AdoptionGuide, props), /<button type="button">追加の列を採用する<\/button>/);
  for (const extra of [{readOnly: true}, {reason: '   '}]) {
    assert.match(render(AdoptionGuide, {...props, ...extra}), /<button type="button" disabled="">追加の列を採用する<\/button>/);
  }
  assert.match(render(AdoptionGuide, {...props, adopting: true}), /<button type="button" disabled="">採用しています…<\/button>/);
});

test('採用済み・通常セット・保存した形・83列も未採用のときは追加列の案内を出さない', () => {
  for (const props of [
    {catalog: {...catalog, additionalPending: 0}}, {setKey: 'all'}, {customColumns: 'work_code'}, {catalog: {...catalog, adopted: false}},
  ]) assert.equal(render(AdditionalAdoptionGuide, {catalog, setKey: 'additional', ...props}), '');
});
