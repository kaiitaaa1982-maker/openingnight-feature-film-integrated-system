import {readFileSync,writeFileSync,mkdirSync,copyFileSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const source=resolve(root,'data/workflow-video-20260923'),target=resolve(root,'public/workflow-demo');
const reports=['committee-income','sales-trend','sales-banpan','sales-pnl','mg-incoming','mg-outgoing'];
const files=['human-workflow-demo.mp4','human-workflow-demo.srt','human-workflow-demo.vtt','poster.png',...reports.flatMap(name=>['pdf','xlsx','html','csv'].map(ext=>`reports/${name}.${ext}`))];
const verification=JSON.parse(readFileSync(resolve(source,'verification.json'),'utf8'));
if(verification.durationSeconds!==232||verification.subtitleCueCount!==18||verification.viewer?.copiedReportCount!==24)throw Error('デモの検証記録が一致しません');
mkdirSync(resolve(target,'reports'),{recursive:true});
for(const file of files){if(statSync(resolve(source,file)).size>=25*1024*1024)throw Error('静的配信のサイズ上限を超えます');copyFileSync(resolve(source,file),resolve(target,file))}
let html=readFileSync(resolve(source,'index.html'),'utf8');
const match=html.match(/<script>([\s\S]*?)<\/script>/);if(!match)throw Error('再生用スクリプトがありません');
writeFileSync(resolve(target,'player.js'),match[1]);
html=html.replace(match[0],'<script src="player.js" defer></script>').replace('人が回す映画業務｜ローカル実証','人が回す映画業務｜操作デモ').replace('ローカル実証であり公開環境には配備していません。','架空専用DBでの実証を収録しています。映像内のデータは現在の業務データとは別です。').replace('<main><h1>','<main><a href="/">業務画面へ戻る</a><h1>');
writeFileSync(resolve(target,'index.html'),html);
console.log(JSON.stringify({files:files.length+2,syntheticOnly:true,path:'/workflow-demo/'}));
