import {foreignKeyViolations} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,good} from './field-sales-independent-fixture.mjs';
import {roundRational} from '../src/tax.mjs';
const installDefault=f=>f.req('/tax/rules',{partnerId:null,baseVersion:0,effectiveFrom:'2026-01-01',effectiveTo:null,basis:'exclusive',grouping:'invoice',rounding:'truncate',precision:0,reason:'検証標準',evidence:'独立テスト入力'});

test('tax rounding defines negative truncate, half-up and away-from-zero ceil',()=>{
  assert.equal(roundRational(-15n,10n,0,'truncate'),-1);
  assert.equal(roundRational(-15n,10n,0,'half_up'),-2);
  assert.equal(roundRational(-11n,10n,0,'ceil'),-2);
  assert.equal(roundRational(1005n,100n,1,'half_up'),101);
});

test('tax preview requires explicit rates and invoice persists exact source/billed provenance',async(t)=>{const f=await fixture({t});try{
  good(await installDefault(f));
  const source=good(await f.req(`/tax/sources?workId=1&reportIds=${f.report.id}`));assert.equal(source.partnerId,2);assert.equal(source.lines.length,1);
  assert.equal((await f.req('/tax/preview',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',lineRates:[]})).status,400);
  const lineRates=[{saleId:source.lines[0].id,category:'standard',rateBps:1000}],preview=good(await f.req('/tax/preview',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',lineRates}));assert.equal(preview.billed.taxAmount,800);assert.equal(preview.lines[0].exactNumerator,'800');assert.equal(preview.lines[0].exactDenominator,'1');
  const invoice=good(await f.req('/billing/invoices',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',dueDate:'2026-11-30',sourceAmountBasis:'platform_net',tax:{previewHash:preview.previewHash,ruleVersionId:preview.rule.id,lineRates}}));assert.equal(invoice.provenance,'calculated');assert.equal(invoice.taxSnapshotId,1);
  const detail=good(await f.req(`/tax/snapshots/${invoice.taxSnapshotId}`));assert.equal(detail.snapshot.source_tax,800);assert.equal(detail.rateTotals[0].billed_tax,800);assert.equal(detail.lines[0].sale_id,source.lines[0].id);
  const ledger=good(await f.req('/tax/ledger?month=2026-10&asOf=2026-10-31'));assert.deepEqual(ledger.totals,{count:1,unknownCount:0,amountExTax:8000,billedTax:800,amountIncTax:8800,sourceTax:800,delta:0});assert.equal(ledger.rows[0].invoice_number,invoice.invoiceNumber);
  assert.deepEqual(await foreignKeyViolations(f.db),[]);
}finally{f.db.close()}});

test('tax rule revisions supersede open prior versions without mutation and stale preview is rejected',async(t)=>{const f=await fixture({t});try{
  const rule=good(await f.req('/tax/rules',{partnerId:2,baseVersion:0,effectiveFrom:'2026-10-01',effectiveTo:null,basis:'exclusive',grouping:'voucher',rounding:'half_up',precision:2,reason:'取引先別検証',evidence:'架空合意'})).rule;assert.equal(rule.version,1);
  const source=good(await f.req(`/tax/sources?workId=1&reportIds=${f.report.id}`)),lineRates=[{saleId:source.lines[0].id,category:'standard',rateBps:1000}],preview=good(await f.req('/tax/preview',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',lineRates}));assert.equal(preview.rule.id,rule.id);assert.equal(preview.reference.precision,2);
  good(await f.req('/tax/rules',{partnerId:2,baseVersion:1,effectiveFrom:'2026-10-05',effectiveTo:null,basis:'exclusive',grouping:'invoice',rounding:'truncate',precision:0,reason:'後続版',evidence:'架空改訂'}));
  const stale=await f.req('/billing/invoices',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',dueDate:'2026-11-30',sourceAmountBasis:'platform_net',tax:{previewHash:preview.previewHash,ruleVersionId:preview.rule.id,lineRates}});assert.equal(stale.status,409);assert.equal((await f.db.get('SELECT COUNT(*) n FROM billing_invoices')).n,0);assert.equal((await f.db.get('SELECT COUNT(*) n FROM tax_rule_versions')).n,2);
}finally{f.db.close()}});

test('legacy invoices stay unknown and voided calculated invoices leave as-of totals once',async(t)=>{const f=await fixture({t});try{
  good(await installDefault(f));
  const legacy=good(await f.req('/billing/invoices',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',dueDate:'2026-11-30',sourceAmountBasis:'platform_net'}));let ledger=good(await f.req('/tax/ledger?month=2026-10&asOf=2026-10-06'));assert.equal(ledger.rows[0].provenance,'unknown');assert.equal(ledger.totals.unknownCount,1);
  good(await f.req(`/billing/invoices/${legacy.invoiceId}/void`,{voidedOn:'2026-10-07',reason:'再発行検証'},{version:1}));
  const source=good(await f.req(`/tax/sources?workId=1&reportIds=${f.report.id}`)),lineRates=[{saleId:source.lines[0].id,category:'standard',rateBps:1000}],preview=good(await f.req('/tax/preview',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-08',lineRates})),invoice=good(await f.req('/billing/invoices',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-08',dueDate:'2026-11-30',sourceAmountBasis:'platform_net',reissueOfInvoiceId:legacy.invoiceId,reissueReason:'取消後の再発行',tax:{previewHash:preview.previewHash,ruleVersionId:preview.rule.id,lineRates}}));assert.equal(invoice.amountIncTax,8800);
  ledger=good(await f.req('/tax/ledger?month=2026-10&asOf=2026-10-31'));assert.equal(ledger.rows.length,2);assert.equal(ledger.totals.count,1);assert.equal(ledger.totals.amountIncTax,8800);assert.equal(ledger.rows.find(x=>x.invoiceId===invoice.invoiceId).priorInvoiceId,legacy.invoiceId);
}finally{f.db.close()}});

test('tax endpoints enforce finance scope and reject unsupported negative groups',async(t)=>{const f=await fixture({t});try{
  good(await installDefault(f));
  const production=await f.login('production@openingnight.invalid');assert.equal((await f.req(`/tax/sources?workId=1&reportIds=${f.report.id}`,null,{cookie:production})).status,403);assert.equal((await f.req('/tax/ledger?month=2026-10',null,{cookie:production})).status,403);
  await f.db.run('UPDATE sale_lines SET amount_ex_tax=-8000,tax_amount=-800,amount_inc_tax=-8800 WHERE id=1');const source=good(await f.req(`/tax/sources?workId=1&reportIds=${f.report.id}`));const result=await f.req('/tax/preview',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',lineRates:[{saleId:source.lines[0].id,category:'standard',rateBps:1000}]});assert.equal(result.status,400);assert.match(result.data.error,/負数/);
}finally{f.db.close()}});

test('expired latest partner rule falls back to default instead of resurrecting an older partner rule',async(t)=>{const f=await fixture({t});try{
  const standard=good(await installDefault(f)).rule;
  good(await f.req('/tax/rules',{partnerId:2,baseVersion:0,effectiveFrom:'2026-02-01',effectiveTo:null,basis:'inclusive',grouping:'voucher',rounding:'half_up',precision:2,reason:'旧取引先版',evidence:'旧合意'}));
  good(await f.req('/tax/rules',{partnerId:2,baseVersion:1,effectiveFrom:'2026-03-01',effectiveTo:'2026-03-31',basis:'exclusive',grouping:'invoice',rounding:'ceil',precision:1,reason:'期限付き最新版',evidence:'期限付き合意'}));
  const resolved=good(await f.req('/tax/rules?partnerId=2&asOf=2026-04-01')).resolvedRule;assert.equal(resolved.id,standard.id);assert.equal(resolved.scope_type,'default');
}finally{f.db.close()}});

test('ledger hides a shared-work invoice unless every allocated work is authorized',async(t)=>{const f=await fixture({t});try{
  good(await installDefault(f));const project=good(await f.req('/projects',{code:'TAX-SHARED',title:'税権限境界',status:'active'})),work=good(await f.req('/works',{project_id:project.id,code:'TAX-SHARED-W',title:'共有税作品',format:'film'}));await f.db.batch([{sql:'UPDATE product_works SET allocation_bps=6000 WHERE org_id=1 AND product_id=1 AND work_id=1'},{sql:'INSERT INTO product_works VALUES(1,1,?,4000)',params:[work.id]}]);
  const source=good(await f.req(`/tax/sources?workId=1&reportIds=${f.report.id}`)),lineRates=[{saleId:source.lines[0].id,category:'standard',rateBps:1000}],preview=good(await f.req('/tax/preview',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',lineRates}));good(await f.req('/billing/invoices',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',dueDate:'2026-11-30',sourceAmountBasis:'platform_net',tax:{previewHash:preview.previewHash,ruleVersionId:preview.rule.id,lineRates}}));
  const editor=await f.login('editor@openingnight.invalid'),ledger=good(await f.req('/tax/ledger?month=2026-10&asOf=2026-10-31',null,{cookie:editor}));assert.equal(ledger.rows.length,0);assert.equal(ledger.totals.count,0);
}finally{f.db.close()}});
