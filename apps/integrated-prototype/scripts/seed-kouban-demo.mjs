#!/usr/bin/env node
// 制作（台本の取込・香盤・日々スケ・衣装香盤・ロケ地・準備）を画面で確かめるための架空データを、別組織 DEMO-SALES に投入する。
// 元データ: demo-fixtures/kouban/kouban-demo.json と、同じ内容から作った縦書きの台本PDF（public/demo-fixtures/scripts/）。
// 連続ドラマの第7話・第8話を1つの作品（撮影ブロック）として、人が画面でするのと同じ順に登録する。
//   1. 台本PDFの取込（第8話の準備稿は取り込むだけで確定しない）
//   2. 読み取り結果の確認（昼夜・予定尺・台詞の無い出演者を人が足した形にする）→ 確認済みの版
//   3. 候補日・時間予算・ロケ地の空き日から規則どおりの日程案 → 確定（第8話は第7話の撮影日に追記される）
//   4. 制作情報（役・俳優・ロケ地・頁・出演・衣装・入り時間・日々スケの移動や食事）
//   5. 撮影実績（基準日より前の日は撮影済み。1シーンは撮りこぼして後の日へ回す）と準備タスク
// 使い方: node scripts/seed-kouban-demo.mjs --db <SQLiteのパス>
// ・--db の指定は必須。data/integrated.sqlite へは --allow-main-db を付けたときだけ書く。
// ・台本PDFの読み取りにローカルのPython（ON_PYTHON、無ければ python / python3）を使う。
// ・2回流しても増えない（作品 DEMO-D78 があれば何もしない）。組織 DEMO-SALES が無ければ作る（売上の架空データとは独立に入れられる）。
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {extractDocument} from '../src/local-extractor.mjs';
import {SALES_DEMO, createOrganization} from './seed-sales-demo.mjs';

const SOURCE = new URL('../demo-fixtures/kouban/kouban-demo.json', import.meta.url);
const SCRIPTS = new URL('../public/demo-fixtures/scripts/', import.meta.url);

export async function loadKoubanSource() {
  return JSON.parse(await readFile(SOURCE, 'utf8'));
}

// 役の識別子は、台本取込の確定が作る役（role:台詞の名前）にそろえる
export const roleKey = (character) => `role:${character.short}`;
export const sceneNo = (episode, scene) => `${episode.no}-${scene.no}`;

const at = (date, minutes) => {
  const day = Math.floor(minutes / 1440), rest = minutes % 1440;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + day);
  return `${d.toISOString().slice(0, 10)}T${String(Math.floor(rest / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}`;
};
const toMinutes = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const DN_ORDER = {D: 0, DN: 1, N: 2};

export async function seedKoubanDemo(db, {python = process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), log = () => {}} = {}) {
  const source = await loadKoubanSource();
  const {series, schedule} = source;
  const found = await db.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode]);
  if (found && await db.get('SELECT 1 FROM works WHERE org_id=? AND code=?', [found.id, series.workCode])) return {skipped: true, orgId: found.id};
  const orgId = found ? found.id : await createOrganization(db);

  const app = createApp({db, mode: 'local', extractDocument: (input) => extractDocument({...input, pythonPath: python, timeoutMs: 60_000})});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
  if (login.status !== 200) throw new Error(`架空の管理者でログインできません（${login.status}）`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, payload, headers = {}) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json', ...headers}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const data = await response.json();
    if (response.status >= 300 || data.ok === false) throw new Error(`${method} ${path}: ${response.status} ${data.error || JSON.stringify(data).slice(0, 600)}`);
    return data;
  };
  const post = (path, payload) => call('POST', path, payload);
  const get = (path) => call('GET', path);
  if ((await get('/session')).user.orgId !== orgId) throw new Error('架空の管理者が DEMO-SALES で入れていません');

  // 案件・作品
  const projectId = (await post('/projects', {code: series.projectCode, title: series.projectTitle, status: 'active', budget_yen: 48000000})).id;
  const workId = (await post('/works', {project_id: projectId, code: series.workCode, title: series.workTitle, format: 'series'})).id;
  const characterByKey = new Map(source.characters.map((c) => [c.key, c]));
  const shortOf = (key) => characterByKey.get(key).short;

  // 1〜3. 台本の取込・確認・日程案・確定
  const upload = async (file) => {
    const bytes = await readFile(new URL(file, SCRIPTS));
    return post('/workflow/artifacts/extract', {kind: 'script', workId, name: file, base64: bytes.toString('base64'), mediaType: 'application/pdf'});
  };
  const artifacts = [];
  for (const episode of [...source.episodes].sort((a, b) => b.no - a.no)) {
    for (const draft of episode.drafts.filter((d) => d.commit === false)) artifacts.push({draft, result: await upload(draft.file)});
  }
  const committed = [];
  for (const episode of source.episodes) {
    const draft = episode.drafts.find((d) => d.commit !== false);
    const uploaded = await upload(draft.file);
    artifacts.push({draft, result: uploaded});
    const expected = new Map(episode.scenes.map((scene) => [sceneNo(episode, scene), scene]));
    const extracted = uploaded.extraction.scenes || [];
    const missing = [...expected.keys()].filter((no) => !extracted.some((scene) => scene.sceneNo === no));
    if (missing.length) throw new Error(`${draft.file} から読み取れなかったシーンがあります: ${missing.join('、')}`);
    // 人が確かめて直す: 昼夜・予定尺、台詞の無い出演者を足す（場所・頁・内容は読み取りのまま）
    const scenes = extracted.filter((scene) => expected.has(scene.sceneNo)).map((scene) => {
      const spec = expected.get(scene.sceneNo);
      return {sceneNo: scene.sceneNo, location: scene.location, dayNight: spec.dn, synopsis: scene.synopsis,
        cast: spec.cast.map(shortOf), estimatedMinutes: spec.min, pageEighths: scene.pageEighths};
    });
    const review = await call('PUT', `/workflow/scripts/${uploaded.artifactId}/review`, {scenes});
    const keyOfLocation = new Map(scenes.map((scene) => [scene.location, expected.get(scene.sceneNo).loc]));
    const dates = schedule.days.map((day) => day.date);
    const availability = {
      cast: Object.fromEntries([...new Set(scenes.flatMap((scene) => scene.cast))].map((name) => [name, dates])),
      locations: Object.fromEntries([...keyOfLocation].map(([name, key]) => [name, schedule.days.filter((day) => day.locations.includes(key)).map((day) => day.date)])),
    };
    const preview = await post(`/workflow/scripts/${uploaded.artifactId}/schedule-preview`, {reviewId: review.reviewId, unit: series.unit,
      dates: schedule.days.map((day) => ({date: day.date, budgetMinutes: day.budget})), availability});
    if (!preview.proposal.commitAllowed) throw new Error(`第${episode.no}話の日程案に競合があります: ${JSON.stringify(preview.proposal.conflicts)}`);
    const commit = await post(`/workflow/scripts/${uploaded.artifactId}/commit`, {token: preview.token, confirmed: true});
    committed.push({episode: episode.no, ...commit});
    log(`第${episode.no}話 ${draft.kind}: ${commit.sceneCount}シーン・撮影日${commit.dayCount}日（うち既存に追記${commit.reusedDayCount}日）`);
  }

  // 5a. 撮影実績と日々スケの並び（場所ごと・昼→夕→夜の順に並べ直し、予定の時刻を入れる）
  let production = await get(`/production?workId=${workId}`);
  const sceneById = new Map(production.scenes.map((scene) => [scene.id, scene]));
  const specOf = new Map(source.episodes.flatMap((episode) => episode.scenes.map((scene) => [sceneNo(episode, scene), {...scene, episode: episode.no}])));
  const dayByDate = new Map(production.days.map((day) => [day.shoot_date, day]));
  const moved = schedule.notShot;
  const movedNo = `${moved.episode}-${moved.scene}`;
  const movedId = production.scenes.find((scene) => scene.scene_no === movedNo).id;
  const timeline = new Map();   // dayId → [{sceneId, start, end}]
  const placeNames = new Map(source.locations.map((l) => [l.key, l.name.replace(/（.*$/, '')]));
  for (const [dayIndex, plan] of schedule.days.entries()) {
    const day = dayByDate.get(plan.date);
    const ids = day.assignments.map((a) => a.scene_id);
    if (plan.date === moved.moveTo) ids.push(movedId);
    const ordered = ids.map((id) => ({id, spec: specOf.get(sceneById.get(id).scene_no)}))
      .sort((a, b) => plan.locations.indexOf(a.spec.loc) - plan.locations.indexOf(b.spec.loc) || DN_ORDER[a.spec.dn] - DN_ORDER[b.spec.dn] || a.spec.episode - b.spec.episode || a.spec.no - b.spec.no);
    let clock = toMinutes(plan.call) + 60;   // 入りから1時間は準備
    const rows = [];
    ordered.forEach((item, index) => {
      if (index > 0 && ordered[index - 1].spec.loc !== item.spec.loc) clock += 30;          // 場所の移動
      if (index === Math.ceil(ordered.length / 2)) clock += 45;                             // 食事
      rows.push({sceneId: item.id, loc: item.spec.loc, start: clock, end: clock + item.spec.min});
      clock += item.spec.min + 10;
    });
    timeline.set(day.id, rows);
    const past = plan.date < schedule.asOf;
    const assignments = rows.map((row, index) => {
      const notShot = row.sceneId === movedId && plan.date === moved.date;
      const shot = past && !notShot;
      const slip = shot ? (index % 3) * 5 : 0;
      return {sceneId: row.sceneId, sequenceOrder: index + 1, plannedStart: at(plan.date, row.start), plannedEnd: at(plan.date, row.end),
        actualStart: shot ? at(plan.date, row.start + slip) : null, actualEnd: shot ? at(plan.date, row.end + slip + 5) : null,
        outcome: notShot ? 'not_shot' : shot ? 'shot' : 'planned',
        notes: notShot ? moved.reason : row.sceneId === movedId ? `${moved.date} の撮りこぼし（再手配）` : null};
    });
    await call('PATCH', `/field/days/${day.id}`, {shootDate: plan.date, unit: series.unit, label: `${dayIndex + 1}日目 ${plan.locations.map((key) => placeNames.get(key)).join('・')}`,
      notes: `入り ${plan.call}・撤収予定 ${plan.wrap}`, assignments}, {'if-match': String(day.version)});
  }

  // 4. 制作情報（役・ロケ地・頁・出演・衣装・日々スケの項目・入り時間）
  production = await get(`/production?workId=${workId}`);
  const idOf = new Map(production.scenes.map((scene) => [scene.scene_no, scene.id]));
  const detailOf = new Map((production.sceneDetails || []).map((detail) => [detail.scene_id, detail]));
  const characters = source.characters.map((c) => ({key: roleKey(c), name: c.name, short_name: c.short, actor_name: c.actor, note: c.note}));
  const locations = source.locations.map((l) => ({key: l.key, name: l.name, address: l.address || null, floor: l.floor || null, green_room: l.green_room || null,
    parking: l.parking || null, facilities: l.facilities || null, contact: l.contact || null, note: l.note || null}));
  const sceneDetails = [], appearances = [], sceneLooks = [];
  for (const episode of source.episodes) {
    for (const scene of episode.scenes) {
      const id = idOf.get(sceneNo(episode, scene));
      sceneDetails.push({scene_id: id, page_eighths: detailOf.get(id)?.page_eighths ?? null, estimated_minutes: scene.min, location_key: scene.loc,
        note: scene.flashback ? '回想（学生時代の衣装）' : scene.head.includes('実景') ? '実景（少人数で撮る）' : null});
      for (const key of [...scene.cast, ...(scene.extras || [])]) {
        appearances.push({scene_id: id, character_key: roleKey(characterByKey.get(key))});
        const looks = source.looks.filter((look) => look.character === key);
        const look = (scene.flashback && looks.find((l) => l.flashback)) || looks.find((l) => (l.locations || []).includes(scene.loc)) || looks.find((l) => (l.locations || []).includes('*'));
        if (look) sceneLooks.push({scene_id: id, look_key: look.key});
      }
    }
  }
  const looks = source.looks.map((l) => ({key: l.key, character_key: roleKey(characterByKey.get(l.character)), label: l.label, makeup: l.makeup || null,
    props: l.props || null, shoes: l.shoes || null, accessories: l.accessories || null, note: null}));
  const daySlots = [], calls = [];
  const locationName = new Map(source.locations.map((l) => [l.key, l.name]));
  const castOf = new Map(source.episodes.flatMap((episode) => episode.scenes.map((scene) => [idOf.get(sceneNo(episode, scene)), [...scene.cast, ...(scene.extras || [])]])));
  for (const plan of schedule.days) {
    const day = dayByDate.get(plan.date);
    const rows = timeline.get(day.id);
    if (!rows.length) continue;
    const meal = Math.ceil(rows.length / 2);
    rows.forEach((row, index) => {
      if (index > 0 && rows[index - 1].loc !== row.loc) daySlots.push({day_id: day.id, key: `move-${index}`, after_scene_order: index, kind: 'move',
        label: `移動：${locationName.get(rows[index - 1].loc)} → ${locationName.get(row.loc)}`, planned_start: at(plan.date, rows[index - 1].end + 10), planned_end: at(plan.date, rows[index - 1].end + 40)});
      if (index === meal && rows.length > 1) daySlots.push({day_id: day.id, key: 'meal', after_scene_order: index, kind: 'meal',
        label: toMinutes(plan.call) >= 720 ? '夕食（45分）' : '昼食（45分）', planned_start: at(plan.date, row.start - 45), planned_end: at(plan.date, row.start)});
    });
    daySlots.push({day_id: day.id, key: 'wrap', after_scene_order: rows.length, kind: 'wrap', label: `撤収（予定 ${plan.wrap}）`,
      planned_start: at(plan.date, rows.at(-1).end + 10), planned_end: at(plan.date, rows.at(-1).end + 70)});
    const first = new Map();
    for (const row of rows) for (const key of castOf.get(row.sceneId) || []) if (!first.has(key)) first.set(key, row.start);
    for (const [key, start] of first) {
      const extra = characterByKey.get(key).extra;
      const call = Math.max(toMinutes(plan.call), start - (extra ? 30 : 90));
      calls.push({day_id: day.id, character_key: roleKey(characterByKey.get(key)), call_time: at(plan.date, call), ready_time: at(plan.date, Math.min(start - 10, call + 60)), note: extra ? '衣装は自前（指定あり）' : null});
    }
  }
  await call('PUT', `/production/${workId}`, {characters, locations, sceneDetails, appearances, looks, sceneLooks, daySlots, calls}, {'if-match': String(production.version)});

  // 5b. 準備タスク
  for (const task of schedule.prep) {
    await post('/field/tasks', {workId, title: task.title, ownerLabel: task.owner, dueOn: task.due, status: task.status,
      shootingDayId: dayByDate.get(task.date)?.id ?? null, note: '架空の準備（デモ）'});
  }

  const count = async (sql) => Number((await db.get(sql, [orgId, workId])).n);
  const summary = {
    skipped: false, orgId, workId,
    scripts: artifacts.length, commits: committed.length,
    scenes: await count('SELECT COUNT(*) n FROM scenes WHERE org_id=? AND work_id=?'),
    shootingDays: await count('SELECT COUNT(*) n FROM shooting_days WHERE org_id=? AND work_id=?'),
    assignments: await count('SELECT COUNT(*) n FROM day_scene_assignments WHERE org_id=? AND work_id=?'),
    characters: await count('SELECT COUNT(*) n FROM production_characters WHERE org_id=? AND work_id=?'),
    locations: await count('SELECT COUNT(*) n FROM production_locations WHERE org_id=? AND work_id=?'),
    appearances: await count('SELECT COUNT(*) n FROM production_appearances WHERE org_id=? AND work_id=?'),
    looks: await count('SELECT COUNT(*) n FROM production_looks WHERE org_id=? AND work_id=?'),
    calls: await count('SELECT COUNT(*) n FROM production_calls WHERE org_id=? AND work_id=?'),
    prepTasks: await count('SELECT COUNT(*) n FROM prep_tasks WHERE org_id=? AND work_id=?'),
    pageEighths: await count('SELECT COALESCE(SUM(page_eighths),0) n FROM production_scene_details WHERE org_id=? AND work_id=?'),
  };
  log(`香盤 ${summary.scenes}シーン・役 ${summary.characters}・ロケ地 ${summary.locations}・撮影日 ${summary.shootingDays}日・出演 ${summary.appearances}件`);
  return summary;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : null;
  };
  const target = option('--db');
  if (!target) {
    console.error('投入先のDBを --db で指定してください（例: --db C:/temp/demo-sales.sqlite）。既定のローカルDBへは書きません。');
    process.exit(2);
  }
  const mainDb = fileURLToPath(new URL('../data/integrated.sqlite', import.meta.url));
  if (resolve(target).toLowerCase() === resolve(mainDb).toLowerCase() && !process.argv.includes('--allow-main-db')) {
    console.error('data/integrated.sqlite への投入は --allow-main-db を付けたときだけ行います。');
    process.exit(2);
  }
  const db = new LocalDatabase(resolve(target));
  try {
    const started = Date.now();
    const result = await seedKoubanDemo(db, {log: (message) => console.log(`  ${message}`)});
    if (result.skipped) console.log('制作の架空データ（DEMO-D78）は投入済みです（何もしませんでした）');
    else console.log(`投入しました（${((Date.now() - started) / 1000).toFixed(1)}秒）: ${JSON.stringify(result)}`);
  } finally {
    db.close();
  }
}
