import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';

export const good=result=>{assert.ok(result.status<300&&result.data.ok,JSON.stringify(result));return result.data;};
// DB は試験の DB のファクトリ（test/test-db.mjs）で開く。ON_TEST_DB=pg なら PostgreSQL。t を渡すと試験の後に閉じる。kind は試験の DB の種類（既定は ON_TEST_DB）
export async function fixture({t,kind}={}){
  const db=await openTestDb({t,kind}),app=createApp({db});
  async function login(email){const response=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];}
  const admin=await login('admin@openingnight.invalid');
  async function req(path,body,options={}){const response=await app.request('/api'+path,{method:options.method||(body?'POST':'GET'),headers:{cookie:options.cookie||admin,'content-type':'application/json',...(options.version?{'If-Match':String(options.version)}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
  const sceneIds=[];
  for(const sceneNo of ['A-01','A-02'])sceneIds.push(good(await req('/scenes',{project_id:1,work_id:1,scene_no:sceneNo,day_night:'N',location:'架空スタジオ',synopsis:`架空検証 ${sceneNo}`,status:'draft'})).id);
  const opportunity=good(await req('/opportunities',{project_id:1,work_id:1,partner_id:2,name:'独立検証・架空配信商談',stage:'proposal',expected_yen:150000,close_date:'2026-10-01'}));
  good(await req('/sales',{workId:1,report_key:'FIELD-SALES-REPORT',kind:'digital',partner_id:2,product_id:1,period_from:'2026-09-01',period_to:'2026-09-30',recognition_basis_id:2,report_received_on:'2026-10-05',basis_reason:'架空報告受領月',description:'架空売上',quantity:10,amount_ex_tax:8000,tax_amount:800,amount_inc_tax:8800}));
  const report=await db.get("SELECT * FROM report_imports WHERE report_key='FIELD-SALES-REPORT'");
  const originalSales=JSON.stringify(await db.all('SELECT * FROM sale_lines ORDER BY id'));
  return {db,app,req,login,sceneIds,opportunityId:opportunity.id,report,originalSales};
}
