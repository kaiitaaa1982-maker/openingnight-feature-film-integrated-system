// 売上集計シート（83列）。売上基幹 › 計上 › 帳票（帳票センター）の入口と、売上明細の列セットの切り替えで使う。
// 1行＝売上明細1件（明細）か、切り口ごとの集計（集計）。絞り込みとページ送り・合計・空の列の判定はサーバー側（全行）で行う。
// 列セット7つ（基本／劇場／ビデオグラム／配信／MG・FLAT／税・請求・入金／監査・原本）と全列。形（列・粒度・切り口・月の基準・税）は保存できる。
// 行を押すと、その売上の全列の値・拡張属性の入力・外貨・ロイヤリティ計上の基準・履歴が開く（理由必須・版で積む）。
// 使い方: 売上基幹 › 計上 › 売上集計シート（単独の画面）・帳票センター <SalesSheet data request onSwitchOrg /> ／ 売上明細 <SalesSheet embedded setKey="theatre" conditions={{from,to,workId,partnerId,q,distribution,billing,productId,deal}} />
// 列の並び・固定・問い合わせ・「データのある最新の年度」の決まりは sheet-view-model.mjs。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {useConditions, ConditionBar} from '../ui/ConditionBar.jsx';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {int, dateTimeJst, yen, decimal} from '../ui/format.mjs';
import {cellText} from '../ui/grid-model.mjs';
import {useFiscal} from '../reports/use-fiscal.mjs';
import {useOrgFeatures} from '../DemoGuide.jsx';
import {sheetQuery, sheetLayout, latestYearOffer, PAGE_SIZES, pageSizeOf} from './sheet-view-model.mjs';
import '../reports/reports.css';
import '../sales-ops/sales-ops.css';
import './sales-sheet.css';

const P = 'ss'; // URL の条件の接頭辞
const CONDITIONS = ['fiscalYear', 'period', 'work', 'partner'];
const KIND_OPTIONS = [['theatrical', '劇場'], ['package', 'ビデオグラム'], ['digital', '配信'], ['broadcast', '放送'], ['other', 'その他']].map(([value, label]) => ({value, label}));
const SET_ORDER = ['basic', 'theatre', 'videogram', 'digital', 'mgflat', 'tax', 'audit', 'all', 'additional', 'all_plus'];

export {sheetQuery};

function useSheetParams(shell, fixed = {}) {
  const read = (key) => (Object.hasOwn(fixed, key) ? fixed[key] : shell.getParam(`${P}${key}`, '') || '');
  const params = {set: read('set') || 'basic', cols: read('cols'), view: read('view'), grain: read('grain') || 'detail', dims: read('dims'), month: read('month') || 'accounting',
    tax: read('tax') || 'ex', pivot: read('pivot'), empty: read('empty'), kind: read('kind'), dist: read('dist'), q: read('q'), page: read('page'), psize: read('psize')};
  const set = (key, value) => {
    if (Object.hasOwn(fixed, key)) return;
    shell.setParam(`${P}${key}`, value || null, {replace: true});
    if (key !== 'page') shell.setParam(`${P}page`, null, {replace: true});
  };
  return [params, set];
}

// 値の表示（空欄は空のまま。率は%、はい/いいえ。集計の「3種類」「2025-01〜2025-06」は文字のまま）
function shown(column, value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  const type = column.valueType;
  if (['yen', 'integer', 'decimal', 'rate_pct'].includes(type)) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || (typeof value === 'string' && !value.trim())) return String(value);
    if (column.type === 'id') return String(value);
    if (type === 'rate_pct') return `${decimal(n, {digits: column.digits ?? 2})}%`;
    if (type === 'decimal') return decimal(n, {digits: column.digits ?? 2});
    return int(n);
  }
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return cellText({type: 'date'}, value);
  if (type === 'month' && /^\d{4}-\d{2}$/.test(value)) return cellText({type: 'month'}, value);
  return String(value);
}
// 表の列。まとまり（2段の見出し）は全列のときだけ付ける（列セットは20列前後で、まとまりが細切れになるため）。
// 並びと固定は sheetLayout: 明細は 計上月・作品コード・作品名（全列は 売上ID・作品コード）を左に固定、集計は 切り口 → 月 → 明細数 → 列
function gridColumns(body, {groups = false, allSet = false} = {}) {
  if (!body) return [];
  const aggregate = body.grain === 'aggregate';
  const monthGroup = body.pivotKey?.startsWith('royalty') ? '月別のロイヤリティ計上額' : '月別の計上額';
  return sheetLayout(body, {allSet}).map((item) => {
    if (item.kind === 'dim') return {key: item.key, label: item.dim.label, type: 'text', group: groups ? '切り口' : undefined, sticky: true};
    if (item.kind === 'month') return {key: item.key, label: item.month, type: 'yen', group: monthGroup, total: 'none'};
    if (item.kind === 'count') return {key: '__count', label: '明細数', type: 'int', group: groups ? '切り口' : undefined};
    const column = item.column;
    const aggregatedText = aggregate && ['min_max', 'distinct'].includes(column.aggregation);
    return {key: column.key, label: column.label, group: groups ? column.groupLabel : undefined, type: aggregatedText ? 'text' : column.type === 'id' ? 'text' : column.type,
      digits: column.digits ?? 2, sticky: item.sticky, exportValue: (row) => row[column.key], total: 'none',
      render: aggregatedText ? (row) => (row[column.key] ?? '') : (row) => shown(column, row[column.key])};
  });
}

// ---- 売上1件の詳細（全列・拡張属性・外貨・ロイヤリティ計上の基準・履歴） ------------------------------------
function attributeText(column, value) {
  if (value === null || value === undefined) return '';
  if (column.valueType === 'bool') return value ? 'はい' : 'いいえ';
  return String(value);
}
function SaleDetail({saleId, request, onSaved}) {
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState({});
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [currency, setCurrency] = useState({currencyCode: 'USD', originalAmount: '', originalRoyaltyAmount: '', exchangeRate: '', rateDate: '', basis: '', reason: ''});
  const [royalty, setRoyalty] = useState({royaltyMonth: '', amountExTax: '', taxAmount: '', reason: ''});
  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true}));
    request(`/sales-sheet/sales/${saleId}`).then((body) => { if (!live) return; setState({body}); setDraft({}); }).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [request, saleId, revision]);
  const body = state.body;
  if (state.error) return <Notice error={state.error} />;
  if (!body) return <p className="rp-muted" aria-busy="true">読み込み中…</p>;
  const columns = body.columns.filter((column) => column.active && column.group !== 'helper');
  const attributes = columns.filter((column) => column.sourceKind === 'attribute');
  const changed = attributes.filter((column) => Object.hasOwn(draft, column.key) && draft[column.key] !== attributeText(column, body.values[column.key]));
  async function saveAttributes() {
    setBusy(true);
    setNotice(null);
    try {
      const out = await request('/sales-sheet/values', {method: 'POST', body: JSON.stringify({reason, changes: changed.map((column) => ({saleId, columnKey: column.key, baseVersion: body.attributeVersions[column.key] || 0, value: draft[column.key]}))})});
      setNotice({tone: 'ok', message: `${out.saved}件の値を登録しました（新しい版を積みました）`});
      setReason('');
      setRevision((n) => n + 1);
      onSaved?.();
    } catch (error) { setNotice({error}); } finally { setBusy(false); }
  }
  async function post(path, payload, reset) {
    setBusy(true);
    setNotice(null);
    try {
      await request(path, {method: 'POST', body: JSON.stringify(payload)});
      setNotice({tone: 'ok', message: '登録しました'});
      reset();
      setRevision((n) => n + 1);
      onSaved?.();
    } catch (error) { setNotice({error}); } finally { setBusy(false); }
  }
  const groups = [];
  for (const column of columns) {
    let group = groups.find((g) => g.label === column.groupLabel);
    if (!group) groups.push(group = {label: column.groupLabel, columns: []});
    group.columns.push(column);
  }
  const s = body.sale;
  return (
    <div className="ss-detail">
      <p className="ss-detail-head">
        <strong>売上ID {s.id}</strong>
        <span>{s.work?.code} {s.work?.title}</span>
        <span>{s.partner?.name}</span>
        <span>{s.product ? `${s.product.sku} ${s.product.name}` : '作品に直接計上'}</span>
        <span>報告 {s.reportKey}</span>
        <span>計上月 {s.accountingMonth}</span>
        <span>税抜 {yen(s.amountExTax)}</span>
        {body.block && <span className="ss-chip">当社売上の列: {body.block}</span>}
      </p>
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      <section className="ss-edit" aria-label="拡張属性の値">
        <h4>拡張属性（この売上の値）</h4>
        <p className="rp-muted">登録済みの表に置き場所の無い列です。直すと新しい版を積みます（前の値は履歴に残ります）。空欄にすると値を消した版になります。</p>
        <div className="ss-edit-grid">
          {attributes.map((column) => {
            const current = attributeText(column, body.values[column.key]);
            const value = Object.hasOwn(draft, column.key) ? draft[column.key] : current;
            const label = `${column.label}${body.attributeVersions[column.key] ? `（第${body.attributeVersions[column.key]}版）` : ''}`;
            return column.valueType === 'bool'
              ? <FormField key={column.key} type="select" label={label} value={value} blankLabel="（空欄）" options={[{value: 'はい', label: 'はい'}, {value: 'いいえ', label: 'いいえ'}]}
                onChange={(next) => setDraft((d) => ({...d, [column.key]: next}))} />
              : <FormField key={column.key} type="text" label={label} value={value} hint={column.valueType === 'rate_pct' ? '%の数（10% は 10）' : column.valueType === 'date' ? '2026-09-25' : undefined}
                onChange={(next) => setDraft((d) => ({...d, [column.key]: next}))} />;
          })}
        </div>
        <div className="ss-edit-actions">
          <FormField type="text" label="直す理由" required value={reason} onChange={setReason} />
          <button type="button" disabled={busy || !changed.length || !reason.trim()} onClick={saveAttributes}>{changed.length ? `${changed.length}件の値を登録` : '値を直すと登録できます'}</button>
        </div>
      </section>
      <div className="ss-two">
        <section className="ss-edit" aria-label="外貨">
          <h4>外貨{body.currencyVersion ? `（第${body.currencyVersion}版）` : ''}</h4>
          <p className="rp-muted">いまの記録: {body.values.currency_code || 'JPY'}{body.values.foreign_amount !== null && body.values.foreign_amount !== undefined ? ` ${decimal(body.values.foreign_amount, {digits: 2})}・レート ${body.values.exchange_rate}` : ''}。外貨×レートは計上額（税抜）と1円まで合わせます。</p>
          <div className="ss-edit-grid">
            <FormField type="text" label="通貨" value={currency.currencyCode} onChange={(v) => setCurrency((x) => ({...x, currencyCode: v}))} hint="USD・EUR・JPY など" />
            <FormField type="text" label="外貨の計上額（税抜）" value={currency.originalAmount} onChange={(v) => setCurrency((x) => ({...x, originalAmount: v}))} />
            <FormField type="text" label="外貨のロイヤリティ計上額" value={currency.originalRoyaltyAmount} onChange={(v) => setCurrency((x) => ({...x, originalRoyaltyAmount: v}))} />
            <FormField type="text" label="為替レート（1外貨あたりの円）" value={currency.exchangeRate} onChange={(v) => setCurrency((x) => ({...x, exchangeRate: v}))} />
            <FormField type="date" label="レートの適用日" value={currency.rateDate} onChange={(v) => setCurrency((x) => ({...x, rateDate: v}))} />
            <FormField type="text" label="レートの根拠" value={currency.basis} onChange={(v) => setCurrency((x) => ({...x, basis: v}))} />
            <FormField type="text" label="理由" required value={currency.reason} onChange={(v) => setCurrency((x) => ({...x, reason: v}))} />
          </div>
          <div className="ss-edit-actions">
            <button type="button" className="secondary" disabled={busy || !currency.reason.trim()} onClick={() => post(`/sales-sheet/sales/${saleId}/currency`, {...currency, baseVersion: body.currencyVersion},
              () => setCurrency((x) => ({...x, reason: ''})))}>外貨の版を登録</button>
          </div>
        </section>
        <section className="ss-edit" aria-label="ロイヤリティ計上の基準">
          <h4>ロイヤリティ計上の基準{body.royaltyVersion ? `（第${body.royaltyVersion}版）` : '（記録なし＝計上月・計上額と同じ）'}</h4>
          <p className="rp-muted">いまの値: {body.values.royalty_month}・税抜 {yen(body.values.royalty_amount_ex_tax)}・税込 {yen(body.values.royalty_amount_inc_tax)}</p>
          <div className="ss-edit-grid">
            <FormField type="month" label="ロイヤリティ計上月" value={royalty.royaltyMonth} onChange={(v) => setRoyalty((x) => ({...x, royaltyMonth: v}))} />
            <FormField type="yen" allowNegative label="ロイヤリティ計上額（税抜）" value={royalty.amountExTax} onChange={(v) => setRoyalty((x) => ({...x, amountExTax: v}))} />
            <FormField type="yen" allowNegative label="消費税額" value={royalty.taxAmount} onChange={(v) => setRoyalty((x) => ({...x, taxAmount: v}))} />
            <FormField type="text" label="理由" required value={royalty.reason} onChange={(v) => setRoyalty((x) => ({...x, reason: v}))} />
          </div>
          <div className="ss-edit-actions">
            <button type="button" className="secondary" disabled={busy || !royalty.reason.trim()} onClick={() => post(`/sales-sheet/sales/${saleId}/royalty-basis`, {...royalty, baseVersion: body.royaltyVersion},
              () => setRoyalty({royaltyMonth: '', amountExTax: '', taxAmount: '', reason: ''}))}>ロイヤリティ計上の基準の版を登録</button>
          </div>
        </section>
      </div>
      <details className="ss-all">
        <summary>この売上の全列の値（{int(columns.length)}列）</summary>
        {groups.map((group) => (
          <dl key={group.label} className="ss-values">
            <dt className="ss-values-group">{group.label}</dt>
            {group.columns.map((column) => (
              <div key={column.key}>
                <dt>{column.legacyPosition ? `${column.legacyPosition}. ` : ''}{column.label}</dt>
                <dd>{shown(column, body.values[column.key]) || '—'}</dd>
              </div>
            ))}
          </dl>
        ))}
      </details>
      {(body.history.attributes.length > 0 || body.history.currency.length > 0 || body.history.royalty.length > 0) && (
        <details className="ss-all">
          <summary>履歴（拡張属性 {int(body.history.attributes.length)}件・外貨 {int(body.history.currency.length)}件・ロイヤリティ {int(body.history.royalty.length)}件）</summary>
          <table className="ss-history" aria-label="値の履歴">
            <thead><tr><th scope="col">列</th><th scope="col">版</th><th scope="col">値</th><th scope="col">入れ方</th><th scope="col">理由</th><th scope="col">登録</th></tr></thead>
            <tbody>
              {body.history.attributes.map((row) => (
                <tr key={`a:${row.column_key}:${row.version_no}`}>
                  <td>{body.columns.find((column) => column.key === row.column_key)?.label || row.column_key}</td><td>{row.version_no}</td>
                  <td>{row.value_text ?? row.value_number ?? '（消した）'}</td><td>{row.origin === 'report_import' ? '取込' : '画面'}</td><td>{row.reason}</td>
                  <td>{row.created_by_name}・{dateTimeJst(row.created_at)}</td>
                </tr>
              ))}
              {body.history.currency.map((row) => (
                <tr key={`c:${row.version_no}`}>
                  <td>外貨</td><td>{row.version_no}</td>
                  <td>{row.currency_code}{row.original_amount_x100 !== null ? ` ${decimal(row.original_amount_x100 / 100, {digits: 2})}・レート ${row.exchange_rate_x10000 / 10000}（${row.rate_date}・${row.basis}）` : ''}</td>
                  <td>画面</td><td>{row.reason}</td><td>{row.created_by_name}・{dateTimeJst(row.created_at)}</td>
                </tr>
              ))}
              {body.history.royalty.map((row) => (
                <tr key={`r:${row.version_no}`}>
                  <td>ロイヤリティ計上の基準</td><td>{row.version_no}</td><td>{row.royalty_month}・税抜 {yen(row.royalty_amount_ex_tax)}・税込 {yen(row.royalty_amount_inc_tax)}</td>
                  <td>画面</td><td>{row.reason}</td><td>{row.created_by_name}・{dateTimeJst(row.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// ---- 列の定義（管理者） ----------------------------------------------------------------------
function CatalogAdmin({catalog, request, onChanged, readOnly, showAdditionalGuide}) {
  const blank = {columnKey: '', label: '', groupKey: 'custom', valueType: 'text', aggregation: 'distinct', numeratorKey: '', denominatorKey: '', reason: ''};
  const [form, setForm] = useState(blank);
  const [edit, setEdit] = useState(null);
  const [notice, setNotice] = useState(null);
  const set = (key) => (value) => setForm((f) => ({...f, [key]: value}));
  const numeric = catalog.columns.filter((column) => ['yen', 'integer', 'decimal', 'rate_pct'].includes(column.valueType));
  async function submit(path, payload, done) {
    setNotice(null);
    try { await request(path, {method: 'POST', body: JSON.stringify(payload)}); setNotice({tone: 'ok', message: '登録しました'}); done(); onChanged?.(); } catch (error) { setNotice({error}); }
  }
  return (
    <details className="ss-admin">
      <summary>列の定義（{int(catalog.columns.length)}列・管理者）</summary>
      {showAdditionalGuide && <AdditionalAdoptionGuide catalog={catalog} setKey="additional" request={request} onChanged={onChanged} readOnly={readOnly} />}
      <p className="rp-muted">列の値の取り方は許可リストのキーか式で持ち、SQL は保存しません。拡張属性の列を足すと、売上ごとに値を入れられ、取込（attr_列キー）でも入れられます。</p>
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      <div className="ss-admin-table">
        <table className="ss-history" aria-label="列の定義">
          <thead><tr><th scope="col">元の列</th><th scope="col">列キー</th><th scope="col">見出し</th><th scope="col">まとまり</th><th scope="col">型</th><th scope="col">集計</th><th scope="col">取り方</th><th scope="col">版</th><th scope="col">状態</th><th scope="col"><span className="dg-vh">操作</span></th></tr></thead>
          <tbody>
            {catalog.columns.map((column) => (
              <tr key={column.key} className={column.active ? undefined : 'ss-inactive'}>
                <td>{column.legacyPosition ?? ''}</td><td><code>{column.key}</code></td><td>{column.label}</td><td>{column.groupLabel}</td><td>{catalog.valueTypes[column.valueType]}</td>
                <td>{catalog.aggregations[column.aggregation]}{column.aggregation === 'ratio' ? `（${column.numeratorKey}÷${column.denominatorKey}${column.ratioScale === 100 ? '×100' : ''}）` : ''}</td>
                <td>{column.sourceKind === 'attribute' ? '拡張属性' : column.sourceRef ? column.sourceRef : '式'}</td><td>{column.version}</td><td>{column.active ? '使う' : 'やめた'}</td>
                <td><button type="button" className="text" onClick={() => setEdit({key: column.key, baseVersion: column.version, label: column.label, active: column.active ? '1' : '0', reason: ''})}>直す</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <div className="ss-edit">
          <h4>列 {edit.key} の新しい版</h4>
          <div className="ss-edit-grid">
            <FormField type="text" label="見出し" value={edit.label} onChange={(v) => setEdit((e) => ({...e, label: v}))} />
            <FormField type="select" label="使う／やめる" value={edit.active} includeBlank={false} options={[{value: '1', label: '使う'}, {value: '0', label: 'やめる'}]} onChange={(v) => setEdit((e) => ({...e, active: v}))} />
            <FormField type="text" label="理由" required value={edit.reason} onChange={(v) => setEdit((e) => ({...e, reason: v}))} />
          </div>
          <div className="ss-edit-actions">
            <button type="button" disabled={!edit.reason.trim()} onClick={() => submit(`/sales-sheet/columns/${edit.key}/versions`, {baseVersion: edit.baseVersion, label: edit.label, active: edit.active === '1', reason: edit.reason}, () => setEdit(null))}>版を登録</button>
            <button type="button" className="secondary" onClick={() => setEdit(null)}>やめる</button>
          </div>
        </div>
      )}
      <div className="ss-edit">
        <h4>拡張属性の列を足す</h4>
        <div className="ss-edit-grid">
          <FormField type="text" label="列キー（英小文字・数字・_）" value={form.columnKey} onChange={set('columnKey')} />
          <FormField type="text" label="見出し" value={form.label} onChange={set('label')} />
          <FormField type="select" label="まとまり" value={form.groupKey} includeBlank={false} options={Object.entries(catalog.groups).filter(([key]) => !['reference', 'helper'].includes(key)).map(([value, label]) => ({value, label}))} onChange={set('groupKey')} />
          <FormField type="select" label="型" value={form.valueType} includeBlank={false} options={Object.entries(catalog.valueTypes).map(([value, label]) => ({value, label}))} onChange={set('valueType')} />
          <FormField type="select" label="集計の決まり" value={form.aggregation} includeBlank={false} options={Object.entries(catalog.aggregations).map(([value, label]) => ({value, label}))} onChange={set('aggregation')} />
          {form.aggregation === 'ratio' && <FormField type="select" label="分子の列" value={form.numeratorKey} options={numeric.map((c) => ({value: c.key, label: c.label}))} onChange={set('numeratorKey')} />}
          {form.aggregation === 'ratio' && <FormField type="select" label="分母の列" value={form.denominatorKey} options={numeric.map((c) => ({value: c.key, label: c.label}))} onChange={set('denominatorKey')} />}
          <FormField type="text" label="理由" required value={form.reason} onChange={set('reason')} />
        </div>
        <div className="ss-edit-actions">
          <button type="button" disabled={!form.columnKey || !form.label || !form.reason.trim()} onClick={() => submit('/sales-sheet/columns', {...form, sourceKind: 'attribute'}, () => setForm(blank))}>列を足す</button>
        </div>
      </div>
    </details>
  );
}

// ---- 未採用の組織の案内 ------------------------------------------------------------------
// 採用前に列の一覧を見られるようにし、採用は取り消せず監査に残ることを示す。管理者以外には管理者の名前を出す。
// 所属する別の組織が採用済みなら、その組織へ切り替えて開く入口を出す（組織の id と名前だけを使う）
export function AdoptionGuide({catalog, reason = '', onReason, onAdopt, readOnly = false, adopting = false, additional = false, adoptedElsewhere = [], onSwitchOrg}) {
  const [busy, setBusy] = useState(false);
  const columns = (additional ? catalog.additionalColumns : catalog.initialColumns) || [];
  const legacy = columns.filter((column) => column.legacyPosition).length;
  const admins = catalog.admins || [];
  const canSwitch = typeof onSwitchOrg === 'function' && !readOnly;
  return (
    <Notice tone="warn" title={additional ? '追加の列がまだ採用されていません' : '売上集計シートの列がまだありません'}>
      {additional
        ? <p>この組織では、追加の列に未採用のものがあります。採用すると、計上の根拠・原報告・版を確認する{int(columns.length)}列が使えるようになります。初期の83列と保存した形は変わりません。</p>
        : <p>この組織では、売上集計シートの列をまだ採用していません。採用すると、定型業務の売上集計シートと同じ意味の{int(legacy || 83)}列（参考の列・集計の補助の列を含めて{int(catalog.initialCount)}列）が、この組織の列の定義の第1版になります。</p>}
      <p><strong>採用は取り消せません。</strong>採用したあとは、列の追加・見出しの変更・使う／やめるを新しい版で直します。採用した人・日時・理由は監査の記録に残ります。</p>
      {columns.length > 0 && (
        <details className="ss-initial">
          <summary>採用する列の一覧を見る（{int(columns.length)}列）</summary>
          <div className="ss-admin-table">
            <table className="ss-history" aria-label="採用する列の一覧">
              <thead><tr><th scope="col">元の列</th><th scope="col">見出し</th><th scope="col">まとまり</th></tr></thead>
              <tbody>{columns.map((column) => <tr key={column.key}><td>{column.legacyPosition ?? '—'}</td><td>{column.label}</td><td>{column.groupLabel}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
      {catalog.canAdmin
        ? (
          <div className="ss-edit-actions">
            <FormField type="text" label={additional ? '追加の列を採用する理由' : '採用の理由'} required value={reason} onChange={onReason} disabled={readOnly || adopting} />
            <button type="button" disabled={readOnly || adopting || !reason.trim()} onClick={onAdopt}>{adopting ? '採用しています…' : additional ? '追加の列を採用する' : '初期の83列を採用する'}</button>
          </div>
        )
        : <p>採用は管理者が行います。{admins.length ? `この組織の管理者（${admins.join('・')}）に、${additional ? '追加の列' : '初期の83列'}の採用を依頼してください。` : `組織の管理者に、${additional ? '追加の列' : '初期の83列'}の採用を依頼してください。`}</p>}
      {adoptedElsewhere.length > 0 && (
        <div className="ss-elsewhere">
          <p>組織「{adoptedElsewhere[0].name}」では採用済みで、表を見られます。</p>
          <button type="button" className="secondary" disabled={!canSwitch || busy} title={canSwitch ? undefined : 'この画面では組織を切り替えられません'}
            onClick={async () => { setBusy(true); try { await onSwitchOrg(adoptedElsewhere[0].id, {after: {page: '売上集計シート'}}); } finally { setBusy(false); } }}>
            {busy ? '組織を切り替えています…' : `組織「${adoptedElsewhere[0].name}」に切り替えて売上集計シートを開く`}
          </button>
        </div>
      )}
    </Notice>
  );
}

export function AdditionalAdoptionGuide({catalog, setKey, customColumns, request, onChanged, readOnly = false}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!catalog?.adopted || !catalog.additionalPending || customColumns || !['additional', 'all_plus'].includes(setKey)) return null;
  async function adopt() {
    if (busy || readOnly || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await request('/sales-sheet/columns/adopt-additional', {method: 'POST', body: JSON.stringify({reason})});
      setReason('');
      onChanged?.();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return <>
    {error && <Notice error={error} />}
    <AdoptionGuide additional catalog={catalog} reason={reason} onReason={setReason} onAdopt={adopt} readOnly={readOnly} adopting={busy} />
  </>;
}

// ---- シート本体 --------------------------------------------------------------------------
export function SalesSheet({data, request: requestProp, embedded = false, setKey, conditions: givenConditions, title = '売上集計シート（83列）', onSwitchOrg}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const [fiscal] = useFiscal(request);
  const values = useConditions(embedded ? [] : CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth});
  const fixed = embedded ? {set: setKey || 'basic', cols: '', grain: 'detail', dims: '', pivot: '', view: ''} : {};
  const [params, setParam] = useSheetParams(shell, fixed);
  const [catalog, setCatalog] = useState(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [views, setViews] = useState([]);
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [qText, setQText] = useState(params.q);
  const [adoptReason, setAdoptReason] = useState('');
  const [viewForm, setViewForm] = useState({name: '', reason: ''});
  const [notice, setNotice] = useState(null);
  const [distributionTypes, setDistributionTypes] = useState([]);
  const conditions = embedded ? (givenConditions || {}) : {from: values.from, to: values.to, workId: values.workId, partnerId: values.partnerId};
  const query = sheetQuery(params, conditions);

  useEffect(() => {
    let live = true;
    request('/sales-sheet/columns').then((body) => live && setCatalog(body)).catch((error) => live && setState({error}));
    if (!embedded) request('/sales-sheet/views').then((body) => live && setViews(body.views || [])).catch(() => {});
    return () => { live = false; };
  }, [request, catalogRevision, embedded]);
  // 流通IDの絞り込みの選択肢（流通マスタの ID と、分類前の旧区分）
  useEffect(() => {
    if (embedded) return undefined;
    let live = true;
    request('/distribution-types').then((body) => live && setDistributionTypes(body.rows || [])).catch(() => {});
    return () => { live = false; };
  }, [request, embedded]);
  // 未採用のとき、所属する別の組織が採用済みなら切り替えの案内を出す（id と名前だけを読む）
  const features = useOrgFeatures(request, {enabled: Boolean(catalog) && !catalog.adopted && !embedded});
  const currentOrgId = data?.currentUser?.orgId ?? null;
  const adoptedElsewhere = features.salesSheet.filter((org) => org.id !== currentOrgId);
  useEffect(() => {
    if (!embedded && !values.valid) return undefined;
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request(`/sales-sheet?${query}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [request, query, revision, catalogRevision, embedded, values.valid]);

  const body = state.body;
  const allSet = !params.cols && ['all', 'all_plus'].includes(embedded ? setKey : params.set);
  const columns = useMemo(() => gridColumns(body, {groups: allSet, allSet}), [body, allSet]);
  const offer = !embedded && body ? latestYearOffer({total: body.total, latestMonth: body.latestMonth, fiscalYear: values.fiscalYear, fiscalStartMonth: values.fiscalStartMonth}) : null;
  const showLatestYear = () => {
    for (const [key, value] of [['fy', String(offer.fiscalYear)], ['period', null], ['from', null], ['to', null], [`${P}page`, null]]) shell.setParam(key, value, {replace: true});
  };
  // 報告の種類の既定の区分（*_unknown。分類の無い明細）は「未分類（…）」、ほかの旧区分は「（旧区分 …）」を付ける
  const distributionOptions = distributionTypes.map((row) => ({value: row.code,
    label: row.legacy && /_unknown$/.test(row.code) ? `未分類（${row.label}）` : row.legacy ? `${row.label}（旧区分 ${row.code}）` : row.label}));
  const dims = params.dims ? params.dims.split(',') : [];
  const setDim = (n, value) => {
    const next = [...dims];
    next[n] = value;
    setParam('dims', [...new Set(next.filter(Boolean))].join(','));
  };
  const currentView = views.find((view) => String(view.id) === params.view);
  function applyView(id) {
    const view = views.find((item) => String(item.id) === id);
    if (!view) { setParam('view', null); setParam('cols', null); return; }
    const d = view.definition;
    for (const [key, value] of [['view', String(view.id)], ['cols', d.columns.join(',')], ['grain', d.grain === 'aggregate' ? 'aggregate' : null], ['dims', d.dimensions.join(',')],
      ['month', d.monthBasis === 'accounting' ? null : d.monthBasis], ['tax', d.taxBasis === 'inc' ? 'inc' : null], ['pivot', d.pivot ? '1' : null], ['empty', d.hideEmpty ? null : 'show'],
      ['kind', d.filters.kind || null], ['dist', d.filters.distribution || null], ['q', d.filters.q || null]]) shell.setParam(`${P}${key}`, value || null, {replace: true});
    shell.setParam(`${P}page`, null, {replace: true});
    setQText(d.filters.q || '');
  }
  const definition = () => ({columns: body?.selected || [], grain: params.grain, dimensions: params.grain === 'aggregate' ? dims : [], monthBasis: params.month, taxBasis: params.tax,
    pivot: params.pivot === '1', hideEmpty: params.empty !== 'show', filters: {kind: params.kind || undefined, distribution: params.dist || undefined, q: params.q || undefined}});
  async function saveView(overwrite) {
    setNotice(null);
    try {
      if (overwrite) await request(`/sales-sheet/views/${currentView.id}/versions`, {method: 'POST', body: JSON.stringify({baseVersion: currentView.version, definition: definition(), reason: viewForm.reason})});
      else {
        const out = await request('/sales-sheet/views', {method: 'POST', body: JSON.stringify({name: viewForm.name, definition: definition(), reason: viewForm.reason})});
        shell.setParam(`${P}view`, String(out.id), {replace: true});
      }
      setViewForm({name: '', reason: ''});
      setNotice({tone: 'ok', message: overwrite ? `「${currentView.name}」を上書きしました（新しい版）` : 'シートの形を保存しました'});
      const list = await request('/sales-sheet/views');
      setViews(list.views || []);
    } catch (error) { setNotice({error}); }
  }
  async function adopt() {
    setNotice(null);
    try {
      await request('/sales-sheet/columns/adopt', {method: 'POST', body: JSON.stringify({reason: adoptReason})});
      setNotice({tone: 'ok', message: '初期の83列（と参考・集計の補助の列）を採用しました'});
      setCatalogRevision((n) => n + 1);
    } catch (error) { setNotice({error}); }
  }

  const sets = catalog?.sets || [];
  const additionalSelected = !params.cols && ['additional', 'all_plus'].includes(params.set);
  const exportQuery = query.replace(/(^|&)page=\d+/, '');
  const page = body?.page || 1, pages = body?.pages || 1, pageSize = body?.pageSize || 100;
  const rowsTotal = body?.grain === 'aggregate' ? body.groups : body?.total || 0;
  const from = rowsTotal ? (page - 1) * pageSize + 1 : 0, to = Math.min(page * pageSize, rowsTotal);
  // 合計行（条件に合う全行から）。最小〜最大・種類の数は集計の文字のまま
  const footer = body?.totals ? {label: `合計（条件に合う${int(body.total)}件）`, values: Object.fromEntries(body.columns.map((column) => [column.key,
    ['min_max', 'distinct'].includes(column.aggregation) ? String(body.totals[column.key] ?? '') : shown(column, body.totals[column.key])]))} : null;

  return (
    <section className={`card rp-report ss-sheet${embedded ? ' ss-embedded' : ''}`} aria-label={title}>
      <header className="so-head">
        <div>
          {embedded ? <h3>{title}</h3> : <h2>{title}</h2>}
          <p className="rp-muted">1行＝売上明細1件。定型業務の売上集計シートの83列と同じ意味の列を、中立の見出しで出します。{body?.scope || ''}</p>
        </div>
        {catalog?.adopted && (
          <div className="so-actions">
            <a className="bc-link-button rw-link-button" href={`/api/sales-sheet/export.xlsx?${exportQuery}`} download>Excel（この表・条件のシート付き）</a>
            <a className="bc-link-button rw-link-button" href={`/api/sales-sheet/export.csv?${exportQuery}`} download>83列の CSV</a>
            <a className="bc-link-button rw-link-button" href={`/api/sales-sheet/export-selected.csv?${exportQuery}`} download>CSV（選択した列・明細）</a>
          </div>
        )}
      </header>
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      {catalog && !catalog.adopted && (
        <AdoptionGuide catalog={catalog} reason={adoptReason} onReason={setAdoptReason} onAdopt={adopt} readOnly={Boolean(shell.readOnly)}
          adoptedElsewhere={embedded ? [] : adoptedElsewhere} onSwitchOrg={onSwitchOrg} />
      )}
      {catalog?.adopted && (
          <>
          <AdditionalAdoptionGuide catalog={catalog} setKey={params.set} customColumns={params.cols} request={request}
            onChanged={() => setCatalogRevision((n) => n + 1)} readOnly={Boolean(shell.readOnly)} />
          {additionalSelected && <p className="rp-muted">追加の金額・数量は合算せず、集計では種類を表示します。原報告の金額と計上額は足し合わせません。</p>}
          {!embedded && (
            <ConditionBar conditions={CONDITIONS} values={values} works={data?.works || []} partners={data?.partners || []} fiscalConfirmed={fiscal?.confirmed} />
          )}
          <div className="ss-sets" role="group" aria-label="列セット">
            <span className="ss-sets-label">列セット</span>
            {(embedded ? [] : SET_ORDER).map((key) => {
              const set = sets.find((item) => item.key === key);
              if (!set) return null;
              const pressed = !params.cols && params.set === key;
              return <button key={key} type="button" className={pressed ? '' : 'secondary'} aria-pressed={pressed} onClick={() => { setParam('cols', null); setParam('view', null); setParam('set', key); }}>{set.label}（{set.columns.length}）</button>;
            })}
            {embedded && <span className="ss-chip">{sets.find((item) => item.key === (setKey || 'basic'))?.label || setKey}（{sets.find((item) => item.key === (setKey || 'basic'))?.columns.length ?? 0}列）</span>}
            {params.cols && <span className="ss-chip">保存した形{currentView ? `「${currentView.name}」` : ''}の列（{params.cols.split(',').length}列）</span>}
          </div>
          <div className="rw-filters ss-filters" role="search" aria-label="売上集計シートの条件">
            {!embedded && (
              <>
                <FormField type="select" label="粒度" value={params.grain} includeBlank={false} options={Object.entries(catalog.grains).map(([value, label]) => ({value, label}))} onChange={(v) => setParam('grain', v === 'detail' ? null : v)} />
                {params.grain === 'aggregate' && [0, 1, 2].map((n) => (
                  <FormField key={n} type="select" label={`切り口${n + 1}`} value={dims[n] || ''} blankLabel="使わない" disabled={n > dims.length}
                    options={catalog.dimensions.filter((d) => d.key === dims[n] || !dims.includes(d.key)).map((d) => ({value: d.key, label: d.label}))} onChange={(v) => setDim(n, v)} />
                ))}
                <FormField type="select" label="月の基準" value={params.month} includeBlank={false} options={Object.entries(catalog.monthBases).map(([value, label]) => ({value, label}))} onChange={(v) => setParam('month', v === 'accounting' ? null : v)} />
                {params.grain === 'aggregate' && (
                  <>
                    <label className="dg-check ss-check"><input type="checkbox" checked={params.pivot === '1'} onChange={(event) => setParam('pivot', event.target.checked ? '1' : null)} />月を横に並べる</label>
                    <FormField type="select" label="月別の額" value={params.tax} includeBlank={false} disabled={params.pivot !== '1'} options={Object.entries(catalog.taxBases).map(([value, label]) => ({value, label}))} onChange={(v) => setParam('tax', v === 'ex' ? null : v)} />
                  </>
                )}
                <FormField type="select" label="報告の種類" value={params.kind} blankLabel="すべて" options={KIND_OPTIONS} onChange={(v) => setParam('kind', v)} />
                <FormField type="select" label="流通ID" value={params.dist} blankLabel="すべての流通" options={distributionOptions.some((o) => o.value === params.dist) || !params.dist ? distributionOptions : [...distributionOptions, {value: params.dist, label: params.dist}]}
                  onChange={(v) => setParam('dist', v)} />
                <form className="rw-q" onSubmit={(event) => { event.preventDefault(); setParam('q', qText.trim()); }}>
                  <FormField type="search" label="作品・取引先・商品・明細名・報告番号" value={qText} onChange={setQText} />
                  <button type="submit" className="secondary">探す</button>
                </form>
              </>
            )}
            <FormField type="select" label="1ページの行数" value={String(pageSizeOf(params.psize))} includeBlank={false} options={PAGE_SIZES.map((n) => ({value: String(n), label: `${n}行`}))}
              onChange={(v) => setParam('psize', pageSizeOf(v) === 100 ? null : String(pageSizeOf(v)))} />
            <label className="dg-check ss-check"><input type="checkbox" checked={params.empty !== 'show'} onChange={(event) => setParam('empty', event.target.checked ? null : 'show')} />全行が空の列を隠す</label>
          </div>
          {!embedded && (
            <details className="ss-views">
              <summary>保存した形（{int(views.length)}件）{currentView ? `：「${currentView.name}」を表示中` : ''}</summary>
              <div className="rw-filters">
                <FormField type="select" label="形を選ぶ" value={params.view} blankLabel="選ばない（列セットで見る）" options={views.filter((view) => view.active).map((view) => ({value: String(view.id), label: `${view.name}（第${view.version}版）`}))} onChange={applyView} />
                <FormField type="text" label="新しい形の名前" value={viewForm.name} onChange={(v) => setViewForm((x) => ({...x, name: v}))} />
                <FormField type="text" label="理由" required value={viewForm.reason} onChange={(v) => setViewForm((x) => ({...x, reason: v}))} />
                <button type="button" className="secondary" disabled={!viewForm.name.trim() || !viewForm.reason.trim() || !body?.selected?.length} onClick={() => saveView(false)}>この形を保存</button>
                {currentView?.canEdit && <button type="button" className="secondary" disabled={!viewForm.reason.trim()} onClick={() => saveView(true)}>「{currentView.name}」を上書き</button>}
              </div>
              <p className="rp-muted">保存するのは 列の並び・粒度・切り口・月の基準・税抜／税込・月を横に並べるか・空の列・報告の種類と語句 です。期間・作品・取引先はそのときの条件で見ます。</p>
            </details>
          )}
          {body && (
            <p className="rp-meta" aria-live="polite">
              <span>条件に合う明細 {int(body.total)}件</span>
              {body.grain === 'aggregate' && <span>集計の行 {int(body.groups)}行</span>}
              <span>表示する列 {int(body.columns.length)}列</span>
              {body.hiddenEmpty?.length > 0 && <span>全行が空で隠した列 {int(body.hiddenEmpty.length)}列 <button type="button" className="text" onClick={() => setParam('empty', 'show')}>空の列も出す</button></span>}
              {body.rows.some((row) => row.__mixed?.length) && <span className="rp-warn">通貨が混ざるため外貨の額・レートを空にした行 {int(body.rows.filter((row) => row.__mixed?.length).length)}行</span>}
              {body.mixed?.length > 0 && <span className="rp-warn">合計行は通貨が混ざるため外貨の額・レートを空にしています（通貨の切り口で分けると出ます）</span>}
              {body.summarySkipped && <span className="rp-warn">件数が多いため、合計と空の列の判定は出していません（条件で絞ってください）</span>}
              {body.unclassifiedCount > 0 && (
                <span className="rp-warn">流通の分類待ち {int(body.unclassifiedCount)}件（流通IDは「未分類」。帳票センター › 年間番販集計の元明細の「流通」で流通マスタの ID に分類します）
                  {!embedded && !shell.readOnly && <button type="button" className="text" onClick={() => shell.navigate?.('帳票センター', {report: 'banpan'})}>帳票センターを開く</button>}</span>
              )}
            </p>
          )}
          {offer && (
            <div className="ss-latest" role="status">
              <span>{offer.note}</span>
              <button type="button" className="secondary" onClick={showLatestYear}>{offer.label}</button>
            </div>
          )}
        </>
      )}
      {state.error && <Notice error={state.error} onRetry={() => setRevision((n) => n + 1)} />}
      {state.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
      {body?.adopted && (
        <DataGrid key={`${body.grain}:${params.cols ? `view${params.view}` : embedded ? setKey : params.set}:${body.dimensions?.map((d) => d.key).join(',') || ''}`} columns={columns} rows={body.rows} rowKey={body.grain === 'aggregate' ? (row) => (body.dimensions.map((d) => row[`dimkey_${d.key}`]).join('|') || 'all') : '__id'}
          persistKey={`sales-sheet:${params.cols ? `view${params.view}` : params.set}:${body.grain}`} ariaLabel={title} showTotals={false} footerRow={footer} maxHeight="70vh"
          emptyText="この条件の売上明細はありません"
          renderDetail={body.grain === 'detail' ? (row) => <SaleDetail saleId={row.__id} request={request} onSaved={() => setRevision((n) => n + 1)} /> : undefined} />
      )}
      {body?.adopted && rowsTotal > 0 && (
        <nav className="rw-pager" aria-label="ページ送り">
          <button type="button" className="secondary" disabled={page <= 1} onClick={() => setParam('page', page - 1 > 1 ? String(page - 1) : null)}>前の{pageSize}行</button>
          <span>{int(from)}〜{int(to)}行目（全{int(rowsTotal)}行・{page}/{pages}ページ）</span>
          <button type="button" className="secondary" disabled={page >= pages} onClick={() => setParam('page', String(page + 1))}>次の{pageSize}行</button>
        </nav>
      )}
      {!embedded && catalog?.adopted && catalog.canAdmin && <CatalogAdmin catalog={catalog} request={request} onChanged={() => setCatalogRevision((n) => n + 1)}
        readOnly={Boolean(shell.readOnly)} showAdditionalGuide={!additionalSelected} />}
    </section>
  );
}

export default SalesSheet;
