// 撮影現場の記録の架空データ（scripts/seed-genba-showcase-demo.mjs）の試験。
// 元データ demo-fixtures/genba-showcase/genba-showcase.json の件数を、試験の中で数えて期待値にする（実装の関数で数えない）。
// ・売上の架空データが作る作品 DEMO-W02 に、日々スケ・シーン・役・ロケ地・小道具・許可申請が、画面の受け口から読める形で入る
// ・2回目は何も書かない（表の行数が変わらない）
// ・作品 DEMO-W02 が無い DB では何も書かずに skipped を返す
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {seedSalesDemo, SALES_DEMO} from '../scripts/seed-sales-demo.mjs';
import {seedGenbaShowcaseDemo, fictionalCallSheetPdf} from '../scripts/seed-genba-showcase-demo.mjs';
import {tableCounts} from '../scripts/seed-all-demo.mjs';

const source = JSON.parse(await readFile(new URL('../demo-fixtures/genba-showcase/genba-showcase.json', import.meta.url), 'utf8'));

async function readAs(db, path) {
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await app.request(`/api${path}`, {headers: {cookie}});
  assert.equal(response.status, 200, path);
  return response.json();
}

test('作品 DEMO-W02 に日々スケ・小道具・許可申請が入り、2回目は何も書かない', async (t) => {
  const db = await openTestDb({t});
  await seedSalesDemo(db, {});
  const work = await db.get('SELECT w.id FROM works w JOIN organizations o ON o.id=w.org_id WHERE o.code=? AND w.code=?', [SALES_DEMO.orgCode, 'DEMO-W02']);
  assert.ok(work, '売上の架空データが作品 DEMO-W02 を作る');

  const first = await seedGenbaShowcaseDemo(db);
  assert.equal(first.skipped, false);
  assert.equal(first.workId, Number(work.id));

  const sheets = source.callSheets.sheets;
  const sceneNos = new Set(sheets.flatMap((sheet) => sheet.rows.filter((row) => row.s).flatMap((row) => row.s)));
  const production = await readAs(db, `/production?workId=${work.id}`);
  assert.deepEqual(production.days.map((day) => day.shoot_date).sort(), sheets.map((sheet) => sheet.date).sort());
  assert.equal(production.scenes.length, sceneNos.size);
  assert.deepEqual(production.characters.map((row) => row.name).sort(), source.callSheets.characters.map((row) => row.name).sort());
  assert.deepEqual(production.locations.map((row) => row.name).sort(), source.callSheets.locations.map((row) => row.name).sort());
  assert.ok(production.days.every((day) => day.notes), '連絡事項が撮影日ごとに入る');

  const props = await readAs(db, `/props?workId=${work.id}`);
  assert.equal(props.workId, Number(work.id));
  assert.equal(props.items.length, source.props.items.length);
  const expectedStates = {};
  for (const item of source.props.items) expectedStates[item.state] = (expectedStates[item.state] ?? 0) + 1;
  const states = {};
  for (const item of props.items) states[item.state] = (states[item.state] ?? 0) + 1;
  assert.deepEqual(states, expectedStates);

  const permits = await readAs(db, '/permits');
  const mine = permits.applications.filter((row) => row.workId === Number(work.id));
  assert.deepEqual(mine.map((row) => row.place).sort(), source.permits.applications.map((row) => row.place).sort());
  const expectedPermitStates = source.permits.applications.map((row) => row.state).sort();
  assert.deepEqual(mine.map((row) => row.state).sort(), expectedPermitStates);

  const before = await tableCounts(db);
  const second = await seedGenbaShowcaseDemo(db);
  assert.equal(second.skipped, true);
  assert.deepEqual(await tableCounts(db), before);
});

test('作品 DEMO-W02 が無い DB では何も書かない', async (t) => {
  const db = await openTestDb({t});
  const before = await tableCounts(db);
  const result = await seedGenbaShowcaseDemo(db);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /DEMO-W02/);
  assert.deepEqual(await tableCounts(db), before);
});

test('日々スケの原本の代わりは、読める1頁の PDF', () => {
  const pdf = fictionalCallSheetPdf('day1-final.pdf').toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.ok(pdf.trimEnd().endsWith('%%EOF'));
  const xref = Number(pdf.match(/startxref\n(\d+)/)[1]);
  assert.equal(pdf.slice(xref, xref + 4), 'xref');
});
