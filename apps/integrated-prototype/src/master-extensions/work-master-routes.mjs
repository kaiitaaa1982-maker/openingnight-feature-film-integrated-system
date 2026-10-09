import {isDbConflict} from '../data-platform/db-errors.mjs';
import {expenseSource,resolveExpenseAccounts} from '../expense-sheet/expense-read.mjs';
import {baseInput,numberValue,normalizeProfile,normalizeFinance,normalizeRights,normalizeContracts,financeTotals} from './work-master-model.mjs';

export const WORK_TABLES={profile:'work_master_profile_versions',finance:'work_finance_versions',contracts:'work_contract_set_versions',rights:'work_rights_versions'};
export const insertRow=(table,row)=>({sql:`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`,params:Object.values(row)});
export function masterSupport({db,bad,body,permittedProjects}) {
  const wrap=fn=>async c=>{try{return await fn(c);}catch(e){return bad(c,e.message,isDbConflict(e)||/stale|mismatch/i.test(e.message)?409:400,undefined,e);}};
  async function works(i,edit=false) {
    if (edit && i.role==='production') return [];
    const allowed=new Set((await permittedProjects(db,i,edit)).map(p=>p.id));
    return (await db.all('SELECT id,project_id FROM works WHERE org_id=?',[i.org_id])).filter(w=>allowed.has(w.project_id));
  }
  async function workAccess(i,id,edit=false) {return (await works(i,edit)).some(w=>w.id===id);}
  async function productAccess(i,id,edit=false) {
    const links=await db.all('SELECT work_id FROM product_works WHERE org_id=? AND product_id=?',[i.org_id,id]);
    const allowed=new Set((await works(i,edit)).map(w=>w.id));
    return links.length>0 && links.every(w=>allowed.has(w.work_id));
  }
  async function readBody(c) {
    const b=await body(c);
    if (!b || Array.isArray(b) || new TextEncoder().encode(JSON.stringify(b)).length>=120000) throw Error('入力は120KB未満にしてください');
    return b;
  }
  async function partner(i,id) {if(id && !await db.get('SELECT id FROM partners WHERE org_id=? AND id=?',[i.org_id,id])) throw Error('組織内の取引先を選んでください');}
  async function read(table,entity,i,id,revision=null) {
    return db.get(`SELECT * FROM ${table} WHERE org_id=? AND ${entity}_id=? ${revision===null?'':'AND revision=?'} ORDER BY revision DESC LIMIT 1`,revision===null?[i.org_id,id]:[i.org_id,id,revision]);
  }
  async function history(table,entity,i,id) {return db.all(`SELECT revision,source_reference,reason,created_at FROM ${table} WHERE org_id=? AND ${entity}_id=? ORDER BY revision DESC`,[i.org_id,id]);}
  function statements(table,entity,i,id,b,values) {
    const meta=baseInput(b), key={org_id:i.org_id,[entity+'_id']:id,revision:meta.revision};
    return {key, revision:meta.revision, statements:[
      {sql:`INSERT INTO transaction_guards(value) SELECT 0 WHERE ?<>(SELECT COALESCE(MAX(revision),0) FROM ${table} WHERE org_id=? AND ${entity}_id=?)`,params:[meta.base,i.org_id,id]},
      insertRow(table,{...key,...values,source_reference:meta.source_reference,reason:meta.reason,created_by:i.user_id}),
    ]};
  }
  function audit(i,table,id,revision) {return insertRow('audit_log',{org_id:i.org_id,user_id:i.user_id,action:'create',entity_type:table,entity_id:String(id),detail_json:JSON.stringify({revision})});}
  return {wrap,works,workAccess,productAccess,readBody,partner,read,history,statements,audit};
}

export async function committeeReferences(db,org,work,selfPartnerId=undefined) {
  const own=selfPartnerId===undefined?(await db.get('SELECT self_partner_id FROM org_profile_versions WHERE org_id=? ORDER BY version_no DESC LIMIT 1',[org]))?.self_partner_id:selfPartnerId;
  const rows=await db.all(`SELECT v.id AS term_version_id,v.version_no,c.id AS contract_id,c.title,f.production_cost_yen
    FROM committee_contracts c JOIN committee_term_versions v ON v.org_id=c.org_id AND v.contract_id=c.id
    LEFT JOIN committee_term_funding f ON f.org_id=v.org_id AND f.term_version_id=v.id
    WHERE c.org_id=? AND c.work_id=? ORDER BY c.id,v.version_no DESC`,[org,work]);
  for(const row of rows) {
    row.investors=await db.all(`SELECT i.partner_id,p.name,i.amount_yen FROM committee_term_investments i JOIN partners p ON p.org_id=i.org_id AND p.id=i.partner_id WHERE i.org_id=? AND i.term_version_id=? ORDER BY i.partner_id`,[org,row.term_version_id]);
    row.self_partner_id=own??null;
    row.own_investment_yen=row.investors.find(p=>p.partner_id===own)?.amount_yen??null;
    row.tax_basis='unknown';
    row.source='committee_term_funding / committee_term_investments';
  }
  return rows;
}

export function registerWorkMasterRoutes(app,deps) {
  const {db,bad}=deps,s=masterSupport(deps);
  async function readSection(i,id,section,revision=null) {
    const row=await s.read(WORK_TABLES[section],'work',i,id,revision);
    if(row && ['rights','contracts'].includes(section)) row.rows=await db.all(`SELECT * FROM ${section==='rights'?'work_rights_party_versions':'work_contract_versions'} WHERE org_id=? AND work_id=? AND revision=? ORDER BY position`,[i.org_id,id,row.revision]);
    return row;
  }
  app.get('/api/work-master/:workId',s.wrap(async c=>{
    const i=c.get('identity'),id=numberValue(c.req.param('workId'),1);
    if(!await s.workAccess(i,id)) return bad(c,'作品の閲覧権限がありません',403);
    const canEdit=await s.workAccess(i,id,true),sections={},history={};
    for(const section of Object.keys(WORK_TABLES)) {
      if(section==='finance' && !canEdit) continue;
      sections[section]=await readSection(i,id,section);
      history[section]=await s.history(WORK_TABLES[section],'work',i,id);
    }
    const out={ok:true,canEdit,canFinance:canEdit,sections,history,partners:await db.all('SELECT id,code,name FROM partners WHERE org_id=? ORDER BY name',[i.org_id]),
      references:{catalog:'/api/work-catalog',proposal:'/api/work-proposal-profiles'}};
    if(canEdit) {
      const finance=sections.finance;
      out.committee_references=await committeeReferences(db,i.org_id,id);
      const pinned=finance?.committee_term_version_id?(await committeeReferences(db,i.org_id,id,finance.self_partner_id)).find(r=>r.term_version_id===finance.committee_term_version_id):null;
      out.finance_reference=pinned??null;
      out.finance_totals=financeTotals(finance,await resolveExpenseAccounts(db,i.org_id,await db.all(`SELECT * FROM ${expenseSource()} WHERE org_id=? AND work_id=?`,[i.org_id,id])),pinned);
      out.warnings=[];
      if(out.committee_references.length && !finance?.committee_term_version_id && (finance?.production_cost_yen!=null || finance?.own_investment_yen!=null)) out.warnings.push('委員会の条件版があります。製作費・自社出資の正本を確認し、次の版で委員会参照へ切り替えてください。');
      const latest=out.committee_references.filter((r,n,a)=>a.findIndex(x=>x.contract_id===r.contract_id)===n);
      if(pinned && latest.some(r=>r.contract_id===pinned.contract_id && r.term_version_id!==pinned.term_version_id)) out.warnings.push('参照している委員会条件版より新しい版があります。');
      if(finance && latest.some(r=>(finance.production_cost_yen!=null && r.production_cost_yen!=null && finance.production_cost_yen!==r.production_cost_yen)||(finance.own_investment_yen!=null && r.own_investment_yen!=null && finance.own_investment_yen!==r.own_investment_yen))) out.warnings.push('作品費用と委員会の参照額が食い違っています。税区分と評価時点も確認してください。');
      out.mg_links=[];
      for(const kind of ['incoming','outgoing']) {
        const rows=await db.all(`SELECT DISTINCT c.id,c.code,c.title,c.contract_date FROM mg_${kind}_contracts c JOIN mg_term_versions v ON v.org_id=c.org_id AND v.${kind}_contract_id=c.id JOIN mg_version_products p ON p.org_id=v.org_id AND p.term_version_id=v.id JOIN product_works w ON w.org_id=p.org_id AND w.product_id=p.product_id WHERE c.org_id=? AND w.work_id=?`,[i.org_id,id]);
        for(const row of rows) {
          const links=await db.all(`SELECT DISTINCT pw.work_id FROM mg_term_versions v JOIN mg_version_products p ON p.org_id=v.org_id AND p.term_version_id=v.id JOIN product_works pw ON pw.org_id=p.org_id AND pw.product_id=p.product_id WHERE v.org_id=? AND v.${kind}_contract_id=?`,[i.org_id,row.id]);
          const allowed=new Set((await s.works(i,true)).map(w=>w.id));
          if(links.every(w=>allowed.has(w.work_id))) out.mg_links.push({...row,kind});
        }
      }
    }
    return c.json(out);
  }));
  app.get('/api/work-master/:workId/:section',s.wrap(async c=>{
    const i=c.get('identity'),id=numberValue(c.req.param('workId'),1),section=c.req.param('section');
    if(!Object.hasOwn(WORK_TABLES,section)) return bad(c,'対象がありません',404);
    if(!await s.workAccess(i,id,section==='finance')) return bad(c,'作品への権限がありません',403);
    const revision=numberValue(c.req.query('revision'),1,1000000);
    return c.json({ok:true,version:await readSection(i,id,section,revision)});
  }));
  app.post('/api/work-master/:workId/:section',s.wrap(async c=>{
    const i=c.get('identity'),id=numberValue(c.req.param('workId'),1),section=c.req.param('section');
    if(!Object.hasOwn(WORK_TABLES,section)) return bad(c,'対象がありません',404);
    if(!await s.workAccess(i,id,true)) return bad(c,'作品の編集権限がありません',403);
    const b=await s.readBody(c);let values={},rows=[];
    if(section==='profile') values=normalizeProfile(b);
    if(section==='finance') {
      values=normalizeFinance(b);
      const refs=await committeeReferences(db,i.org_id,id);
      if(refs.length && !values.committee_term_version_id && (values.production_cost_yen!==null || values.own_investment_yen!==null)) throw Error('委員会の条件版を選んでください。製作費・自社出資は参照値です');
      if(values.committee_term_version_id && !refs.some(r=>r.term_version_id===values.committee_term_version_id)) throw Error('この作品の委員会条件版を選んでください');
      values.self_partner_id=refs.find(r=>r.term_version_id===values.committee_term_version_id)?.self_partner_id??null;
    }
    if(section==='rights') rows=normalizeRights(b);
    if(section==='contracts') rows=normalizeContracts(b);
    for(const row of rows) await s.partner(i,row.partner_id);
    const table=WORK_TABLES[section],batch=s.statements(table,'work',i,id,b,values);
    for(const row of rows) {
      if(section==='contracts') batch.statements.push({sql:'INSERT INTO work_contracts(org_id,work_id,contract_key) VALUES(?,?,?) ON CONFLICT(org_id,work_id,contract_key) DO NOTHING',params:[i.org_id,id,row.contract_key]});
      batch.statements.push(insertRow(section==='rights'?'work_rights_party_versions':'work_contract_versions',{...batch.key,...row}));
    }
    batch.statements.push(s.audit(i,table,id,batch.revision));
    await db.batch(batch.statements);
    return c.json({ok:true,revision:batch.revision},201);
  }));
}
