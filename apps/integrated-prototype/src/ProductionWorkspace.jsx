// 制作（撮影の編成）。香盤・日々スケ・衣装香盤・ロケ地マップ・準備タスクの5つのタブ（選んだタブと撮影日は URL に残す）。
// 保存は2種類ある:
// - 役・ロケ地・香盤の詳細（頁・予定尺・ロケ地・出演）・衣装・移動などの項目・入り時間 → 「制作情報を保存」でまとめて保存
// - シーンと撮影日（日々スケ）→ それぞれの保存ボタンで、その場で保存
// 未保存の件数は外枠の未保存保護に登録する（作品の切替・画面移動・再読込の前に確認が出る）。
// 香盤表・日々スケ・衣装香盤は Excel と印刷（印刷用HTML）で出せる（シート定義は work/production-print.mjs）。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import './production-ui.css';
import ProductionLocationPlan from './ProductionLocationPlan.jsx';
import {PrepTaskPanel} from './FieldOperations.jsx';
import {useShell} from './shell/context.mjs';
import {KoubanDemoEntry, useKoubanDemoPlace} from './DemoGuide.jsx';
import {showKoubanDemoEntry} from './demo-guide.mjs';
import {Tabs} from './ui/Tabs.jsx';
import {Notice} from './ui/Notice.jsx';
import {labelOf} from './ui/labels.mjs';
import {OUTPUT_LABELS} from './ui/ReportOutputBar.jsx';
import {downloadReportXlsx, reportBaseName} from './xlsx-report.mjs';
import {downloadDocument} from './report-output.mjs';
import {jstToday} from './work/catalog-model.mjs';
import {
  PRODUCTION_TABS, productionTab, OUTCOME_LABELS, SLOT_KIND_LABELS, splitDayTime, joinDayTime, rebaseDayTime, dayTimeText,
  timeRangeError, shootDateText, countGraphChanges, wardrobeGaps, gapSummary, pageText, koubanGroups, dayLabel, koubanSheet, koubanCharacters,
  dayTimeline, dailyScheduleSheet, callSheet, costumeSheet, sceneCostumeSheet, productionPrintHtml,
} from './work/production-print.mjs';

const initial = {characters: [], locations: [], locationPlans: [], sceneDetails: [], appearances: [], looks: [], sceneLooks: [], daySlots: [], calls: []};
const copyGraph = (data) => Object.fromEntries(Object.keys(initial).map((key) => [key, (data?.[key] || []).map((row) => ({...row}))]));
const newKey = () => globalThis.crypto?.randomUUID?.() || `p${Date.now()}${Math.random().toString(36).slice(2)}`;
const nullable = (value) => (value === '' ? null : value);
const labelScene = (scene) => `S#${scene.scene_no}${scene.synopsis ? ` ${scene.synopsis}` : ''}`;
const emptyScene = () => ({scene_no: '', day_night: 'D', location: '', synopsis: ''});
const emptyDay = () => {
  const today = jstToday();
  return {id: null, version: null, shoot_date: today, baseDate: today, unit: 'A班', label: '日々スケ', notes: '', assignments: []};
};
const DAY_NIGHT_OPTIONS = [{value: 'D', label: labelOf('dayNight', 'D')}, {value: 'N', label: labelOf('dayNight', 'N')}, {value: 'DN', label: labelOf('dayNight', 'DN')}];
const SCENE_STATUS_OPTIONS = ['draft', 'ready', 'shot'].map((value) => ({value, label: labelOf('sceneStatus', value)}));
const OUTCOME_OPTIONS = Object.entries(OUTCOME_LABELS).map(([value, label]) => ({value, label}));
const SLOT_KIND_OPTIONS = Object.entries(SLOT_KIND_LABELS).map(([value, label]) => ({value, label}));

function Field({label, value, onChange, type = 'text', placeholder, wide = false, disabled = false}) {
  return <label className={wide ? 'wide' : ''}>{label}<input type={type} value={value ?? ''} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} /></label>;
}
function Select({label, value, onChange, items, blank = '選択してください', disabled = false}) {
  return <label>{label}<select value={value ?? ''} onChange={(event) => onChange(event.target.value)} disabled={disabled}>{blank !== null && <option value="">{blank}</option>}{items.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>;
}
function Section({title, extra, children, className = ''}) {
  return <section className={`card production-card ${className}`.trim()}><header className="section-head"><h3>{title}</h3>{extra}</header>{children}</section>;
}

// 時刻の入力（撮影日の時刻＋「翌日」）。保存値は YYYY-MM-DDTHH:MM。
function TimeField({label, value, shootDate, onChange, disabled = false}) {
  const parts = splitDayTime(value, shootDate);
  const [error, setError] = useState('');
  function emit(time, nextDay) {
    try {
      setError('');
      onChange(joinDayTime(shootDate, time, nextDay));
    } catch (cause) {
      setError(cause.message);
    }
  }
  return (
    <div className="production-time" role="group" aria-label={label}>
      <span className="production-time-label">{label}</span>
      <div className="production-time-inputs">
        <input type="time" aria-label={`${label}の時刻`} value={parts.time} disabled={disabled} onChange={(event) => emit(event.target.value, parts.nextDay)} />
        <label className="production-next"><input type="checkbox" checked={parts.nextDay} disabled={disabled || !parts.time} onChange={(event) => emit(parts.time, event.target.checked)} />翌日</label>
      </div>
      {parts.outside && <small className="production-time-warn">撮影日の範囲外の値です（{dayTimeText(value, shootDate)}）。時刻を入れ直すと撮影日に付け直します。</small>}
      {error && <small className="production-time-warn" role="alert">{error}</small>}
    </div>
  );
}

// URL の条件（戻る・再読込・作品の切替で残す）。外枠が無いときは手元の状態で動く。
function useParamState(shell, key, fallback) {
  const [local, setLocal] = useState(fallback);
  const fromUrl = shell.getParam(key, null);
  const value = fromUrl ?? local;
  const set = (next) => {
    setLocal(next);
    shell.setParam(key, next === fallback || next === null ? null : String(next), {replace: true});
  };
  return [value, set];
}

// 香盤表・日々スケ・衣装香盤の出力（Excel・印刷・印刷用HTML）
function ProductionOutput({name, title, sheets, pending = 0, paper, label = '出力'}) {
  const [error, setError] = useState(null);
  function run(format) {
    setError(null);
    try {
      const list = sheets();
      if (!list.length) throw Error('出力する表がありません');
      const base = reportBaseName(name);
      if (format === 'xlsx') { downloadReportXlsx(`${base}.xlsx`, {sheets: list}); return; }
      const html = productionPrintHtml({title, sheets: list, paper});
      if (format === 'html') { downloadDocument(`${base}.html`, html); return; }
      const popup = window.open('', '_blank');
      if (!popup) throw Error('印刷画面を開けませんでした。ポップアップを許可するか、「印刷用HTML」を保存して開いてください');
      popup.document.open();
      popup.document.write(html);
      popup.document.close();
    } catch (cause) {
      setError(cause);
    }
  }
  return (
    <div className="production-output" role="group" aria-label={`${title}の出力`}>
      <span className="production-output-label">{label}</span>
      {['xlsx', 'print', 'html'].map((format) => <button key={format} type="button" className="secondary" onClick={() => run(format)}>{OUTPUT_LABELS[format]}</button>)}
      {pending > 0 && <span className="production-output-note">未保存の変更 {pending}件を含めて出力します</span>}
      {error && <Notice error={error} compact onDismiss={() => setError(null)} />}
    </div>
  );
}

export default function ProductionWorkspace({data, request: requestProp, onNavigate, onSwitchOrg}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const workId = data.selectedWorkId;
  const workTitle = data.selectedWork?.title || '';
  const loadNo = useRef(0), sceneEditorRef = useRef(null), workspaceRef = useRef(null);
  const [snapshot, setSnapshot] = useState(null), [graph, setGraph] = useState(initial), [busy, setBusy] = useState(false), [notice, setNotice] = useState(null);
  const [dayEdit, setDayEdit] = useState(null), [dayEditBase, setDayEditBase] = useState('');
  const [newScene, setNewScene] = useState(emptyScene), [sceneEdit, setSceneEdit] = useState(null), [sceneEditBase, setSceneEditBase] = useState('');
  const [roleName, setRoleName] = useState(''), [lookCharacter, setLookCharacter] = useState(''), [locationName, setLocationName] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false), [dayScope, setDayScope] = useState('day');
  const [tabParam, setTab] = useParamState(shell, 'tab', 'kouban');
  const [dayParam, setDayParam] = useParamState(shell, 'day', null);
  const [costumeView, setCostumeView] = useParamState(shell, 'view', 'looks');
  const tab = productionTab(tabParam);

  const ok = (message) => setNotice({tone: 'ok', message});
  const warn = (message, details) => setNotice({tone: 'warn', message, details});
  const fail = (error) => setNotice({tone: 'error', error});

  async function load() {
    const n = ++loadNo.current;
    try {
      const result = await request(`/production?workId=${workId}`);
      if (n !== loadNo.current) return;
      setSnapshot(result);
      setGraph(copyGraph(result));
      setConfirmDiscard(false);
    } catch (error) {
      if (n === loadNo.current) fail(error);
    }
  }
  useEffect(() => {
    setSnapshot(null); setGraph(initial); setNotice(null); setDayEdit(null); setSceneEdit(null); setNewScene(emptyScene()); setConfirmDiscard(false);
    load();
  }, [workId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 未保存の件数（制作情報の行の差＋編集中の日々スケ・シーン）
  const graphChanges = useMemo(() => (snapshot ? countGraphChanges(copyGraph(snapshot), graph) : 0), [snapshot, graph]);
  const dayDirty = dayEdit && JSON.stringify(dayEdit) !== dayEditBase ? 1 : 0;
  const sceneDirty = sceneEdit ? (JSON.stringify(sceneEdit) !== sceneEditBase ? 1 : 0) : (newScene.scene_no || newScene.location || newScene.synopsis ? 1 : 0);
  const unsavedCount = graphChanges + dayDirty + sceneDirty;
  const registerUnsaved = shell.registerUnsaved;
  useEffect(() => { registerUnsaved?.('production-workspace', unsavedCount, '制作（香盤・日々スケ・衣装）'); }, [registerUnsaved, unsavedCount]);
  useEffect(() => () => registerUnsaved?.('production-workspace', 0, '制作（香盤・日々スケ・衣装）'), [registerUnsaved]);

  function change(key, fn) { setGraph((current) => ({...current, [key]: fn(current[key])})); }
  function editRow(key, where, patch) { change(key, (rows) => rows.map((row) => (where(row) ? {...row, ...patch} : row))); }
  function removeRow(key, where) { change(key, (rows) => rows.filter((row) => !where(row))); }
  function detail(scene) { return graph.sceneDetails.find((item) => item.scene_id === scene.id) || {scene_id: scene.id, page_eighths: null, estimated_minutes: null, location_key: null, note: null}; }
  function setDetail(sceneId, patch) { change('sceneDetails', (rows) => (rows.some((item) => item.scene_id === sceneId) ? rows.map((item) => (item.scene_id === sceneId ? {...item, ...patch} : item)) : [...rows, {scene_id: sceneId, page_eighths: null, estimated_minutes: null, location_key: null, note: null, ...patch}])); }

  const characters = graph.characters, locations = graph.locations, scenes = snapshot?.scenes || [], days = snapshot?.days || [];
  const dayId = days.some((item) => String(item.id) === String(dayParam)) ? Number(dayParam) : days[0]?.id ?? null;
  const day = days.find((item) => item.id === dayId);
  const locByKey = new Map(locations.map((item) => [item.key, item]));
  const production = useMemo(() => ({...graph, scenes, days}), [graph, scenes, days]);
  const castOrder = useMemo(() => koubanCharacters(production), [production]);
  const groups = useMemo(() => koubanGroups(production), [production]);
  const gaps = useMemo(() => wardrobeGaps(graph), [graph]);
  const gapInfo = gapSummary(gaps, {scenes, characters});
  // 「香盤のデモを見る」（今の組織か、所属する別の組織にデモがあるとき）。デモの作品そのものでは出さない。
  // 香盤が空なら案内の文と一緒に、シーンがあるときもマスター香盤の見出しの横に小さく出す（空の香盤以外からもデモへ行けるように）
  const koubanDemo = useKoubanDemoPlace({request, works: data.works || [], currentOrgId: data.currentUser?.orgId, enabled: Boolean(snapshot)});
  const showKoubanDemo = showKoubanDemoEntry({place: koubanDemo, workId});

  async function saveGraph() {
    if (readOnly) return;
    const problems = [];
    graph.daySlots.forEach((slot) => {
      const target = days.find((item) => item.id === slot.day_id);
      for (const [start, end, label] of [[slot.planned_start, slot.planned_end, '予定'], [slot.actual_start, slot.actual_end, '実績']]) {
        const message = timeRangeError(start, end, {label});
        if (message) problems.push({row: target ? shootDateText(target.shoot_date) : '撮影日未確認', column: slot.label || '項目', message});
      }
    });
    if (problems.length) { warn('時刻を確認してください。保存していません。', problems); return; }
    setBusy(true); setNotice(null);
    try {
      await request(`/production/${workId}`, {method: 'PUT', headers: {'If-Match': String(snapshot.version)}, body: JSON.stringify(graph)});
      await load();
      ok('制作情報を保存しました');
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  function discardChanges() {
    setGraph(copyGraph(snapshot));
    setConfirmDiscard(false);
    ok('未保存の変更を取り消し、保存済みの内容に戻しました');
  }

  const graphFirst = () => {
    if (!graphChanges) return false;
    warn(`役・衣装・入り時間などの未保存の変更（${graphChanges}件）があります。先に「制作情報を保存」で保存してください。シーンや日々スケを保存すると画面を読み直すためです。`);
    return true;
  };

  function validateDay(target) {
    const problems = [];
    const seen = new Set();
    target.assignments.forEach((assignment, index) => {
      const row = `${index + 1}番目`;
      if (!assignment.scene_id) problems.push({row, message: 'シーンを選んでください'});
      else if (seen.has(String(assignment.scene_id))) problems.push({row, message: '同じシーンが2回入っています'});
      seen.add(String(assignment.scene_id));
      for (const [start, end, label] of [[assignment.planned_start, assignment.planned_end, '予定'], [assignment.actual_start, assignment.actual_end, '実績']]) {
        const message = timeRangeError(start, end, {label, bothRequired: true});
        if (message) problems.push({row, message});
      }
    });
    if (!target.shoot_date) problems.push({row: '撮影日', message: '撮影日を入れてください'});
    if (!String(target.unit || '').trim()) problems.push({row: '班', message: '班を入れてください'});
    if (!String(target.label || '').trim()) problems.push({row: '表示名', message: '表示名を入れてください'});
    return problems;
  }

  async function saveDay(event) {
    event.preventDefault();
    if (readOnly || graphFirst()) return;
    const target = dayEdit;
    const problems = validateDay(target);
    if (problems.length) { warn('日々スケの入力を確認してください。保存していません。', problems); return; }
    setBusy(true); setNotice(null);
    try {
      const body = {workId, shootDate: target.shoot_date, unit: target.unit, label: target.label, notes: target.notes,
        assignments: target.assignments.map((assignment, index) => ({sceneId: Number(assignment.scene_id), sequenceOrder: index + 1,
          plannedStart: nullable(assignment.planned_start || ''), plannedEnd: nullable(assignment.planned_end || ''),
          actualStart: nullable(assignment.actual_start || ''), actualEnd: nullable(assignment.actual_end || ''), outcome: assignment.outcome || 'planned', notes: assignment.notes || ''}))};
      const options = {method: target.id ? 'PATCH' : 'POST', body: JSON.stringify(body)};
      if (target.id) options.headers = {'If-Match': String(target.version)};
      const result = await request(target.id ? `/field/days/${target.id}` : '/field/days', options);
      setDayEdit(null);
      await load();
      setDayParam(String(target.id || result.dayId));
      ok(target.id ? '日々スケを保存しました' : '撮影日を作成しました');
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function saveScene(event) {
    event.preventDefault();
    if (readOnly || graphFirst()) return;
    const current = sceneEdit || newScene;
    if (!String(current.scene_no || '').trim()) { warn('シーン番号を入れてください'); return; }
    setBusy(true); setNotice(null);
    try {
      const payload = sceneEdit
        ? {scene_no: current.scene_no, day_night: current.day_night || null, location: current.location || null, synopsis: current.synopsis || '', status: current.status}
        : {project_id: data.selectedWork?.project_id, work_id: workId, scene_no: current.scene_no, day_night: current.day_night || null, location: current.location || null, synopsis: current.synopsis || '', status: 'draft'};
      const options = {method: sceneEdit ? 'PATCH' : 'POST', body: JSON.stringify(payload)};
      if (sceneEdit) options.headers = {'If-Match': String(sceneEdit.version)};
      await request(sceneEdit ? `/scenes/${sceneEdit.id}` : '/scenes', options);
      const wasEdit = Boolean(sceneEdit);
      setSceneEdit(null);
      setNewScene(emptyScene());
      await load();
      ok(wasEdit ? 'シーンを保存しました' : 'シーンを登録しました');
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  function openScene(scene) {
    const copy = {...scene};
    setSceneEdit(copy);
    setSceneEditBase(JSON.stringify(copy));
    setNotice(null);
    requestAnimationFrame(() => sceneEditorRef.current?.scrollIntoView({block: 'start', behavior: 'smooth'}));
  }
  function openLocationScene(scene) { setTab('kouban'); openScene(scene); }
  function selectDay(target) {
    if (dayDirty) { warn('編集中の日々スケがあります。保存するか「修正をやめる」を押してから撮影日を切り替えてください。'); return; }
    setDayEdit(null);
    setDayParam(String(target.id));
  }
  function openLocationDay(target) {
    setTab('day');
    selectDay(target);
    requestAnimationFrame(() => workspaceRef.current?.scrollIntoView({block: 'start', behavior: 'smooth'}));
  }
  function startDayEdit(target) {
    const copy = target
      ? {...target, baseDate: target.shoot_date, assignments: target.assignments.map((assignment) => ({...assignment, scene_id: String(assignment.scene_id)}))}
      : emptyDay();
    setDayEdit(copy);
    setDayEditBase(JSON.stringify(copy));
  }
  function setDayDate(value) {
    setDayEdit((current) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return {...current, shoot_date: value};
      const rebase = (time) => rebaseDayTime(time, current.baseDate, value);
      return {...current, shoot_date: value, baseDate: value, assignments: current.assignments.map((assignment) => ({...assignment,
        planned_start: rebase(assignment.planned_start), planned_end: rebase(assignment.planned_end), actual_start: rebase(assignment.actual_start), actual_end: rebase(assignment.actual_end)}))};
    });
  }
  function updateDayAssignment(index, patch) { setDayEdit((current) => ({...current, assignments: current.assignments.map((assignment, n) => (n === index ? {...assignment, ...patch} : assignment))})); }
  function moveDayAssignment(index, delta) {
    setDayEdit((current) => {
      const rows = [...current.assignments], target = index + delta;
      if (target < 0 || target >= rows.length) return current;
      [rows[index], rows[target]] = [rows[target], rows[index]];
      return {...current, assignments: rows};
    });
  }

  function addRole(event) {
    event.preventDefault();
    const name = roleName.trim();
    if (!name) return;
    if (characters.some((item) => item.name === name)) { warn('同じ役名があります'); return; }
    change('characters', (rows) => [...rows, {key: newKey(), name, short_name: name.slice(0, 2), actor_name: '', note: ''}]);
    setRoleName('');
  }
  function addLocation(event) {
    event.preventDefault();
    const name = locationName.trim();
    if (!name) return;
    if (locations.some((item) => item.name === name)) { warn('同じロケ地名があります'); return; }
    change('locations', (rows) => [...rows, {key: newKey(), name, address: '', floor: '', green_room: '', parking: '', facilities: '', contact: '', note: ''}]);
    setLocationName('');
  }
  function setLocationPlan(locationKey, strokes) { change('locationPlans', (rows) => (rows.some((plan) => plan.location_key === locationKey) ? rows.map((plan) => (plan.location_key === locationKey ? {...plan, strokes} : plan)) : [...rows, {location_key: locationKey, strokes}])); }
  function addLook(event) {
    event.preventDefault();
    if (!lookCharacter) return;
    const count = graph.looks.filter((item) => item.character_key === lookCharacter).length + 1;
    change('looks', (rows) => [...rows, {key: newKey(), character_key: lookCharacter, label: `${count}`, makeup: '', props: '', shoes: '', accessories: '', note: ''}]);
  }
  function toggleAppearance(sceneId, characterKey) {
    const removed = graph.appearances.some((item) => item.scene_id === sceneId && item.character_key === characterKey);
    change('appearances', (rows) => (removed ? rows.filter((item) => !(item.scene_id === sceneId && item.character_key === characterKey)) : [...rows, {scene_id: sceneId, character_key: characterKey}]));
    if (removed) {
      const keys = new Set(graph.looks.filter((item) => item.character_key === characterKey).map((item) => item.key));
      change('sceneLooks', (rows) => rows.filter((item) => !(item.scene_id === sceneId && keys.has(item.look_key))));
    }
  }
  function toggleLook(sceneId, lookKey) { change('sceneLooks', (rows) => (rows.some((item) => item.scene_id === sceneId && item.look_key === lookKey) ? rows.filter((item) => !(item.scene_id === sceneId && item.look_key === lookKey)) : [...rows, {scene_id: sceneId, look_key: lookKey}])); }
  function setCall(targetDay, characterKey, field, value) {
    change('calls', (rows) => (rows.some((item) => item.day_id === targetDay.id && item.character_key === characterKey)
      ? rows.map((item) => (item.day_id === targetDay.id && item.character_key === characterKey ? {...item, [field]: value} : item))
      : [...rows, {day_id: targetDay.id, character_key: characterKey, call_time: '', ready_time: '', note: '', [field]: value}]));
  }

  const noticeView = notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} details={notice.details} onDismiss={() => setNotice(null)} />;
  if (!snapshot) return <section className="card"><p className="empty">制作情報を読み込んでいます。</p>{notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onRetry={load} />}</section>;

  const dataAsOf = new Date().toISOString();
  const pendingText = graphChanges ? `未保存の変更 ${graphChanges}件` : '変更はありません';
  const sceneForm = sceneEdit || newScene;
  const setSceneForm = (patch) => (sceneEdit ? setSceneEdit({...sceneEdit, ...patch}) : setNewScene({...newScene, ...patch}));

  const koubanPanel = (
    <>
      <details ref={sceneEditorRef} className="production-add" open={sceneEdit ? true : undefined}>
        <summary>{sceneEdit ? `S#${sceneEdit.scene_no} を修正中` : 'シーンを追加・修正'}</summary>
        <Section title={sceneEdit ? 'シーンを修正' : 'シーンを追加'}>
          <p className="production-note">シーンはこのボタンでその場に保存します。香盤の頁・予定尺・ロケ地・出演は「制作情報を保存」で保存します。</p>
          <form onSubmit={saveScene}>
            <div className="production-formgrid">
              <Field label="シーン番号（必須）" value={sceneForm.scene_no} onChange={(value) => setSceneForm({scene_no: value})} />
              <Select label="昼夜" value={sceneForm.day_night} onChange={(value) => setSceneForm({day_night: value})} items={DAY_NIGHT_OPTIONS} blank="未確認" />
              <Field label="台本の場所表記" value={sceneForm.location} onChange={(value) => setSceneForm({location: value})} />
              <Field label="内容" value={sceneForm.synopsis} onChange={(value) => setSceneForm({synopsis: value})} />
              {sceneEdit && <Select label="状態" value={sceneEdit.status} onChange={(value) => setSceneEdit({...sceneEdit, status: value})} items={SCENE_STATUS_OPTIONS} blank={null} />}
            </div>
            <div className="production-actions">
              <button disabled={busy || readOnly}>{sceneEdit ? '修正を保存' : 'シーンを登録'}</button>
              {sceneEdit && <button type="button" className="secondary" onClick={() => setSceneEdit(null)}>修正をやめる</button>}
            </div>
          </form>
        </Section>
      </details>
      <Section title="マスター香盤" extra={<>
        <span className="count">{scenes.length} シーン</span>
        {showKoubanDemo && scenes.length > 0 && <KoubanDemoEntry place={koubanDemo} onNavigate={onNavigate || shell.navigate} onSwitchOrg={onSwitchOrg} label="香盤のデモを見る" note={false} />}
      </>}>
        <ProductionOutput label="香盤表" name={`香盤表${workTitle ? `_${workTitle}` : ''}`} title={`${workTitle} 香盤表`.trim()} pending={graphChanges}
          paper={characters.length > 10 ? 'A3 landscape' : 'A4 landscape'} sheets={() => [koubanSheet(production, {workTitle, dataAsOf: new Date().toISOString()})]} />
        {scenes.length === 0
          ? (
            <>
              <p className="empty">シーンはまだありません。上の「シーンを追加・修正」か「台本を取り込む」から登録します。</p>
              {showKoubanDemo && (
                <div className="production-empty-demo">
                  <p className="note">登録済みの香盤を見てみたいときは、架空の連続ドラマの香盤のデモ（58シーン・9撮影日）を開けます。</p>
                  <KoubanDemoEntry place={koubanDemo} onNavigate={onNavigate || shell.navigate} onSwitchOrg={onSwitchOrg} label="香盤のデモを見る" />
                </div>
              )}
            </>
          )
          : (
            <div className="production-table-wrap is-sticky">
              <table className="production-matrix">
                <thead>
                  <tr>
                    <th scope="col" className="production-sticky-col">S#</th><th scope="col">昼夜</th><th scope="col">頁</th><th scope="col">場所</th><th scope="col">内容</th>
                    {castOrder.map((character) => <th scope="col" key={character.key} className="production-cast-head" title={`${character.name}（${character.actor_name || '俳優未定'}）`}>{character.short_name || character.name}</th>)}
                    <th scope="col">予定尺（分）</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <React.Fragment key={group.day?.id || 'unassigned'}>
                      <tr className="date-band"><th colSpan={6 + characters.length} scope="rowgroup"><span className="production-band-label">{dayLabel(group.day)}</span></th></tr>
                      {group.scenes.map((scene) => {
                        const item = detail(scene), location = locByKey.get(item.location_key);
                        return (
                          <tr key={scene.id}>
                            <th scope="row" className="production-sticky-col"><button type="button" className="production-scene-open" onClick={() => openScene(scene)}>S#{scene.scene_no}</button></th>
                            <td>{scene.day_night ? labelOf('dayNight', scene.day_night) : '—'}</td>
                            <td><input aria-label={`S#${scene.scene_no} の頁（1/8頁単位の小数）`} type="number" min="0" step="0.125" value={item.page_eighths == null ? '' : Number(item.page_eighths) / 8} onChange={(event) => setDetail(scene.id, {page_eighths: event.target.value === '' ? null : Math.round(Number(event.target.value) * 8)})} />{item.page_eighths != null && <small>{pageText(item.page_eighths)}頁</small>}</td>
                            <td><select aria-label={`S#${scene.scene_no} のロケ地`} value={item.location_key || ''} onChange={(event) => setDetail(scene.id, {location_key: nullable(event.target.value)})}><option value="">{scene.location || '未定'}</option>{locations.map((loc) => <option key={loc.key} value={loc.key}>{loc.name}</option>)}</select>{location?.address && <small>{location.address}</small>}</td>
                            <td className="production-wrap">{scene.synopsis || '—'}</td>
                            {castOrder.map((character) => (
                              <td key={character.key} className="cast-cell">
                                <label className="production-cast-hit"><input type="checkbox" aria-label={`S#${scene.scene_no} ${character.name} の出演`} checked={graph.appearances.some((a) => a.scene_id === scene.id && a.character_key === character.key)} onChange={() => toggleAppearance(scene.id, character.key)} /></label>
                              </td>
                            ))}
                            <td><input aria-label={`S#${scene.scene_no} の予定尺（分）`} type="number" min="1" value={item.estimated_minutes ?? ''} onChange={(event) => setDetail(scene.id, {estimated_minutes: nullable(event.target.value)})} /></td>
                          </tr>
                        );
                      })}
                      <tr className="subtotal"><th colSpan="2" scope="row" className="production-sticky-col">小計</th><td className="num">{pageText(group.scenes.reduce((n, scene) => n + (Number(detail(scene).page_eighths) || 0), 0))}頁</td><td colSpan={2 + characters.length}></td><td className="num">{group.scenes.reduce((n, scene) => n + (Number(detail(scene).estimated_minutes) || 0), 0)}分</td></tr>
                    </React.Fragment>
                  ))}
                </tbody>
                <tfoot><tr><th colSpan="2" scope="row" className="production-sticky-col">合計</th><td className="num">{pageText(scenes.reduce((n, scene) => n + (Number(detail(scene).page_eighths) || 0), 0))}頁</td><td colSpan={2 + characters.length}></td><td className="num">{scenes.reduce((n, scene) => n + (Number(detail(scene).estimated_minutes) || 0), 0)}分</td></tr></tfoot>
              </table>
            </div>
          )}
        <p className="production-note">頁は 1/8 頁単位（1.375 = 1 3/8 頁）。○の欄を押すと出演を付け外しします。</p>
      </Section>
      <Section title="役・キャスト" extra={<span className="count">{characters.length} 役</span>}>
        <form className="production-inline" onSubmit={addRole}><input aria-label="追加する役名" placeholder="役名" value={roleName} onChange={(event) => setRoleName(event.target.value)} /><button disabled={readOnly}>役を追加</button></form>
        <div className="production-cards">
          {characters.map((character) => (
            <article className="production-mini" key={character.key}>
              <Field label="役名" value={character.name} onChange={(value) => editRow('characters', (x) => x.key === character.key, {name: value})} />
              <Field label="略称（香盤の見出し）" value={character.short_name} onChange={(value) => editRow('characters', (x) => x.key === character.key, {short_name: value})} />
              <Field label="俳優" value={character.actor_name} onChange={(value) => editRow('characters', (x) => x.key === character.key, {actor_name: value})} />
              <button type="button" className="secondary" onClick={() => {
                if (graph.appearances.some((a) => a.character_key === character.key) || graph.looks.some((l) => l.character_key === character.key) || graph.calls.some((a) => a.character_key === character.key)) {
                  warn(`「${character.name}」には出演・衣装・入り時間があります。先にそれらを外してから削除してください。`);
                  return;
                }
                removeRow('characters', (x) => x.key === character.key);
              }}>役を削除</button>
            </article>
          ))}
        </div>
      </Section>
    </>
  );

  const daySheets = () => {
    const targets = dayScope === 'all' ? days : day ? [day] : [];
    return targets.flatMap((target) => {
      const suffix = dayScope === 'all' ? ` ${target.shoot_date.slice(5)}` : '';
      const schedule = dailyScheduleSheet(production, target, {workTitle, dataAsOf: new Date().toISOString()});
      const calls = callSheet(production, target, {workTitle, dataAsOf: new Date().toISOString()});
      return [{...schedule, name: `${schedule.name}${suffix}`}, {...calls, name: `${calls.name}${suffix}`}];
    });
  };

  const dayPanel = (
    <>
      <Section title="撮影日" extra={<button type="button" className="secondary" disabled={readOnly || busy} onClick={() => { if (dayDirty) { warn('編集中の日々スケを保存するか「修正をやめる」を押してから追加してください。'); return; } startDayEdit(null); }}>撮影日を追加</button>}>
        {days.length
          ? <div className="production-daytabs" role="group" aria-label="撮影日を選ぶ">{days.map((item) => <button type="button" key={item.id} aria-pressed={dayId === item.id} className={dayId === item.id ? 'active' : ''} onClick={() => selectDay(item)}>{shootDateText(item.shoot_date)} {item.unit}</button>)}</div>
          : <p className="empty">撮影日はまだありません。「撮影日を追加」から作ります。</p>}
      </Section>
      {day && !dayEdit && (
        <Section title={`${shootDateText(day.shoot_date)} ${day.unit}｜${day.label}`} extra={<button type="button" className="secondary" disabled={readOnly} onClick={() => startDayEdit(day)}>この日の割当・時刻を修正</button>}>
          <div className="production-output-row">
            <label className="production-scope">出力する日<select value={dayScope} onChange={(event) => setDayScope(event.target.value)}><option value="day">この日</option><option value="all">全撮影日（{days.length}日）</option></select></label>
            <ProductionOutput label="日々スケ" name={`日々スケ${workTitle ? `_${workTitle}` : ''}${dayScope === 'day' ? `_${day.shoot_date}` : ''}`} title={`${workTitle} 日々スケ`.trim()} pending={graphChanges} sheets={daySheets} />
          </div>
          <p className="production-note">連絡事項：{day.notes || 'なし'}</p>
          <div className="production-timeline">
            {dayTimeline(day, graph.daySlots).map((item) => item.type === 'scene'
              ? <article key={`a${item.row.id}`} className="production-line"><span>{item.row.sequence_order}</span><strong>{labelScene(scenes.find((scene) => scene.id === item.row.scene_id) || {scene_no: '?', synopsis: ''})}</strong><span>{item.row.planned_start ? `${dayTimeText(item.row.planned_start, day.shoot_date)}〜${dayTimeText(item.row.planned_end, day.shoot_date)}` : '時刻未定'}</span><span>{OUTCOME_LABELS[item.row.outcome] || '—'}</span><small>{item.row.notes}</small></article>
              : <article key={`s${item.row.key}`} className="production-line interlude"><span>—</span><strong>{item.row.label}</strong><span>{item.row.planned_start ? `${dayTimeText(item.row.planned_start, day.shoot_date)}〜${dayTimeText(item.row.planned_end, day.shoot_date) || '未定'}` : '時刻未定'}</span><span>{SLOT_KIND_LABELS[item.row.kind] || 'その他'}</span><small>{item.row.note}</small></article>)}
            {!day.assignments.length && !graph.daySlots.some((slot) => slot.day_id === day.id) && <p className="empty">この日の割当はまだありません。「この日の割当・時刻を修正」でシーンを入れます。</p>}
          </div>
          <div className="production-two">
            <div>
              <h4>移動・食事・撤収</h4>
              <p className="production-note">「制作情報を保存」で保存します。</p>
              <button type="button" className="secondary" disabled={readOnly} onClick={() => change('daySlots', (rows) => [...rows, {day_id: day.id, key: newKey(), after_scene_order: day.assignments.length, kind: 'move', label: '移動', planned_start: '', planned_end: '', actual_start: '', actual_end: '', note: ''}])}>項目を追加</button>
              {graph.daySlots.filter((slot) => slot.day_id === day.id).map((slot) => {
                const where = (x) => x.key === slot.key && x.day_id === day.id;
                const positionItems = Array.from({length: day.assignments.length + 1}, (_, n) => ({value: String(n), label: n === 0 ? '最初（シーンの前）' : `${n}番目のシーンの後`}));
                return (
                  <div className="production-mini" key={slot.key}>
                    <Select label="種類" value={slot.kind} onChange={(value) => editRow('daySlots', where, {kind: value})} items={SLOT_KIND_OPTIONS} blank={null} />
                    <Field label="項目" value={slot.label} onChange={(value) => editRow('daySlots', where, {label: value})} />
                    <Select label="入れる位置" value={String(slot.after_scene_order ?? 0)} onChange={(value) => editRow('daySlots', where, {after_scene_order: Number(value)})} items={positionItems} blank={null} />
                    <Field label="メモ" value={slot.note} onChange={(value) => editRow('daySlots', where, {note: value})} />
                    <TimeField label="予定開始" value={slot.planned_start} shootDate={day.shoot_date} onChange={(value) => editRow('daySlots', where, {planned_start: value})} />
                    <TimeField label="予定終了" value={slot.planned_end} shootDate={day.shoot_date} onChange={(value) => editRow('daySlots', where, {planned_end: value})} />
                    <TimeField label="実績開始" value={slot.actual_start} shootDate={day.shoot_date} onChange={(value) => editRow('daySlots', where, {actual_start: value})} />
                    <TimeField label="実績終了" value={slot.actual_end} shootDate={day.shoot_date} onChange={(value) => editRow('daySlots', where, {actual_end: value})} />
                    <button type="button" className="secondary" onClick={() => removeRow('daySlots', where)}>この項目を外す</button>
                  </div>
                );
              })}
            </div>
            <div>
              <h4>役の入り時間</h4>
              <p className="production-note">「制作情報を保存」で保存します。</p>
              {characters.length === 0 && <p className="empty">役がありません。「香盤」タブで役を追加します。</p>}
              {characters.map((character) => {
                const call = graph.calls.find((item) => item.day_id === day.id && item.character_key === character.key);
                return (
                  <div className="production-call" key={character.key}>
                    <strong>{character.name}</strong>
                    <TimeField label="入り" value={call?.call_time || ''} shootDate={day.shoot_date} onChange={(value) => setCall(day, character.key, 'call_time', value)} />
                    <TimeField label="支度完了" value={call?.ready_time || ''} shootDate={day.shoot_date} onChange={(value) => setCall(day, character.key, 'ready_time', value)} />
                  </div>
                );
              })}
            </div>
          </div>
        </Section>
      )}
      {dayEdit && (
        <Section title={dayEdit.id ? '日々スケを修正' : '撮影日を作成'}>
          <p className="production-note">撮影日・シーンの割当・撮影順・予定と実績の時刻を、この日の分まとめて保存します。日をまたぐ時刻は「翌日」に印を付けます。</p>
          <form onSubmit={saveDay}>
            <div className="production-formgrid">
              <Field label="撮影日（必須）" type="date" value={dayEdit.shoot_date} onChange={setDayDate} />
              <Field label="班（必須）" value={dayEdit.unit} onChange={(value) => setDayEdit({...dayEdit, unit: value})} />
              <Field label="表示名（必須）" value={dayEdit.label} onChange={(value) => setDayEdit({...dayEdit, label: value})} />
              <Field label="連絡事項" value={dayEdit.notes} onChange={(value) => setDayEdit({...dayEdit, notes: value})} />
            </div>
            {dayEdit.assignments.map((assignment, index) => (
              <div className="production-assignment" key={`${index}-${assignment.scene_id}`}>
                <span className="production-assignment-no">{index + 1}</span>
                <Select label="シーン" value={assignment.scene_id} onChange={(value) => updateDayAssignment(index, {scene_id: value})} items={scenes.map((scene) => ({value: String(scene.id), label: labelScene(scene)}))} />
                <Select label="撮影実績" value={assignment.outcome} onChange={(value) => updateDayAssignment(index, {outcome: value})} items={OUTCOME_OPTIONS} blank={null} />
                {[['planned_start', '予定開始'], ['planned_end', '予定終了'], ['actual_start', '実績開始'], ['actual_end', '実績終了']].map(([key, label]) => (
                  <TimeField key={key} label={label} value={assignment[key]} shootDate={dayEdit.baseDate} onChange={(value) => updateDayAssignment(index, {[key]: value})} />
                ))}
                <Field label="メモ" value={assignment.notes} onChange={(value) => updateDayAssignment(index, {notes: value})} wide />
                <div className="production-actions">
                  <button type="button" className="secondary" disabled={index === 0} onClick={() => moveDayAssignment(index, -1)}>前へ</button>
                  <button type="button" className="secondary" disabled={index === dayEdit.assignments.length - 1} onClick={() => moveDayAssignment(index, 1)}>後へ</button>
                  <button type="button" className="secondary" onClick={() => setDayEdit({...dayEdit, assignments: dayEdit.assignments.filter((_, n) => n !== index)})}>この割当を外す</button>
                </div>
              </div>
            ))}
            <div className="production-actions">
              <button type="button" className="secondary" onClick={() => setDayEdit({...dayEdit, assignments: [...dayEdit.assignments, {scene_id: '', planned_start: '', planned_end: '', actual_start: '', actual_end: '', outcome: 'planned', notes: ''}]})}>シーンを追加</button>
              <button disabled={busy || readOnly}>{dayEdit.id ? 'この日の日々スケを保存' : '撮影日を作成'}</button>
              <button type="button" className="secondary" onClick={() => setDayEdit(null)}>修正をやめる</button>
            </div>
          </form>
        </Section>
      )}
    </>
  );

  const costumePanel = (
    <>
      <div className="production-output-row">
        <ProductionOutput label="衣装香盤" name={`衣装香盤${workTitle ? `_${workTitle}` : ''}`} title={`${workTitle} 衣装香盤`.trim()} pending={graphChanges}
          sheets={() => [costumeSheet(production, {workTitle, dataAsOf: new Date().toISOString()}), sceneCostumeSheet(production, {workTitle, dataAsOf: new Date().toISOString()})]} />
      </div>
      {gapInfo.total > 0 && <Notice tone="warn" title={`衣装未割当 ${gapInfo.total}件`} message={gapInfo.text} />}
      <Tabs label="衣装香盤の表示" value={costumeView === 'scenes' ? 'scenes' : 'looks'} onChange={setCostumeView} tabs={[{id: 'looks', label: '役 × ルック'}, {id: 'scenes', label: 'シーン → 衣装', badge: gapInfo.total || undefined}]}>
        {(view) => (view === 'looks' ? (
          <div className="stack">
            <Section title="ルックを追加">
              <form className="production-inline" onSubmit={addLook}>
                <select aria-label="ルックを追加する役" value={lookCharacter} onChange={(event) => setLookCharacter(event.target.value)}><option value="">役を選択</option>{characters.map((character) => <option value={character.key} key={character.key}>{character.name}</option>)}</select>
                <button disabled={readOnly || !lookCharacter}>ルックを追加</button>
              </form>
              {characters.length === 0 && <p className="empty">役がありません。「香盤」タブで役を追加します。</p>}
            </Section>
            {characters.map((character) => {
              const looks = graph.looks.filter((look) => look.character_key === character.key);
              return looks.length ? (
                <Section key={character.key} title={`${character.name}｜${character.actor_name || '俳優未定'}`} extra={<span className="count">{looks.length} ルック</span>}>
                  <div className="production-cards">
                    {looks.map((look) => (
                      <article className="production-look" key={look.key}>
                        <div className="production-lookhead"><strong>{character.name}　{look.label}</strong><button type="button" className="secondary" onClick={() => { removeRow('sceneLooks', (x) => x.look_key === look.key); removeRow('looks', (x) => x.key === look.key); }}>このルックを削除</button></div>
                        <div className="production-formgrid">{[['label', 'ルック番号'], ['makeup', 'メイク'], ['props', '持ち道具'], ['shoes', '靴'], ['accessories', '装飾品'], ['note', '備考']].map(([key, label]) => <Field key={key} label={label} value={look[key]} onChange={(value) => editRow('looks', (x) => x.key === look.key, {[key]: value})} />)}</div>
                        <div className="production-scenechecks"><strong>着用シーン</strong>
                          {graph.appearances.filter((a) => a.character_key === character.key).map((a) => {
                            const scene = scenes.find((x) => x.id === a.scene_id);
                            return <label key={a.scene_id}><input type="checkbox" checked={graph.sceneLooks.some((x) => x.scene_id === a.scene_id && x.look_key === look.key)} onChange={() => toggleLook(a.scene_id, look.key)} />{scene ? `S#${scene.scene_no}` : 'シーン未確認'}</label>;
                          })}
                          {!graph.appearances.some((a) => a.character_key === character.key) && <span className="production-note">出演シーンがありません（香盤で○を付けます）</span>}
                        </div>
                      </article>
                    ))}
                  </div>
                </Section>
              ) : null;
            })}
          </div>
        ) : (
          <Section title="シーンから衣装を確認">
            <div className="production-table-wrap is-sticky">
              <table>
                <thead><tr><th scope="col" className="production-sticky-col">S#</th><th scope="col">場所</th><th scope="col">役と衣装</th></tr></thead>
                <tbody>
                  {scenes.map((scene) => (
                    <tr key={scene.id}>
                      <th scope="row" className="production-sticky-col">S#{scene.scene_no}</th>
                      <td>{locByKey.get(detail(scene).location_key)?.name || scene.location || '未定'}</td>
                      <td>{graph.appearances.filter((a) => a.scene_id === scene.id).map((a) => {
                        const character = characters.find((x) => x.key === a.character_key);
                        const assigned = graph.sceneLooks.filter((x) => x.scene_id === scene.id).map((x) => graph.looks.find((l) => l.key === x.look_key)).filter((l) => l?.character_key === a.character_key);
                        return <span className={assigned.length ? 'production-tag' : 'production-tag missing'} key={a.character_key}>{character?.name} {assigned.length ? assigned.map((l) => l.label).join('・') : '未割当'}</span>;
                      })}</td>
                    </tr>
                  ))}
                  {!scenes.length && <tr><td colSpan="3" className="empty">シーンがありません。</td></tr>}
                </tbody>
              </table>
            </div>
          </Section>
        ))}
      </Tabs>
    </>
  );

  const locationPanel = (
    <>
      <Section title="ロケ地を追加"><form className="production-inline" onSubmit={addLocation}><input aria-label="追加するロケ地名" value={locationName} onChange={(event) => setLocationName(event.target.value)} placeholder="ロケ地名" /><button disabled={readOnly}>ロケ地を追加</button></form></Section>
      {locations.length === 0 && <p className="empty">ロケ地はまだありません。追加すると、香盤の場所欄で選べるようになります。</p>}
      <div className="production-locations">
        {locations.map((location) => {
          const used = scenes.filter((scene) => detail(scene).location_key === location.key);
          const shootDays = days.filter((item) => item.assignments.some((a) => used.some((scene) => scene.id === a.scene_id)));
          const plan = graph.locationPlans.find((item) => item.location_key === location.key);
          return (
            <article className="card production-location" key={location.key}>
              <header><h3>{location.name}</h3><span>{used.length} シーン ／ {pageText(used.reduce((n, scene) => n + (Number(detail(scene).page_eighths) || 0), 0)) || '0'} 頁</span></header>
              <div className="production-location-layout">
                <div>
                  <div className="production-formgrid">{[['name', '名称'], ['address', '住所'], ['floor', '階'], ['green_room', '控室'], ['parking', '駐車'], ['facilities', '設備'], ['contact', '連絡先'], ['note', '備考']].map(([field, label]) => <Field key={field} label={label} value={location[field]} onChange={(value) => editRow('locations', (x) => x.key === location.key, {[field]: value})} />)}</div>
                  <div className="production-locationfoot">
                    <div className="production-location-links"><strong>使用シーン</strong>{used.length ? used.map((scene) => <button type="button" className="production-scene-open" key={scene.id} onClick={() => openLocationScene(scene)}>S#{scene.scene_no}</button>) : '未指定'}</div>
                    <div className="production-location-links"><strong>撮影日</strong>{shootDays.length ? shootDays.map((item) => <button type="button" className="secondary" key={item.id} onClick={() => openLocationDay(item)}>{shootDateText(item.shoot_date)} {item.unit}</button>) : '未編成'}</div>
                    {location.address && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location.address)}`} target="_blank" rel="noopener noreferrer">住所を地図で開く ↗</a>}
                    <button type="button" className="secondary" onClick={() => {
                      if (used.length) { warn(`「${location.name}」を使っているシーンが${used.length}件あります。香盤の場所欄から外してから削除してください。`); return; }
                      removeRow('locationPlans', (x) => x.location_key === location.key);
                      removeRow('locations', (x) => x.key === location.key);
                    }}>ロケ地を削除</button>
                  </div>
                </div>
                <ProductionLocationPlan key={`${workId}:${location.key}:${snapshot.version}`} locationName={location.name} value={plan?.strokes || []} onChange={(strokes) => setLocationPlan(location.key, strokes)} disabled={busy || readOnly} />
              </div>
            </article>
          );
        })}
      </div>
      <Section title="移動予定" extra={<span className="count">日々スケと共通</span>}>
        {graph.daySlots.some((slot) => slot.kind === 'move') ? (
          <div className="production-table-wrap">
            <table>
              <thead><tr><th scope="col">撮影日</th><th scope="col">移動</th><th scope="col">予定</th><th scope="col">実績</th><th scope="col">メモ</th></tr></thead>
              <tbody>
                {[...graph.daySlots].filter((slot) => slot.kind === 'move').sort((a, b) => (days.find((d) => d.id === a.day_id)?.shoot_date || '').localeCompare(days.find((d) => d.id === b.day_id)?.shoot_date || '') || a.after_scene_order - b.after_scene_order).map((slot) => {
                  const target = days.find((item) => item.id === slot.day_id);
                  const date = target?.shoot_date;
                  return (
                    <tr key={`${slot.day_id}:${slot.key}`}>
                      <td>{target && <button type="button" className="production-scene-open" onClick={() => openLocationDay(target)}>{shootDateText(target.shoot_date)} {target.unit}</button>}</td>
                      <td>{slot.label}</td>
                      <td>{dayTimeText(slot.planned_start, date) || '未定'} 〜 {dayTimeText(slot.planned_end, date) || '未定'}</td>
                      <td>{dayTimeText(slot.actual_start, date) || '—'} 〜 {dayTimeText(slot.actual_end, date) || '—'}</td>
                      <td>{slot.note || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="empty">日々スケで「移動」を追加すると、ここに表示されます。</p>}
      </Section>
    </>
  );

  const panels = {kouban: koubanPanel, day: dayPanel, costume: costumePanel, location: locationPanel,
    prep: <PrepTaskPanel workId={workId} workTitle={workTitle} request={request} refreshKey={`${snapshot.version}:${days.length}:${scenes.length}`} />};

  return (
    <div className="production-workspace stack" ref={workspaceRef}>
      <section className="card production-head">
        <div>
          <h2>撮影の編成</h2>
          <button type="button" className="text" onClick={() => (onNavigate || shell.navigate)?.('台本・香盤')}>台本を取り込む ↗</button>
        </div>
        <div className="production-save">
          <span className={graphChanges ? 'production-pending' : ''} aria-live="polite">{pendingText}</span>
          <button type="button" onClick={saveGraph} disabled={!graphChanges || busy || readOnly} title={readOnly ? '閲覧専用の表示のため保存できません' : graphChanges ? undefined : '変更はありません'}>{busy ? '保存中…' : '制作情報を保存'}</button>
          {graphChanges > 0 && !confirmDiscard && <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmDiscard(true)}>変更を取り消す</button>}
          {!graphChanges && <button type="button" className="secondary" disabled={busy} onClick={load}>再読込</button>}
        </div>
      </section>
      {confirmDiscard && (
        <Notice tone="warn" title={`未保存の変更 ${graphChanges}件を取り消しますか`} message="取り消すと、保存済みの内容に戻ります。入力した内容は元に戻せません。"
          actions={<><button type="button" onClick={discardChanges}>取り消して保存済みに戻す</button><button type="button" className="secondary" onClick={() => setConfirmDiscard(false)}>戻らない</button></>} />
      )}
      {readOnly && <Notice tone="info" message="閲覧専用の表示です。保存はできません。" compact />}
      {noticeView}
      <Tabs label="制作の表示" value={tab} onChange={(id) => setTab(id)} tabs={PRODUCTION_TABS.map((item) => ({...item, badge: item.id === 'costume' && gapInfo.total ? gapInfo.total : undefined}))}>
        {(active) => <div className="stack">{panels[active]}</div>}
      </Tabs>
    </div>
  );
}
