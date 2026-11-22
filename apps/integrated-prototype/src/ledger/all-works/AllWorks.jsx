// 全案件。作品を選ばずに、見てよい全作品の行（日々スケ・経費・台本）を1つの表で見る。作品と種類の札で絞り、行を押すとその作品の画面へ移る。
import React, {useEffect, useRef, useState} from 'react';
import {useShell} from '../../shell/context.mjs';
import {Notice} from '../../ui/Notice.jsx';
import './all-works.css';

const ALL = 'all';
const ymd = (value) => String(value || '').replaceAll('-', '/');
const yen = (value) => (value == null ? '—' : Number(value).toLocaleString('ja-JP'));

function query({work, kind, offset}) {
  const params = new URLSearchParams();
  if (work !== ALL) params.set('work_id', String(work));
  if (kind !== ALL) params.set('kind', kind);
  if (offset) params.set('offset', String(offset));
  const text = params.toString();
  return `/works/activity${text ? `?${text}` : ''}`;
}

function Chips({label, value, options, onChange}) {
  return (
    <div className="aw-chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" className="aw-chip" aria-pressed={value === option.id} onClick={() => onChange(option.id)}>{option.label}</button>
      ))}
    </div>
  );
}

export function AllWorks() {
  const shell = useShell();
  const [filter, setFilter] = useState({work: ALL, kind: ALL});
  const [state, setState] = useState({loading: true, rows: []});
  const loadNo = useRef(0);

  const load = (offset = 0) => {
    const n = ++loadNo.current;
    setState((previous) => ({...previous, loading: true, error: null, ...(offset ? {} : {rows: []})}));
    shell.request(query({...filter, offset}))
      .then((body) => {
        if (n !== loadNo.current) return;
        setState((previous) => ({loading: false, body, rows: offset ? [...previous.rows, ...body.rows] : body.rows}));
      })
      .catch((error) => { if (n === loadNo.current) setState((previous) => ({...previous, loading: false, error})); });
  };
  useEffect(() => load(0), [filter.work, filter.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = state.body;
  const works = [{id: ALL, label: '全部'}, ...(body?.works || []).map((work) => ({id: work.id, label: work.title}))];
  const kinds = [{id: ALL, label: '全部'}, ...(body?.kinds || [])];
  const open = (row) => shell.navigate(row.open.page, row.open.params, {workId: row.open.workId});

  return (
    <div className="aw">
      <div className="aw-bar">
        <Chips label="作品" value={filter.work} options={works} onChange={(work) => setFilter((f) => ({...f, work}))} />
        {body?.attention > 0 && <span className="aw-alert">! 要確認 {body.attention}</span>}
      </div>
      <div className="aw-bar">
        <Chips label="種類" value={filter.kind} options={kinds} onChange={(kind) => setFilter((f) => ({...f, kind}))} />
      </div>
      {state.error && <Notice error={state.error} onRetry={() => load(0)} />}
      <div className="aw-scroll">
        <table className="aw-table" aria-label="全案件" aria-busy={state.loading}>
          <thead>
            <tr><th>日付</th><th>作品</th><th>種類</th><th>中身</th><th>状態</th><th className="aw-num">金額</th></tr>
          </thead>
          <tbody>
            {state.rows.map((row) => (
              <tr key={row.key} className={row.attention ? 'is-attention' : undefined} onClick={() => open(row)}>
                <td className="aw-date">{ymd(row.date)}</td>
                <td>{row.work.title}</td>
                <td>{row.kindLabel}</td>
                <td><button type="button" className="aw-open" onClick={(event) => { event.stopPropagation(); open(row); }}>{row.summary || '—'}</button></td>
                <td><span className={`aw-tag${row.attention ? ' is-attention' : ''}`}>{row.status}</span></td>
                <td className="aw-num">{yen(row.amount)}</td>
              </tr>
            ))}
            {!state.loading && body && !state.rows.length && <tr><td colSpan={6} className="aw-empty">なし</td></tr>}
          </tbody>
        </table>
      </div>
      {state.loading && <p className="aw-faint" aria-busy="true">読み込み中…</p>}
      {!state.loading && body?.nextOffset != null && <button type="button" className="aw-more" onClick={() => load(body.nextOffset)}>さらに</button>}
    </div>
  );
}

export default AllWorks;
