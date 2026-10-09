import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function extractWorkbenchFile({name,base64,pythonPath}){
 if(!/\.(csv|xlsx)$/i.test(name||'')||typeof base64!=='string'||base64.length>7*1024*1024)throw Error('5MB以内のCSV・XLSXを選んでください');
 return new Promise((resolve,reject)=>{
  const child=spawn(pythonPath,[fileURLToPath(new URL('../python/workbench_extract.py',import.meta.url))],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  let data='',done=false;const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result)};
  const timer=setTimeout(()=>{child.kill();finish(Error('表の読取がタイムアウトしました'))},30000);
  child.stdout.on('data',chunk=>{data+=chunk;if(data.length>16*1024*1024){child.kill();finish(Error('読取結果が大きすぎます'))}});
  child.stderr.on('data',()=>{});child.on('error',finish);child.stdin.on('error',finish);
  child.on('close',code=>{try{const result=JSON.parse(data);if(code||result.error)finish(Error(result.error||'読取に失敗しました'));else finish(null,result)}catch{finish(Error('読取結果を確認できません'))}});
  child.stdin.end(JSON.stringify({name,base64}));
 });
}
