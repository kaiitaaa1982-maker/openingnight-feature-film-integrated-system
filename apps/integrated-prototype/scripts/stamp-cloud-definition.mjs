import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root=fileURLToPath(new URL('..',import.meta.url));
const walk=p=>readdirSync(resolve(root,p),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p+'/'+e.name):[p+'/'+e.name]);
const paths=[...walk('src'),...walk('python').filter(p=>p.endsWith('.py')),...walk('../../analytics-poc/dbt/models'),...walk('../../analytics-poc/dbt/tests'),'../../analytics-poc/run_workbench_snapshot.py','scripts/export-workbench-snapshot.mjs','scripts/cloud-snapshot-materialize.mjs','Dockerfile.cloud','requirements-cloud.txt','package-lock.json'].sort();
const hash=createHash('sha256');for(const path of paths)hash.update(path).update(readFileSync(resolve(root,path)));
const definition=hash.digest('hex'),file=resolve(root,'wrangler.cloud.jsonc'),config=JSON.parse(readFileSync(file,'utf8'));
config.vars.CLOUD_ANALYTICS_DEFINITION_VERSION=definition;
writeFileSync(file,JSON.stringify(config,null,2)+'\n');
console.log(JSON.stringify({definition,files:paths.length}));
