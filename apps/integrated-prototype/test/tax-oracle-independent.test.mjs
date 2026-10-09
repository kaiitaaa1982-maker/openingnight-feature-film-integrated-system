import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {roundRational} from '../src/tax.mjs';
import {fixture,good} from './field-sales-independent-fixture.mjs';

// Expected values were generated separately with Python fractions.Fraction.
// Includes exact halves, recurring fractions, signed values and the safe-integer boundary.
test('tax rounding agrees with 168 independent exact Fraction results',()=>{
 const fixture=JSON.parse(readFileSync(new URL('../fixtures/tax-rounding-independent.json',import.meta.url),'utf8'));
 assert.equal(fixture.cases.length,168);
 for(const row of fixture.cases){
  assert.equal(String(roundRational(row.numerator,row.denominator,row.precision,row.mode)),row.expectedScaled,JSON.stringify(row));
 }
 assert.throws(()=>roundRational('9007199254740992','1'),/安全/);
 assert.throws(()=>roundRational('1','0'),/分母/);
});

test('monthly ledger rejects impossible dates and uses the real month end',async(t)=>{
 const f=await fixture({t});try{
  assert.equal((await f.req('/tax/ledger?month=2026-13')).status,400);
  assert.equal((await f.req('/tax/ledger?month=2026-02&asOf=2026-02-30')).status,400);
  assert.equal((await f.req('/tax/ledger?month=2026-02')).data.asOf,'2026-02-28');
 }finally{f.db.close()}
});

test('tax correction voids and reissues without losing either computation or double counting',async(t)=>{
 const f=await fixture({t});try{
  good(await f.req('/tax/rules',{partnerId:null,baseVersion:0,effectiveFrom:'2026-01-01',basis:'exclusive',grouping:'invoice',rounding:'truncate',precision:0,reason:'訂正検証',evidence:'架空テスト'}));
  const lines=good(await f.req(`/tax/sources?workId=1&reportIds=${f.report.id}`)).lines;
  const rates=lines.map(l=>({saleId:l.id,category:'standard',rateBps:1000}));
  const make=async(date,prior)=>{
   const input={workId:1,reportIds:[f.report.id],invoiceDate:date,lineRates:rates};
   const preview=good(await f.req('/tax/preview',input));
   return good(await f.req('/billing/invoices',{...input,dueDate:'2026-11-30',sourceAmountBasis:'platform_net',tax:{previewHash:preview.previewHash,ruleVersionId:preview.rule.id,lineRates:rates},...(prior?{reissueOfInvoiceId:prior,reissueReason:'帳票再発行の架空検証'}:{})}));
  };
  const original=await make('2026-10-06');
  good(await f.req(`/billing/invoices/${original.invoiceId}/void`,{voidedOn:'2026-10-07',reason:'訂正のため取消'},{version:1}));
  const corrected=await make('2026-10-08',original.invoiceId);
  const ledger=good(await f.req('/tax/ledger?month=2026-10&asOf=2026-10-08'));
  assert.equal(ledger.rows.length,2);assert.equal(ledger.totals.count,1);
  assert.equal(ledger.totals.billedTax,corrected.taxAmount);
  assert.equal(ledger.rows.find(r=>r.invoiceId===corrected.invoiceId).priorInvoiceId,original.invoiceId);
  assert.equal(good(await f.req(`/tax/snapshots/${original.taxSnapshotId}`)).snapshot.invoice_id,original.invoiceId);
  assert.equal(good(await f.req('/tax/ledger?month=2026-10&asOf=2026-10-06')).totals.billedTax,original.taxAmount);
 }finally{f.db.close()}
});
