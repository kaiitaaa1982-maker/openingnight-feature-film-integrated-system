#!/usr/bin/env node
// 撮影現場の記録（日々スケ・香盤・ロケ地・小道具・許可申請）の架空データを、別組織 DEMO-SALES の作品 DEMO-W02「七月の標本室（架空）」に入れる。
// 公開デモ（閲覧用プレビュー）のプリプロ・香盤・小道具・許可申請の画面に、実務で使っている画面と同じ形の中身を出すため。
// 元データ: demo-fixtures/genba-showcase/genba-showcase.json（generate_genba_showcase.py が作る。題名・人物・場所・担当はすべて架空）。
// 人が画面でするのと同じ受け口を、同じ順に呼ぶ。
//   1. 日々スケの取込（src/production/call-sheet-import.mjs。シーン・撮影日・役・ロケ地・入り時間・連絡事項）。原本の PDF は架空の1枚をその場で作る
//   2. 小道具の取込（POST /api/props/import。キーで重ならない）
//   3. 許可申請の提出先と申請（POST /api/permit-offices・/api/permits。提出先は名前、申請は場所で重ならない）と、
//      申請書・略図の架空の見本の PDF（demo-fixtures/genba-showcase/permits/）をプリプロの保管庫に置いて申請に結び付ける
// 使い方: node scripts/seed-genba-showcase-demo.mjs --db <SQLiteのパス> [--standalone]
// ・--standalone は、売上の架空データを使わず、この作品だけを持つ架空の制作会社（組織 DEMO-GENBA・管理者 genba-admin@openingnight.invalid）を作って入れる。
//   公開デモをこの1作品だけで記録するとき（scripts/build-preview.mjs --org DEMO-GENBA --user genba-admin@openingnight.invalid）に使う
// ・--db の指定は必須。data/integrated.sqlite へは --allow-main-db を付けたときだけ書く。
// ・売上の架空データ（scripts/seed-sales-demo.mjs）が作る組織 DEMO-SALES と作品 DEMO-W02 が要る。無ければ何もしない（skipped）。
// ・2回流しても増えない（入れ済みの日々スケ・小道具のキー・提出先・申請は飛ばす）。
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {importCallSheets} from '../src/production/call-sheet-import.mjs';
import {SALES_DEMO} from './seed-sales-demo.mjs';

const SOURCE = new URL('../demo-fixtures/genba-showcase/genba-showcase.json', import.meta.url);
const PERMIT_PDFS = new URL('../demo-fixtures/genba-showcase/permits/', import.meta.url);
export const SHOWCASE_WORK_CODE = 'DEMO-W02';
export const SHOWCASE_WORK_TITLE = '七月の標本室（架空）';
// --standalone で作る、この作品だけを持つ架空の制作会社
export const GENBA_DEMO = Object.freeze({orgCode: 'DEMO-GENBA', orgName: '架空の制作会社（デモ）', adminEmail: 'genba-admin@openingnight.invalid', adminName: '架空の制作部'});

async function createGenbaOrganization(db) {
  const orgId = Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM organizations')).id);
  await db.batch([
    {sql: "INSERT INTO organizations(id,code,name,kind) VALUES(?,?,?,'demo')", params: [orgId, GENBA_DEMO.orgCode, GENBA_DEMO.orgName]},
    {sql: 'INSERT INTO schema_meta(org_id,version) VALUES(?,1) ON CONFLICT(org_id) DO NOTHING', params: [orgId]},
    {sql: 'INSERT INTO users(email,display_name) VALUES(?,?) ON CONFLICT(email) DO NOTHING', params: [GENBA_DEMO.adminEmail, GENBA_DEMO.adminName]},
    {sql: "INSERT INTO memberships(org_id,user_id,role) SELECT ?,id,'admin' FROM users WHERE email=? ON CONFLICT(org_id,user_id) DO NOTHING", params: [orgId, GENBA_DEMO.adminEmail]},
  ]);
  return orgId;
}

export async function loadGenbaShowcase() {
  return JSON.parse(await readFile(SOURCE, 'utf8'));
}

// 日々スケの原本の代わりの、1頁の架空の PDF（文字は ASCII だけ。中身は「架空の日々スケ」と日付）
export function fictionalCallSheetPdf(label) {
  const text = `Fictional call sheet ${label}`.replace(/[()\\]/g, '');
  const stream = `BT /F1 18 Tf 60 760 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export async function seedGenbaShowcaseDemo(db, {log = () => {}, standalone = false} = {}) {
  const target = standalone ? GENBA_DEMO : SALES_DEMO;
  let org = await db.get('SELECT id FROM organizations WHERE code=?', [target.orgCode]);
  if (!org && standalone) org = {id: await createGenbaOrganization(db)};
  let work = org ? await db.get('SELECT id, project_id, code, title FROM works WHERE org_id=? AND code=?', [org.id, SHOWCASE_WORK_CODE]) : null;
  if (!work && !standalone) return {skipped: true, reason: `組織 ${SALES_DEMO.orgCode} の作品 ${SHOWCASE_WORK_CODE} がありません（売上の架空データを先に入れる）`};
  const source = await loadGenbaShowcase();

  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: target.adminEmail})});
  if (login.status !== 200) throw new Error(`架空の管理者でログインできません（${login.status}）`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, payload, headers = {}) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json', ...headers}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const data = await response.json();
    if (response.status >= 300 || data.ok === false) throw new Error(`${method} ${path}: ${response.status} ${data.error || JSON.stringify(data).slice(0, 600)}`);
    return data;
  };
  if ((await call('GET', '/session')).user.orgId !== org.id) throw new Error(`架空の管理者が ${target.orgCode} で入れていません`);
  let createdWork = 0;
  if (!work) {
    const projectId = (await call('POST', '/projects', {code: SHOWCASE_WORK_CODE, title: SHOWCASE_WORK_TITLE, status: 'active'})).id;
    const workId = (await call('POST', '/works', {project_id: projectId, code: SHOWCASE_WORK_CODE, title: SHOWCASE_WORK_TITLE, format: 'film'})).id;
    work = {id: workId, project_id: projectId};
    createdWork = 1;
  }
  const workTarget = {id: Number(work.id), project_id: Number(work.project_id)};

  // 1. 日々スケ
  const sheets = await importCallSheets(call, source.callSheets, {work: workTarget, readPdf: async (name) => fictionalCallSheetPdf(name), log});

  // 2. 小道具
  const knownKeys = new Set((await call('GET', `/props?workId=${workTarget.id}`)).items.map((row) => row.key));
  const newItems = source.props.items.filter((item) => !knownKeys.has(item.key));
  if (newItems.length) await call('POST', '/props/import', {workId: workTarget.id, items: newItems});
  log(`小道具: ${newItems.length}件（入れ済み ${source.props.items.length - newItems.length}件）`);

  // 3. 許可申請
  let permits = await call('GET', '/permits');
  const officeId = new Map(permits.offices.map((office) => [office.name, office.id]));
  let offices = 0;
  for (const office of source.permits.offices) {
    if (officeId.has(office.name)) continue;
    const created = await call('POST', '/permit-offices', office);
    officeId.set(office.name, created.id);
    offices += 1;
  }
  permits = await call('GET', '/permits');
  const placed = new Set(permits.applications.filter((row) => row.workId === workTarget.id).map((row) => row.place));
  let applications = 0;
  for (const {office, documents: _documents, ...application} of source.permits.applications) {
    if (placed.has(application.place)) continue;
    await call('POST', '/permits', {workId: workTarget.id, officeId: officeId.get(office), ...application});
    applications += 1;
  }
  // 申請書・略図の架空の見本を保管庫に置き（同じ名前があれば置かない）、申請に結び付ける（結び付いていれば飛ばす）
  const vault = new Map((await call('GET', `/preprod/works/${workTarget.id}/documents`)).documents.map((row) => [row.file_name, row.document_id]));
  const byPlace = new Map((await call('GET', '/permits')).applications.filter((row) => row.workId === workTarget.id).map((row) => [row.place, row.id]));
  let documents = 0;
  for (const application of source.permits.applications) {
    const permitId = byPlace.get(application.place);
    const linked = new Set((await call('GET', `/permits/${permitId}`)).documents.map((row) => row.document_id));
    for (const doc of application.documents ?? []) {
      if (!vault.has(doc.file)) {
        const bytes = await readFile(new URL(doc.file, PERMIT_PDFS));
        await call('POST', `/preprod/works/${workTarget.id}/documents`, {category: 'other', datedOn: application.appliedOn ?? application.startsOn,
          note: `許可申請（架空の見本）: ${application.place}`, fileName: doc.file, mediaType: 'application/pdf', base64: bytes.toString('base64')});
        vault.set(doc.file, (await call('GET', `/preprod/works/${workTarget.id}/documents`)).documents.find((row) => row.file_name === doc.file).document_id);
      }
      const documentId = vault.get(doc.file);
      if (linked.has(documentId)) continue;
      await call('POST', `/permits/${permitId}/documents`, {documentId, role: doc.role});
      documents += 1;
    }
  }
  log(`許可申請: 提出先 ${offices}件・申請 ${applications}件・書類 ${documents}件`);

  const wrote = createdWork + sheets.applied.length + newItems.length + offices + applications + documents;
  return {skipped: wrote === 0, orgCode: target.orgCode, workId: workTarget.id, callSheets: sheets.applied.length, props: newItems.length, offices, permits: applications, documents};
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const index = process.argv.indexOf('--db');
  const targetDb = index > 0 ? process.argv[index + 1] : null;
  if (!targetDb) {
    console.error('投入先のDBを --db で指定してください。既定のローカルDBへは書きません。');
    process.exit(2);
  }
  const mainDb = fileURLToPath(new URL('../data/integrated.sqlite', import.meta.url));
  if (resolve(targetDb).toLowerCase() === resolve(mainDb).toLowerCase() && !process.argv.includes('--allow-main-db')) {
    console.error('data/integrated.sqlite への投入は --allow-main-db を付けたときだけ行います。');
    process.exit(2);
  }
  const db = new LocalDatabase(resolve(targetDb));
  try {
    const result = await seedGenbaShowcaseDemo(db, {log: (message) => console.log(`  ${message}`), standalone: process.argv.includes('--standalone')});
    console.log(result.skipped ? `何もしませんでした: ${result.reason ?? '入れ済み'}` : `投入しました: ${JSON.stringify(result)}`);
  } finally {
    db.close();
  }
}
