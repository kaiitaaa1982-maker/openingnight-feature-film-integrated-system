const allowed=/\.(txt|csv|docx|xlsx|pdf)$/i;
const maxBytes=5*1024*1024;
const maxEncoded=7*1024*1024;
const maxResultChars=16*1024*1024;

function validate({name,base64}){if(!allowed.test(String(name||'')))throw new Error('TXT、CSV、DOCX、XLSX、PDFだけを抽出できます');if(typeof base64!=='string'||!base64||base64.length>maxEncoded)throw new Error('ファイルは5MB以内です');return {name:String(name),base64}}

export function createCloudExtractors({namespace,getContainer,sharedToken,timeoutMs=60_000,containerName='workbench-extractor-v1'}){
  if(!namespace||typeof getContainer!=='function'||!sharedToken)throw new Error('Container binding configuration is incomplete');
  const extract=async input=>{const payload=validate(input),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);try{const stub=getContainer(namespace,containerName),response=await stub.fetch(new Request('http://container.internal/extract',{method:'POST',headers:{'content-type':'application/json','x-openingnight-container-token':sharedToken},body:JSON.stringify(payload),signal:controller.signal}));const text=await response.text();if(text.length>maxResultChars)throw new Error('抽出結果が16MB上限を超えています');let result;try{result=JSON.parse(text)}catch{throw new Error('抽出Containerの応答を確認できません')}if(!response.ok||result.error)throw new Error(result.error||`抽出Containerが${response.status}を返しました`);return result}finally{clearTimeout(timer)}};
  return {extractWorkbenchFile:extract,extractDocument:extract};
}

export function createCloudAnalyticsBuilder({namespace,getContainer,sharedToken,timeoutMs=300_000,containerName='workbench-extractor-v1'}){
  if(!namespace||typeof getContainer!=='function'||!sharedToken)throw new Error('Container binding configuration is incomplete');
  return async frozen=>{const body=JSON.stringify(frozen);if(new TextEncoder().encode(body).byteLength>8*1024*1024)throw new Error('分析スナップショットが8MB上限を超えています');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);try{const response=await getContainer(namespace,containerName).fetch(new Request('http://container.internal/analytics/build',{method:'POST',headers:{'content-type':'application/json','x-openingnight-container-token':sharedToken},body,signal:controller.signal}));const text=await response.text();if(text.length>maxResultChars)throw new Error('分析成果物が16MB上限を超えています');let result;try{result=JSON.parse(text)}catch{throw new Error(`分析Container HTTP ${response.status}: ${text.replace(/<[^>]*>/g,' ').slice(0,1200)}`)}if(!response.ok||result.error||result.ok!==true)throw new Error(result.error||`分析Containerが${response.status}を返しました`);return result}finally{clearTimeout(timer)}};
}

export const cloudExtractorLimits={maxBytes,maxEncoded,maxResultChars};
