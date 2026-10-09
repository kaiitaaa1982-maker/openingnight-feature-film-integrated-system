import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseCsv} from '../src/csv.mjs';
const source=process.argv[2]||new URL('../../../../openingnight-brain/raw/流通マスタ.csv',import.meta.url);
const bytes=await readFile(source),hash=createHash('sha256').update(bytes).digest('hex');
const headers=['流通ID','流通名','取引方法','販売種別','備考'];
const rows=parseCsv(bytes.toString('utf8'));
if(rows.some(r=>JSON.stringify(Object.keys(r.values))!==JSON.stringify(headers)))throw Error('Expected five source columns');
const ids=new Set();for(const r of rows){const id=r.values.流通ID;if(!/^[A-Z][0-9]{3}$/.test(id)||ids.has(id))throw Error('Invalid or duplicate distribution ID');ids.add(id)}
const q=x=>"'"+String(x).replaceAll("'","''")+"'";
let sql=`-- Generated from the user-supplied 流通マスタ.csv. SHA-256: ${hash}\nCREATE TABLE IF NOT EXISTS distribution_master (\n code TEXT PRIMARY KEY REFERENCES distribution_types(code), distribution_name TEXT NOT NULL, transaction_method TEXT NOT NULL, sales_type TEXT NOT NULL, notes TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_row INTEGER NOT NULL\n);\n`;
for(const [index,r] of rows.entries()){
 const values=headers.map(h=>r.values[h]);
 sql+=`INSERT INTO distribution_types(code,family,label,utilization,sort_order) VALUES(${q(values[0])},'unverified',${q(values[0])},NULL,${100+index}) ON CONFLICT(code) DO NOTHING;\n`;
 sql+=`INSERT INTO distribution_master VALUES(${[...values,hash].map(q).join(',')},${r.rowNo}) ON CONFLICT(code) DO NOTHING;\n`;
 sql+=`INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM distribution_master WHERE code=${q(values[0])} AND distribution_name=${q(values[1])} AND transaction_method=${q(values[2])} AND sales_type=${q(values[3])} AND notes=${q(values[4])});\n`;
}
sql+="CREATE TRIGGER IF NOT EXISTS distribution_master_no_update BEFORE UPDATE ON distribution_master BEGIN SELECT RAISE(ABORT,'distribution master requires explicit migration'); END;\nCREATE TRIGGER IF NOT EXISTS distribution_master_no_delete BEFORE DELETE ON distribution_master BEGIN SELECT RAISE(ABORT,'distribution master in use'); END;\n";
await writeFile(new URL('../src/distribution-master.sql',import.meta.url),sql);
console.log(`Generated ${rows.length} master rows; ${hash}`);
