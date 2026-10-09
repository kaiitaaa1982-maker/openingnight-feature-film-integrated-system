// 定義は全役割、行の中身は管理者のみ。行は明示的に開くまで取得しない。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {columnSpecFor, columnLabel} from '../ui/labels.mjs';
import {objects} from '../design-model.mjs';
import '../reports/reports.css';

const meaningOf = (name) => objects.filter((o) => o.tables.includes(name)).map((o) => o.meaning).join('・') || '説明未登録';
const TABLE_COLUMNS = [
  {key: 'label', label: '表の和名', type: 'text', value: (row) => row.label || '和名未登録'},
  {key: 'name', label: '表の名前', type: 'code', sticky: true},
  {key: 'meaning', label: '意味・説明', type: 'text', wrap: true, value: (row) => meaningOf(row.name)},
  {key: 'columns', label: '列数', type: 'int', total: 'none'},
  {key: 'scope', label: '行の範囲', type: 'text', value: (row) => row.orgScoped ? '自組織の行' : '全体の参照データ'},
];
const DEFINITION_COLUMNS = [
  {key: 'label', label: '列の和名', type: 'text', value: (row) => row.label || '和名未登録'},
  {key: 'name', label: '列の名前', type: 'code'},
  {key: 'type', label: '型', type: 'text'},
  {key: 'required', label: '必須・主キー', type: 'text', value: (row) => [row.notnull ? '必須（NOT NULL）' : 'NOT NULL制約なし', row.pk ? `主キー（順番${row.pk}）` : ''].filter(Boolean).join('・')},
  {key: 'dflt_value', label: '既定値', type: 'text', value: (row) => row.dflt_value === null ? '指定なし' : row.dflt_value},
  {key: 'foreignKeys', label: '外部キー', type: 'text', wrap: true},
  {key: 'description', label: '意味・説明', type: 'text', wrap: true, value: (row) => row.description || '説明未登録'},
];

export function DataBrowser() {
  const shell = useShell();
  const {request, role} = shell;
  const selected = shell.getParam('table', '');
  const [tab, setTab] = useState('definition');
  const [tables, setTables] = useState({loading: true});
  const [detail, setDetail] = useState(null);
  const [listRetry, setListRetry] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);
  const canReadRows = role === 'admin';
  const canLoadDetail = Boolean(selected) && (tab === 'definition' || Boolean(canReadRows));
  useEffect(() => {
    let live = true;
    setTables({loading: true});
    request('/admin/tables').then((body) => live && setTables({body})).catch((error) => live && setTables({error}));
    return () => {live = false;};
  }, [request, role, listRetry]);
  useEffect(() => {
    let live = true;
    if (!canLoadDetail) {setDetail(null); return undefined;}
    setDetail({loading: true});
    const suffix = tab === 'definition' ? '/definition' : '';
    request(`/admin/tables/${encodeURIComponent(selected)}${suffix}`)
      .then((body) => live && setDetail({body, selected, tab}))
      .catch((error) => live && setDetail({error}));
    return () => {live = false;};
  }, [selected, tab, canLoadDetail, request, role, detailRetry]);
  const body = detail?.selected === selected && detail?.tab === tab ? detail.body : null;
  const rowColumns = useMemo(() => (tab === 'rows' ? body?.columns || [] : []).map((key) => {
    const spec = columnSpecFor(key);
    return {...spec, label: columnLabel(key) ? `${columnLabel(key)}（${key}）` : key, hidden: false, type: spec.type === 'status' ? 'text' : spec.type};
  }), [body, tab]);
  const definitionRows = tab === 'definition' ? (body?.columns || []).map((c) => ({...c,
    foreignKeys: (body.foreignKeys || []).filter((fk) => fk.from === c.name).map((fk) => `${fk.table}.${fk.to || '主キー'}（関係${fk.id}・順番${fk.seq}）`).join('、') || 'なし',
  })) : [];
  return <div className="stack">
    <section className="card rp-report">
      <h2>データ一覧</h2>
      <p className="rp-muted">表を選ぶと、表・列・型・必須・既定値・関係・意味を確認できます。行の中身は管理者だけが見られます。件数は行を開いたときに数えます。</p>
      <p className="rp-muted">{role === 'production' ? '制作担当には制作に関わる表の定義だけを表示しています。' : '役割による表の絞り込みはありません。'}内部の表と秘密に見える列は表示しません。</p>
      {tables.loading && <p role="status" aria-busy="true">表の一覧を読み込み中…</p>}
      {tables.error && <Notice error={tables.error} onRetry={() => setListRetry((n) => n + 1)} />}
      {tables.body?.tables.length === 0 && <p role="status">表示できる表は0件です。</p>}
      {tables.body?.tables.length > 0 && <DataGrid columns={TABLE_COLUMNS} rows={tables.body.tables} rowKey="name" persistKey="admin-table-definitions" maxHeight="40vh"
        onRowClick={(row) => {setTab('definition'); shell.setParam('table', row.name, {replace: false});}} />}
    </section>
    {selected && <section className="card rp-report" aria-label={`表 ${selected}`}>
      <header className="rp-head"><div><h2>{body?.label || selected}</h2><p>{selected}：{meaningOf(selected)}</p></div>
        <button type="button" className="text" onClick={() => shell.setParam('table', null)}>閉じる</button></header>
      <div role="group" aria-label="表示する内容" className="on-segmented">
        <button type="button" className={tab === 'definition' ? 'selected' : ''} aria-pressed={tab === 'definition'} onClick={() => setTab('definition')}>表の定義</button>
        <button type="button" className={tab === 'rows' ? 'selected' : ''} aria-pressed={tab === 'rows'} onClick={() => setTab('rows')}>行の中身</button>
      </div>
      {tab === 'rows' && !canReadRows ? <p role="status">行の中身は、この組織の管理者だけが見られます。「表の定義」で列や関係を確認できます。</p> : <>
        {detail?.loading && <p role="status" aria-busy="true">{tab === 'definition' ? '表の定義' : '行の中身と件数'}を読み込み中…</p>}
        {detail?.error && <Notice error={detail.error} onRetry={() => setDetailRetry((n) => n + 1)} />}
        {body && tab === 'definition' && <>
          {body.meanings.map((m) => <p key={m.label}>{m.label}：{m.description}</p>)}
          {body.hiddenColumnCount > 0 && <p>秘密に見える列と大きな列は、定義の表示から省略しています。</p>}
          {definitionRows.length === 0 ? <p role="status">表示できる列は0件です。</p> : <DataGrid columns={DEFINITION_COLUMNS} rows={definitionRows} rowKey="name" />}
        </>}
        {body && tab === 'rows' && <>
          <p>{body.total.toLocaleString('ja-JP')}行（最大{body.limit}行を表示）。秘密に見える列は表示しません。大きな列の中身は読み込まず省略します。</p>
          {body.rows.length === 0 ? <p role="status">この表の閲覧範囲には行がありません（0件）。</p> : <DataGrid columns={rowColumns} rows={body.rows} rowKey={body.columns.includes('id') ? 'id' : undefined} persistKey={`admin-table-${selected}`}
            exportSpec={{name: selected, title: `データ一覧 ${selected}`, conditions: [['表', selected]], dataAsOf: new Date().toISOString()}} />}
        </>}
      </>}
    </section>}
  </div>;
}
export default DataBrowser;
