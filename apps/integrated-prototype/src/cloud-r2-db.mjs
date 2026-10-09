import {D1Database} from './d1-db.mjs';
import {D1_INLINE_VALUE_BYTES} from './d1-limits.mjs';

const markerPrefix='@r2:v1:';
const encoder=new TextEncoder();
const decoder=new TextDecoder();
const maxHydratedBytes=16*1024*1024;
const largeValueBytes=D1_INLINE_VALUE_BYTES;
const externalColumns=new Map([
  ['workbench_source_artifacts',new Set(['raw_base64','extraction_json'])],
  ['workflow_raw_artifacts',new Set(['original_base64','extraction_json'])],
  ['expense_source_files',new Set(['original_base64'])],
  ['sales_source_files',new Set(['original_base64','extraction_json'])],
  ['sales_source_selections',new Set(['canonical_csv'])],
  ['import_previews',new Set(['payload_json'])],
  ['workbench_snapshots',new Set(['rows_json'])],
  ['workbench_drafts',new Set(['rows_json'])],
  ['workbench_validations',new Set(['result_json'])],
  ['workbench_applications',new Set(['result_json'])],
  ['workbench_lineage',new Set(['detail_json'])]
]);
const hydrationColumns=new Set([...externalColumns.values()].flatMap(columns=>[...columns]));
// 大きさによらず、いつも R2 に置く列（D1 には参照だけを書く）
const forcedExternalColumns=new Set(['raw_base64','original_base64','extraction_json']);

async function sha256(bytes){const digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('')}
function marker(key,hash,size){return `${markerPrefix}${key}:${hash}:${size}`}
function parseMarker(value){if(typeof value!=='string'||!value.startsWith(markerPrefix))return null;const rest=value.slice(markerPrefix.length),last=rest.lastIndexOf(':'),second=rest.lastIndexOf(':',last-1);if(last<1||second<1)return null;const size=Number(rest.slice(last+1)),hash=rest.slice(second+1,last),key=rest.slice(0,second);return Number.isSafeInteger(size)&&/^[a-f0-9]{64}$/.test(hash)?{key,hash,size}:null}
function insertColumns(sql){const match=/insert\s+into\s+([a-z0-9_]+)\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)/i.exec(sql);if(!match)return null;const columns=match[2].split(',').map(value=>value.trim().toLowerCase()),values=match[3].split(',').map(value=>value.trim());return values.length===columns.length&&values.every(value=>value==='?')?{table:match[1].toLowerCase(),columns}:null}

// 大きな値を R2 へ逃がす層。内側の入口（all・get・run・batch・readBatch を持つもの。D1Database・LocalDatabase・PgDatabase）を包む（FR-CORE-DATA-008）。
// - 外へ逃がす列（externalColumns）の値は R2 に置き、行には印（@r2:v1:…）だけを書く。読むときに印を元の値へ戻す
// - 逃がさない列の値は maxInlineValueBytes（既定は D1 の1行の上限 128KB）を超えると断る。PostgreSQL の入口でも本番の D1 と同じ断り方にそろえる。
//   null で外せる（外すかは代表の判断待ち。既定はそろえる）
// - 1回の batch の文の数は maxBatchStatements で断る。D1 の上限なので、PostgreSQL の入口では持ち込まない（既定 null。FR-CORE-DATA-007）
// - dialect と maxBatchStatements を外へ見せる（src/admin/er-routes.mjs が dialect、src/production.mjs が maxBatchStatements を読む）
export class R2LargeValueDatabase {
  constructor(inner,bucket,{prefix='private/workbench',maxBatchStatements=null,maxInlineValueBytes=largeValueBytes}={}){
    if(!inner||!['all','get','run','batch','readBatch'].every(name=>typeof inner[name]==='function'))throw new Error('R2LargeValueDatabase には入口（all・get・run・batch・readBatch）を渡す');
    if(!bucket)throw new Error('R2 binding is required');
    this.inner=inner;this.bucket=bucket;this.prefix=prefix.replace(/\/$/,'');this.maxBatchStatements=maxBatchStatements;this.maxInlineValueBytes=maxInlineValueBytes;
  }
  // DB の種類の印は内側の入口のもの（PgDatabase は 'postgres'。SQLite の入口には無い）
  get dialect(){return this.inner.dialect}
  async store(value,{force=false}={}){if(typeof value!=='string')return value;const bytes=encoder.encode(value);if(!force&&bytes.byteLength<=largeValueBytes)return value;if(bytes.byteLength>maxHydratedBytes)throw new Error('永続化する値が16MB上限を超えています');const hash=await sha256(bytes),key=`${this.prefix}/sha256/${hash.slice(0,2)}/${hash}`;const existing=await this.bucket.head(key);if(existing){if(existing.size!==undefined&&existing.size!==bytes.byteLength)throw new Error('R2 immutable object size mismatch');if(existing.customMetadata?.sha256&&existing.customMetadata.sha256!==hash)throw new Error('R2 immutable object hash mismatch')}else{const created=await this.bucket.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/octet-stream'},customMetadata:{sha256:hash,immutable:'true'}});if(!created){const raced=await this.bucket.head(key);if(!raced||raced.size!==undefined&&raced.size!==bytes.byteLength||raced.customMetadata?.sha256&&raced.customMetadata.sha256!==hash)throw new Error('R2 immutable object race mismatch')}}return marker(key,hash,bytes.byteLength)}
  async hydrateValue(value){const ref=parseMarker(value);if(!ref)return value;const expected=`${this.prefix}/sha256/${ref.hash.slice(0,2)}/${ref.hash}`;if(ref.key!==expected)throw new Error('R2参照キーが不正です');if(ref.size>maxHydratedBytes)throw new Error('R2参照値が読取上限を超えています');const object=await this.bucket.get(ref.key);if(!object||!object.body)throw new Error('R2参照先がありません');const bytes=new Uint8Array(await object.arrayBuffer());if(bytes.byteLength!==ref.size||await sha256(bytes)!==ref.hash)throw new Error('R2参照値の完全性を確認できません');return decoder.decode(bytes)}
  async hydrateRow(row){if(!row)return row;const output={...row};for(const [key,value] of Object.entries(output))if(hydrationColumns.has(key))output[key]=await this.hydrateValue(value);return output}
  async prepareStatement({sql,params=[]}){const info=insertColumns(sql),allowed=info&&externalColumns.get(info.table),limit=this.maxInlineValueBytes,next=[];for(let index=0;index<params.length;index++){const value=params[index],column=info?.columns[index]||'',external=Boolean(allowed?.has(column));if(typeof value==='string'&&value.startsWith(markerPrefix)&&!external)throw new Error('予約済みR2参照形式は保存できません');if(limit!=null&&typeof value==='string'&&encoder.encode(value).byteLength>limit&&!external)throw new Error('この項目はD1行内サイズ上限を超えています');next.push(external?await this.store(value,{force:forcedExternalColumns.has(column)}):value)}return {sql,params:next}}
  // 書き込みの文（INSERT … RETURNING id を get で受け取るときなど）は、run と同じく大きな値を R2 へ逃がしてから流す
  async writeStatement(sql,params){return /^\s*(?:insert|update|replace|delete)\b/i.test(sql)?this.prepareStatement({sql,params}):{sql,params}}
  async hydrateRows(rows){return Promise.all(rows.map(row=>this.hydrateRow(row)))}
  // 文の数の上限は R2 にも DB にも書く前に断る（上限が null なら配列であることだけを見る）
  checkBatch(statements){if(!Array.isArray(statements))throw new Error(this.maxBatchStatements==null?'batch には文の配列を渡す':`D1 atomic batch exceeds ${this.maxBatchStatements} statements`);if(this.maxBatchStatements!=null&&statements.length>this.maxBatchStatements)throw new Error(`D1 atomic batch exceeds ${this.maxBatchStatements} statements`)}
  async all(sql,params=[]){const statement=await this.writeStatement(sql,params);return this.hydrateRows(await this.inner.all(statement.sql,statement.params))}
  async get(sql,params=[]){const statement=await this.writeStatement(sql,params);return this.hydrateRow(await this.inner.get(statement.sql,statement.params))}
  async run(sql,params=[]){const statement=await this.prepareStatement({sql,params});return this.inner.run(statement.sql,statement.params)}
  async batch(statements){this.checkBatch(statements);const prepared=[];for(const statement of statements)prepared.push(await this.prepareStatement(statement));return Promise.all((await this.inner.batch(prepared)).map(async result=>({...result,rows:await this.hydrateRows(result.rows)})))}
  async readBatch(statements){this.checkBatch(statements);return Promise.all((await this.inner.readBatch(statements)).map(rows=>this.hydrateRows(rows)))}
}

// 本番（Cloudflare D1）の入口。D1 の束ねを D1Database で開き、R2 の層で包む。名前・引数・エラーの文・文の数の上限（既定500）はいままでのまま
export class R2BackedD1Database extends R2LargeValueDatabase {
  constructor(binding,bucket,{prefix='private/workbench',maxBatchStatements=500}={}){super(new D1Database(binding),bucket,{prefix,maxBatchStatements});this.binding=binding}
}

export const cloudR2Internals={markerPrefix,parseMarker,insertColumns,largeValueBytes,maxHydratedBytes,hydrationColumns,externalColumns,forcedExternalColumns};
