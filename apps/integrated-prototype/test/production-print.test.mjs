import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeXlsx} from '../src/xlsx.mjs';
import {encodeReportXlsx} from '../src/xlsx-report.mjs';
import {
  addDays, parseClock, splitDayTime, joinDayTime, rebaseDayTime, dayTimeText, timeRangeError, shootDateText,
  countGraphChanges, wardrobeGaps, gapSummary, pageText, koubanGroups, koubanSheet, dayTimeline, dailyScheduleSheet,
  callSheet, costumeSheet, sceneCostumeSheet, productionPrintHtml, productionTab, PRODUCTION_TABS, prepTaskState, prepSummary,
} from '../src/work/production-print.mjs';

// 架空の制作データ（シーン4件・撮影日2日・役3人）
function fixture() {
  return {
    scenes: [
      {id: 11, scene_no: '1', day_night: 'D', location: '架空の駅', synopsis: '朝の駅で出会う'},
      {id: 12, scene_no: '2', day_night: 'N', location: '架空の部屋', synopsis: '夜の部屋'},
      {id: 13, scene_no: '3', day_night: 'DN', location: '', synopsis: '夕方の坂道'},
      {id: 14, scene_no: '4', day_night: null, location: '架空の海', synopsis: ''},
    ],
    days: [
      {id: 1, shoot_date: '2026-10-01', unit: 'A班', label: '第1日', notes: '雨天時は室内', assignments: [
        {scene_id: 12, sequence_order: 1, planned_start: '2026-10-01T18:00', planned_end: '2026-10-01T21:00', outcome: 'planned', notes: ''},
        {scene_id: 11, sequence_order: 2, planned_start: '2026-10-01T23:30', planned_end: '2026-10-02T01:30', outcome: 'shot', notes: '夜明け前'},
      ]},
      {id: 2, shoot_date: '2026-10-03', unit: 'B班', label: '第2日', notes: '', assignments: [
        {scene_id: 13, sequence_order: 1, planned_start: null, planned_end: null, outcome: 'planned', notes: ''},
      ]},
    ],
    characters: [
      {key: 'a', name: '主人公', short_name: '主', actor_name: '架空 太郎'},
      {key: 'b', name: '友人', short_name: '友', actor_name: ''},
      {key: 'c', name: '駅員', short_name: '', actor_name: '架空 花子'},
    ],
    locations: [{key: 'loc1', name: '架空スタジオ', address: '架空県架空市'}],
    sceneDetails: [
      {scene_id: 11, page_eighths: 13, estimated_minutes: 45, location_key: 'loc1'},
      {scene_id: 12, page_eighths: 3, estimated_minutes: '20', location_key: null},
    ],
    appearances: [{scene_id: 11, character_key: 'a'}, {scene_id: 11, character_key: 'b'}, {scene_id: 12, character_key: 'a'}, {scene_id: 13, character_key: 'c'}],
    looks: [{key: 'l1', character_key: 'a', label: '1', makeup: '薄め', props: '傘', shoes: '', accessories: '', note: ''}],
    sceneLooks: [{scene_id: 11, look_key: 'l1'}, {scene_id: 12, look_key: 'l1'}],
    daySlots: [
      {day_id: 1, key: 's1', after_scene_order: 1, kind: 'meal', label: '夕食', planned_start: '2026-10-01T21:00', planned_end: '2026-10-01T22:00', note: ''},
      {day_id: 1, key: 's0', after_scene_order: 0, kind: 'move', label: 'スタジオへ移動', planned_start: '2026-10-01T17:00', planned_end: '2026-10-01T17:40', note: '車2台'},
      {day_id: 2, key: 's2', after_scene_order: 1, kind: 'wrap', label: '撤収', planned_start: '', planned_end: '', note: ''},
    ],
    calls: [{day_id: 1, character_key: 'a', call_time: '2026-10-01T16:30', ready_time: '2026-10-01T17:30', note: ''}],
  };
}

test('時刻の入力: 時刻と「翌日」を撮影日に対する保存値に組み立て、分け直すと元に戻る', () => {
  assert.equal(addDays('2026-10-31'), '2026-11-01');
  assert.equal(addDays('2026-12-31'), '2027-01-01');
  assert.equal(addDays('2026-02-30'), null);
  assert.equal(joinDayTime('2026-10-01', '09:05'), '2026-10-01T09:05');
  assert.equal(joinDayTime('2026-10-01', '01:30', true), '2026-10-02T01:30');
  assert.equal(joinDayTime('2026-12-31', '00:10', true), '2027-01-01T00:10');
  assert.equal(joinDayTime('2026-10-01', ''), '');
  assert.equal(joinDayTime('', ''), '');
  // 25:30 のような書き方は翌日 01:30 とみなす。全角・区切りなしも受け付ける
  assert.equal(joinDayTime('2026-10-01', '25:30'), '2026-10-02T01:30');
  assert.equal(joinDayTime('2026-10-01', '０９：００'), '2026-10-01T09:00');
  assert.equal(joinDayTime('2026-10-01', '930'), '2026-10-01T09:30');
  assert.throws(() => joinDayTime('2026-10-01', '25:30', true), /翌日の24時以降/);
  assert.throws(() => joinDayTime('2026-10-01', '9:75'), /存在しない時刻/);
  assert.throws(() => joinDayTime('2026-10-01', '朝'), /9:00 のように/);
  assert.throws(() => joinDayTime('', '09:00'), /撮影日/);
  assert.deepEqual(parseClock('48:00'), {ok: false, error: '存在しない時刻です'});

  assert.deepEqual(splitDayTime('2026-10-01T09:05', '2026-10-01'), {time: '09:05', nextDay: false, outside: false});
  assert.deepEqual(splitDayTime('2026-10-02T01:30', '2026-10-01'), {time: '01:30', nextDay: true, outside: false});
  assert.deepEqual(splitDayTime('', '2026-10-01'), {time: '', nextDay: false, outside: false});
  assert.deepEqual(splitDayTime(null, '2026-10-01'), {time: '', nextDay: false, outside: false});
  const outside = splitDayTime('2026-09-20T10:00', '2026-10-01');
  assert.equal(outside.outside, true);
  assert.equal(outside.time, '10:00');
  for (const [time, nextDay] of [['00:00', false], ['23:59', false], ['00:00', true], ['05:45', true]]) {
    const value = joinDayTime('2026-10-01', time, nextDay);
    assert.deepEqual(splitDayTime(value, '2026-10-01'), {time, nextDay, outside: false});
  }
});

test('時刻の表示・撮影日の変更・開始終了の確認', () => {
  assert.equal(dayTimeText('2026-10-01T09:00', '2026-10-01'), '09:00');
  assert.equal(dayTimeText('2026-10-02T01:30', '2026-10-01'), '翌01:30');
  assert.equal(dayTimeText('2026-09-20T10:00', '2026-10-01'), '2026/09/20 10:00');
  assert.equal(dayTimeText('', '2026-10-01'), '');
  // 撮影日を変えても「撮影日の何時・翌日の何時」はそのまま
  assert.equal(rebaseDayTime('2026-10-01T22:00', '2026-10-01', '2026-10-05'), '2026-10-05T22:00');
  assert.equal(rebaseDayTime('2026-10-02T02:00', '2026-10-01', '2026-10-05'), '2026-10-06T02:00');
  assert.equal(rebaseDayTime('', '2026-10-01', '2026-10-05'), '');
  assert.equal(timeRangeError('2026-10-01T23:30', '2026-10-02T01:30'), null);
  assert.match(timeRangeError('2026-10-01T23:30', '2026-10-01T01:30'), /翌日/);
  assert.match(timeRangeError('2026-10-01T09:00', '', {bothRequired: true, label: '実績'}), /実績の開始と終了を両方/);
  assert.equal(timeRangeError('2026-10-01T09:00', '', {bothRequired: false}), null);
  assert.equal(shootDateText('2026-10-01'), '2026/10/01（木）');
  assert.equal(shootDateText(''), '日付未定');
});

test('香盤シート: 列は固定7列＋役の数、行はシーン数＋撮影日ごとの小計行', () => {
  const production = fixture();
  const sheet = koubanSheet(production, {workTitle: '架空の作品'});
  assert.deepEqual(sheet.columns.map((column) => column.label), ['撮影日', 'S#', '昼夜', '頁', '予定尺（分）', '場所', '内容', '主', '友', '駅員']);
  const groups = koubanGroups(production);
  assert.deepEqual(groups.map((group) => group.scenes.map((scene) => scene.scene_no)), [['2', '1'], ['3'], ['4']]);
  assert.equal(sheet.rows.length, production.scenes.length + groups.length);
  assert.equal(sheet.rows.filter((row) => row.__kind === 'subtotal').length, 3);
  const first = sheet.rows[0];
  assert.equal(first.shootDay, '2026/10/01（木） A班');
  assert.equal(first.sceneNo, '2');
  assert.equal(first.dayNight, '夜');
  assert.equal(first.pages, '3/8');
  assert.equal(first.minutes, 20);
  assert.equal(first.location, '架空の部屋');
  assert.equal(first['cast:a'], '○');
  assert.equal(first['cast:b'], '');
  const second = sheet.rows[1];
  assert.equal(second.pages, '1 5/8');
  assert.equal(second.location, '架空スタジオ');
  assert.equal(sheet.rows[2].__kind, 'subtotal');
  assert.equal(sheet.rows[2].pages, '2');
  assert.equal(sheet.rows[2].minutes, 65);
  assert.equal(sheet.rows[3].dayNight, '薄暮');
  assert.equal(sheet.rows.at(-2).shootDay, '撮影日未編成');
  assert.equal(sheet.totals[0].values.pages, '2');
  assert.equal(sheet.totals[0].values.minutes, 65);
  assert.equal(sheet.freezeCols, 2);

  // Excel に出して読み戻すと見出しと行数が合う（タイトル帯4行＋見出し1行＋データ行＋空行＋合計行＋空行＋注記）
  const [decoded] = decodeXlsx(encodeReportXlsx({sheets: [sheet], generatedAt: new Date('2026-09-24T00:00:00Z')}));
  const headerIndex = decoded.rows.findIndex((row) => row[0] === '撮影日');
  assert.equal(headerIndex, 4);
  assert.deepEqual(decoded.rows[headerIndex].slice(0, 7), ['撮影日', 'S#', '昼夜', '頁', '予定尺（分）', '場所', '内容']);
  const dataRows = decoded.rows.slice(headerIndex + 1, headerIndex + 1 + sheet.rows.length);
  assert.equal(dataRows.length, 7);
  assert.equal(dataRows[0][7], '○');
});

test('香盤シート: 役・シーンが無くても出力でき、空の香盤は合計0', () => {
  const sheet = koubanSheet({scenes: [], days: [], characters: []});
  assert.equal(sheet.columns.length, 7);
  assert.equal(sheet.rows.length, 0);
  assert.equal(sheet.totals[0].values.pages, '0');
  assert.equal(pageText(null), '');
  assert.equal(pageText(0), '0');
  assert.equal(pageText(16), '2');
  assert.equal(pageText(5), '5/8');
  assert.ok(encodeReportXlsx({sheets: [sheet]}).length > 0);
});

test('日々スケ・入り時間のシート: 項目はシーンの後ろに並び、翌日の時刻は「翌」で出る', () => {
  const production = fixture();
  const day = production.days[0];
  assert.deepEqual(dayTimeline(day, production.daySlots).map((item) => item.type === 'scene' ? `S${item.row.scene_id}` : item.row.key), ['s0', 'S12', 's1', 'S11']);
  const sheet = dailyScheduleSheet(production, day, {workTitle: '架空の作品'});
  assert.equal(sheet.rows.length, 4);
  assert.deepEqual(sheet.rows.map((row) => row.kind), ['移動', 'シーン', '食事', 'シーン']);
  assert.equal(sheet.rows[3].plannedStart, '23:30');
  assert.equal(sheet.rows[3].plannedEnd, '翌01:30');
  assert.equal(sheet.rows[3].cast, '主・友');
  assert.equal(sheet.rows[3].outcome, '撮影済み');
  assert.equal(sheet.rows[3].location, '架空スタジオ');
  assert.ok(sheet.conditions.some(([label, value]) => label === '連絡事項' && value === '雨天時は室内'));
  const calls = callSheet(production, day);
  assert.deepEqual(calls.rows.map((row) => row.role), ['主人公', '友人']);
  assert.equal(calls.rows[0].callTime, '16:30');
  assert.equal(calls.rows[1].callTime, '');
  // 出演シーンの無い日でも入り時間が入っていれば載せる
  const second = callSheet({...production, calls: [{day_id: 2, character_key: 'b', call_time: '2026-10-03T08:00', ready_time: '', note: ''}]}, production.days[1]);
  assert.deepEqual(second.rows.map((row) => [row.role, row.notes]), [['友人', 'この日の出演シーンなし'], ['駅員', '']]);
});

test('衣装香盤・シーン別衣装と未割当の警告（先頭8件＋ほかn件）', () => {
  const production = fixture();
  const costume = costumeSheet(production);
  assert.equal(costume.rows.length, 1);
  assert.equal(costume.rows[0].scenes, 'S#2、S#1');
  const byScene = sceneCostumeSheet(production);
  assert.equal(byScene.rows.length, 4);
  assert.equal(byScene.rows[1].cast, '主人公 1 ／ 友人 未割当');
  assert.equal(byScene.rows[1].missing, '1件');
  const gaps = wardrobeGaps(production);
  assert.deepEqual(gaps.map((gap) => `${gap.scene_id}:${gap.character_key}`), ['11:b', '13:c']);
  const many = Array.from({length: 11}, (_, index) => ({scene_id: 11, character_key: index % 2 ? 'a' : 'b'}));
  const summary = gapSummary(many, {scenes: production.scenes, characters: production.characters});
  assert.equal(summary.total, 11);
  assert.equal(summary.shown.length, 8);
  assert.equal(summary.rest, 3);
  assert.match(summary.text, /ほか3件$/);
  assert.equal(gapSummary([], {}).text, '');
  assert.equal(gapSummary(gaps, {scenes: production.scenes, characters: production.characters}).rest, 0);
});

test('未保存の件数: 追加・削除・変更を行ごとに数え、同じ値の入れ直しや空の詳細は数えない', () => {
  const before = fixture();
  const same = JSON.parse(JSON.stringify(before));
  assert.equal(countGraphChanges(before, same), 0);
  // 数字を文字で入れ直しても同じ値なら数えない
  same.sceneDetails[0] = {...same.sceneDetails[0], estimated_minutes: '45'};
  same.calls[0] = {...same.calls[0], note: null};
  assert.equal(countGraphChanges(before, same), 0);
  const edited = JSON.parse(JSON.stringify(before));
  edited.characters[0].actor_name = '架空 次郎';
  edited.characters.push({key: 'd', name: '通行人', short_name: '通', actor_name: ''});
  edited.appearances = edited.appearances.filter((item) => !(item.scene_id === 12 && item.character_key === 'a'));
  edited.sceneDetails.push({scene_id: 13, page_eighths: null, estimated_minutes: null, location_key: null, note: null});
  assert.equal(countGraphChanges(before, edited), 3);
  assert.equal(countGraphChanges({}, {}), 0);
  assert.equal(countGraphChanges(null, {characters: [{key: 'x', name: '役'}]}), 1);
});

test('印刷用HTML: 空欄は空欄のまま、見出し・小計・合計・注記を出し、文字をエスケープする', () => {
  const production = fixture();
  production.scenes[0].synopsis = '<script>駅</script>';
  const html = productionPrintHtml({title: '架空の作品 香盤表', sheets: [koubanSheet(production, {workTitle: '架空の作品'})], generatedAt: new Date('2026-09-24T00:00:00Z')});
  assert.match(html, /<th>撮影日<\/th><th>S#<\/th>/);
  assert.equal((html.match(/<tr class="subtotal">/g) || []).length, 3);
  assert.equal((html.match(/<tr class="total">/g) || []).length, 1);
  assert.ok(!html.includes('<script>駅'));
  assert.ok(html.includes('&lt;script&gt;駅'));
  assert.ok(!html.includes('未確認</td>'));
  assert.match(html, /出力 2026\/09\/24 09:00/);
  assert.match(html, /○ は出演/);
  const empty = productionPrintHtml({title: '空', sheets: [costumeSheet({characters: [], looks: []})]});
  assert.match(empty, /登録がありません/);
});

test('制作のタブ: 準備タスクを含む5つのタブ、不明な値は香盤', () => {
  assert.deepEqual(PRODUCTION_TABS.map((tab) => tab.id), ['kouban', 'day', 'costume', 'location', 'prep']);
  assert.equal(productionTab('prep'), 'prep');
  assert.equal(productionTab('unknown'), 'kouban');
  assert.equal(productionTab(null), 'kouban');
});

test('準備タスクの状態: 準備済みでないまま期限を過ぎたものに「期限超過」を添える', () => {
  const today = '2026-09-24';
  assert.deepEqual(prepTaskState({status: 'pending', due_on: '2026-09-23'}, today), {label: '未準備・期限超過', overdue: true, tone: 'warn'});
  assert.deepEqual(prepTaskState({status: 'pending', due_on: '2026-09-24'}, today), {label: '未準備', overdue: false, tone: 'info'});
  assert.deepEqual(prepTaskState({status: 'ready', due_on: '2026-09-01'}, today), {label: '準備済み', overdue: false, tone: 'ok'});
  assert.deepEqual(prepTaskState({status: 'blocked', due_on: null}, today), {label: '保留', overdue: false, tone: 'warn'});
  assert.equal(prepTaskState({status: 'x'}, today).label, '状態未確認');
  const summary = prepSummary([{status: 'pending', due_on: '2026-09-01'}, {status: 'blocked'}, {status: 'ready', due_on: '2026-09-01'}], today);
  assert.deepEqual(summary, {total: 3, pending: 1, blocked: 1, ready: 1, overdue: 1});
  assert.deepEqual(prepSummary(null, today), {total: 0, pending: 0, blocked: 0, ready: 0, overdue: 0});
});
