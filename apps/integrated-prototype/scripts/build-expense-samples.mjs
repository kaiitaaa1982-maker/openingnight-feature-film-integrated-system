import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expenseTemplate} from '../src/expense-sheet/expense-workbook.mjs';
export async function buildExpenseSamples(directory){await mkdir(directory,{recursive:true});const paths=[];for(const [n,layout] of [[22,'legacy22'],[25,'standard25']]){const path=resolve(directory,`DEMO-expense-${n}.xlsx`);await writeFile(path,expenseTemplate(layout,{samples:true}));paths.push(path);}return paths;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const at=process.argv.indexOf('--out'),dir=at<0?process.argv[2]:process.argv[at+1];if(!dir)throw Error('出力先: node scripts/build-expense-samples.mjs --out <フォルダ>');console.log((await buildExpenseSamples(resolve(dir))).join('\n'));}
