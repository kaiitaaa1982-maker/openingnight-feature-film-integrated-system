import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script=fileURLToPath(new URL('../python/extract_document.py',import.meta.url));
export async function extractDocument({name,base64,maxBytes=8*1024*1024,timeoutMs=20_000,pythonPath=process.env.ON_PYTHON}){
  if(!pythonPath)throw new Error('ローカル抽出Pythonが設定されていません（ON_PYTHON）');
  if(typeof base64!=='string'||!base64)throw new Error('ファイル本文がありません');
  const bytes=Buffer.from(base64,'base64');
  if(!bytes.length||bytes.length>maxBytes)throw new Error(`ファイルは1〜${maxBytes}バイトにしてください`);
  if(bytes.toString('base64').replace(/=+$/,'')!==base64.replace(/\s/g,'').replace(/=+$/,''))throw new Error('Base64本文が不正です');
  return new Promise((resolve,reject)=>{
    const child=spawn(pythonPath,[script],{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'}});
    let stdout='',stderr='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value)};
    const timer=setTimeout(()=>{child.kill();finish(new Error('文書抽出がタイムアウトしました'))},timeoutMs);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>12*1024*1024){child.kill();finish(new Error('抽出結果が大きすぎます'))}});
    child.stderr.on('data',chunk=>{if(stderr.length<4000)stderr+=chunk});
    child.on('error',finish);
    child.stdin.on('error',error=>finish(error));
    child.on('close',code=>{if(done)return;let parsed;try{parsed=JSON.parse(stdout)}catch{finish(new Error('抽出器の応答を確認できません'));return}if(code!==0||parsed.error)finish(new Error(parsed.error||stderr||'文書抽出に失敗しました'));else finish(null,parsed)});
    child.stdin.end(JSON.stringify({name,base64}));
  });
}
