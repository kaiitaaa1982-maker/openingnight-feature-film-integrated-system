import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {createHash} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LocalDatabase } from './db.mjs';
import { createApp } from './app.mjs';
import { extractDocument } from './local-extractor.mjs';
import {extractWorkbenchFile} from './workbench-extractor-local.mjs';
import {registerLocalWorkbenchAnalytics} from './workbench-analytics-local.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dbFile = process.env.ON_DB_FILE || resolve(root, 'data/integrated.sqlite');
const db = new LocalDatabase(dbFile);
const bundledPython=resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const pythonPath=process.env.ON_PYTHON||(existsSync(bundledPython)?bundledPython:null);
const app = createApp({ db, mode: 'local', extractDocument:pythonPath?input=>extractDocument({...input,pythonPath}):undefined,extractWorkbenchFile:pythonPath?input=>extractWorkbenchFile({...input,pythonPath}):undefined });
const analyticsRoot=resolve(root,'../../analytics-poc');
const sourceKey=createHash('sha256').update(resolve(dbFile).toLowerCase()).digest('hex').slice(0,16);
registerLocalWorkbenchAnalytics(app,{db,database:dbFile,root:process.env.ON_ANALYTICS_ROOT||resolve(analyticsRoot,'.runtime/workbench-sources',sourceKey),python:resolve(analyticsRoot,'.runtime/venv/Scripts/python.exe'),node:process.execPath,script:resolve(analyticsRoot,'run_workbench_snapshot.py')});

app.use('/*', serveStatic({ root: resolve(root, 'dist') }));
app.get('*', c => c.html(readFileSync(resolve(root, 'dist/index.html'), 'utf8')));

const port = Number(process.env.PORT || 9041);
const fetch = async request => {
  const url = new URL(request.url);
  if (!['127.0.0.1','localhost'].includes(url.hostname)) return new Response('ローカルホストだけを受け付けます。', { status: 403 });
  const response = await app.fetch(request);
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options','nosniff'); headers.set('X-Frame-Options','DENY'); headers.set('Referrer-Policy','no-referrer');
  headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
};
const server = serve({ fetch, hostname: '127.0.0.1', port }, info => {
  console.log(`OpeningNight 統合試作: http://${info.address}:${info.port}`);
});

for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  server.close(() => { db.close(); process.exit(0); });
});
