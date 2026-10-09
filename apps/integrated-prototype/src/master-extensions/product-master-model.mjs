import {textValue, numberValue, dateValue, normalizeMoney} from './work-master-model.mjs';
export const PRODUCT_FIELDS = {
  product_number:'品番',jan_code:'JANコード',product_type:'商品区分',media:'メディア',release_on:'発売日',sales_end_on:'販売期限',publisher_partner_id:'発売元',distributor_partner_id:'販売元',label:'レーベル',series:'商品シリーズ',sales_class:'レンタル／セル・流通区分',
  disc_count:'ディスク枚数',disc_layer:'ディスク層',case_color:'ケース色',pressing_company:'プレス会社',audio:'音声',subtitles:'字幕',video_quality:'画質',runtime_minutes:'本編収録時間（分）',design:'デザイン',video_production_company:'映像制作会社',rights_holder:'商品固有の権利元表記',original_rights_holder:'商品固有の原権利元表記',system_product_name:'基幹向け商品名',notes:'備考',other1:'その他1（意味未確認）',other2:'その他2（意味未確認）',
};
export const PRODUCT_MONEY_FIELDS={price:'価格',price_ex_tax:'定価（税別）',price_inc_tax:'定価（税込）'};
export function normalizeProduct(b) {
  const out={};
  for (const k of Object.keys(PRODUCT_FIELDS)) out[k]=k.endsWith('_partner_id')?numberValue(b[k],1):k==='disc_count'?numberValue(b[k],0,1000):k==='runtime_minutes'?numberValue(b[k],0,100000):k.endsWith('_on')?dateValue(b[k]):textValue(b[k]);
  if (out.jan_code && !/^(\d{8}|\d{13})$/.test(out.jan_code)) throw Error('JANは8桁または13桁の文字列です');
  if (out.release_on && out.sales_end_on && out.sales_end_on<out.release_on) throw Error('販売期間を確認してください');
  for(const key of Object.keys(PRODUCT_MONEY_FIELDS)) {
    Object.assign(out,normalizeMoney({...b,[key+'_tax_basis']:b[key+'_tax_basis'] ?? (key==='price_ex_tax'?'ex_tax':key==='price_inc_tax'?'inc_tax':'unknown')},key));
    if(key!=='price' && out[key+'_tax_basis']!==(key==='price_ex_tax'?'ex_tax':'inc_tax')) throw Error('定価の税区分を確認してください');
  }
  return out;
}
export function withoutProductMoney(row) {
  if(!row) return row;
  return Object.fromEntries(Object.entries(row).filter(([k])=>!Object.keys(PRODUCT_MONEY_FIELDS).some(prefix=>k.startsWith(prefix+'_'))));
}
