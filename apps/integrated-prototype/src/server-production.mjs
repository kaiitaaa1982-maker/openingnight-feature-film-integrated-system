import {serve} from '@hono/node-server';
import {serveStatic} from '@hono/node-server/serve-static';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalDatabase} from './db.mjs';
import {createApp} from './app.mjs';
import {extractDocument} from './local-extractor.mjs';
import {extractWorkbenchFile} from './workbench-extractor-local.mjs';
import {registerLocalWorkbenchAnalytics} from './workbench-analytics-local.mjs';
import {productionConfig,productionGateway} from './production-gateway.mjs';

productionConfig(process.env); // Fail closed before opening any database.
for(const key of ['ON_DB_FILE','ON_PYTHON','ON_ANALYTICS_PYTHON','ON_ANALYTICS_ROOT'])if(!process.env[key])throw Error(`${key} is required`);
if(!existsSync(process.env.ON_DB_FILE))throw Error('移行検証済みDBが必要です。空DBを自動生成しません');
const root=fileURLToPath(new URL('../',import.meta.url)),db=new LocalDatabase(resolve(process.env.ON_DB_FILE));
const identities=new WeakMap();
const app=createApp({db,mode:'production',authenticate:async request=>identities.get(request),
  extractDocument:input=>extractDocument({...input,pythonPath:process.env.ON_PYTHON}),
  extractWorkbenchFile:input=>extractWorkbenchFile({...input,pythonPath:process.env.ON_PYTHON})});
 registerLocalWorkbenchAnalytics(app,{db,database:resolve(process.env.ON_DB_FILE),root:resolve(process.env.ON_ANALYTICS_ROOT),python:process.env.ON_ANALYTICS_PYTHON,node:process.execPath,script:resolve(root,'../../analytics-poc/run_workbench_snapshot.py')});
app.use('/*',serveStatic({root:resolve(root,'dist')}));
app.get('*',c=>c.html(readFileSync(resolve(root,'dist/index.html'),'utf8')));
const fetch=productionGateway({db,env:process.env,handle:async(request,identity)=>{
 identities.set(request,identity);
 try{return await app.fetch(request)}finally{identities.delete(request)}
}});
const server=serve({fetch,hostname:process.env.ON_BIND_HOST||'127.0.0.1',port:Number(process.env.PORT||9050)},()=>console.log('認証付き専用環境の原点が起動しました'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0)}));
