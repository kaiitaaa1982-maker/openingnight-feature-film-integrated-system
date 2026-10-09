import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {resolve} from 'node:path';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {committeeReportSheets,mgReportSheets} from '../src/rights-report-output.mjs';
import {salesReportSheets} from '../src/report-center-model.mjs';
import {encodeXlsx} from '../src/xlsx.mjs';
import {printableReport,csvDocument} from '../src/report-output.mjs';
const path=resolve('data/human-workflow-proof.sqlite'),out=resolve('data/human-workflow-files/reports');
const reg=JSON.parse(readFileSync(path+'.workbench-demo.json'));if(reg.kind!=='workbench-synthetic-v1'||resolve(reg.database)!==path)throw Error('Synthetic registration required');
const db=new LocalDatabase(path);const app=createApp({db,mode:'snapshot',authenticate:async()=>({org_id:1,user_id:1,role:'admin'})});
const req=async path=>{const r=await app.request('/api'+path);const j=await r.json();if(!r.ok||!j.ok)throw Error(JSON.stringify(j));return j};
try{
 const committee=(await req('/rights-reports/committee?workId=3&snapshotId=3')).report;
 const annual=await req('/report-center?start=2026-01&workId=3');
 const partners=await db.all('SELECT id,name FROM partners');const partyName=id=>partners.find(p=>p.id===id)?.name||String(id);
 const outputs=[{name:'committee-income',title:'架空映画・波の向こうへ 製作委員会収支報告',sheets:committeeReportSheets(committee,partyName)},...['trend','banpan','pnl'].map(mode=>({name:'sales-'+mode,title:({trend:'年間売上推移',banpan:'年間番販集計',pnl:'作品別収支'})[mode],sheets:salesReportSheets(annual,mode)}))];
 for(const direction of ['incoming','outgoing']){
  const v=await db.get(`SELECT v.id,v.${direction}_contract_id contractId FROM mg_term_versions v WHERE v.${direction}_contract_id IS NOT NULL LIMIT 1`);
  const r=(await req(`/rights-reports/mg?direction=${direction}&contractId=${v.contractId}&termVersionId=${v.id}&month=2026-09`)).report;
  outputs.push({name:'mg-'+direction,title:direction==='incoming'?'受取MGの回収現況':'支払MGの回収現況',sheets:mgReportSheets(r,()=> '架空映画・波の向こうへ')});
 }
 mkdirSync(out,{recursive:true});
 for(const o of outputs){writeFileSync(resolve(out,o.name+'.xlsx'),encodeXlsx(o.sheets));writeFileSync(resolve(out,o.name+'.html'),printableReport({title:o.title,subtitle:'2026年9月まで ／ 架空データ ／ JPY税抜 ／ 下書き・未確認',sheets:o.sheets}));writeFileSync(resolve(out,o.name+'.csv'),csvDocument(o.sheets[0].rows));}
 console.log(JSON.stringify({out,outputs:outputs.map(o=>o.name)}));
}finally{db.close()}
