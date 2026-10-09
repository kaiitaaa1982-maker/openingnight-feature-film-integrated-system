// cloud-analytics.test.mjs と cloud-analytics-sqlite.test.mjs が共有する組み立て（架空の R2・コンテナの結果・分析の写しの引数）。
// DB は試験の DB のファクトリ（test-db.mjs。field-sales-independent-fixture.mjs の fixture）で開く。kind は試験の DB の種類（既定は ON_TEST_DB）。
// 分析の写しのジョブの表（cloud_analytics_state・cloud_analytics_jobs）は、両方の試験の DB がすでに持つ（scripts/pg-ddl.mjs の APP_DDL_SOURCES）
import {fixture} from './field-sales-independent-fixture.mjs';
import {createCloudAnalytics,sha256} from '../src/cloud-analytics.mjs';

export const identity={org_id:1,user_id:1,role:'admin'};
export class MemoryBucket{constructor(){this.objects=new Map();this.failPut=null}async put(key,value){if(this.failPut?.(key))throw Error('injected R2 failure');this.objects.set(key,typeof value==='string'?Buffer.from(value):Buffer.from(value))}async get(key){const value=this.objects.get(key);return value?{arrayBuffer:async()=>Uint8Array.from(value).buffer}:null}}
export async function resultFor(frozen){const content={
 'snapshot.json':JSON.stringify({id:frozen.runId,org_id:frozen.orgId,registrationId:frozen.registrationId,auditThrough:frozen.auditThrough,frozenHash:frozen.frozenHash,cloudDefinitionVersion:frozen.definitionVersion}),
 'analytics.duckdb':'test-database','outputs.json':'{}','reports/report.json':'{}','reports/report.html':'<h1>verified</h1>','reports/sales.csv':'sales\n10\n'
 };const hashes={};for(const [p,s] of Object.entries(content))hashes[p]=await sha256(s);content['verification.json']=JSON.stringify({status:'verified',passedTests:13,files:hashes});return {ok:true,files:await Promise.all(Object.entries(content).map(async([path,data])=>({path,sha256:await sha256(data),base64:Buffer.from(data).toString('base64')})))};}
export async function setup({t,kind,...overrides}={}){const f=await fixture({t,kind});const bucket=new MemoryBucket(),options={db:f.db,bucket,registrationId:'synthetic-test-registration',definitionVersion:'test-definition-1',containerBuild:resultFor,...overrides},service=createCloudAnalytics(options);return {...f,bucket,options,service}}

export const plain=value=>JSON.parse(JSON.stringify(value));
export const freezeArgs={orgId:1,registrationId:'synthetic-test-registration',definitionVersion:'test-definition-1',runId:'a'.repeat(32),asOf:'2026-09-22',userId:1};
// 写しから、抽出のたびに変わる値（抽出の時刻と、それを含むハッシュ）を除く
export const stable=({exportedAt,frozenHash,...rest})=>plain(rest);
