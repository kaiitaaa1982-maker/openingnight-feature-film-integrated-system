// 設計キャンバス。業務のまとまりを選び、「業務のつながり」「データの構造」「画面の確認」を切り替えて確かめる。
// - サイドバーは消さない（外枠のまま）。?from= に元の画面があれば「戻る」を出す。
// - 画面の確認は確認専用: 書き込みの呼び出しは送らず（readOnlyRequest）、URL も画面移動も変えない（LocalShellProvider）。
// - キャンバス自身の選択は画面内の状態で持ち、URL は開いたときの ?table= ?canvas=（concept/er/screen）を読むだけ（mode は旧帳票センターの予約語なので使わない）。
import React, {useEffect, useMemo, useState} from 'react';
import {objects, relations, screenSources, screenFiles, selectObject, selectTable, selectScreen, foreignKeys, validateModel, impactForObject, canvasTableScope} from './design-model.mjs';
import {readOnlyRequest, readOnlyPreview, canvasBackTarget} from './design-preview.mjs';
import {LocalShellProvider, useShell} from './shell/context.mjs';
import {displayLabel} from './shell/nav-model.mjs';
import {Tabs} from './ui/Tabs.jsx';
import {Notice} from './ui/Notice.jsx';
import {ErrorBoundary} from './ui/ErrorBoundary.jsx';
import {dateTimeJst} from './ui/format.mjs';
import {tableTitle, tableLabel, columnRows, columnDisplayName, linkText} from './admin/er-model.mjs';
import './design-canvas.css';

const MODES = [
  {id: 'concept', label: '業務のつながり'},
  {id: 'er', label: 'データの構造'},
  {id: 'screen', label: '画面の確認'},
];
const SCOPES = [
  {value: 'core', label: '選んだまとまりの表'},
  {value: 'related', label: '選んだ表と直接つながる表'},
  {value: 'all', label: 'すべての表'},
];

function initialState(allowed, table) {
  if (!allowed.length) return {};
  const base = selectObject({}, allowed[0].id, allowed);
  if (!table) return base;
  const next = selectTable(base, table, allowed);
  return {...next, notice: ''};
}

export default function DesignCanvas({request: requestProp, renderScreen, currentUser, onNavigate, screenKeys = Object.keys(screenSources)}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const navigate = onNavigate || shell.navigate;
  const role = currentUser?.role || shell.role;
  const allowed = useMemo(() => (role === 'production' ? objects.filter((object) => object.production) : objects), [role]);
  const [state, setState] = useState(() => initialState(allowed, shell.getParam('table', '')));
  const [mode, setMode] = useState(() => {
    const requested = shell.getParam('canvas', '');
    return MODES.some((item) => item.id === requested) ? requested : 'concept';
  });
  const [schema, setSchema] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState('core');
  const safeRequest = useMemo(() => readOnlyRequest(request), [request]);
  const back = canvasBackTarget(shell.getParam('from', ''), {isKnownPage: (page) => screenKeys.includes(page)});

  const refresh = () => setNonce((n) => n + 1);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setSchema(null);
    setLoadedAt(null);
    setError(null);
    request('/er').then((data) => {if (live) {setSchema(data); setLoadedAt(new Date()); setLoading(false);}})
      .catch((reason) => {if (live) {setError(reason); setLoading(false);}});
    return () => {live = false;};
  }, [request, role, nonce]);

  const tables = schema?.tables || [];
  const object = allowed.find((item) => item.id === state.objectId);
  const table = tables.find((item) => item.name === state.table);
  const edges = foreignKeys(tables);
  const impact = impactForObject(state.objectId, allowed);
  const visibleTables = role === 'production' ? tables.filter((item) => allowed.some((o) => o.tables.includes(item.name))) : tables;
  const visibleNames = new Set(visibleTables.map((item) => item.name));
  const shownTables = canvasTableScope(visibleTables, edges, state.table, impact.tables, scope);
  const shownNames = new Set(shownTables.map((item) => item.name));
  const shownEdges = edges.filter((edge) => shownNames.has(edge.from) && shownNames.has(edge.to));
  const near = edges.filter((edge) => (edge.from === state.table || edge.to === state.table) && visibleNames.has(edge.from) && visibleNames.has(edge.to));
  const screens = [...new Set(allowed.flatMap((item) => item.screens))];
  const issues = schema ? validateModel(allowed, tables, screenKeys) : [];
  const query = filter.trim().toLowerCase();
  const tableOptions = visibleTables.filter((item) => item.name === state.table || !query || item.name.toLowerCase().includes(query) || tableTitle(item.name).toLowerCase().includes(query));

  const choose = (id) => setState((previous) => selectObject(previous, id, allowed));
  const chooseTable = (name) => setState((previous) => selectTable(previous, name, allowed));
  const chooseScreen = (page) => setState((previous) => selectScreen(previous, page, allowed));
  const previewScreen = (page) => { chooseScreen(page); setMode('screen'); };

  const original = mode === 'screen' && state.page ? renderScreen?.(state.page) : null;
  const preview = original ? readOnlyPreview(original, {request: safeRequest}) : null;

  return (
    <div className="dc">
      <header className="dc-header">
        <div>
          <h2>設計を確かめる</h2>
          <p>業務のまとまりを選び、つながり・データの構造・画面を切り替えて確かめます。ここでの操作でDBや画面は変わりません。</p>
        </div>
        {back && <button type="button" className="secondary" onClick={() => navigate?.(back)}>「{displayLabel(back)}」へ戻る</button>}
      </header>

      <div className="dc-controls">
        <label>業務のまとまり
          <select value={state.objectId || ''} onChange={(event) => choose(event.target.value)}>
            <option value="" disabled>業務のまとまりに入っていない表</option>
            {allowed.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label>画面から探す
          <select value={state.page || ''} onChange={(event) => previewScreen(event.target.value)}>
            <option value="" disabled>対応する画面なし</option>
            {screens.map((page) => <option key={page} value={page}>{displayLabel(page)}</option>)}
          </select>
        </label>
        <button type="button" className="secondary" disabled={loading} onClick={refresh}>表の構造を読み直す</button>
      </div>

      <Tabs tabs={MODES} value={mode} onChange={setMode} label="表示の切り替え" className="dc-tabs" />

      <div className="dc-selection">
        <strong>{object?.label || tableTitle(state.table)}</strong>
        <span>{object?.meaning || 'この表は、業務のまとまり・画面との対応がまだ決まっていません。'}</span>
      </div>
      {state.notice && <Notice tone="info" message={state.notice} compact onDismiss={() => setState((previous) => ({...previous, notice: ''}))} />}
      <p className="dc-muted">{role === 'production' ? '制作担当には制作に関わる業務・表だけを表示しています。' : '役割による業務・表の絞り込みはありません。'}</p>
      {loading && <p role="status" aria-busy="true">表の構造を読み込み中… 業務のつながりは確認できます。</p>}
      {error && <Notice error={error} onRetry={refresh} retryLabel="再試行" />}
      {schema && visibleTables.length === 0 && <p role="status">表示できる表は0件です。</p>}
      {schema && tableOptions.length === 0 && visibleTables.length > 0 && <p role="status">検索条件に合う表は0件です。検索条件を変えてください。</p>}
      {issues.length > 0 && (
        <Notice tone="warn" title="業務のまとまりの対応表と、実際の表・画面が食い違っています"
          message={`${issues.length}件。設計の対応表を直す必要があります（詳しくは技術情報）。`} technical={['対応表: src/design-model.mjs', ...issues].join('\n')} />
      )}

      <div className="dc-board">
        {mode === 'concept' && (
          <section className="dc-pane dc-concept">
            <div className="dc-pane-head"><h3>業務のつながり</h3></div>
            <Concept object={object} allowed={allowed} choose={choose} />
            <div className="dc-related">
              <h4>この業務で使う画面</h4>
              {impact.screens.length === 0 ? <p className="dc-muted">対応する画面はありません。</p> : (
                <div className="dc-chips">
                  {impact.screens.map((page) => <button key={page} type="button" onClick={() => previewScreen(page)}>「{displayLabel(page)}」を確かめる</button>)}
                </div>
              )}
            </div>
          </section>
        )}

        {mode === 'er' && (
          <section className="dc-pane dc-er">
            <div className="dc-pane-head">
              <h3>データの構造</h3>
              <small>{loading ? '読み込み中' : error ? '取得失敗（上の理由を確認して再試行してください）' : `読み込み ${dateTimeJst(loadedAt)}・${visibleTables.length.toLocaleString('ja-JP')}表`}</small>
            </div>
            <div className="dc-er-tools">
              <label>表示する表
                <select value={scope} onChange={(event) => setScope(event.target.value)}>
                  {SCOPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <label>表を探す
                <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="和名か英字の表名" />
              </label>
              <label>選んだ表
                <select value={state.table || ''} onChange={(event) => chooseTable(event.target.value)}>
                  {tableOptions.map((item) => <option key={item.name} value={item.name}>{tableTitle(item.name)}（{item.name}）</option>)}
                </select>
              </label>
              <label className="dc-zoom">図の倍率
                <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
                  {[60, 80, 100, 125, 150].map((value) => <option key={value} value={value}>{value}%</option>)}
                </select>
              </label>
            </div>
            <p className="dc-muted">{shownTables.length.toLocaleString('ja-JP')}表を表示しています。すべての表は多いので、「表を探す」と「選んだ表」で絞り込めます。矢印は参照する側から参照される側へ向きます。◆は主キー（行を見分ける列）です。</p>
            <div className="dc-graph-scroll dc-er-scroll">
              <div style={{zoom: zoom / 100}}>
                {!error && <ErDiagram tables={shownTables} focus={state.table} edges={shownEdges} choose={chooseTable} loaded={Boolean(schema)} />}
              </div>
            </div>
            {table && (
              <>
                <h4>「{tableTitle(table.name)}」の列</h4>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th scope="col">列の名前</th><th scope="col">DBの列名</th><th scope="col">値の種類</th><th scope="col">制約</th><th scope="col">意味・説明</th></tr></thead>
                    <tbody>
                      {columnRows(table).map((column) => (
                        <tr key={column.key}>
                          <td>{column.label || <span className="dc-muted">和名未登録</span>}</td>
                          <td><code>{column.name}</code></td>
                          <td>{column.type}</td>
                          <td>{column.constraint}</td>
                          <td>{column.description || <span className="dc-muted">説明未登録</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h4>選んだ表のつながり</h4>
                {near.length === 0 ? <p className="dc-muted">この表とつながる表はありません。</p> : (
                  <div className="dc-fk-list">
                    {near.map((edge) => {
                      const outgoing = edge.from === state.table;
                      const link = linkText(edge, outgoing ? 'outgoing' : 'incoming');
                      return (
                        <button type="button" className="dc-fk" key={edge.key} onClick={() => chooseTable(link.table)}>
                          <span>{outgoing ? 'この表が参照: ' : 'この表を参照: '}<strong>{link.title}</strong></span>
                          <small>つなぐ列 {link.pairs}</small>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {mode === 'screen' && (
          <section className="dc-pane dc-screen">
            <div className="dc-pane-head">
              <h3>{state.page ? displayLabel(state.page) : '対応する画面なし'}</h3>
              {state.page && <button type="button" onClick={() => navigate?.(state.page)}>この画面を開いて作業する</button>}
            </div>
            <p className="dc-muted">確認専用のプレビューです。登録・修正・画面の移動はできず、URLも変わりません。作業するときは「この画面を開いて作業する」を押します。</p>
            {state.page && screenFiles[state.page] && (
              <details className="dc-files">
                <summary>この画面のコード（{screenFiles[state.page].length}ファイル）</summary>
                <ul>{screenFiles[state.page].map((file) => <li key={file}><code>{file}</code></li>)}</ul>
              </details>
            )}
            <div className="dc-preview" inert={true}>
              <fieldset disabled>
                <ErrorBoundary name={`プレビュー: ${state.page ? displayLabel(state.page) : ''}`} resetKeys={[state.page]}>
                  <LocalShellProvider request={safeRequest} readOnly>
                    {preview || <p className="dc-muted">業務のまとまり・画面との対応がありません。</p>}
                  </LocalShellProvider>
                </ErrorBoundary>
              </fieldset>
            </div>
          </section>
        )}
      </div>
      <footer className="dc-footer">この図は、画面のコード・DBの表・業務のまとまりの対応表から毎回作ります。図を操作してもDBや画面は変わりません。</footer>
    </div>
  );
}

function Concept({object, allowed, choose}) {
  if (!object) return <p className="dc-muted">業務のまとまりを選んでください。</p>;
  const links = relations.filter((relation) => (relation.from === object.id || relation.to === object.id) && allowed.some((item) => item.id === relation.from) && allowed.some((item) => item.id === relation.to));
  return (
    <div className="dc-concept-map">
      <button type="button" className="dc-object selected" onClick={() => choose(object.id)}><small>選んでいるまとまり</small><strong>{object.label}</strong></button>
      {links.length === 0 && <p className="dc-muted">つながっているまとまりはありません。</p>}
      {links.map((relation, index) => {
        const id = relation.from === object.id ? relation.to : relation.from;
        const other = allowed.find((item) => item.id === id);
        const outgoing = relation.from === object.id;
        return (
          <div className="dc-concept-link" key={index}>
            <span>{outgoing ? `↓ ${relation.label}（このまとまりから）` : `↑ ${relation.label}（このまとまりへ）`}</span>
            <button type="button" className="dc-object" onClick={() => choose(id)}><strong>{other.label}</strong><small>押すとこのまとまりに切り替えます</small></button>
          </div>
        );
      })}
    </div>
  );
}

function ErDiagram({tables, focus, edges, choose, loaded}) {
  if (!loaded) return <p className="dc-muted">表の構造を読み込んでいます…</p>;
  if (!tables.length) return <p className="dc-muted">表示する表がありません。「表示する表」を切り替えてください。</p>;
  const sorted = [...tables].sort((a, b) => (a.name === focus ? -1 : b.name === focus ? 1 : tableTitle(a.name).localeCompare(tableTitle(b.name), 'ja')));
  const width = 600;
  const height = Math.max(190, Math.ceil(sorted.length / 2) * 185);
  const position = new Map(sorted.map((item, index) => [item.name, {x: 10 + (index % 2) * 300, y: 12 + Math.floor(index / 2) * 185}]));
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="dc-er-svg" role="group" aria-label="選んだ表と参照の関係">
      <defs><marker id="dc-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0L7,3L0,6" fill="currentColor" /></marker></defs>
      {edges.filter((edge) => position.has(edge.from) && position.has(edge.to)).map((edge) => {
        const a = position.get(edge.from);
        const b = position.get(edge.to);
        return (
          <path key={edge.key} d={`M${a.x + 140},${a.y + 147} C${a.x + 140},${a.y + 175} ${b.x + 140},${b.y - 15} ${b.x + 140},${b.y}`} fill="none" stroke="currentColor" markerEnd="url(#dc-arrow)">
            <title>{`${tableTitle(edge.from)} → ${tableTitle(edge.to)}`}</title>
          </path>
        );
      })}
      {sorted.map((item) => {
        const p = position.get(item.name);
        const title = tableTitle(item.name);
        const choosePress = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(item.name); } };
        return (
          <g key={item.name} transform={`translate(${p.x},${p.y})`} role="button" tabIndex="0" aria-label={`表 ${title}（${item.name}）`} onClick={() => choose(item.name)} onKeyDown={choosePress}>
            <rect width="278" height="148" rx="10" className={item.name === focus ? 'selected' : ''} />
            <text x="12" y="23" className="dc-table-title">{clip(title, 18)}<title>{title}</title></text>
            <text x="12" y="40" className="dc-table-code">{clip(item.name, 36)}</text>
            {item.columns.slice(0, 4).map((column, index) => (
              <text key={column.name} x="12" y={62 + index * 18}>{column.pk ? '◆ ' : ''}{clip(columnDisplayName(column.name) || column.name, 22)}</text>
            ))}
            <text x="12" y="138" className="dc-table-code">{item.columns.length}列・{tableLabel(item.name) ? '押すと詳細' : '和名未登録・押すと詳細'}</text>
          </g>
        );
      })}
    </svg>
  );
}
