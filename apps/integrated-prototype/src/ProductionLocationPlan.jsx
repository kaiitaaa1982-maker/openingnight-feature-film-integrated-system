import React,{useEffect,useRef,useState} from 'react';
import {PLAN_LIMITS} from './production-plans.mjs';

const rounded=value=>Math.round(Math.max(0,Math.min(1,value))*10000)/10000;
function paint(canvas,strokes,current){
  const rect=canvas.getBoundingClientRect(),ratio=globalThis.devicePixelRatio||1;
  if(!rect.width||!rect.height)return;
  const width=Math.round(rect.width*ratio),height=Math.round(rect.height*ratio);
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height}
  const context=canvas.getContext('2d');if(!context)return;
  context.clearRect(0,0,width,height);
  // 線の色はテーマのトークン（--plan-blue=--accent、--plan-red=--bad）から読む。読めないときは文字色で描く
  const style=getComputedStyle(canvas),token=name=>style.getPropertyValue(name).trim(),colors={blue:token('--plan-blue')||token('--accent')||style.color,red:token('--plan-red')||token('--bad')||style.color};
  for(const stroke of [...strokes,...(current?[current]:[])]){
    if(!stroke.points.length)continue;
    context.save();context.globalCompositeOperation=stroke.tool==='erase'?'destination-out':'source-over';
    context.strokeStyle=colors[stroke.tool]||colors.blue;context.fillStyle=context.strokeStyle;
    context.lineWidth=stroke.width*width;context.lineCap='round';context.lineJoin='round';
    const first=stroke.points[0];context.beginPath();
    if(stroke.points.length===1){context.arc(first.x*width,first.y*height,context.lineWidth/2,0,Math.PI*2);context.fill()}
    else{context.moveTo(first.x*width,first.y*height);for(const point of stroke.points.slice(1))context.lineTo(point.x*width,point.y*height);context.stroke()}
    context.restore();
  }
}

export default function ProductionLocationPlan({locationName,value=[],onChange,disabled=false}){
  const canvasRef=useRef(null),active=useRef(null),undo=useRef([]),latest=useRef(value);
  const [tool,setTool]=useState('blue'),[notice,setNotice]=useState(''),[undoCount,setUndoCount]=useState(0);
  latest.current=value;
  useEffect(()=>{const canvas=canvasRef.current;if(!canvas)return;const redraw=()=>paint(canvas,latest.current,active.current?.stroke);redraw();const observer=new ResizeObserver(redraw);observer.observe(canvas);return()=>observer.disconnect()},[]);
  useEffect(()=>{if(canvasRef.current)paint(canvasRef.current,value,active.current?.stroke)},[value]);
  function pushUndo(){undo.current.push(latest.current);if(undo.current.length>40)undo.current.shift();setUndoCount(undo.current.length)}
  function point(event){const r=canvasRef.current.getBoundingClientRect();return {x:rounded((event.clientX-r.left)/(r.width||1)),y:rounded((event.clientY-r.top)/(r.height||1))}}
  function start(event){
    if(disabled||active.current||event.button!==0)return;
    const total=value.reduce((n,s)=>n+s.points.length,0);
    if(value.length>=PLAN_LIMITS.strokes||total>=PLAN_LIMITS.pointsPerPlan){setNotice('図の上限です。不要な画を戻すか、全消去して描き直してください。');return}
    event.preventDefault();setNotice('');event.currentTarget.setPointerCapture(event.pointerId);
    const stroke={tool,width:tool==='erase'?0.04:0.006,points:[point(event)]},remainingBytes=PLAN_LIMITS.planJsonBytes-JSON.stringify([...value,stroke]).length;
    if(remainingBytes<0){setNotice('図の保存容量上限です。不要な画を戻すか、全消去して描き直してください。');event.currentTarget.releasePointerCapture(event.pointerId);return}
    active.current={pointerId:event.pointerId,remaining:PLAN_LIMITS.pointsPerPlan-total,remainingBytes,stroke};
    paint(canvasRef.current,value,active.current.stroke);
  }
  function move(event){
    const drawing=active.current;if(!drawing||drawing.pointerId!==event.pointerId)return;event.preventDefault();
    const points=drawing.stroke.points,p=point(event),last=points.at(-1);
    if(Math.abs(p.x-last.x)+Math.abs(p.y-last.y)<0.002)return;
    if(points.length>=Math.min(PLAN_LIMITS.pointsPerStroke,drawing.remaining)){setNotice('1画の点数上限です。指やペンを離して続けてください。');return}
    const bytes=JSON.stringify(p).length+1;if(bytes>drawing.remainingBytes){setNotice('図の保存容量上限です。不要な画を戻すか、全消去して描き直してください。');return}drawing.remainingBytes-=bytes;
    points.push(p);paint(canvasRef.current,latest.current,drawing.stroke);
  }
  function finish(event){
    const drawing=active.current;if(!drawing||drawing.pointerId!==event.pointerId)return;
    active.current=null;pushUndo();const next=[...latest.current,drawing.stroke];onChange(next);paint(canvasRef.current,next,null);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function restore(){if(!undo.current.length||disabled)return;const previous=undo.current.pop();setUndoCount(undo.current.length);setNotice('');onChange(previous)}
  function clear(){if(!value.length||disabled)return;pushUndo();onChange([]);setNotice('図を消去しました。保存前は「戻す」で復元できます。')}
  return <section className="production-plan" aria-label={`${locationName}の見取り図`}>
    <h4>見取り図・現場メモ</h4>
    <p className="production-plan-help">空の下地に通路・待機場所などを描けます。「制作情報を保存」で記録します。</p>
    <div className="production-plan-tools" role="group" aria-label={`${locationName}の描画ツール`}>
      {[['blue','青ペン'],['red','赤ペン'],['erase','消しゴム']].map(([key,label])=><button type="button" key={key} className={`secondary ${tool===key?'selected':''}`} aria-pressed={tool===key} onClick={()=>setTool(key)} disabled={disabled}>{key!=='erase'&&<i className={`production-plan-ink ${key}`} aria-hidden="true"/>}{label}</button>)}
      <button type="button" className="secondary" onClick={restore} disabled={disabled||!undoCount}>戻す</button>
      <button type="button" className="secondary" onClick={clear} disabled={disabled||!value.length}>全部消す</button>
      <span>{value.filter(s=>s.tool!=='erase').length}画</span>
    </div>
    <div className="production-plan-surface">
      <svg viewBox="0 0 640 360" className="production-plan-base" aria-hidden="true"><rect x="0" y="0" width="640" height="360" fill="currentColor"/><rect x="14" y="14" width="612" height="332" fill="none" stroke="var(--line)" strokeDasharray="4 4"/></svg>
      <canvas ref={canvasRef} role="img" aria-label={`${locationName}の手書き見取り図。青ペン・赤ペン・消しゴムで編集できます。`} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}/>
    </div>
    {notice&&<p className="production-plan-notice" role="status">{notice}</p>}
  </section>;
}
