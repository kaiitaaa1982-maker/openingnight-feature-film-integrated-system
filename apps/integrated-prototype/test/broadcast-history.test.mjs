// 放送履歴表（全作品×年月）。計算（純関数）・API・Excel の読み戻しを確かめる。
// 壊れたら: 期間の端の月が抜ける・中止の枠が局名として出る・同じ月の別局の赤／黄が付かない・打ち切った件数が消えて全件あると誤解する。
import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync, strFromU8} from 'fflate';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {encodeReportXlsx} from '../src/xlsx-report.mjs';
import {buildHistoryMatrix, historySheets, normalizeHistoryQuery, defaultHistoryRange, CELL_FILLS} from '../src/broadcast/broadcast-history-model.mjs';

const slot = (id, work, month, station, status = 'confirmed', extra = {}) => ({slot_id: id, work_id: work, broadcast_month: month, station_name: station, status,
  period_from: `${month}-01`, period_to: `${month}-28`, planned_runs: 1, revision: 1, ...extra});
const filters = (extra = {}) => ({from: '2025-10', to: '2027-09', q: '', station: '', overlaps: false, ...extra});

// Excel のセルの塗り（styles.xml の fill の色）を位置で読む
function fillsOf(bytes, sheetIndex = 1) {
  const files = unzipSync(bytes);
  const styles = strFromU8(files['xl/styles.xml']);
  const fills = [...styles.matchAll(/<fill>(.*?)<\/fill>/g)].map((m) => (/fgColor rgb="(\w+)"/.exec(m[1]) || [])[1] || null);
  const xfs = [...styles.match(/<cellXfs[^>]*>(.*?)<\/cellXfs>/)[1].matchAll(/<xf [^>]*fillId="(\d+)"/g)].map((m) => fills[Number(m[1])]);
  const sheet = strFromU8(files[`xl/worksheets/sheet${sheetIndex}.xml`]);
  const out = new Map();
  for (const m of sheet.matchAll(/<c r="([A-Z]+\d+)"(?: t="inlineStr")? s="(\d+)"/g)) if (xfs[Number(m[2])]) out.set(m[1], xfs[Number(m[2])]);
  return {out, sheet};
}

test('既定の期間は今月の11か月前〜12か月後の24か月で、条件の誤りは理由を返す', () => {
  assert.deepEqual(defaultHistoryRange('2026-09'), {from: '2025-10', to: '2027-09'});
  assert.deepEqual(defaultHistoryRange('2026-01'), {from: '2025-02', to: '2027-01'}, '年をまたぐ');
  assert.deepEqual(normalizeHistoryQuery({}, '2026-09').value, filters());
  assert.equal(normalizeHistoryQuery({from: '2026-13'}, '2026-09').error, '期間は 2026-10 の形（年-月）で指定してください');
  assert.match(normalizeHistoryQuery({from: '2027-01', to: '2026-12'}, '2026-09').error, /始まり以降/);
  assert.match(normalizeHistoryQuery({from: '2020-01', to: '2025-12'}, '2026-09').error, /60か月まで/);
  assert.equal(normalizeHistoryQuery({overlaps: '1', station: ' 局A ', q: 'W01'}, '2026-09').value.overlaps, true);
});

test('期間の両端の月は出て外は出ず、中止は出さず、未確定には注記、実放送は回数を付ける', () => {
  const works = [{id: 1, code: 'W01', title: '作品一'}];
  const slots = [
    slot(1, 1, '2025-09', '局A'), slot(2, 1, '2025-10', '局A'), slot(3, 1, '2027-09', '局B', 'tentative'), slot(4, 1, '2027-10', '局B'),
    slot(5, 1, '2026-03', '局C', 'cancelled'), slot(6, 1, '2026-04', '局D', 'draft'), slot(7, 1, '2026-05', '局E', 'rejected'), slot(8, 1, '2026-06', '局F', 'pending_first'),
  ];
  const m = buildHistoryMatrix({works, slots, airings: [{slot_id: 2, run_count: 2}, {slot_id: 2, run_count: 1}], filters: filters()});
  assert.equal(m.months.length, 24);
  assert.equal(m.months[0], '2025-10');
  assert.equal(m.months.at(-1), '2027-09');
  const cells = m.rows[0].cells;
  assert.deepEqual(Object.keys(cells).sort(), ['2025-10', '2026-04', '2026-05', '2026-06', '2027-09']);
  assert.equal(cells['2025-10'].text, '局A ×3', '実放送の回数の合計');
  assert.equal(cells['2027-09'].text, '局B（仮押さえ）');
  assert.equal(cells['2026-04'].text, '局D（下書き）');
  assert.equal(cells['2026-05'].text, '局E（差し戻し）');
  assert.equal(cells['2026-06'].text, '局F（一次承認待ち）');
  assert.equal(m.rows[0].slot_count, 7, '枠数は中止を除いた全期間の枠');
  assert.equal(m.rows[0].aired_runs, 3);
  assert.equal(m.rows[0].first_month, '2025-09', '初回放送月は確定の枠か実放送の最も早い月（表の期間の外でも）');
  assert.deepEqual(m.stations.map((s) => s.label), ['局A', '局B', '局D', '局E', '局F']);
});

test('同じ月の別の局は確定同士が赤・未確定を含むと黄、表記ゆれの同じ局は色を付けない', () => {
  const works = [{id: 1, code: 'W01', title: '一'}, {id: 2, code: 'W02', title: '二'}, {id: 3, code: 'W03', title: '三'}];
  const slots = [
    slot(1, 1, '2026-01', '局A'), slot(2, 1, '2026-01', '局B'),
    slot(3, 2, '2026-02', '局A'), slot(4, 2, '2026-02', '局B', 'tentative'),
    slot(5, 3, '2026-03', 'ＢＳ架空'), slot(6, 3, '2026-03', 'BS架空'), slot(7, 3, '2026-04', '局A', 'draft'), slot(8, 3, '2026-04', '局B'),
  ];
  const m = buildHistoryMatrix({works, slots, filters: filters()});
  const cell = (work, ym) => m.rows.find((r) => r.work_code === work).cells[ym];
  assert.equal(cell('W01', '2026-01').color, 'red');
  assert.equal(cell('W01', '2026-01').text, '局A／局B');
  assert.equal(cell('W02', '2026-02').color, 'yellow');
  assert.equal(cell('W03', '2026-03').color, null, '全角・半角のゆれは同じ局');
  assert.equal(cell('W03', '2026-04').color, null, '下書きは競合に数えない');
  assert.deepEqual([m.counts.red, m.counts.yellow], [1, 1]);
  const only = buildHistoryMatrix({works, slots, filters: filters({overlaps: true})});
  assert.deepEqual(only.rows.map((r) => r.work_code), ['W01', 'W02'], '同じ月に別の局があるものだけ');
  assert.deepEqual(buildHistoryMatrix({works, slots, filters: filters({station: 'bs架空'})}).rows.map((r) => r.work_code), ['W03'], '局で絞る（NFKC）');
  assert.deepEqual(buildHistoryMatrix({works, slots, filters: filters({q: 'ｗ０２'})}).rows.map((r) => r.work_code), ['W02'], '作品コードで絞る（全角も読む）');
});

test('画面は120作品で打ち切り、打ち切った件数を返す（Excel 用には全件を持つ）', () => {
  const works = Array.from({length: 125}, (_, n) => ({id: n + 1, code: `W${String(n + 1).padStart(3, '0')}`, title: `作品${n + 1}`}));
  const m = buildHistoryMatrix({works, slots: [slot(1, 125, '2026-01', '局A')], filters: filters()});
  assert.equal(m.rows.length, 120);
  assert.equal(m.total, 125);
  assert.equal(m.truncated, 5);
  assert.equal(m.allRows.length, 125);
  assert.equal(m.rows.at(-1).no, 120);
  assert.equal(m.allRows.at(-1).cells['2026-01'].text, '局A');
});

test('Excel の1枚目は続く月を「〃」にして赤・黄で塗り、2枚目は1枠1行の縦長', () => {
  const works = [{id: 1, code: 'W01', title: '一'}];
  const slots = [slot(1, 1, '2025-10', '局A'), slot(2, 1, '2025-11', '局A'), slot(3, 1, '2025-11', '局B'), slot(4, 1, '2025-12', '局A'), slot(5, 1, '2025-12', '局B', 'tentative'), slot(6, 1, '2026-01', '局A')];
  const m = buildHistoryMatrix({works, slots, filters: filters({to: '2026-03'})});
  const bytes = encodeReportXlsx({sheets: historySheets(m, {conditions: [['期間', 'テスト']], slots, partners: []})});
  const [sheet1, sheet2] = decodeXlsx(bytes);
  assert.deepEqual([sheet1.name, sheet2.name], ['放送履歴表', '放送枠一覧']);
  const header = sheet1.rows[4];
  assert.deepEqual(header.slice(0, 8), ['通し番号', '作品コード', '作品名', '放送用の品番', '放送解禁の期間', '枠数', '実放送の回数', '初回放送月']);
  assert.deepEqual(header.slice(8), ['2025年10月', '2025年11月', '2025年12月', '2026年1月', '2026年2月', '2026年3月']);
  const row = sheet1.rows[5];
  assert.deepEqual(row.slice(8, 12), ['局A', '局A／局B', '局A／局B（仮押さえ）', '局A']);
  const same = buildHistoryMatrix({works, slots: [slot(1, 1, '2025-10', '局A'), slot(2, 1, '2025-11', '局A'), slot(3, 1, '2025-12', '局A')], filters: filters({to: '2025-12'})});
  const repeated = decodeXlsx(encodeReportXlsx({sheets: historySheets(same, {slots: []})}))[0].rows[5].slice(8);
  assert.deepEqual(repeated, ['局A', '〃', '〃'], '前の月と同じなら「〃」、期間の先頭の列は局名');
  const {out} = fillsOf(bytes);
  assert.equal(out.get('J6'), CELL_FILLS.red, '2025年11月は確定同士の別局＝赤');
  assert.equal(out.get('K6'), CELL_FILLS.yellow, '2025年12月は仮押さえを含む＝黄');
  assert.equal(out.get('I6'), undefined);
  assert.equal(sheet2.rows[4][0], '作品コード');
  assert.equal(sheet2.rows.slice(5).filter((r) => r.length && r[0] === 'W01').length, 6, '期間の中の生きている枠の数');
});

// ---------- API ----------
async function setup(t) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const cookies = {admin: await login('admin@openingnight.invalid'), editor: await login('editor@openingnight.invalid'), production: await login('production@openingnight.invalid'), outsider: await login('outsider@other.invalid')};
  const call = async (path, {method = 'GET', body, as = 'admin'} = {}) => {
    const res = await app.request(`/api${path}`, {method, headers: {cookie: cookies[as], ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    const type = res.headers.get('content-type') || '';
    return {status: res.status, data: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()), headers: res.headers};
  };
  // 編集担当に権限の無い案件の作品を1つ足す
  const project = await call('/projects', {method: 'POST', body: {code: 'PRJ-ADMIN', title: '管理者だけの案件', status: 'active', budget_yen: 0}});
  const work = await call('/works', {method: 'POST', body: {project_id: project.data.id, code: 'WRK-ADMIN', title: '管理者だけの作品', format: 'film'}});
  const add = async (workId, month, station) => (await call('/broadcast/slots', {method: 'POST', body: {workId, broadcastMonth: month, stationName: station, periodFrom: `${month}-01`, periodTo: `${month}-28`, plannedRuns: 2, sourceReference: '架空'}})).data.slotId;
  const confirm = async (slotId) => { for (const [rev, status] of [[1, 'pending_first'], [2, 'tentative'], [3, 'pending_final'], [4, 'confirmed']]) assert.equal((await call(`/broadcast/slots/${slotId}/transition`, {method: 'POST', body: {baseRevision: rev, status}})).status, 200); };
  return {db, call, add, confirm, adminWork: work.data.id};
}

test('API: 見られる作品だけを期間の条件で返し、制作担当は使えず、別組織には出ない', async (t) => {
  const {db, call, add, confirm, adminWork} = await setup(t);
  try {
    const a = await add(1, '2026-11', '架空BS'), b = await add(1, '2026-11', '架空地上波');
    await confirm(a); await confirm(b);
    assert.equal((await call(`/broadcast/slots/${a}/airings`, {method: 'POST', body: {airedOn: '2026-11-10', runCount: 2, sourceReference: '架空の放送確認'}})).status, 201);
    await add(adminWork, '2026-12', '架空CS');
    const r = await call('/broadcast/history?from=2026-10&to=2027-01');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.months, ['2026-10', '2026-11', '2026-12', '2027-01']);
    assert.deepEqual(r.data.rows.map((row) => row.work_code), ['WRK-ADMIN', 'WRK-DEMO']);
    const demo = r.data.rows.find((row) => row.work_code === 'WRK-DEMO');
    assert.equal(demo.cells['2026-11'].color, 'red');
    assert.equal(demo.cells['2026-11'].text, '架空BS ×2／架空地上波');
    assert.equal(r.data.truncated, 0);
    const editor = await call('/broadcast/history?from=2026-10&to=2027-01', {as: 'editor'});
    assert.deepEqual(editor.data.rows.map((row) => row.work_code), ['WRK-DEMO'], '案件の権限が無い作品は出ない');
    assert.equal((await call('/broadcast/history', {as: 'production'})).status, 403);
    assert.equal((await call('/broadcast/history/export.xlsx', {as: 'production'})).status, 403);
    const outsider = await call('/broadcast/history?from=2026-10&to=2027-01', {as: 'outsider'});
    assert.equal(outsider.status, 200);
    assert.ok(outsider.data.rows.every((row) => row.work_code === 'WRK-OTHER'), '別組織には自分の組織の作品だけ');
    assert.equal(JSON.stringify(outsider.data).includes('架空BS'), false);
    assert.equal((await call('/broadcast/history?from=2026-13')).status, 400);
  } finally { await db.close(); }
});

test('API: Excel は画面と同じ条件で全件を出し、読み戻すと見出し・件数・〃・色が合う', async (t) => {
  const {db, call, add, confirm} = await setup(t);
  try {
    for (const m of ['2026-10', '2026-11']) await confirm(await add(1, m, '架空BS'));
    const r = await call('/broadcast/history/export.xlsx?from=2026-10&to=2026-12&q=wrk-demo');
    assert.equal(r.status, 200);
    assert.match(decodeURIComponent(r.headers.get('content-disposition')), /放送履歴表_2026-10-2026-12_\d{8}\.xlsx/);
    const [sheet1, sheet2] = decodeXlsx(r.data);
    assert.equal(sheet1.rows[0][0], '放送履歴表');
    assert.match(sheet1.rows[1][0], /期間 2026年10月〜2026年12月 ／ 作品 wrk-demo/);
    assert.deepEqual(sheet1.rows[5].slice(8, 11), ['架空BS', '〃', null]);
    assert.equal(sheet1.rows[5][1], 'WRK-DEMO');
    assert.equal(sheet2.rows.filter((row) => row[0] === 'WRK-DEMO').length, 2);
  } finally { await db.close(); }
});

test('実放送を記録してから中止にした枠は、枠数に数えず、実放送の回数・初回放送月・セル（局名（中止）×回数）・2枚目の一覧に残す', () => {
  const slots = [slot(1, 1, '2026-05', 'BS架空', 'cancelled'), slot(2, 1, '2026-07', '局G', 'cancelled')];
  const m = buildHistoryMatrix({works: [{id: 1, code: 'W01', title: '一'}], slots, airings: [{slot_id: 1, run_count: 1}], filters: filters()});
  const row = m.rows[0];
  assert.deepEqual([row.slot_count, row.aired_runs, row.first_month], [0, 1, '2026-05']);
  assert.equal(row.cells['2026-05'].text, 'BS架空（中止） ×1');
  assert.equal(row.cells['2026-05'].color, null, '中止の枠は競合の色を付けない');
  assert.equal(row.cells['2026-07'], undefined, '実放送の無い中止の枠は出さない');
  const [, list] = historySheets(m, {slots, airings: [{slot_id: 1, run_count: 1}]});
  assert.deepEqual(list.rows.map((r) => [r.station_name, r.status, r.aired_runs]), [['BS架空', 'cancelled', 1]]);
  // 状態の注記は放送枠のタブと同じ語（「提案」は使わない）
  const all = buildHistoryMatrix({works: [{id: 1, code: 'W01', title: '一'}], filters: filters(),
    slots: ['draft', 'pending_first', 'tentative', 'pending_final', 'rejected'].map((status, k) => slot(10 + k, 1, `2026-0${k + 1}`, `局${k}`, status))});
  const texts = Object.values(all.rows[0].cells).map((cell) => cell.text);
  assert.deepEqual(texts, ['局0（下書き）', '局1（一次承認待ち）', '局2（仮押さえ）', '局3（最終承認待ち）', '局4（差し戻し）']);
  assert.ok(texts.every((text) => !text.includes('提案')));
});

test('API: 確定の枠に実放送を記録してから中止にしても、放送履歴表の実放送の回数・初回放送月は変わらず、提案の直近の放送局と食い違わない', async (t) => {
  const db = await openTestDb({t});
  try {
    const app = createApp({db, mode: 'local'});
    const cookie = (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})})).headers.get('set-cookie').split(';')[0];
    const call = async (path, body) => {
      const r = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
      const data = await r.json();
      assert.ok(r.status < 300, `${path} ${r.status} ${JSON.stringify(data)}`);
      return data;
    };
    const {slotId} = await call('/broadcast/slots', {workId: 1, broadcastMonth: '2026-05', stationName: 'BS架空', periodFrom: '2026-05-01', periodTo: '2026-05-31', plannedRuns: 3});
    let revision = 1;
    for (const status of ['pending_first', 'tentative', 'pending_final', 'confirmed']) { await call(`/broadcast/slots/${slotId}/transition`, {baseRevision: revision, status, reason: '試験'}); revision += 1; }
    await call(`/broadcast/slots/${slotId}/airings`, {airedOn: '2026-05-10', runCount: 1, sourceReference: '架空の放送実績'});
    const snapshot = async () => {
      const row = (await call('/broadcast/history?from=2026-01&to=2026-12')).rows.find((r) => r.work_id === 1);
      const recent = (await call('/broadcast/window-proposals?asOf=2026-09-26&workId=1')).rows[0].recent_text;
      return {runs: row.aired_runs, first: row.first_month, recent};
    };
    const before = await snapshot();
    await call(`/broadcast/slots/${slotId}/transition`, {baseRevision: revision, status: 'cancelled', reason: '残り2回は中止（試験）'});
    const after = await snapshot();
    assert.deepEqual(after, before);
    assert.deepEqual([after.runs, after.first], [1, '2026-05']);
    assert.match(after.recent, /2026年5月 BS架空様/);
  } finally { await db.close(); }
});
