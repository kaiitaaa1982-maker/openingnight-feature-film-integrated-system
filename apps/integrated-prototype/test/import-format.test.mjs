import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestSalesImportFormats,preflightSalesImport} from '../src/import-format.mjs';

test('report format suggestion exposes evidence and still requires a human choice',()=>{
  const suggested=suggestSalesImportFormats({headers:['取引先ID','サービスコード','視聴秒','販売件数'],rows:[{'取引先ID':'2','サービスコード':'EST','視聴秒':'100','販売件数':'1'}]});
  assert.equal(suggested.recommended,'digital');
  assert.equal(suggested.confidence,'high');
  assert.equal(suggested.requiresHumanConfirmation,true);
  assert.ok(suggested.candidates[0].evidence.some(item=>item.headers.includes('視聴秒')));
  assert.equal(suggestSalesImportFormats({headers:['report_key','partner_id','amount_ex_tax']}).recommended,null);
});

test('mixed report indicators remain ambiguous',()=>{
  const suggested=suggestSalesImportFormats({headers:['券種','視聴秒','報告種別'],rows:[{'報告種別':'劇場'},{'報告種別':'配信'}]});
  assert.equal(suggested.ambiguous,true);
  assert.equal(suggested.recommended,null);
  assert.equal(suggested.confidence,'low');
});

const source=[{'報告キー':'r-1','取引先ID':'002','商品ID':'10'},{'報告キー':'r-1','取引先ID':'2','商品ID':'10'}];
const canonical=[
  {report_key:'r-1',partner_id:2,product_id:10,kind:'digital',amount_ex_tax:100,tax_amount:10,amount_inc_tax:110},
  {report_key:'r-1',partner_id:2,product_id:10,kind:'digital',amount_ex_tax:-20,tax_amount:-2,amount_inc_tax:-22}
];
const totals={rowCount:2,amountExTax:80,taxAmount:8,amountIncTax:88,byChannel:{digital:{rowCount:2,amountExTax:80,taxAmount:8,amountIncTax:88}}};
const idColumns={report_key:'報告キー',partner_id:'取引先ID',product_id:'商品ID'};

test('preflight reconciles explicit source controls and IDs, but cannot authorize posting',()=>{
  const result=preflightSalesImport({sourceDetailRows:source,canonicalRows:canonical,sourceTotals:totals,sourceIdentifierColumns:idColumns,requiredIds:['report_key','partner_id','product_id']});
  assert.equal(result.blocking,false);
  assert.equal(result.readyForHumanReview,true);
  assert.equal(result.canCommit,false);
  assert.equal(result.requiresHumanConfirmation,true);
  assert.equal(result.checks.find(check=>check.key==='amount:amount_ex_tax').actual,'80');
  assert.equal(result.checks.find(check=>check.key==='source-id:partner_id').status,'pass');
});

test('preflight blocks mismatched source total, missing ID, and channel control',()=>{
  const rows=canonical.map(row=>({...row}));
  rows[1].partner_id=null;
  const result=preflightSalesImport({sourceDetailRows:source,canonicalRows:rows,sourceTotals:{...totals,amountExTax:81,byChannel:{digital:{rowCount:1,amountExTax:80}}},sourceIdentifierColumns:idColumns});
  assert.equal(result.blocking,true);
  assert.equal(result.status,'blocked');
  assert.ok(result.failures.some(check=>check.key==='amount:amount_ex_tax'));
  assert.ok(result.failures.some(check=>check.key==='source-id:partner_id'));
  assert.ok(result.failures.some(check=>check.key==='channel:digital:rowCount'));
});

test('package inventory observation counts as a report row without becoming sale revenue',()=>{
  const sourceRows=[{'報告キー':'pkg-1','取引先ID':'2'},{'報告キー':'pkg-1','取引先ID':'2'}];
  const sale={report_key:'pkg-1',partner_id:2,kind:'package',amount_ex_tax:100,tax_amount:10,amount_inc_tax:110};
  const observation={report_key:'pkg-1',partner_id:2,kind:'package',destination:'inventory_observation',inventory_count:30};
  const controls={rowCount:2,amountExTax:100,taxAmount:10,amountIncTax:110,byChannel:{package:{rowCount:2,amountExTax:100,taxAmount:10,amountIncTax:110}}};
  const result=preflightSalesImport({sourceDetailRows:sourceRows,reportRows:[sale,observation],canonicalRows:[sale],sourceTotals:controls,sourceIdentifierColumns:{report_key:'報告キー',partner_id:'取引先ID'}});
  assert.equal(result.blocking,false);
  assert.equal(result.checks.find(check=>check.key==='source-row-count').status,'pass');
  assert.equal(result.checks.find(check=>check.key==='channel:package:rowCount').actual,'2');
  assert.equal(result.checks.find(check=>check.key==='channel:package:amountExTax').actual,'100');
  assert.equal(result.canCommit,false);
  const onlyObservation=preflightSalesImport({sourceDetailRows:sourceRows.slice(0,1),reportRows:[observation],canonicalRows:[],sourceTotals:{rowCount:1,amountExTax:0,taxAmount:0,amountIncTax:0,byChannel:{package:{rowCount:1,amountExTax:0,taxAmount:0,amountIncTax:0}}},sourceIdentifierColumns:{report_key:'報告キー',partner_id:'取引先ID'}});
  assert.equal(onlyObservation.blocking,false);
  assert.equal(onlyObservation.checks.find(check=>check.key==='nonempty').status,'pass');
});

test('unknown controls stay unverified and invalid amounts are not read as zero',()=>{
  const unknown=preflightSalesImport({canonicalRows:[canonical[0]]});
  assert.equal(unknown.status,'unverified');
  assert.ok(unknown.unverified.some(check=>check.key==='control-row-count'));
  const bad=preflightSalesImport({canonicalRows:[{...canonical[0],tax_amount:''}]});
  assert.equal(bad.blocking,true);
  assert.ok(bad.failures.some(check=>check.key==='amount:tax_amount'));
  assert.throws(()=>preflightSalesImport({canonicalRows:canonical,sourceTotals:{rowCount:'1.5'}}),/整数/);
  assert.equal(preflightSalesImport({canonicalRows:[]}).blocking,true);
  assert.ok(preflightSalesImport({sourceDetailRows:source.slice(0,1),canonicalRows:canonical}).failures.some(check=>check.key==='source-row-count'));
});

test('blank source IDs never appear as fully reconciled',()=>{
  const incomplete=[source[0],{...source[1],'取引先ID':''}];
  const explicit=preflightSalesImport({sourceDetailRows:incomplete,canonicalRows:canonical,sourceIdentifierColumns:idColumns});
  assert.equal(explicit.checks.find(check=>check.key==='source-id:partner_id').status,'fail');
  const inferred=preflightSalesImport({sourceDetailRows:[{partner_id:'2'},{partner_id:''}],canonicalRows:canonical});
  assert.equal(inferred.checks.find(check=>check.key==='source-id:partner_id').status,'unverified');
});
