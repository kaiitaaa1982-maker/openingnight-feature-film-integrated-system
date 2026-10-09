import {build} from 'esbuild';
import {readFileSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
// Isolated, in-memory source transformations; real components and live source files remain unchanged.
for(const changed of [false,true]){
 const out=resolve(`data/canvas-propagation-${process.pid}-${Number(changed)}.mjs`);
 try{
 await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import Canvas from './src/DesignCanvas.jsx';import {SalesCatalog} from './src/ReportCenter.jsx';export const html=renderToStaticMarkup(<Canvas request={async()=>({tables:[]})} renderScreen={()=> <SalesCatalog data={{selectedWorkId:1}} request={async()=>({rows:[]})}/>}/>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',loader:{'.css':'empty'},outfile:out,plugins:[{name:'isolated-label-probe',setup(builder){builder.onLoad({filter:/DesignCanvas\.jsx$/},args=>({contents:readFileSync(args.path,'utf8').replace('allowed[0].id',"'distribution'"),loader:'jsx'}));if(changed)builder.onLoad({filter:/ReportCenter\.jsx$/},args=>({contents:readFileSync(args.path,'utf8').replace('<h2>作品 × 流通の営業一覧</h2>','<h2>営業一覧・追従検証</h2>'),loader:'jsx'}));}}]});
 const {html}=await import(pathToFileURL(out));assert.equal(html.includes('営業一覧・追従検証'),changed);assert.ok(html.includes('inert=""'));assert.ok(html.includes('fieldset disabled'));
 }finally{try{unlinkSync(out)}catch{}}
}
console.log('PASS: source label change propagates into actual component embedded in read-only design canvas');

