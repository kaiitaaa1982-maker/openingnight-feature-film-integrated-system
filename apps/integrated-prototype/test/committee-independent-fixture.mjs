import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';

export const expected=JSON.parse(readFileSync(new URL('../../../docs/platform/team-development/committee-report-expected.json',import.meta.url),'utf8'));
export const good=result=>{assert.ok(result.status<300&&result.data.ok,JSON.stringify(result));return result.data;};
// DB は試験の DB のファクトリ（test/test-db.mjs）で開く。ON_TEST_DB=pg なら PostgreSQL。t を渡すと試験の後に閉じる
export async function fixture({t}={}){
  const db=await openTestDb({t}),app=createApp({db});
  async function login(email){const response=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];}
  const admin=await login('admin@openingnight.invalid');
  async function req(path,body,cookie=admin){const response=await app.request('/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
  const intake=good(await req('/intakes',{workId:1,caseCode:'COMMITTEE-INDEPENDENT',title:'架空委員会契約',intakeType:'committee',documents:[{title:'架空製作委員会契約',reference:'独立検証用 COMMITTEE-001',versionLabel:'v1'}],scopes:[{channel:'digital/package',territory:'JP',rightsStart:'2026-09-01',rightsEnd:'2031-08-31',exclusivity:'exclusive'}],participants:[{partyKind:'partner',partnerId:1,role:'出資者・配信窓口',investmentYen:600000,explicitShareBps:6000},{partyKind:'partner',partnerId:2,role:'出資者・幹事・ビデオ窓口',investmentYen:400000,explicitShareBps:4000}]}));
  const intakeCase=(good(await req('/intakes?workId=1')).cases).find(item=>item.case_code==='COMMITTEE-INDEPENDENT');
  async function sale(key,kind,amount,options={}){return good(await req('/sales',{workId:1,report_key:key,kind,partner_id:kind==='digital'?2:3,product_id:kind==='digital'?1:2,period_from:'2026-09-01',period_to:'2026-09-30',recognition_basis_id:2,report_received_on:'2026-10-05',basis_reason:'架空月次報告の受領月',description:key,quantity:1,amount_ex_tax:amount,tax_amount:0,amount_inc_tax:amount,...options}));}
  await sale('COM-DIGITAL','digital',100000);await sale('COM-PACKAGE','package',80000);
  const reports=await db.all('SELECT * FROM report_imports ORDER BY id');
  await db.run("INSERT INTO expenses(id,org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(1,1,1,1,'2026-09-20','2026-09','宣伝','架空配信経費',3000,0,3000)");
  await db.run("INSERT INTO expenses(id,org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(2,1,1,1,'2026-09-21','2026-09','製造','架空ビデオ経費',6000,0,6000)");
  return {db,app,req,login,sale,intake,intakeCase,reports};
}
