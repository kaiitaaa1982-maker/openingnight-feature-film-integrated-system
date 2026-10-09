// Offline rendering of app-generated, synthetic report HTML. No website navigation.
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const {chromium}=createRequire(import.meta.url)(resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const out=resolve(process.argv[2]||'data/report-completion-20260923');
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor:1});
 await page.route('**/*',route=>route.abort());
 for(const name of (await readdir(out)).filter(n=>n.endsWith('.html'))){
  await page.setContent(await readFile(resolve(out,name),'utf8'));
  await page.emulateMedia({media:'print'});
  await page.pdf({path:resolve(out,name.replace('.html','.pdf')),preferCSSPageSize:true,printBackground:true});
  await page.screenshot({path:resolve(out,name.replace('.html','-preview.png')),fullPage:true});
  console.log(name+' rendered');
 }
}finally{await browser.close()}
