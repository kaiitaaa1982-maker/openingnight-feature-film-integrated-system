import test from 'node:test';
import assert from 'node:assert/strict';
import {productionConfig,productionGateway} from '../src/production-gateway.mjs';
const env={ON_PUBLIC_ORIGIN:'https://system.example.com',ACCESS_TEAM_DOMAIN:'test.cloudflareaccess.com',ACCESS_AUD:'audience'};
test('production configuration refuses absent authentication and insecure origins',()=>{
 assert.throws(()=>productionConfig({}));assert.throws(()=>productionConfig({...env,ON_PUBLIC_ORIGIN:'http://system.example.com'}));assert.throws(()=>productionConfig({...env,ACCESS_AUD:''}));assert.equal(productionConfig(env).origin,'https://system.example.com');
});
test('all assets and APIs require authentication; local fixture login never opens',async()=>{
 let handled=0;
 const gateway=productionGateway({env,db:{},authenticate:async()=>null,handle:async()=>{handled++;return new Response('secret')}});
 for(const path of ['/','/assets/app.js','/api/health','/api/workbench/analytics/report'])assert.equal((await gateway(new Request(env.ON_PUBLIC_ORIGIN+path))).status,403);
 assert.equal((await gateway(new Request(env.ON_PUBLIC_ORIGIN+'/api/local/login',{method:'POST'}))).status,404);assert.equal(handled,0);
});
test('valid identity passes; wrong host, cross-origin and revoked identity cannot',async()=>{
 let active=true;const gateway=productionGateway({env,db:{},authenticate:async()=>active?{user_id:1,role:'admin'}:null,handle:async(req,identity)=>Response.json({id:identity.user_id})});
 let response=await gateway(new Request(env.ON_PUBLIC_ORIGIN+'/'));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
 assert.equal((await gateway(new Request('https://wrong.example.com/'))).status,403);
 assert.equal((await gateway(new Request(env.ON_PUBLIC_ORIGIN+'/',{method:'POST',headers:{origin:'https://wrong.example.com'}}))).status,403);
 active=false;assert.equal((await gateway(new Request(env.ON_PUBLIC_ORIGIN+'/'))).status,403);
});
