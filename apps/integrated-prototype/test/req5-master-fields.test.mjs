import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {transform} from 'esbuild';
// JSX変換は文字列を渡し、依存先はNodeが解決したURLを使う。ファイル探索や一時生成物は不要。
const sourceUrl=new URL('../src/master-extensions/MasterVersionForm.jsx',import.meta.url);
const source=readFileSync(sourceUrl,'utf8').replace(/^import ['"].*\.css['"];?$/gm,'').replace(/from (['"])([^'"]+)\1/g,(_,quote,path)=>`from ${quote}${path.startsWith('.')?new URL(path,sourceUrl).href:import.meta.resolve(path)}${quote}`);
const compiled=await transform(source,{loader:'jsx',format:'esm',jsx:'transform'});
const {MasterField,MoneyFields,MasterVersionForm,RowActions}=await import('data:text/javascript;base64,'+Buffer.from(compiled.code).toString('base64'));
const h=React.createElement,render=component=>renderToStaticMarkup(component);
test('入力表示は未確認の空欄と0円を区別し、税区分・状態・評価日・根拠をそろえる',()=>{
  const fields={own_investment:'自社の出資額（税別）',promotion_budget:'宣伝費の予算'};
  const html=render(h(MoneyFields,{fields,draft:{own_investment_yen:0,own_investment_status:'confirmed'},set:()=>{}}));
  assert.match(html,/value="0"/);assert.match(html,/placeholder="未確認" value=""/);assert.match(html,/value="ex_tax" selected=""/);assert.match(html,/value="confirmed" selected=""/);assert.match(html,/評価日/);assert.match(html,/金額の根拠/);
  const ref=render(h(MoneyFields,{fields,draft:{},set:()=>{},reference:true}));assert.match(ref,/委員会の条件版の参照値を使います/);
});
test('閲覧専用フォームは入力を無効にし保存を出さず、版の根拠を選択肢に出す',()=>{
  const html=render(h(MasterVersionForm,{title:'作品の仕様',path:'/work-master/1/profile',saved:{revision:2,source_reference:'文書（架空）'},history:[{revision:1,created_at:'2026-09-28 00:00:00',reason:'初回（架空）'}],request:async()=>({}),canEdit:false,onSaved:async()=>{},readHistory:async()=>({})},draft=>h(MasterField,{label:'シリーズ',value:draft.series,onChange:()=>{}})));
  assert.match(html,/<fieldset disabled=""/);assert.doesNotMatch(html,/新しい版として保存/);assert.match(html,/初回（架空）/);assert.match(html,/閲覧のみ/);
});
test('行の上下移動は端だけ無効で、行を外す操作を表示する',()=>{
  const rows=[{name:'一（架空）'},{name:'二（架空）'}],html=render(h(RowActions,{rows,index:0,onChange:()=>{}}));
  assert.match(html,/<button type="button" disabled="">上へ/);assert.match(html,/<button type="button">下へ/);assert.match(html,/この行を外す/);
});
