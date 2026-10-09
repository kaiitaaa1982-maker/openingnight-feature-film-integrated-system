// 営業基幹「提案資料」。タブは「月別」（PVOD基準・TVOD基準・TVOD先行基準・EST先行基準・EST基準）と「SVOD」（提案先×提案期間）。
// どちらも画面の表で中身を確かめてから、同じ条件の Excel・CSV を出す。条件（タブ・基準・月・状態・提案先・期間）は URL（pp*）に残す。
// 提案資料は全作品のウィンドウの最新の版からそのつど組み立てる（保存しない）。作品情報は作品・商品マスタで入れる。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {Tabs} from '../ui/Tabs.jsx';
import {int} from '../ui/format.mjs';
import {PROPOSAL_BASES, STATUS_MODES, shiftMonth, monthText, isMonth, nextSvodPeriod, SVOD_MAX_MONTHS} from './release-proposal-model.mjs';
import '../reports/reports.css';
import './sales-ops.css';
import './release-windows.css';
import './proposals.css';

const P = 'pp'; // URL の条件の接頭辞

function useRequest(requestProp) {
  const shell = useShell();
  const ref = useRef(null);
  ref.current = requestProp || shell.request;
  return useCallback((path, options) => ref.current(path, options), []);
}

function useLoad(request, path) {
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!path) return undefined;
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request(path).then((body) => { if (live) setState({body}); }).catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [request, path, revision]);
  return [state, () => setRevision((n) => n + 1)];
}

// 月のプルダウン: 件数のある月と選んでいる月を、最初の月から最後の月まで切れ目なく並べる（件数の無い月は「0件」）
export function monthOptions(months = [], selected) {
  const list = months.map((item) => item.month).concat(isMonth(selected) ? [selected] : []).sort();
  if (!list.length) return [];
  const counts = new Map(months.map((item) => [item.month, item.count]));
  const out = [];
  for (let m = list[0]; m <= list.at(-1) && out.length < 240; m = shiftMonth(m, 1)) out.push({value: m, label: `${monthText(m)}（${int(counts.get(m) || 0)}件）`});
  return out;
}

const statusControl = (value, onChange) => (
  <div className="rw-view" role="group" aria-label="状態の条件">
    {Object.entries(STATUS_MODES).map(([key, label]) => (
      <button key={key} type="button" className={value === key ? '' : 'secondary'} aria-pressed={value === key} onClick={() => onChange(key === 'all' ? null : key)}>{label}</button>
    ))}
  </div>
);

// ---- 月別 ------------------------------------------------------------------------------------
function MonthlyProposals({request}) {
  const shell = useShell();
  const read = (key, fallback = '') => shell.getParam(`${P}${key}`, '') || fallback;
  const set = (key, value) => shell.setParam(`${P}${key}`, value || null, {replace: true});
  const statusMode = read('status', 'all');
  const [summary, reloadSummary] = useLoad(request, `/release-proposals?status=${statusMode}`);
  const basisKey = PROPOSAL_BASES.some((basis) => basis.key === read('basis')) ? read('basis') : PROPOSAL_BASES[0].key;
  const month = isMonth(read('month')) ? read('month') : summary.body?.defaultMonth || '';
  const [report, reloadReport] = useLoad(request, month ? `/release-proposals/${basisKey}?month=${month}&status=${statusMode}` : null);
  const bases = summary.body?.bases || [];
  const basis = bases.find((item) => item.key === basisKey);
  const countIn = (item) => item?.months.find((m) => m.month === month)?.count || 0;
  const body = report.body;
  const columns = useMemo(() => (body?.columns || []).map((column) => ({key: column.key, group: column.group || undefined, label: column.part, type: column.type === 'year' ? 'text' : column.type,
    wrap: column.wrap, total: 'none', ...(['credits', 'synopsis_long', 'intro_long', 'caution'].includes(column.key) ? {width: 320} : {})})), [body]);
  const query = `month=${month}&status=${statusMode}`;
  const href = (format) => `/api/release-proposals/${basisKey}/export.${format}?${query}`;

  return (
    <section className="card rp-report pp-report" aria-label="月別の提案資料">
      <header className="so-head">
        <div>
          <h2>月別の提案資料</h2>
          <p className="rp-muted">基準のウィンドウの解禁日がその月にある作品を1行ずつ並べ、同じ作品のほかのウィンドウ・作品情報・権利を横に出します。ウィンドウ（全作品のウィンドウの最新の版）の取り下げは入れません。状態の条件はほかのウィンドウの列にも当てます（確定だけなら予定のウィンドウは空欄、予定＋確定なら予定のウィンドウを備考に書きます）。データの無い列も空欄のまま出します（推測で埋めません）。</p>
        </div>
        {month && (
          <div className="so-actions">
            <a className="bc-link-button rw-link-button" href={href('xlsx')} download>Excelで出力</a>
            <a className="bc-link-button rw-link-button" href={href('csv')} download>CSVで出力</a>
          </div>
        )}
      </header>
      {summary.error && <Notice error={summary.error} onRetry={reloadSummary} />}
      {summary.body?.needsAdoption && <Notice tone="warn" message="ウィンドウの種別がまだありません。管理者が全作品のウィンドウで初期の種別を採用すると、提案資料を出せます。" />}
      {bases.length > 0 && (
        <div className="pp-bases" role="group" aria-label="基準">
          {bases.map((item) => (
            <button key={item.key} type="button" className={item.key === basisKey ? '' : 'secondary'} aria-pressed={item.key === basisKey} disabled={!item.available}
              title={`基準のウィンドウ: ${item.typeLabels.join('・')}`} onClick={() => set('basis', item.key === PROPOSAL_BASES[0].key ? null : item.key)}>
              {item.label}<span className="pp-count">{int(countIn(item))}件</span>
            </button>
          ))}
        </div>
      )}
      {month && (
        <div className="rw-filters pp-filters">
          <div className="pp-month" role="group" aria-label="対象月">
            <button type="button" className="secondary" onClick={() => set('month', shiftMonth(month, -1))}>← 前月</button>
            <FormField type="select" label="対象月" includeBlank={false} value={month} onChange={(value) => set('month', value)} options={monthOptions(basis?.months || [], month)} />
            <button type="button" className="secondary" onClick={() => set('month', shiftMonth(month, 1))}>翌月 →</button>
          </div>
          {statusControl(statusMode, (value) => set('status', value))}
        </div>
      )}
      {report.error && <Notice error={report.error} onRetry={reloadReport} />}
      {body && (
        <p className="rp-meta" aria-live="polite">
          <span>{body.basis.label}・{body.monthText}</span>
          <span>{body.statusText}</span>
          <span>件数 {int(body.count)}件</span>
          <span>列 {int(body.columns.length)}列（空の列 {int(body.emptyColumns.length)}列）</span>
          <span className={body.undated.length ? 'rp-warn' : ''}>月が決まっていない候補 {int(body.undated.length)}件</span>
        </p>
      )}
      {report.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
      {body && (
        <DataGrid key={`${basisKey}:${body.columns.length}`} columns={columns} rows={body.rows} rowKey={(row) => `${row.work_code}:${row.basis_type}`} ariaLabel={`${body.basis.label}の提案資料`}
          showTotals={false} maxHeight="60vh" persistKey={`proposals:${basisKey}`}
          emptyText={`${body.monthText}に解禁する${body.basis.label.replace('基準', '')}のウィンドウはありません。前月・翌月で月を変えてください。`} />
      )}
      {body && (body.undated.length > 0 || body.emptyColumns.length > 0) && (
        <div className="pp-notes">
          {body.undated.length > 0 && (
            <section aria-label="月が決まっていない候補">
              <h3>月が決まっていない候補（{int(body.undated.length)}件・表と Excel の行には入れません）</h3>
              <ul>{body.undated.map((item) => <li key={item.text}>{item.text}</li>)}</ul>
            </section>
          )}
          {body.emptyColumns.length > 0 && (
            <details>
              <summary>空の列（{int(body.emptyColumns.length)}列）</summary>
              <p className="rp-muted">{body.emptyColumns.join('、')}。作品情報は作品・商品マスタ、ウィンドウは全作品のウィンドウで入れます。</p>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

// ---- SVOD ------------------------------------------------------------------------------------
const PARTNER_GROUPS = Object.freeze({svod: 'SVOD の契約がある取引先', platform: '配信の取引先（SVOD の契約なし）', other: 'その他の取引先'});
// 提案先の選択肢（サーバーの並び: SVOD の明細が多い順 → 配信 → そのほか）。明細0件は選んだときの結果が分かるように書く
export function svodPartnerOptions(partners = []) {
  return partners.map((p) => ({value: String(p.id), group: PARTNER_GROUPS[p.group] || undefined,
    label: `${p.name}（${p.svodContracts ? `SVOD の明細 ${int(p.svodContracts)}件` : 'SVOD の契約なし・全作品が新規'}）`}));
}

// 提案先・提案期間・状態の欄と、読み込みの失敗の知らせ。失敗しても（最初の読み込みで提案先の一覧が無くても）期間の欄は出し、
// 「期間を既定に戻す」で URL の期間を消せる（再試行は同じ条件で同じ 400 を繰り返すため）
export function SvodConditions({form, from, to, partnerParam, statusMode, error, onRetry, set, setPeriod}) {
  return (
    <>
      {(form || error) && (
        <div className="rw-filters pp-filters">
          {form && (
            <FormField type="select" label="提案先" value={partnerParam === 'none' ? '' : partnerParam || (form.partner ? String(form.partner.id) : '')} blankLabel="指定しない（新規だけ）"
              onChange={(value) => set('partner', value || 'none')} options={svodPartnerOptions(form.partners)} />
          )}
          <FormField type="month" label="提案期間（開始月）" value={from || form?.from || ''} onChange={(value) => setPeriod('from', value)} />
          <FormField type="month" label="提案期間（終了月）" value={to || form?.to || ''} onChange={(value) => setPeriod('to', value)}
            hint={`開始月から${SVOD_MAX_MONTHS}か月まで。空欄は開始月から12か月`} />
          {statusControl(statusMode, (value) => set('status', value))}
        </div>
      )}
      {error && <Notice error={error} onRetry={onRetry}
        actions={<button type="button" className="secondary" onClick={() => { set('from', null); set('to', null); }}>期間を既定に戻す</button>} />}
    </>
  );
}

export function SvodProposals({request}) {
  const shell = useShell();
  const read = (key) => shell.getParam(`${P}${key}`, null);
  const set = (key, value) => shell.setParam(`${P}${key}`, value === null || value === undefined ? null : String(value), {replace: true});
  const statusMode = read('status') || 'all';
  const partnerParam = read('partner');
  const from = isMonth(read('from')) ? read('from') : '';
  const to = isMonth(read('to')) ? read('to') : '';
  const search = new URLSearchParams();
  if (partnerParam !== null) search.set('partnerId', partnerParam);
  if (from) search.set('from', from);
  if (to) search.set('to', to);
  search.set('status', statusMode);
  const query = search.toString();
  const [state, reload] = useLoad(request, `/svod-proposals?${query}`);
  const body = state.body;
  // 最後に読めた応答（400 などで失敗しても、提案先・期間の欄は出したままにして画面から直せるようにする）
  const last = useRef(null);
  if (body) last.current = body;
  const form = body || last.current;
  const setPeriod = (key, value) => {
    const next = nextSvodPeriod({from: from || form?.from || null, to: to || form?.to || null}, key, isMonth(value) ? value : null);
    if (next.from !== (from || null)) set('from', next.from);
    if (next.to !== (to || null)) set('to', next.to);
  };
  const columns = useMemo(() => (body?.columns || []).map((column) => ({...column, sticky: column.key === 'category_label' || column.key === 'work_code',
    total: column.key === 'amount' ? 'sum' : column.key === 'months' ? 'sum' : 'none'})), [body]);
  const money = (n) => `${int(n)}円`;
  const summaryText = body ? Object.entries(body.categories).map(([key, label]) => `${label} ${int(body.subtotals[key].count)}件（${money(body.subtotals[key].amount)}）`) : [];

  return (
    <section className="card rp-report pp-report" aria-label="SVOD の提案資料">
      <header className="so-head">
        <div>
          <h2>SVOD の提案資料</h2>
          <p className="rp-muted">提案先と提案期間を選ぶと、継続（提案先との契約が期間の中に終わり、続く契約・再契約が無い）・新規（SVOD のウィンドウが期間と重なり、提案先と契約が無い）・注意（他社の独占と重なる、または権利が切れている）に分けて並べます。提案の期間はウィンドウと配信の権利範囲で狭め、提案金額は月額単価（SVOD のウィンドウの価格）×月数で計算します。単価の無いウィンドウは空欄です。</p>
        </div>
        {body && (
          <div className="so-actions">
            <a className="bc-link-button rw-link-button" href={`/api/svod-proposals/export.xlsx?${query}`} download>Excelで出力</a>
            <a className="bc-link-button rw-link-button" href={`/api/svod-proposals/export.csv?${query}`} download>CSVで出力</a>
          </div>
        )}
      </header>
      <SvodConditions form={form} from={from} to={to} partnerParam={partnerParam} statusMode={statusMode} error={state.error} onRetry={reload} set={set} setPeriod={setPeriod} />
      {state.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
      {body && (
        <p className="rp-meta" aria-live="polite">
          <span>{body.partner ? body.partner.name : '提案先の指定なし'}</span>
          <span>{monthText(body.from)}〜{monthText(body.to)}（{int(body.period.months)}か月）</span>
          {summaryText.map((text) => <span key={text}>{text}</span>)}
          <span><strong>合計 {int(body.total.count)}件・{money(body.total.amount)}</strong></span>
        </p>
      )}
      {body && (
        <DataGrid key={query} columns={columns} rows={body.rows} rowKey={(row) => `${row.category}:${row.work_code}:${row.proposal_start}`} ariaLabel="SVOD の提案資料"
          groupBy="category_label" subtotalLabel="小計" totalLabel={`合計（${int(body.total.count)}件）`} maxHeight="60vh" persistKey="proposals:svod"
          emptyText="提案期間に当てはまる作品がありません。期間や提案先を変えてください。" />
      )}
    </section>
  );
}

export function ProposalsPage({request: requestProp}) {
  const request = useRequest(requestProp);
  return (
    <div className="so-page">
      <Tabs urlKey={`${P}tab`} label="提案資料の種類" tabs={[{id: 'monthly', label: '月別'}, {id: 'svod', label: 'SVOD'}]}>
        {(active) => (active === 'svod' ? <SvodProposals request={request} /> : <MonthlyProposals request={request} />)}
      </Tabs>
    </div>
  );
}

export default ProposalsPage;
