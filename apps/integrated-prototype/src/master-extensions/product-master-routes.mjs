import {masterSupport} from './work-master-routes.mjs';
import {numberValue} from './work-master-model.mjs';
import {normalizeProduct,withoutProductMoney} from './product-master-model.mjs';
export function registerProductMasterRoutes(app,deps) {
  const {db,bad}=deps,s=masterSupport(deps),table='product_master_profile_versions';
  app.get('/api/product-master/:productId',s.wrap(async c=>{
    const i=c.get('identity'),id=numberValue(c.req.param('productId'),1);
    if(!await s.productAccess(i,id)) return bad(c,'商品の全作品への閲覧権限が必要です',403);
    const canEdit=await s.productAccess(i,id,true),revision=numberValue(c.req.query('revision'),1,1000000);
    const profile=await s.read(table,'product',i,id,revision);
    return c.json({ok:true,canEdit,canFinance:canEdit,profile:canEdit?profile:withoutProductMoney(profile),history:await s.history(table,'product',i,id),partners:await db.all('SELECT id,code,name FROM partners WHERE org_id=? ORDER BY name',[i.org_id])});
  }));
  app.post('/api/product-master/:productId',s.wrap(async c=>{
    const i=c.get('identity'),id=numberValue(c.req.param('productId'),1);
    if(!await s.productAccess(i,id,true)) return bad(c,'商品の全作品への編集権限が必要です',403);
    const b=await s.readBody(c),values=normalizeProduct(b);
    await s.partner(i,values.publisher_partner_id);await s.partner(i,values.distributor_partner_id);
    const batch=s.statements(table,'product',i,id,b,values);
    batch.statements.push(s.audit(i,table,id,batch.revision));await db.batch(batch.statements);
    return c.json({ok:true,revision:batch.revision},201);
  }));
}
