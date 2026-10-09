import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createApp } from './app.mjs';
import { identityForEmail } from './session-org.mjs';
import { D1Database } from './d1-db.mjs';
import { WorkersAiAdapter } from './ai-adapter.mjs';

const keysets = new Map();
const securityHeaders = {
  'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
};

function config(env) {
  if (env.DEPLOYMENT_ENABLED !== 'true') return null;
  const domain=env.ACCESS_TEAM_DOMAIN||'',aud=env.ACCESS_AUD||'';
  if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)||!aud.trim()||!env.DB||!env.ASSETS)return null;
  return {domain,aud};
}

async function authenticateAccess(request, db, env, cfg) {
  const token=request.headers.get('Cf-Access-Jwt-Assertion');if(!token)return null;
  try {
    if(!keysets.has(cfg.domain))keysets.set(cfg.domain,createRemoteJWKSet(new URL(`https://${cfg.domain}/cdn-cgi/access/certs`)));
    const {payload}=await jwtVerify(token,keysets.get(cfg.domain),{issuer:`https://${cfg.domain}`,audience:cfg.aud,algorithms:['RS256'],requiredClaims:['exp','email']});
    if(typeof payload.email!=='string')return null;const email=payload.email.trim().toLowerCase();
    // JWT の検証はここまで。所属は Cookie on_org で本人が選んだ組織（所属を確かめ、無効なら org_id が最小の組織。
    // 既定へ戻したとき・画面の組織（X-On-Org）と食い違うときは、/api/session 系のほかは app.mjs が 409 にする）
    return identityForEmail(db,email,request.headers.get('cookie'),Date.now());
  } catch { return null; }
}

export default {
  async fetch(request, env) {
    const cfg=config(env);if(!cfg)return new Response('統合試作の配備は無効です。',{status:503,headers:securityHeaders});
    const db=new D1Database(env.DB);
    const aiAdapter=new WorkersAiAdapter({binding:env.AI,enabled:env.AI_ENABLED==='true',model:env.AI_MODEL,modelAllowlist:(env.AI_MODEL_ALLOWLIST||'').split(',').filter(Boolean),maxCalls:Number(env.AI_MAX_CALLS||0),maxTokens:Number(env.AI_MAX_TOKENS||0)});
    const identity=await authenticateAccess(request,db,env,cfg);
    if(!identity)return new Response('Cloudflare Accessと有効なチーム所属を確認できません。',{status:403,headers:securityHeaders});
    const app=createApp({db,mode:'worker',authenticate:async()=>identity,ai:aiAdapter,suggestMappings:aiAdapter.enabled?request=>aiAdapter.suggestMappings(request):undefined});
    const url=new URL(request.url);let response;
    if(url.pathname.startsWith('/api/')) response=await app.fetch(request,env);
    else response=await env.ASSETS.fetch(request);
    const headers=new Headers(response.headers);for(const [key,value] of Object.entries(securityHeaders))headers.set(key,value);
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }
};

export { config, authenticateAccess };
