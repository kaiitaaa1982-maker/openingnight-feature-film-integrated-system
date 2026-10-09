// 一覧（DataGrid）を上、登録フォーム（RecordForm）を開閉式で下に置く汎用パネル。
// 行を押すと詳細が行の直下に開き、editable のときはその場で修正できる（PATCH /api/:resource/:id、If-Match: version）。
// API は props の request か ShellContext の request を使う（設計キャンバスでは読み取り専用の request が入る）。
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from './DataGrid.jsx';
import {RecordForm} from './RecordForm.jsx';
import {Notice} from './Notice.jsx';
import {inferColumns, rowCellText} from './grid-model.mjs';
import {isApiError} from './api-client.mjs';
import './forms.css';

const LOOKUP_KEYS = {project_id: 'projects', work_id: 'works', allocated_work_id: 'works', product_id: 'products', partner_id: 'partners'};

export function lookupsFrom(bootstrap) {
  if (!bootstrap) return {};
  return Object.fromEntries(Object.entries(LOOKUP_KEYS).filter(([, list]) => Array.isArray(bootstrap[list])).map(([key, list]) => [key, bootstrap[list]]));
}

function Detail({row, columns}) {
  const shown = columns.filter((column) => column.key !== 'id');
  return (
    <dl>
      {shown.map((column) => (
        <div key={column.key}>
          <dt>{column.label}</dt>
          <dd>{rowCellText(column, row) || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ResourceList({
  title, description, resource, request: requestProp, bootstrap, fields = [], editFields, query = '', filter, onChanged,
  readonly = false, readonlyReason, editable = false, columns: columnsProp, hiddenColumns = [], bulkSlot, persistKey,
  emptyText = 'まだ登録がありません', reloadKey, successMessage, exportName, initialSort,
}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = readonly || Boolean(shell.readOnly);
  const [rows, setRows] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const body = await request(`/${resource}${query || ''}`);
      const list = Array.isArray(body?.rows) ? body.rows : [];
      setRows(filter ? list.filter(filter) : list);
      setLoadError(null);
    } catch (error) {
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  // filter は呼び出し側で毎回作られるため依存に入れない（resource・query・reloadKey で読み直す）
  }, [request, resource, query, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setEditing(null); }, [reloadKey]);

  const columns = useMemo(() => {
    if (columnsProp) return columnsProp;
    const keys = rows.length ? rows : fields.map((field) => field.name);
    return inferColumns(keys, {resource, lookups: lookupsFrom(bootstrap), hidden: hiddenColumns});
  }, [columnsProp, rows, fields, resource, bootstrap, hiddenColumns]);

  const defaults = useMemo(() => Object.fromEntries(fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.name, field.defaultValue])), [fields]);

  async function create(values) {
    const result = await request(`/${resource}`, {method: 'POST', body: JSON.stringify({...defaults, ...values})});
    return result;
  }

  async function update(row, values) {
    try {
      return await request(`/${resource}/${row.id}`, {method: 'PATCH', headers: {'If-Match': String(row.version ?? '')}, body: JSON.stringify(values)});
    } catch (error) {
      if (isApiError(error) && error.kind === 'conflict') {
        error.message = '他の人が先に更新しました。再読込して直してください';
      }
      throw error;
    }
  }

  const editSpec = editFields || fields;

  return (
    <section className="card on-resource">
      <header className="on-resource-head">
        <div>
          {title && <h2>{title}</h2>}
          {description && <p>{description}</p>}
        </div>
        {bulkSlot}
      </header>
      {loadError && <Notice error={loadError} onRetry={load} />}
      {notice && <Notice tone="ok" message={notice} compact onDismiss={() => setNotice(null)} />}
      <DataGrid
        columns={columns}
        rows={rows}
        rowKey="id"
        emptyText={loading ? '読み込み中…' : emptyText}
        persistKey={persistKey || (resource ? `on-grid-${resource}` : undefined)}
        exportSpec={{name: exportName || title || resource, title: title || resource}}
        initialSort={initialSort}
        renderDetail={(row) => (
          <div className="on-resource-detail">
            <Detail row={row} columns={columns} />
            {editable && !readOnly && (editing === row.id ? (
              <RecordForm mode="edit" title={`${title || ''}を修正`} fields={editSpec} initialValues={row} resetKey={`${row.id}:${row.version}`}
                onSubmit={(values) => update(row, values)}
                onSaved={() => { setEditing(null); setNotice('修正を保存しました'); load(); onChanged?.(); }}
                onCancel={() => setEditing(null)} />
            ) : (
              <div className="on-form-actions"><button type="button" className="secondary" onClick={() => setEditing(row.id)}>修正</button></div>
            ))}
            {editable && readOnly && <p className="on-resource-lock">{readonlyReason || 'この画面では修正できません'}</p>}
          </div>
        )}
      />
      {!readOnly && fields.length > 0 && (
        <RecordForm fields={fields} title={title ? `${title}の新規登録` : '新規登録'} resetKey={reloadKey}
          successMessage={successMessage}
          onSubmit={create}
          onSaved={() => { load(); onChanged?.(); }} />
      )}
      {readOnly && readonlyReason && !editable && <p className="on-resource-lock">{readonlyReason}</p>}
    </section>
  );
}

export default ResourceList;
