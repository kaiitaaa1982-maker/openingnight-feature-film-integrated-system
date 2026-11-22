// 台本の無い作品の日々スケ（撮影スケジュール）を、構造化した JSON から統合システムへ登録する。
// 画面（香盤・日々スケの「日々スケを取り込む」）と scripts/import-call-sheets.mjs が使う。ブラウザでも Node でも動く。
// 人が画面でするのと同じ受け口を、版の古い順に呼ぶ:
//   1. 案件・作品（work を渡さないときだけ。無ければ作る）
//   2. シーン（POST /api/scenes。同じ S# は内容が変わったときだけ PATCH し、前の値は監査の記録に残る）
//   3. 撮影日と並び（POST /api/field/days。同じ日の新しい版は PATCH で差し替える）
//   4. 役・ロケ地・頁・出演・日々スケの帯・入り時間（PUT /api/production/:workId。各日の最新の版から作る）
//   5. 原本の PDF をプリプロの保管庫へ（種類 daily・撮影日・元の置き場・版の印）
// 元データの形は demo-fixtures/call-sheets/call-sheets-demo.json（架空）。実データの JSON はリポジトリに置かない。
// call(method, path, payload, headers) は /api からの道で受け口を呼び、JSON を返す（失敗は投げる）。

import {assertCallSheetJson, checkCallSheetJson, formatProblem} from './call-sheet-source-check.mjs';

const at = (date, clock) => (clock ? `${date}T${clock}` : null);
const eighths = (pages) => (pages == null ? null : Math.round(pages * 8));
const short = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// 「@グループ名」を役の識別子へ広げる
export function expandCast(source, keys) {
  return [...new Set(keys.flatMap((key) => (key.startsWith('@') ? source.groups?.[key.slice(1)] || [] : [key])))];
}

// 1枚の日々スケを、撮影日の並び（シーンの行）と帯（休憩・準備・2回目の撮影）に分ける。
// 同じ撮影日に同じシーンは1回しか割り当てられないので、2回目の行（again）は帯にする。
// 予定の時刻は始まりと終わりが両方書いてある行だけに入れ、片方だけの「9:00〜」は備考に残す。
export function planSheet(source, sheet) {
  const assignments = [], slots = [];
  for (const row of sheet.rows) {
    if (row.slot || row.again) {
      slots.push({after: assignments.length, kind: row.slot || 'other', label: row.label, start: row.start || null, end: row.end || null,
        note: row.again ? row.team || null : null});
      continue;
    }
    const both = Boolean(row.start && row.end);
    const clock = !both && (row.start || row.end) ? `${row.start ? row.start.replace(/^0/, '') : ''}〜${row.end ? row.end.replace(/^0/, '') : ''}` : null;
    const notes = [clock, row.dnLabel, row.team, row.s.length > 1 ? `S#${row.s.join(',')} を1行で撮る` : null, row.note].filter(Boolean).join('・') || null;
    row.s.forEach((sceneNo, index) => assignments.push({sceneNo, start: both ? row.start : null, end: both ? row.end : null, notes,
      pages: index === 0 ? row.pages : null, row}));
  }
  return {assignments, slots};
}

// シーンの値（各 S# の最後に出た版の行から）
export function sceneSpecs(sheets) {
  const specs = new Map();
  for (const sheet of sheets) for (const row of sheet.rows) {
    if (row.slot || row.again) continue;
    row.s.forEach((sceneNo, index) => specs.set(sceneNo, {sceneNo, dayNight: row.dn ?? null, location: row.head ?? null, synopsis: row.synopsis || '',
      pages: index === 0 ? row.pages ?? null : null, dnLabel: row.dnLabel || null, shared: row.s.length > 1 ? row.s : null, cast: row.cast || []}));
  }
  return specs;
}

export function dayLabel(sheet) {
  return `${short(sheet.date)}（${sheet.weekday}）${sheet.crew} ${sheet.stamp}`;
}

export function dayNotes(sheet) {
  return [sheet.weather && `天候：${sheet.weather}`, sheet.sunrise && `日の出 ${sheet.sunrise.replace(/^0/, '')}・日の入り ${sheet.sunset.replace(/^0/, '')}`,
    sheet.departure, ...(sheet.notes || [])].filter(Boolean).join('\n');
}

export async function importCallSheets(call, source, {work: target = null, readPdf, log = () => {}} = {}) {
  // 形と中の食い違いがあれば、受け口を1つも呼ばずに投げる（問題の一覧を全部メッセージに入れる）
  assertCallSheetJson(source);
  const {work: spec} = source;
  // 1. 案件・作品
  let project, work;
  if (target) { project = {id: target.project_id}; work = target; }
  else {
    project = (await call('GET', '/projects')).rows.find((row) => row.code === spec.projectCode);
    if (!project) project = {id: (await call('POST', '/projects', {code: spec.projectCode, title: spec.projectTitle, status: 'active'})).id};
    work = (await call('GET', '/works')).rows.find((row) => row.project_id === project.id && row.code === spec.workCode);
    if (!work) work = {id: (await call('POST', '/works', {project_id: project.id, code: spec.workCode, title: spec.workTitle, format: 'film'})).id};
  }
  const workId = work.id;

  const placed = (await call('GET', `/preprod/works/${workId}/documents`)).documents;
  const done = (sheet) => isRegisteredSheet(placed, sheet);
  const result = {workId, applied: [], skipped: []};
  const applied = source.sheets.filter(done);
  result.skipped = applied.map((sheet) => sheet.file);

  for (const sheet of source.sheets) {
    if (done(sheet)) continue;
    applied.push(sheet);
    // 2. シーン
    let scenes = (await call('GET', `/production?workId=${workId}`)).scenes;
    for (const scene of sceneSpecs([sheet]).values()) {
      const current = scenes.find((row) => row.scene_no === scene.sceneNo);
      const values = {day_night: scene.dayNight, location: scene.location, synopsis: scene.synopsis};
      if (!current) await call('POST', '/scenes', {project_id: project.id, work_id: workId, scene_no: scene.sceneNo, ...values, status: 'draft'});
      else if (Object.entries(values).some(([key, value]) => (current[key] ?? null) !== value)) {
        await call('PATCH', `/scenes/${current.id}`, values, {'if-match': String(current.version)});
      }
    }
    // 3. 撮影日と並び
    let production = await call('GET', `/production?workId=${workId}`);
    scenes = production.scenes;
    const idOf = new Map(scenes.map((row) => [row.scene_no, row.id]));
    const {assignments} = planSheet(source, sheet);
    const rows = assignments.map((a, index) => ({sceneId: idOf.get(a.sceneNo), sequenceOrder: index + 1, plannedStart: at(sheet.date, a.start), plannedEnd: at(sheet.date, a.end),
      outcome: 'planned', notes: a.notes}));
    const day = production.days.find((row) => row.shoot_date === sheet.date && row.unit === spec.unit);
    const dayInput = {shootDate: sheet.date, unit: spec.unit, label: dayLabel(sheet), notes: dayNotes(sheet), assignments: rows};
    if (day) await call('PATCH', `/field/days/${day.id}`, dayInput, {'if-match': String(day.version)});
    else await call('POST', '/field/days', {workId, ...dayInput});

    // 4. 制作情報（各日の最新の版から全部を作り直す）
    production = await call('GET', `/production?workId=${workId}`);
    await call('PUT', `/production/${workId}`, productionGraph(source, applied, production), {'if-match': String(production.version)});

    // 5. 原本
    const dayId = production.days.find((row) => row.shoot_date === sheet.date && row.unit === spec.unit).id;
    const bytes = await readPdf(sheet.file);
    await call('POST', `/preprod/works/${workId}/documents`, {category: 'daily', datedOn: sheet.date, shootingDayId: dayId, originPath: sheet.originPath,
      note: `日々スケ ${sheet.stamp}`, fileName: sheet.file, mediaType: 'application/pdf', base64: toBase64(bytes)});
    result.applied.push(sheet.file);
    log(`${sheet.file}: ${dayLabel(sheet)}・シーン ${assignments.length}行`);
  }
  return result;
}

// 制作情報の全体。日ごとに最後に登録した版を使い、シーンの頁・出演は最後に出た版の行から作る。
// 保存は作品の制作情報を丸ごと入れ直すので、いまある行（人が入れた衣装・役・ほかの日の入り時間など）に重ねる。
// 取り込んだシーンの出演と、取り込んだ日の帯・入り時間だけを差し替える。同じ名前の役が別の識別子であれば、いまある識別子を使う。
export function productionGraph(source, applied, production) {
  const latest = [...new Map(applied.map((sheet) => [sheet.date, sheet])).values()];
  const specs = sceneSpecs(applied);
  const idOf = new Map(production.scenes.map((row) => [row.scene_no, row.id]));
  const dayOf = new Map(production.days.filter((row) => row.unit === source.work.unit).map((row) => [row.shoot_date, row]));
  const existingByName = new Map((production.characters || []).map((c) => [c.name, c.key]));
  const keyOf = new Map(source.characters.map((c) => [c.key, existingByName.get(c.name) || c.key]));
  const cast = (keys) => expandCast(source, keys).map((key) => keyOf.get(key) || key);
  // ロケ地も役と同じく、同じ名前がいまあれば、いまある識別子を使う（名前は作品の中で一意。重ねると保存が断られる）
  const existingLocationByName = new Map((production.locations || []).map((l) => [l.name, l.key]));
  const locationKeyOf = new Map(source.locations.map((l) => [l.key, existingLocationByName.get(l.name) || l.key]));
  const used = new Set();
  const castOf = new Map();
  for (const [sceneNo, scene] of specs) castOf.set(sceneNo, new Set(cast(scene.cast)));
  for (const sheet of latest) for (const row of sheet.rows) if (row.again) for (const sceneNo of row.s) for (const key of cast(row.cast || [])) castOf.get(sceneNo)?.add(key);
  const importedScenes = new Set([...specs.keys()].map((no) => idOf.get(no)));
  const appearances = (production.appearances || []).filter((a) => !importedScenes.has(a.scene_id)).map((a) => ({scene_id: a.scene_id, character_key: a.character_key}));
  for (const [sceneNo, keys] of castOf) for (const key of keys) { appearances.push({scene_id: idOf.get(sceneNo), character_key: key}); used.add(key); }
  const detailOf = new Map((production.sceneDetails || []).map((d) => [d.scene_id, d]));
  const sceneDetails = (production.sceneDetails || []).filter((d) => !importedScenes.has(d.scene_id)).map(pickDetail);
  for (const scene of specs.values()) {
    const id = idOf.get(scene.sceneNo), current = detailOf.get(id);
    const note = [scene.dnLabel, scene.shared && `S#${scene.shared.join(',')} を1行で撮る（頁数は先頭の S# に計上）`].filter(Boolean).join('・') || null;
    sceneDetails.push({scene_id: id, page_eighths: eighths(scene.pages), estimated_minutes: current?.estimated_minutes ?? null,
      location_key: current?.location_key || locationKeyOf.get(source.locations[0].key), note: note ?? current?.note ?? null});
  }
  const importedDays = new Set(latest.map((sheet) => dayOf.get(sheet.date).id));
  const daySlots = (production.daySlots || []).filter((slot) => !importedDays.has(slot.day_id)).map(pickSlot);
  const calls = (production.calls || []).filter((c) => !importedDays.has(c.day_id)).map(pickCall);
  // 日々スケにバラしは無いので、取り込み直した日も人が入れたバラしを引き継ぐ（新しい入りより後のときだけ）
  const wrapOf = new Map((production.calls || []).filter((c) => c.wrap_time).map((c) => [`${c.day_id}\u0000${c.character_key}`, c.wrap_time]));
  const placeName = new Map(source.locations.map((l) => [l.key, l.name]));
  for (const sheet of latest) {
    const day = dayOf.get(sheet.date);
    planSheet(source, sheet).slots.forEach((slot, index) => daySlots.push({day_id: day.id, key: `slot-${index + 1}`, after_scene_order: slot.after,
      kind: slot.kind, label: slot.label, planned_start: at(sheet.date, slot.start), planned_end: at(sheet.date, slot.end), note: slot.note}));
    for (const entry of sheet.calls) for (const key of cast(entry.who)) {
      used.add(key);
      const callTime = at(sheet.date, entry.time), wrap = wrapOf.get(`${day.id}\u0000${key}`) ?? null;
      calls.push({day_id: day.id, character_key: key, call_time: callTime, ready_time: entry.ready ? callTime : null,
        wrap_time: wrap && (!callTime || wrap > callTime) ? wrap : null,
        note: [entry.time ? null : entry.note, [placeName.get(entry.place), entry.placeNote].filter(Boolean).join(' '), entry.time ? entry.note : null, entry.label].filter(Boolean).join('・') || null});
    }
  }
  // 役: いまある役はそのまま残し、取り込みに出る役は日々スケの値で埋める（俳優名は空のときだけ上書きしない）
  const fromSource = new Map(source.characters.map((c) => [keyOf.get(c.key), c]));
  const characters = (production.characters || []).map((c) => {
    const s = used.has(c.key) ? fromSource.get(c.key) : null;
    return s ? {key: c.key, name: c.name, short_name: s.short || c.short_name, actor_name: s.actor || c.actor_name || null, note: [s.group, s.note].filter(Boolean).join('・') || c.note || null} : pickCharacter(c);
  });
  const have = new Set(characters.map((c) => c.key));
  for (const [key, c] of fromSource) if (used.has(key) && !have.has(key)) characters.push({key, name: c.name, short_name: c.short, actor_name: c.actor || null, note: [c.group, c.note].filter(Boolean).join('・') || null});
  const locations = (production.locations || []).map(pickLocation);
  const haveLocation = new Set(locations.map((l) => l.key));
  for (const l of source.locations) if (!haveLocation.has(locationKeyOf.get(l.key))) locations.push({key: l.key, name: l.name, address: l.address || null, green_room: l.green_room || null, note: l.note || null});
  // 衣装の着用は、出演が残っているシーンのものだけ残す
  const appearing = new Set(appearances.map((a) => `${a.scene_id}\u0000${a.character_key}`));
  const lookOf = new Map((production.looks || []).map((l) => [l.key, l]));
  const sceneLooks = (production.sceneLooks || []).filter((sl) => appearing.has(`${sl.scene_id}\u0000${lookOf.get(sl.look_key)?.character_key}`)).map((sl) => ({scene_id: sl.scene_id, look_key: sl.look_key}));
  return {characters, locations, sceneDetails, appearances, looks: (production.looks || []).map(pickLook), sceneLooks, daySlots, calls};
}

const pick = (keys) => (row) => Object.fromEntries(keys.map((key) => [key, row[key] ?? null]));
const pickDetail = pick(['scene_id', 'page_eighths', 'estimated_minutes', 'location_key', 'note']);
const pickSlot = pick(['day_id', 'key', 'after_scene_order', 'kind', 'label', 'planned_start', 'planned_end', 'actual_start', 'actual_end', 'note']);
const pickCall = pick(['day_id', 'character_key', 'call_time', 'ready_time', 'wrap_time', 'note']);
const pickCharacter = pick(['key', 'name', 'short_name', 'actor_name', 'note']);
const pickLocation = pick(['key', 'name', 'address', 'floor', 'green_room', 'parking', 'facilities', 'contact', 'note']);
const pickLook = pick(['key', 'character_key', 'label', 'makeup', 'props', 'shoes', 'accessories', 'note']);

// 原本の中身を base64 へ（ブラウザと Node の両方で使える形）
export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = '';
  for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(text);
}

// JSON の形の確かめ（取り込む前に画面で見せる）。中身は call-sheet-source-check.mjs。問題を文で返す
export function checkCallSheetSource(source) {
  return checkCallSheetJson(source).map(formatProblem);
}

// 保管庫に同じファイル名・日付の原本がある版は登録済み
export const isRegisteredSheet = (documents, sheet) => documents.some((doc) => doc.file_name === sheet.file && doc.dated_on === sheet.date);
