import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
// DB は試験の DB のファクトリ（test/test-db.mjs）で開く。ON_TEST_DB=pg なら PostgreSQL。t を渡すと試験の後に閉じる
export async function setupMaster({t}={}) {
  const db=await openTestDb({t}),app=createApp({db});
  const login=async email=>(await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin=await login('admin@openingnight.invalid');
  const call=async(path,b,cookie=admin)=>{const r=await app.request('/api'+path,{method:b?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {status:r.status,data:await r.json()};};
  return {db,call,login};
}
export const meta={baseRevision:0,source_reference:'DEMO-REQ5（架空）',reason:'初回確認（架空）'};
