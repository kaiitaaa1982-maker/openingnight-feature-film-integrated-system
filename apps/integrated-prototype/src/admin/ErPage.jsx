// 表の構造（ER）。業務のデータがどの表に入り、表どうしがどうつながっているかを確かめる（読み取り専用）。
// 表は和名で並べ、DB の表名・列名は副表示にする。選んだ表は URL（?table=）に残し、戻る・共有で同じ表を開く。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {Notice} from '../ui/Notice.jsx';
import {DataGrid} from '../ui/DataGrid.jsx';
import {objects} from '../design-model.mjs';
import {
  groupTablesByConcept, searchTables, tablesForRole, tableTitle, tableLabel, tableLinks, linkText, columnRows, conceptsOf,
} from './er-model.mjs';
import './admin.css';

const COLUMN_SPECS = [
  {key: 'label', label: '列の名前', type: 'text', sticky: true, value: (row) => row.label || '和名未登録'},
  {key: 'name', label: 'DBの列名', type: 'code'},
  {key: 'type', label: '値の種類', type: 'text'},
  {key: 'constraint', label: '制約', type: 'text'},
  {key: 'description', label: '意味・説明', type: 'text', wrap: true, value: (row) => row.description || '説明未登録'},
];

const MAPPING_SPECS = [
  {key: 'title', label: '表', type: 'text', sticky: true},
  {key: 'name', label: 'DBの表名', type: 'code'},
  {key: 'canonical', label: '既存の正本での対応', type: 'text', wrap: true},
];

const byJapanese = (a, b) => tableTitle(a.name).localeCompare(tableTitle(b.name), 'ja') || a.name.localeCompare(b.name);

function TableButton({table, selected, onSelect}) {
  const known = Boolean(tableLabel(table.name));
  return (
    <li>
      <button type="button" className={`adm-er-item${selected ? ' is-selected' : ''}`} aria-pressed={selected} onClick={() => onSelect(table.name)}>
        <span className={known ? '' : 'adm-muted'}>{tableTitle(table.name)}</span>
        <small><code>{table.name}</code>・{table.columns.length.toLocaleString('ja-JP')}列</small>
      </button>
    </li>
  );
}

const LINK_PREVIEW = 8;

function LinkList({title, edges, direction, onSelect, emptyText}) {
  const [all, setAll] = useState(false);
  const shown = all ? edges : edges.slice(0, LINK_PREVIEW);
  return (
    <div className="adm-er-links">
      <h4>{title}<span className="adm-count">{edges.length.toLocaleString('ja-JP')}件</span></h4>
      {edges.length === 0 ? <p className="adm-muted">{emptyText}</p> : (
        <ul>
          {shown.map((edge) => {
            const link = linkText(edge, direction);
            return (
              <li key={`${direction}-${edge.key}`}>
                <button type="button" className="secondary adm-er-link" onClick={() => onSelect(link.table)}>
                  <span>{link.title}</span>
                  <small>つなぐ列: <code>{link.pairs}</code></small>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {edges.length > LINK_PREVIEW && (
        <button type="button" className="text adm-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? `先頭の${LINK_PREVIEW}件だけにする` : `すべて表示する（ほか${(edges.length - LINK_PREVIEW).toLocaleString('ja-JP')}件）`}
        </button>
      )}
    </div>
  );
}

export function ErPage({data, request: requestProp}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const role = data?.currentUser?.role || shell.role;
  const allowedObjects = useMemo(() => (role === 'production' ? objects.filter((object) => object.production) : objects), [role]);
  const [state, setState] = useState({loading: true});
  const [nonce, setNonce] = useState(0);
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState('concept');
  const selected = shell.getParam('table', '') || '';

  useEffect(() => {
    let live = true;
    setState({loading: true});
    request('/er')
      .then((body) => { if (live) setState({body, loading: false, loadedAt: new Date()}); })
      .catch((error) => { if (live) setState({error, loading: false}); });
    return () => { live = false; };
  }, [request, role, nonce]);

  const tables = useMemo(() => tablesForRole(state.body?.tables || [], role, allowedObjects), [state.body, role, allowedObjects]);
  const found = useMemo(() => searchTables(tables, query), [tables, query]);
  const groups = useMemo(() => (order === 'concept'
    ? groupTablesByConcept(found, allowedObjects).map((group) => ({...group, tables: [...group.tables].sort(byJapanese)}))
    : [{id: 'all', label: '名前順', tables: [...found].sort(byJapanese)}]), [found, order, allowedObjects]);
  const table = tables.find((item) => item.name === selected) || null;
  const links = useMemo(() => (table ? tableLinks(tables, table.name) : {outgoing: [], incoming: []}), [tables, table]);
  const concepts = table ? conceptsOf(table.name, allowedObjects) : [];
  const select = (name) => shell.setParam('table', name, {replace: false});
  const mapping = Object.entries(state.body?.mapping || {}).map(([name, canonical]) => ({key: name, name, title: tableTitle(name), canonical}));

  return (
    <div className="stack adm-page">
      <section className="card adm-intro">
        <div>
          <h2>表の構造</h2>
          <p className="adm-muted">業務のデータがどの表に入り、表どうしがどの列でつながっているかを確かめます（読み取り専用）。表を選ぶと、列の一覧と、参照している表・参照されている表が出ます。</p>
          {role === 'production' && <p className="adm-muted">制作担当には、制作に関わる業務のまとまりの表だけを表示しています。</p>}
          {role !== 'production' && <p className="adm-muted">役割による表の絞り込みはありません（定義のみ）。</p>}
        </div>
        <div className="adm-intro-actions">
          <button type="button" className="secondary" onClick={() => shell.navigate('設計キャンバス', table ? {from: 'ER', table: table.name, canvas: 'er'} : {from: 'ER', canvas: 'er'})}>設計キャンバスで図にする</button>
          <button type="button" className="text" onClick={() => setNonce((value) => value + 1)} disabled={state.loading}>{state.loading ? '読み込み中…' : '表の構造を読み直す'}</button>
        </div>
      </section>

      {state.loading && <p role="status" aria-busy="true">表の構造を読み込み中…</p>}
      {state.error && <Notice error={state.error} onRetry={() => setNonce((value) => value + 1)} retryLabel="再試行" />}

      {state.body && (
        <div className="adm-er-layout">
          <section className="card adm-er-list" aria-label="表の一覧">
            <div className="adm-er-tools">
              <label className="adm-search">
                <span>表を探す</span>
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例: 売上、請求、works" />
              </label>
              <div className="on-segmented adm-segmented" role="group" aria-label="並べ方">
                <button type="button" className={order === 'concept' ? 'selected' : ''} aria-pressed={order === 'concept'} onClick={() => setOrder('concept')}>業務のまとまりごと</button>
                <button type="button" className={order === 'name' ? 'selected' : ''} aria-pressed={order === 'name'} onClick={() => setOrder('name')}>名前順</button>
              </div>
              <p className="adm-muted" aria-live="polite">{found.length.toLocaleString('ja-JP')}表{query ? `（全${tables.length.toLocaleString('ja-JP')}表から絞込）` : ''}</p>
            </div>
            {found.length === 0 ? <p className="empty">条件に合う表はありません。和名の一部か、DBの表名（英字）で探せます。</p> : (
              <div className="adm-er-groups">
                {groups.map((group) => (
                  <section key={group.id} className="adm-er-group" aria-label={group.label}>
                    {order === 'concept' && <h3>{group.label}<span className="adm-count">{group.tables.length.toLocaleString('ja-JP')}表</span></h3>}
                    <ul>
                      {group.tables.map((item) => <TableButton key={item.name} table={item} selected={item.name === selected} onSelect={select} />)}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </section>

          <section className="card adm-er-detail" aria-label="選んだ表">
            {!selected && <p className="empty">一覧から表を選ぶと、列と参照の向きがここに出ます。</p>}
            {selected && !table && (
              <Notice tone="warn" message={`選んだ表（${selected}）は、いまの表の構造に見つかりません。名前が変わったか、この役割では表示しない表です。`}
                actions={<button type="button" className="secondary" onClick={() => shell.setParam('table', null)}>選択を外す</button>} />
            )}
            {table && (
              <>
                <header className="adm-er-head">
                  <div>
                    <h2>{tableTitle(table.name)}</h2>
                    <p className="adm-meta"><span>DBの表名 <code>{table.name}</code></span><span>{table.columns.length.toLocaleString('ja-JP')}列</span><span>参照 {links.outgoing.length}件・被参照 {links.incoming.length}件</span></p>
                  </div>
                  <button type="button" className="text" onClick={() => shell.setParam('table', null)}>閉じる</button>
                </header>
                <p className="adm-muted">{concepts.length
                  ? <>業務のまとまり: {concepts.map((concept) => concept.label).join('、')}</>
                  : '業務のまとまりには入っていない表です（ログイン・記録など仕組みのための表）。'}</p>
                <div className="adm-er-link-grid">
                  <LinkList key={`out-${table.name}`} title="この表が参照する表" edges={links.outgoing} direction="outgoing" onSelect={select} emptyText="他の表を参照していません。" />
                  <LinkList key={`in-${table.name}`} title="この表を参照する表" edges={links.incoming} direction="incoming" onSelect={select} emptyText="この表を参照している表はありません。" />
                </div>
                <h3 className="adm-subhead">列</h3>
                <DataGrid columns={COLUMN_SPECS} rows={columnRows(table)} rowKey="key" persistKey="admin-er-columns" maxHeight="50vh"
                  emptyText="列がありません" ariaLabel={`${tableTitle(table.name)}の列`} showTotals={false} />
              </>
            )}
          </section>
        </div>
      )}

      {state.body && (
        <details className="card adm-tech">
          <summary>開発者向けの情報（主な流れ・既存の正本との対応）</summary>
          <h3 className="adm-subhead">主な流れ</h3>
          <ul className="adm-flow">{(state.body.entities || []).map((text) => <li key={text}>{text}</li>)}</ul>
          <h3 className="adm-subhead">既存の正本との対応</h3>
          <DataGrid columns={MAPPING_SPECS} rows={mapping} rowKey="key" persistKey="admin-er-mapping" maxHeight="40vh" showTotals={false} emptyText="対応の記録はありません" />
        </details>
      )}
    </div>
  );
}

export default ErPage;
