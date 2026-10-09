// 準備タスク（制作の「準備タスク」タブ）。一覧を上に置き、行を押すと修正、「＋準備タスクを追加」で登録する。
// シーンの編集と日々スケは制作の「香盤」「日々スケ」タブで行う（ここでは扱わない）。
// API: GET /api/field?workId（タスク・撮影日・シーン）、POST /api/field/tasks、PATCH /api/field/tasks/:id（If-Match 版）。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import './production-ui.css';
import {useShell} from './shell/context.mjs';
import {DataGrid} from './ui/DataGrid.jsx';
import {RecordForm} from './ui/RecordForm.jsx';
import {Notice} from './ui/Notice.jsx';
import {PREP_STATUS_LABELS, prepTaskState, prepSummary, shootDateText} from './work/production-print.mjs';
import {jstToday} from './work/catalog-model.mjs';

const STATUS_OPTIONS = Object.entries(PREP_STATUS_LABELS).map(([value, label]) => ({value, label}));

function dayText(day) {
  return day ? `${shootDateText(day.shoot_date)} ${day.unit || ''}`.trim() : '作品全体';
}

function sceneText(scene) {
  return scene ? `S#${scene.scene_no}${scene.synopsis ? ` ${scene.synopsis}` : ''}` : '指定なし';
}

function taskFields(state) {
  return [
    {name: 'title', label: '準備項目', type: 'text', required: true, wide: true, placeholder: '例: 雨降らしの手配'},
    {name: 'status', label: '状態', type: 'select', options: STATUS_OPTIONS, required: true, defaultValue: 'pending'},
    {name: 'dueOn', label: '期限', type: 'date'},
    {name: 'ownerLabel', label: '担当（役割名）', type: 'text', placeholder: '例: 美術部', hint: '個人名・連絡先は入れません'},
    {name: 'shootingDayId', label: '撮影日', type: 'select', blankLabel: '作品全体', options: state.days.map((day) => ({value: String(day.id), label: dayText(day)}))},
    {name: 'sceneId', label: 'シーン', type: 'select', blankLabel: '指定なし', options: state.scenes.map((scene) => ({value: String(scene.id), label: sceneText(scene)}))},
    {name: 'note', label: 'メモ', type: 'textarea', wide: true},
  ];
}

// 修正では空欄を '' で送る（サーバーは null を「変更なし」と読むため）
const forPatch = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? '']));

export function PrepTaskPanel({workId, workTitle = '', request: requestProp, refreshKey}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const today = jstToday();

  const loadNo = useRef(0);
  const load = useCallback(async () => {
    const n = ++loadNo.current;
    setError(null);
    try {
      const result = await request(`/field?workId=${workId}`);
      if (n === loadNo.current) setState({tasks: result.tasks || [], days: result.days || [], scenes: result.scenes || []});
    } catch (cause) {
      if (n === loadNo.current) setError(cause);
    }
  }, [request, workId]);

  useEffect(() => { setState(null); }, [workId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const fields = useMemo(() => (state ? taskFields(state) : []), [state]);
  const rows = useMemo(() => {
    if (!state) return [];
    const days = new Map(state.days.map((day) => [day.id, day]));
    const scenes = new Map(state.scenes.map((scene) => [scene.id, scene]));
    return state.tasks.map((task) => ({
      ...task,
      stateText: prepTaskState(task, today).label,
      dayText: task.shooting_day_id ? dayText(days.get(task.shooting_day_id)) : '作品全体',
      sceneText: task.scene_id ? sceneText(scenes.get(task.scene_id)) : '指定なし',
    }));
  }, [state, today]);
  const summary = prepSummary(state?.tasks, today);

  if (error && !state) return <Notice error={error} onRetry={load} />;
  if (!state) return <p className="empty">準備タスクを読み込んでいます。</p>;

  const columns = [
    {key: 'stateText', label: '状態', type: 'text', sticky: true, render: (row) => <span className={`production-state is-${prepTaskState(row, today).tone}`}>{row.stateText}</span>},
    {key: 'title', label: '準備項目', type: 'text', wrap: true},
    {key: 'due_on', label: '期限', type: 'date'},
    {key: 'owner_label', label: '担当（役割名）', type: 'text'},
    {key: 'dayText', label: '撮影日', type: 'text'},
    {key: 'sceneText', label: 'シーン', type: 'text', wrap: true},
    {key: 'note', label: 'メモ', type: 'text', wrap: true, hidden: true},
  ];

  return (
    <div className="stack production-prep">
      <section className="card production-card">
        <header className="section-head">
          <div>
            <h3>準備タスク</h3>
            <p className="production-note">撮影日やシーンに向けた準備を、担当の役割名と期限で管理します。行を押すと修正できます。</p>
          </div>
          <span className="count">{summary.total}件</span>
        </header>
        <p className="production-summary" aria-live="polite">
          未準備 {summary.pending}件 ／ 保留 {summary.blocked}件 ／ 準備済み {summary.ready}件
          {summary.overdue > 0 && <strong className="production-overdue">　期限超過 {summary.overdue}件</strong>}
        </p>
        {error && <Notice error={error} onRetry={load} compact />}
        {notice && <Notice tone="ok" message={notice} compact onDismiss={() => setNotice(null)} />}
        <RecordForm mode="create" openLabel="＋準備タスクを追加" submitLabel="準備タスクを登録" title="準備タスクを追加" fields={fields} resetKey={workId}
          unsavedLabel="準備タスクの入力" successMessage="準備タスクを登録しました"
          onSubmit={(values) => request('/field/tasks', {method: 'POST', body: JSON.stringify({workId, ...values})})}
          onSaved={() => load()} />
        <DataGrid columns={columns} rows={rows} rowKey="id" emptyText="準備タスクはまだありません。「＋準備タスクを追加」から登録します。" showTotals={false}
          ariaLabel="準備タスクの一覧" initialSort={{key: 'due_on', dir: 'asc'}}
          exportSpec={{name: `準備タスク${workTitle ? `_${workTitle}` : ''}`, title: `${workTitle ? `${workTitle} ` : ''}準備タスク`, conditions: [['作品', workTitle || '未確認']]}}
          renderDetail={(row) => (
            <RecordForm key={`${row.id}:${row.version}`} mode="edit" title={`「${row.title}」を修正`} fields={fields}
              initialValues={{title: row.title, status: row.status, dueOn: row.due_on || '', ownerLabel: row.owner_label || '',
                shootingDayId: row.shooting_day_id ? String(row.shooting_day_id) : '', sceneId: row.scene_id ? String(row.scene_id) : '', note: row.note || ''}}
              submitLabel="修正を保存" successMessage="準備タスクを修正しました" unsavedLabel="準備タスクの修正"
              onSubmit={(values) => request(`/field/tasks/${row.id}`, {method: 'PATCH', headers: {'If-Match': String(row.version)}, body: JSON.stringify(forPatch(values))})}
              onSaved={() => { setNotice(`「${row.title}」を修正しました`); load(); }} />
          )} />
      </section>
    </div>
  );
}

// 旧来の呼び出し（main.jsx の Production）との互換。作品の準備タスクだけを出す。
export default function FieldOperations({data, request}) {
  return <PrepTaskPanel workId={data.selectedWorkId} workTitle={data.selectedWork?.title} request={request} />;
}
