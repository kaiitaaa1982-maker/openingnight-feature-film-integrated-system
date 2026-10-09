import { createRemoteJWKSet, jwtVerify } from 'jose';

// 正本の DB の種類（PG 計画 段2。代表の決定 2026-10-04 の論点1）。var の DATABASE_ENGINE が無いか d1 なら D1（本番の道）、postgres なら Hyperdrive。
// それ以外の値は設定の誤り（null）。本番（top-level）は var を持たないか d1 にする（core の scripts/ops/check-cloud-db-config.mjs が CI で守る）
export function databaseEngine(env) {
  const value=env?.DATABASE_ENGINE;
  if(value===undefined||value===null||value==='d1')return 'd1';
  return value==='postgres'?'postgres':null;
}

// エンジンごとに必須の DB の束ね。d1 は env.DB、postgres は env.HYPERDRIVE（接続文字列を持つもの。中身は読まずに有無だけを見る）
export function hasDatabaseBinding(env,engine) {
  if(engine==='d1')return Boolean(env?.DB);
  if(engine==='postgres')return typeof env?.HYPERDRIVE?.connectionString==='string'&&env.HYPERDRIVE.connectionString.length>0;
  return false;
}

export function cloudConfig(env) {
  if(env.DEPLOYMENT_ENABLED!=='true')return null;
  const domain=env.ACCESS_TEAM_DOMAIN||'',aud=env.ACCESS_AUD||'',publicOrigin=env.PUBLIC_ORIGIN||'',engine=databaseEngine(env);
  if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)||!aud.trim()||!engine||!hasDatabaseBinding(env,engine)||!env.ASSETS||!env.PRIVATE_ARTIFACTS||!env.WORKBENCH_CONTAINER||!env.CONTAINER_SHARED_TOKEN||!env.CLOUD_ANALYTICS_REGISTRATION_ID||!env.CLOUD_ANALYTICS_DEFINITION_VERSION)return null;
  try { if(new URL(publicOrigin).origin!==publicOrigin||new URL(publicOrigin).protocol!=='https:')return null } catch { return null }
  return {domain,aud,publicOrigin,engine};
}

export function isSafeCloudRequest(request,cfg){const url=new URL(request.url);if(url.origin!==cfg.publicOrigin)return false;if(!['POST','PUT','PATCH','DELETE'].includes(request.method))return true;const site=request.headers.get('Sec-Fetch-Site');return request.headers.get('Origin')===cfg.publicOrigin&&(!site||site==='same-origin')}

// Cloudflare Access の JWT（Cf-Access-Jwt-Assertion）を確かめる。チームの公開鍵・発行者・AUD・RS256・exp を見る。
// requireEmail が true（既定。業務の API）ならメールの主張も必須。false はヘルス専用の経路だけ（サービストークンの JWT はメールを持たない）。
// 確かめられなければ null、確かめられれば payload。keys は試験で差し替える（既定はチームの certs の鍵の束。チームごとに1つ持つ）
const keysets=new Map();
const teamKeys=domain=>{if(!keysets.has(domain))keysets.set(domain,createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`)));return keysets.get(domain)};
export async function verifyAccessToken(request,cfg,{requireEmail=true,keys}={}) {
  const token=request.headers.get('Cf-Access-Jwt-Assertion');if(!token)return null;
  try {
    const {payload}=await jwtVerify(token,keys||teamKeys(cfg.domain),{issuer:`https://${cfg.domain}`,audience:cfg.aud,algorithms:['RS256'],requiredClaims:requireEmail?['exp','email']:['exp']});
    if(requireEmail&&typeof payload.email!=='string')return null;
    return payload;
  } catch { return null; }
}
