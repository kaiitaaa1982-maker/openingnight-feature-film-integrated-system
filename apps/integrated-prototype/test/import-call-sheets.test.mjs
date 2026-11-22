import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {createClient, importCallSheets} from '../scripts/import-call-sheets.mjs';
import {checkCallSheetSource, isRegisteredSheet, toBase64} from '../src/production/call-sheet-import.mjs';

const source = JSON.parse(await readFile(new URL('../demo-fixtures/call-sheets/call-sheets-demo.json', import.meta.url), 'utf8'));
const readPdf = async (name) => new TextEncoder().encode(`%PDF-1.4 架空 ${name}`);

async function client(app) {
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})});
  assert.equal(login.status, 200);
  return createClient({app, cookie: login.headers.get('set-cookie').split(';')[0]});
}

test('call sheets without a script become scenes, days, production info and vault originals; the later version replaces the earlier with history', async (t) => {
  const db = await openTestDb({t}), app = createApp({db, mode: 'local'});
  try {
    const call = await client(app);
    const first = await importCallSheets(call, source, {readPdf});
    assert.deepEqual(first.applied, ['day1-draft.pdf', 'day1-final.pdf', 'day2-draft.pdf']);
    const production = await call('GET', `/production?workId=${first.workId}`);
    const scene = (no) => production.scenes.find((row) => row.scene_no === no);
    assert.deepEqual(production.scenes.map((row) => row.scene_no).sort(), ['1', '2', '3', '4', '5']);
    assert.equal(scene('1').synopsis, '6年ぶりの再会');
    assert.equal(scene('1').version, 2);
    assert.equal(scene('5').day_night, null);

    const day1 = production.days.find((row) => row.shoot_date === '2026-11-02');
    assert.equal(day1.label, '11/2（月）本隊 決');
    assert.equal(day1.version, 2);
    assert.match(day1.notes, /6:15 架空駅前発/);
    // 始まりと終わりが両方ある行だけ予定の時刻を入れ、片方だけの時刻は備考に残す
    assert.deepEqual(day1.assignments.map((a) => [a.sequence_order, a.planned_start, a.notes]), [
      [1, '2026-11-02T09:00', null],
      [2, null, '〜17:00・作りD・S#2,3 を1行で撮る'],
      [3, null, '〜17:00・作りD・S#2,3 を1行で撮る'],
    ]);
    const day2 = production.days.find((row) => row.shoot_date === '2026-11-04');
    assert.deepEqual(day2.assignments.map((a) => scene('4').id === a.scene_id || scene('5').id === a.scene_id), [true, true]);

    // 2回目の撮影は帯にし、出演に足す
    const again = production.daySlots.find((slot) => slot.day_id === day2.id && slot.label.startsWith('S#1'));
    assert.equal(again.after_scene_order, 1);
    assert.ok(production.appearances.some((a) => a.scene_id === scene('1').id && a.character_key === 'ren'));
    // グループは役へ広げる。入り時間は各日の最新の版
    const calls = production.calls.filter((c) => c.day_id === day1.id);
    assert.deepEqual(calls.map((c) => c.character_key).sort(), ['aoi', 'kaede', 'sora']);
    assert.equal(calls.find((c) => c.character_key === 'aoi').call_time, '2026-11-02T07:45');
    const details = new Map(production.scenes.map((row) => [row.scene_no, row]));
    assert.equal(details.get('2').page_eighths, 16);
    assert.equal(details.get('3').page_eighths, null);

    const history = await db.all("SELECT entity_type, detail_json FROM audit_log WHERE action='update' AND entity_type IN ('scenes','shooting_day') ORDER BY id");
    assert.equal(history.length, 2);
    assert.equal(JSON.parse(history[0].detail_json).before.synopsis, '5年ぶりの再会');
    assert.equal(JSON.parse(history[1].detail_json).before.label, '11/2（月）本隊 仮');

    const documents = (await call('GET', `/preprod/works/${first.workId}/documents`)).documents;
    assert.equal(documents.length, 3);
    assert.ok(documents.every((doc) => doc.category === 'daily' && doc.shooting_day_id && doc.origin_path.startsWith('current/ORG/')));

    // 2回流しても増えない
    const second = await importCallSheets(call, source, {readPdf});
    assert.deepEqual(second.applied, []);
    assert.equal(second.skipped.length, 3);
    assert.equal((await db.get('SELECT COUNT(*) n FROM scenes WHERE work_id=?', [first.workId])).n, 5);
    assert.equal((await db.get('SELECT COUNT(*) n FROM preprod_document_placements WHERE work_id=?', [first.workId])).n, 3);
  } finally {
    await db.close();
  }
});

test('the screen path imports into the selected work and checks the JSON before importing', async (t) => {
  const db = await openTestDb({t}), app = createApp({db, mode: 'local'});
  try {
    const call = await client(app);
    const work = (await call('GET', '/works')).rows.find((row) => row.id === 1);
    const result = await importCallSheets(call, source, {work, readPdf});
    assert.equal(result.workId, 1);
    assert.equal((await db.get("SELECT COUNT(*) n FROM projects WHERE code='DEMO-CS'")).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) n FROM scenes WHERE work_id=1 AND scene_no IN (?,?,?,?,?)', ['1', '2', '3', '4', '5'])).n, 5);
    const documents = (await call('GET', '/preprod/works/1/documents')).documents;
    assert.ok(source.sheets.every((sheet) => isRegisteredSheet(documents, sheet)));
  } finally {
    await db.close();
  }
  assert.deepEqual(checkCallSheetSource(source), []);
  const broken = {...source, sheets: [{...source.sheets[0], rows: [{s: ['9'], cast: ['nobody']}]}]};
  assert.deepEqual(checkCallSheetSource(broken), ['day1-draft.pdf 1行目 cast: 役 nobody が characters・groups にない']);
  assert.deepEqual(checkCallSheetSource({work: {unit: '本隊', projectCode: 'P', projectTitle: 'T', workCode: 'W', workTitle: 'T'}}), ['characters: characters（役）の配列がない', 'locations: locations（ロケ地）を1つ以上にする', 'sheets: sheets（日々スケ）を1枚以上にする']);
  assert.equal(toBase64(new TextEncoder().encode('架空')), Buffer.from('架空').toString('base64'));
});

test('a later import keeps what people entered by hand (costumes, other roles, other days)', async (t) => {
  const db = await openTestDb({t}), app = createApp({db, mode: 'local'});
  try {
    const call = await client(app);
    const first = await importCallSheets(call, {...source, sheets: [source.sheets[0]]}, {readPdf});
    let production = await call('GET', `/production?workId=${first.workId}`);
    const scene1 = production.scenes.find((row) => row.scene_no === '1').id;
    // 人が画面で足す: 衣装と着用・日々スケに無い役・予定尺
    const graph = {characters: [...production.characters, {key: 'role:監督', name: '架空の監督役', short_name: '監'}], locations: production.locations,
      sceneDetails: production.sceneDetails.map((d) => (d.scene_id === scene1 ? {...d, estimated_minutes: 30} : d)), appearances: production.appearances,
      looks: [{key: 'look-aoi', character_key: 'aoi', label: '#1 私服'}], sceneLooks: [{scene_id: scene1, look_key: 'look-aoi'}], daySlots: production.daySlots, calls: production.calls};
    await call('PUT', `/production/${first.workId}`, graph, {'if-match': String(production.version)});

    await importCallSheets(call, source, {readPdf});
    production = await call('GET', `/production?workId=${first.workId}`);
    assert.ok(production.characters.some((c) => c.key === 'role:監督'));
    assert.deepEqual(production.looks.map((l) => l.key), ['look-aoi']);
    assert.deepEqual(production.sceneLooks.map((l) => [l.scene_id, l.look_key]), [[scene1, 'look-aoi']]);
    assert.equal(production.sceneDetails.find((d) => d.scene_id === scene1).estimated_minutes, 30);
    const day1 = production.days.find((row) => row.shoot_date === '2026-11-02').id;
    assert.equal(production.calls.find((c) => c.day_id === day1 && c.character_key === 'aoi').call_time, '2026-11-02T07:45');
  } finally {
    await db.close();
  }
});

test('作品に同じ名前のロケ地が別の識別子で入っていても、取り込みはいまあるロケ地を使い、ロケ地を重ねない', async (t) => {
  const db = await openTestDb({t}), app = createApp({db, mode: 'local'});
  try {
    const call = await client(app);
    const first = await importCallSheets(call, {...source, sheets: [source.sheets[0]]}, {readPdf});
    let production = await call('GET', `/production?workId=${first.workId}`);
    // 人が画面で「架空海浜公園」を別の識別子で入れ直す（日々スケの識別子 park とは違う）
    const handKey = 'loc-hand-1';
    const locations = production.locations.map((l) => (l.key === 'park' ? {...l, key: handKey, note: '手で入れた'} : l));
    const sceneDetails = production.sceneDetails.map((d) => ({...d, location_key: d.location_key === 'park' ? handKey : d.location_key}));
    await call('PUT', `/production/${first.workId}`, {characters: production.characters, locations, sceneDetails, appearances: production.appearances,
      looks: production.looks, sceneLooks: production.sceneLooks, daySlots: production.daySlots, calls: production.calls}, {'if-match': String(production.version)});

    const result = await importCallSheets(call, source, {readPdf});
    assert.equal(result.applied.length, source.sheets.length - 1);
    production = await call('GET', `/production?workId=${first.workId}`);
    const parks = production.locations.filter((l) => l.name === '架空海浜公園');
    assert.deepEqual(parks.map((l) => [l.key, l.note]), [[handKey, '手で入れた']]);
    assert.equal(production.locations.some((l) => l.key === 'park'), false);
    // 取り込んだシーンも、いまあるロケ地を指す
    assert.deepEqual([...new Set(production.sceneDetails.map((d) => d.location_key))], [handKey]);
  } finally {
    await db.close();
  }
});
