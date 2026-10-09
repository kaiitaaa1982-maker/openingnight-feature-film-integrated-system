import {D1_INLINE_VALUE_BYTES} from './d1-limits.mjs';
// 1ロケ地の見取り図（JSON・UTF-8 のバイト数）は D1 の1行の上限（128KB）まで。本番の DB 部品と同じ値（画面もこの値まで描かせる）
export const PLAN_LIMITS=Object.freeze({plans:300,strokes:200,pointsPerStroke:1000,pointsPerPlan:12000,pointsPerWork:30000,planJsonBytes:D1_INLINE_VALUE_BYTES,jsonBytes:2000000});
export const planJsonBytesOf=strokes=>new TextEncoder().encode(JSON.stringify(strokes)).byteLength;
const point=value=>{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)throw Error('見取り図の座標は0〜1の数値で指定してください');
  return Math.round(value*10000)/10000;
};
export function normalizeLocationPlans(input,locationKeys){
  if(!Array.isArray(input)||input.length>PLAN_LIMITS.plans)throw Error('見取り図は300件以内です');
  if(new TextEncoder().encode(JSON.stringify(input)).byteLength>PLAN_LIMITS.jsonBytes)throw Error('見取り図のJSONは2MB以内です');
  const seen=new Set();let workPoints=0;
  return input.map(plan=>{
    if(!plan||typeof plan.location_key!=='string'||!locationKeys.has(plan.location_key))throw Error('見取り図のロケ地が同じ作品にありません');
    if(seen.has(plan.location_key))throw Error('同じロケ地の見取り図が重複しています');seen.add(plan.location_key);
    if(!Array.isArray(plan.strokes)||plan.strokes.length>PLAN_LIMITS.strokes)throw Error('見取り図は1ロケ地200画以内です');
    let planPoints=0;
    const strokes=plan.strokes.map(stroke=>{
      if(!stroke||!['blue','red','erase'].includes(stroke.tool))throw Error('見取り図のペンを確認してください');
      if(typeof stroke.width!=='number'||!Number.isFinite(stroke.width)||stroke.width<0.001||stroke.width>0.1)throw Error('見取り図の線幅は0.001〜0.1で指定してください');
      if(!Array.isArray(stroke.points)||stroke.points.length<1||stroke.points.length>PLAN_LIMITS.pointsPerStroke)throw Error('見取り図の1画は1〜1000点です');
      planPoints+=stroke.points.length;workPoints+=stroke.points.length;
      if(planPoints>PLAN_LIMITS.pointsPerPlan||workPoints>PLAN_LIMITS.pointsPerWork)throw Error('見取り図の点数上限を超えています（ロケ地12000点・作品30000点）');
      return {tool:stroke.tool,width:Math.round(stroke.width*10000)/10000,points:stroke.points.map(p=>{if(!p||typeof p!=='object')throw Error('見取り図の座標を確認してください');return {x:point(p.x),y:point(p.y)}})};
    });
    if(planJsonBytesOf(strokes)>PLAN_LIMITS.planJsonBytes)throw Error(`見取り図（ロケ地 ${plan.location_key}）は1ロケ地${Math.round(PLAN_LIMITS.planJsonBytes/1024)}KB以内です。画を減らしてください`);
    return {location_key:plan.location_key,strokes};
  });
}
