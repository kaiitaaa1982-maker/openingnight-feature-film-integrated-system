#!/usr/bin/env node
// DEMO-SALES の既存作品・商品へ依頼5の架空情報を追加。すべてAPI経由、DDLなし。
// 作品・商品・節ごとの版の目印で途中から再開できる。利用者の既存版は上書きしない。
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {SALES_DEMO} from './seed-sales-demo.mjs';
import {PRODUCTION_COSTS} from './seed-plbs-demo.mjs';
export const MASTER_DEMO_MARKER='DEMO-MASTER-REQ5（架空）';
const meta={baseRevision:0,source_reference:MASTER_DEMO_MARKER,reason:'架空マスタの初回確認（架空）'};
const money=(key,amount)=>({[key+'_yen']:amount,[key+'_tax_basis']:'ex_tax',[key+'_status']:amount==null?'unknown':'estimated',[key+'_as_of']:amount==null?null:'2026-09-28',[key+'_evidence']:amount==null?null:'DEMO-見積書（架空）'});
export async function seedMasterDemo(db,{log=()=>{}}={}) {
  const org=await db.get('SELECT id FROM organizations WHERE code=?',[SALES_DEMO.orgCode]);
  if(!org) throw Error('先に売上・制作・PLBSの架空データを入れてください');
  const app=createApp({db,mode:'local'}),login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:SALES_DEMO.adminEmail})});
  if(login.status!==200) throw Error('架空の管理者でログインできません');
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const call=async(path,payload)=>{
    const value=payload?JSON.stringify(payload):undefined;
    if(value && Buffer.byteLength(value)>=120000) throw Error('架空データが120KB以上です');
    const r=await app.request('/api'+path,{method:payload?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:value});const result=await r.json();
    if(r.status>=300) throw Error(`${path}: ${r.status} ${JSON.stringify(result)}`);return result;
  };
  if((await call('/session')).user.orgId!==org.id) throw Error('DEMO-SALES の組織ではありません');
  const catalog=await call('/work-catalog'),works=catalog.works.filter(w=>w.code.startsWith('DEMO-'));
  let written=0;
  for(const [n,w] of works.entries()) {
    const data=await call(`/work-master/${w.id}`),partners=data.partners.filter(p=>p.code.startsWith('DEMO-'));
    const other=partners.find(p=>p.code==='DEMO-INV-PUB')??partners[0];
    if(!other) throw Error('架空の契約相手がありません');
    const add=async(section,payload)=>{
      if(data.history[section].some(v=>v.source_reference===MASTER_DEMO_MARKER)||data.sections[section]) return;
      await call(`/work-master/${w.id}/${section}`,{...meta,...payload});written++;
    };
    await add('profile',{series:n%3===0?'季節の物語（架空）':null,label:'映像レーベル（架空）',production_category:data.committee_references.length?'委員会製作':'自社製作',registration_state:'confirmed',work_kind:'work',internal_notes:'すべて検証用の設定（架空）',primary_use:'劇場・放送（架空）',secondary_use:'配信・パッケージ（架空）'});
    await add('contracts',{rows:[{contract_key:'DEMO-RIGHTS',title:'権利取得の契約（架空）',kind:'acquisition',signed_on:'2026-01-10',starts_on:'2026-02-01',ends_on:'2028-01-31',partner_id:other.id,document_reference:'DEMO-権利取得契約書（架空）'},{contract_key:'DEMO-PRODUCTION',title:'製作委託の契約（架空）',kind:'production',signed_on:'2026-01-15',starts_on:'2026-02-01',ends_on:'2026-12-31',partner_id:other.id,document_reference:'DEMO-製作委託契約書（架空）'}]});
    await add('rights',{rows:[{partner_id:other.id,role:'権利元',evidence:'DEMO-契約書（架空）'},{name:`物語の原作者${n+1}（架空）`,role:'原作者',rights_scope:'原作利用（架空）',evidence:'DEMO-原作利用許諾（架空）'}]});
    const ref=data.committee_references[0],production=PRODUCTION_COSTS[w.code]??(20000000+n*1000000);
    await add('finance',{committee_term_version_id:ref?.term_version_id??null,...money('production_cost',ref?null:production),...money('promotion_budget',n===0?0:3000000+n*100000),...money('own_investment',ref?null:production),...money('sales_rights_purchase',null)});
  }
  const products=[...new Map(catalog.products.map(p=>[p.id,p])).values()].filter(p=>p.sku.startsWith('DEMO-'));
  for(const [n,p] of products.entries()) {
    const data=await call(`/product-master/${p.id}`);
    if(data.profile) continue;
    const publisher=data.partners.find(p=>p.code==='DEMO-SELF'),distributor=data.partners.find(p=>p.code==='DEMO-INV-VID');
    await call(`/product-master/${p.id}`,{...meta,product_number:`DEMO-P-${String(n+1).padStart(4,'0')}`,jan_code:`00${String(n+1).padStart(11,'0')}`,product_type:'映像商品',media:p.channel==='package'?'Blu-ray':'デジタル',release_on:'2026-10-01',sales_end_on:'2028-09-30',publisher_partner_id:publisher?.id??null,distributor_partner_id:distributor?.id??null,label:'映像レーベル（架空）',sales_class:n%2?'セル':'レンタル',disc_count:p.channel==='package'?2:null,disc_layer:'二層',audio:'日本語・ステレオ',subtitles:'日本語',video_quality:'HD',runtime_minutes:95,notes:'検証用の仕様（架空）',...money('price',3000+n*100)});written++;
  }
  log(`作品マスタ ${works.length}作品・商品マスタ ${products.length}商品／追加 ${written}版`);
  return {orgId:org.id,works:works.length,products:products.length,written,skipped:written===0};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),pos=args.indexOf('--db');
  if(pos<0||!args[pos+1]) throw Error('--db で対象の一時DBを指定してください');
  const path=resolve(args[pos+1]);
  if(path===fileURLToPath(new URL('../data/integrated.sqlite',import.meta.url))) throw Error('既定のDBは対象外です');
  // スキーマの追加は実行しない。先に最新の移行と既存の架空データを用意する。
  const db=new LocalDatabase(path,{init:false});try{console.log(await seedMasterDemo(db,{log:console.log}));}finally{db.close();}
}
