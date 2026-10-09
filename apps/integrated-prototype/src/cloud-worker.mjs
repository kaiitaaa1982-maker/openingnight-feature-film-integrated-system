import { getContainer } from '@cloudflare/containers';
import { createApp } from './app.mjs';
import { identityForEmail } from './session-org.mjs';
import { restartWorkbenchRuntime } from './cloud-runtime-restart.mjs';
import { WorkersAiAdapter } from './ai-adapter.mjs';
import { createCloudRuntime } from './cloud-runtime.mjs';
import { registerCloudAnalyticsRoutes } from './cloud-analytics.mjs';
import { respondToMediaRange } from './cloud-media.mjs';
import { cloudConfig as config, isSafeCloudRequest as isSafeRequest, verifyAccessToken } from './cloud-security.mjs';
import { CloudDatabaseConfigError, CloudDatabaseUnavailableError, DATABASE_UNAVAILABLE_MESSAGE, releaseCloudDatabase } from './data-platform/cloud-db.mjs';
import { HEALTH_DB_PATH, respondDatabaseHealth } from './data-platform/cloud-health.mjs';
import { runScheduledPgExport } from './data-platform/cloud-pg-export.mjs';
export { WorkbenchExtractContainer } from './cloud-container.mjs';

// pg は DATABASE_ENGINE が postgres の要求で、最初の問い合わせのときにだけ読み込む（d1 の道では評価しない）
const loadPgClient = () => import('pg').then(module => module.Client ?? module.default.Client);
const securityHeaders = {
  'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
};

async function authenticateAccess(request, db, env, cfg) {
  // JWT（発行者・AUD・RS256・exp・メール）の検証は cloud-security.mjs の verifyAccessToken
  const payload=await verifyAccessToken(request,cfg);if(!payload)return null;
  const email=payload.email.trim().toLowerCase();
  // 所属は Cookie on_org で本人が選んだ組織（所属を確かめ、無効なら org_id が最小の組織。
  // 既定へ戻したとき・画面の組織（X-On-Org）と食い違うときは、/api/session 系のほかは app.mjs が 409 にする）。
  // DB の失敗は前と同じく null にせず投げる（postgres で接続できなければ fetch が 503 にする）
  return identityForEmail(db,email,request.headers.get('cookie'),Date.now());
}

export default {
  async scheduled(_event, env, _ctx) {
    await runScheduledPgExport(env, {loadClient: loadPgClient});
  },
  async fetch(request, env, ctx) {
    const cfg=config(env);if(!cfg)return new Response('統合試作の配備は無効です。',{status:503,headers:securityHeaders});
    if(!isSafeRequest(request,cfg))return new Response('許可されたオリジンから操作してください。',{status:403,headers:securityHeaders});
    let runtime;
    try { runtime=createCloudRuntime(env,ctx,{loadClient:loadPgClient}); }
    catch (error) { if(error instanceof CloudDatabaseConfigError)return new Response('統合試作の配備は無効です。',{status:503,headers:securityHeaders}); throw error; }
    // postgres で開いた接続は、応答を作り終えたら ctx.waitUntil で閉じる（d1 では何もしない）。接続できなければ 503（中身を出さない）
    try { return await handle(request,env,cfg,runtime); }
    catch (error) { if(error instanceof CloudDatabaseUnavailableError)return new Response(DATABASE_UNAVAILABLE_MESSAGE,{status:503,headers:securityHeaders}); throw error; }
    finally { releaseCloudDatabase(runtime.db); }
  }
};

async function handle(request, env, cfg, {db,extractDocument,extractWorkbenchFile,containerBuild}) {
    // ヘルス専用の経路（GET /api/health/db）。サービストークン（メールなし）の JWT でも通り、DB の種類と SELECT 1 の成否だけを返す
    if(new URL(request.url).pathname===HEALTH_DB_PATH)return respondDatabaseHealth(request,{cfg,db,headers:securityHeaders});
    const aiAdapter=new WorkersAiAdapter({binding:env.AI,enabled:env.AI_ENABLED==='true',model:env.AI_MODEL,modelAllowlist:(env.AI_MODEL_ALLOWLIST||'').split(',').filter(Boolean),maxCalls:Number(env.AI_MAX_CALLS||0),maxTokens:Number(env.AI_MAX_TOKENS||0)});
    const identity=await authenticateAccess(request,db,env,cfg);
    if(!identity)return new Response('Cloudflare Accessと有効なチーム所属を確認できません。',{status:403,headers:securityHeaders});
    if(new URL(request.url).pathname==='/api/workbench/runtime/restart'&&request.method==='POST'){
      // 権限とロックは分析の組織（1）で確かめる（コンテナは全組織で共有。cloud-runtime-restart.mjs）
      const result=await restartWorkbenchRuntime({db,identity,request,destroy:()=>getContainer(env.WORKBENCH_CONTAINER,'workbench-extractor-v1').destroy()});
      return Response.json(result.body,{status:result.status,headers:securityHeaders});
    }
    const app=createApp({db,mode:'worker',authenticate:async()=>identity,extractDocument,extractWorkbenchFile,ai:aiAdapter,suggestMappings:aiAdapter.enabled?request=>aiAdapter.suggestMappings(request):undefined});
    // 分析の写しも入口（db）の読み取りの一括で読む。D1 の束ねを直接渡さない（FR-CORE-DATA-010。R2BackedD1Database の readBatch が D1 の素の batch を1回呼ぶ）
    registerCloudAnalyticsRoutes(app,{db,bucket:env.PRIVATE_ARTIFACTS,registrationId:env.CLOUD_ANALYTICS_REGISTRATION_ID,definitionVersion:env.CLOUD_ANALYTICS_DEFINITION_VERSION,containerBuild});
    const url=new URL(request.url);let response;
    const isDemoVideo=url.pathname==='/workflow-demo/human-workflow-demo.mp4';
    if(url.pathname.startsWith('/api/')) response=await app.fetch(request,env);
    else {const assetRequest=isDemoVideo&&request.method==='HEAD'?new Request(request,{method:'GET'}):request;response=await env.ASSETS.fetch(assetRequest);if(isDemoVideo)response=await respondToMediaRange(assetRequest,response)}
    const headers=new Headers(response.headers);for(const [key,value] of Object.entries(securityHeaders))headers.set(key,value);
    const body=isDemoVideo?(request.method==='HEAD'?null:await response.arrayBuffer()):response.body;
    return new Response(body,{status:response.status,statusText:response.statusText,headers});
}

export { config, authenticateAccess, isSafeRequest };
