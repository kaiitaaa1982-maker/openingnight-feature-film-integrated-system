// 日々スケの JSON を取り込む前に確かめる純関数（src/production/call-sheet-source-check.mjs）と、取り込みがその検査で止まること。データは架空。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {createClient} from '../scripts/import-call-sheets.mjs';
import {importCallSheets} from '../src/production/call-sheet-import.mjs';
import {assertCallSheetJson, checkCallSheetJson, formatProblem, isRealDate} from '../src/production/call-sheet-source-check.mjs';

const demo = JSON.parse(await readFile(new URL('../demo-fixtures/call-sheets/call-sheets-demo.json', import.meta.url), 'utf8'));
const broken = (change) => { const copy = structuredClone(demo); change(copy); return checkCallSheetJson(copy); };
const has = (problems, {sheet, row, field, message}) => problems.some((p) => (sheet === undefined || p.sheet === sheet) && (row === undefined || p.row === row)
  && (field === undefined || p.field === field) && p.message.includes(message));

test('見本の JSON は問題0', () => {
  assert.deepEqual(checkCallSheetJson(demo), []);
  assert.doesNotThrow(() => assertCallSheetJson(demo));
});

test('必須の欄と型: work の各値・役・ロケ地・sheets', () => {
  assert.deepEqual(checkCallSheetJson(null).map(formatProblem), ['JSON の一番外はオブジェクトにする']);
  for (const field of ['projectCode', 'projectTitle', 'workCode', 'workTitle', 'unit']) {
    assert.ok(has(broken((s) => { s.work[field] = ''; }), {field: `work.${field}`, message: '空でない文字'}), field);
  }
  assert.ok(has(broken((s) => { delete s.work; }), {field: 'work', message: 'work'}));
  assert.ok(has(broken((s) => { s.characters[1].key = 'aoi'; }), {field: 'characters[2].key', message: '役 aoi が2つある'}));
  assert.ok(has(broken((s) => { s.characters[0].name = ''; }), {field: 'characters[1].name', message: '空でない文字'}));
  assert.ok(has(broken((s) => { s.locations = []; }), {field: 'locations', message: '1つ以上'}));
  assert.ok(has(broken((s) => { s.locations[1].key = 'park'; }), {field: 'locations[2].key', message: 'ロケ地 park が2つある'}));
  assert.ok(has(broken((s) => { s.sheets = []; }), {field: 'sheets', message: '1枚以上'}));
  assert.ok(has(broken((s) => { s.sheets[0].stamp = ''; }), {sheet: 'day1-draft.pdf', field: 'stamp', message: '版の印'}));
  assert.ok(has(broken((s) => { delete s.sheets[0].crew; }), {sheet: 'day1-draft.pdf', field: 'crew', message: '班'}));
  assert.ok(has(broken((s) => { s.sheets[0].file = 'day1-draft.png'; }), {field: 'file', message: '.pdf'}));
  assert.ok(has(broken((s) => { delete s.sheets[0].calls; }), {field: 'calls', message: '配列'}));
  assert.ok(has(broken((s) => { s.sheets[0].notes = 'メモ'; }), {field: 'notes', message: '文字の配列'}));
});

test('日付は実在する YYYY-MM-DD で、曜日が合う', () => {
  assert.equal(isRealDate('2026-11-02'), true);
  assert.equal(isRealDate('2028-02-29'), true);
  for (const value of ['2026-02-29', '2026-13-01', '2026-11-31', '2026/11/02', '2026-11-2', 20261102]) assert.equal(isRealDate(value), false, String(value));
  assert.ok(has(broken((s) => { s.sheets[0].date = '2026-11-31'; }), {sheet: 'day1-draft.pdf', field: 'date', message: '実在する YYYY-MM-DD'}));
  assert.ok(has(broken((s) => { s.sheets[0].weekday = '火'; }), {sheet: 'day1-draft.pdf', field: 'weekday', message: '2026-11-02（月）と合わない'}));
});

test('時刻は HH:MM で 00:00〜23:59、頁数は数か null', () => {
  for (const value of ['24:00', '9:00', '09:60', '0900', 900]) {
    assert.ok(has(broken((s) => { s.sheets[0].rows[0].start = value; }), {row: '1行目', field: 'start', message: 'HH:MM'}), String(value));
  }
  assert.ok(has(broken((s) => { s.sheets[0].calls[1].time = '25:00'; }), {row: '入り2', field: 'time', message: 'HH:MM'}));
  assert.ok(has(broken((s) => { s.sheets[0].sunrise = '6:05'; }), {field: 'sunrise', message: 'HH:MM'}));
  assert.ok(has(broken((s) => { delete s.sheets[0].sunset; }), {field: 'sunset', message: 'そろえて'}));
  assert.deepEqual(broken((s) => { s.sheets[0].rows[0].pages = null; }), []);
  assert.ok(has(broken((s) => { s.sheets[0].rows[0].pages = '1.5'; }), {row: '1行目', field: 'pages', message: '数か null'}));
  assert.ok(has(broken((s) => { s.sheets[0].calls[0].ready = 'yes'; }), {row: '入り1', field: 'ready', message: 'true か false'}));
});

test('行はシーンの行・帯・again のどれか1つ。S# は空でなく、帯の種類は決まった5つ', () => {
  assert.ok(has(broken((s) => { s.sheets[0].rows[1].s = ['9']; }), {row: '2行目', message: 'どれか1つ'}));
  assert.ok(has(broken((s) => { s.sheets[0].rows[1].again = true; }), {row: '2行目', message: 'どれか1つ'}));
  assert.ok(has(broken((s) => { s.sheets[0].rows.push({label: '何か'}); }), {row: '4行目', message: 'どれでもない'}));
  assert.ok(has(broken((s) => { s.sheets[0].rows[0].s = []; }), {row: '1行目', field: 's', message: '1つ以上'}));
  assert.ok(has(broken((s) => { s.sheets[0].rows[0].s = ['']; }), {row: '1行目', field: 's', message: '空でない文字'}));
  assert.ok(has(broken((s) => { s.sheets[0].rows[0].s = [1]; }), {row: '1行目', field: 's', message: '空でない文字'}));
  assert.ok(has(broken((s) => { s.sheets[2].rows.find((r) => r.again).s = []; }), {sheet: 'day2-draft.pdf', field: 's', message: '1つ以上'}));
  assert.ok(has(broken((s) => { s.sheets[2].rows.find((r) => r.again).label = ''; }), {sheet: 'day2-draft.pdf', field: 'label', message: '2回目の帯'}));
  assert.ok(has(broken((s) => { s.sheets[0].rows[1].slot = 'lunch'; }), {row: '2行目', field: 'slot', message: 'move・meal・wrap・prep・other'}));
  assert.ok(has(broken((s) => { s.sheets[0].rows[1].label = ''; }), {row: '2行目', field: 'label', message: '帯の名前'}));
  for (const kind of ['move', 'meal', 'wrap', 'prep', 'other']) assert.deepEqual(broken((s) => { s.sheets[0].rows[1].slot = kind; }), [], kind);
  assert.ok(has(broken((s) => { s.sheets[0].rows[2].s = ['1']; }), {row: '3行目', field: 's', message: 'S#1 が 1行目 と重なる'}));
});

test('cast・who は characters か @groups にあり、place は locations に、groups の中身は characters にある', () => {
  assert.ok(has(broken((s) => { s.sheets[0].rows[0].cast = ['aoi', 'nobody']; }), {sheet: 'day1-draft.pdf', row: '1行目', field: 'cast', message: '役 nobody'}));
  assert.ok(has(broken((s) => { s.sheets[0].rows[0].cast = ['@無いバンド']; }), {row: '1行目', field: 'cast', message: '役 @無いバンド'}));
  assert.ok(has(broken((s) => { s.sheets[2].rows.find((r) => r.again).cast = ['nobody']; }), {sheet: 'day2-draft.pdf', field: 'cast', message: '役 nobody'}));
  assert.ok(has(broken((s) => { s.sheets[0].calls[0].who = ['nobody']; }), {row: '入り1', field: 'who', message: '役 nobody'}));
  assert.ok(has(broken((s) => { s.sheets[0].calls[0].who = []; }), {row: '入り1', field: 'who', message: '1つ以上'}));
  assert.ok(has(broken((s) => { s.sheets[0].calls[0].place = 'nowhere'; }), {row: '入り1', field: 'place', message: 'ロケ地 nowhere'}));
  assert.ok(has(broken((s) => { s.groups['架空バンド'].push('nobody'); }), {field: 'groups.架空バンド', message: '役 nobody'}));
  assert.ok(has(broken((s) => { s.groups['空の組'] = []; }), {field: 'groups.空の組', message: '1人以上'}));
});

test('帯とシーンの終わりが始まりより前（か同じ）', () => {
  assert.ok(has(broken((s) => { s.sheets[1].rows[0].end = '08:30'; }), {sheet: 'day1-final.pdf', row: '1行目', field: 'end', message: '終わり 08:30 が始まり 09:00 より前'}));
  assert.ok(has(broken((s) => { s.sheets[0].rows[1].end = '12:00'; }), {sheet: 'day1-draft.pdf', row: '2行目', field: 'end', message: 'より前か同じ'}));
  assert.ok(has(broken((s) => { const again = s.sheets[2].rows.find((r) => r.again); again.end = '14:00'; }), {sheet: 'day2-draft.pdf', field: 'end', message: '終わり 14:00'}));
});

test('同じ date・stamp の sheet が2つ、file 名の重複', () => {
  assert.ok(has(broken((s) => { s.sheets[1].stamp = '仮'; }), {sheet: 'day1-final.pdf', field: 'stamp', message: '2026-11-02 の「仮」が day1-draft.pdf と2つある'}));
  assert.ok(has(broken((s) => { s.sheets[2].file = 'day1-draft.pdf'; }), {field: 'file', message: '1 枚目と同じ'}));
});

test('問題のある JSON では受け口を1つも呼ばず、一覧を全部メッセージに入れて投げる', async () => {
  const bad = structuredClone(demo);
  bad.sheets[0].weekday = '火';
  bad.sheets[1].rows[0].cast = ['nobody'];
  const calls = [];
  const call = async (method, path) => { calls.push(`${method} ${path}`); return {rows: [], documents: [], scenes: [], days: []}; };
  await assert.rejects(importCallSheets(call, bad, {readPdf: async () => new Uint8Array()}), (error) => {
    assert.equal(error.problems.length, 2);
    assert.match(error.message, /2 件の問題/);
    assert.match(error.message, /day1-draft\.pdf weekday/);
    assert.match(error.message, /day1-final\.pdf 1行目 cast: 役 nobody/);
    return true;
  });
  assert.deepEqual(calls, []);
});

test('問題のある JSON は手元の DB に何も書かない', async (t) => {
  const db = await openTestDb({t}), app = createApp({db, mode: 'local'});
  try {
    const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})});
    const call = createClient({app, cookie: login.headers.get('set-cookie').split(';')[0]});
    const count = async () => Object.fromEntries(await Promise.all(['projects', 'works', 'scenes', 'shooting_days', 'preprod_document_placements', 'audit_log']
      .map(async (table) => [table, (await db.get(`SELECT COUNT(*) n FROM ${table}`)).n])));
    const before = await count();
    const bad = structuredClone(demo);
    bad.sheets[2].rows[0].s = [];
    await assert.rejects(importCallSheets(call, bad, {readPdf: async () => new Uint8Array()}), /1 件の問題/);
    assert.deepEqual(await count(), before);
  } finally {
    await db.close();
  }
});
