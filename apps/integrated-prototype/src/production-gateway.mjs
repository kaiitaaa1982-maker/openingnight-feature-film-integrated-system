import {authenticateAccess} from './worker.mjs';

export function productionConfig(env){
 const origin=new URL(env.ON_PUBLIC_ORIGIN||'https://invalid.invalid');
 const domain=env.ACCESS_TEAM_DOMAIN||'',aud=env.ACCESS_AUD||'';
 if(origin.protocol!=='https:'||origin.hostname==='invalid.invalid'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw Error('専用環境のHTTPSオリジンを設定してください');
 if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)||!aud.trim()||domain.startsWith('replace-')||aud.startsWith('replace-'))throw Error('専用Accessアプリのdomainとaudienceを設定してください');
 return {origin:origin.origin,domain,aud};
}

export function productionGateway({db,env,handle,authenticate=authenticateAccess}){
 const cfg=productionConfig(env);
 const security={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"};
 const deny=(message,status)=>new Response(message,{status,headers:security});
 return async request=>{
  const url=new URL(request.url);
  if(url.host!==new URL(cfg.origin).host)return deny('Hostが専用環境と一致しません',403);
  if(request.headers.get('origin')&&request.headers.get('origin')!==cfg.origin)return deny('別サイトからの要求は受け付けません',403);
  if(url.pathname==='/api/local/login')return deny('ローカルログインは無効です',404);
  const identity=await authenticate(request,db,env,cfg);
  if(!identity)return deny('認証と有効な所属が必要です',403);
  const response=await handle(request,identity);
  const headers=new Headers(response.headers);for(const [k,v]of Object.entries(security))headers.set(k,v);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
 };
}
