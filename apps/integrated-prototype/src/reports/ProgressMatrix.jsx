// 月次の受領進捗。届くはずの報告（取引先×報告の種類×頻度）ごとに、月の欄へ未受領・取込済・請求済・入金済を出す。
// 件数カードで絞り込み（URL の pstate に残る）、セルから取込・売上明細・売掛へ移る。届くはずの報告の登録と終了もここで行う。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {useConditions, ConditionBar} from '../ui/ConditionBar.jsx';
import {describeConditions, monthText} from '../ui/condition-model.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {RecordForm} from '../ui/RecordForm.jsx';
import {FormField} from '../ui/FormField.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {Notice} from '../ui/Notice.jsx';
import {toEntityItems} from '../ui/entity-match.mjs';
import {dateJst, dateTimeJst} from '../ui/format.mjs';
import {CELL_STATUS, FREQUENCIES, filterRows} from '../progress/progress-model.mjs';
import './reports.css';

const CONDITIONS = ['fiscalYear', 'period'];
const CARDS = [
  {code: 'missing_overdue', label: '未受領（期限超過）'},
  {code: 'missing', label: '未受領（期限前）'},
  {code: 'imported', label: '取込済（未請求）'},
  {code: 'partly_billed', label: '一部請求'},
  {code: 'billed', label: '請求済（入金待ち）'},
  {code: 'paid', label: '入金済'},
  {code: 'no_invoice', label: '取込済（請求の対象外）'},
];
const KIND_OPTIONS = [['digital', '配信'], ['package', 'ビデオグラム'], ['theatrical', '劇場'], ['broadcast', '放送'], ['other', 'その他']].map(([value, label]) => ({value, label}));
const FREQUENCY_OPTIONS = Object.entries(FREQUENCIES).map(([value, f]) => ({value, label: f.label}));
const RULE_COLUMNS = [
  {key: 'partner_name', label: '取引先', type: 'text', sticky: true},
  {key: 'kind_label', label: '報告の種類', type: 'text'},
  {key: 'work_title', label: '作品', type: 'text', value: (r) => r.work_title || 'すべての作品'},
  {key: 'frequency_label', label: '頻度', type: 'text'},
  {key: 'due_day', label: '届く日', type: 'text', value: (r) => (r.due_day ? `翌月${r.due_day}日` : '翌月末')},
  {key: 'active_from', label: '開始月', type: 'month'},
  {key: 'last_month', label: '最後の対象月', type: 'month', value: (r) => r.last_month || null, render: (r) => (r.last_month ? monthText(r.last_month) : '継続中')},
  {key: 'note', label: '備考', type: 'text', wrap: true, value: (r) => r.note || '—'},
];

function CloseRule({rule, request, onClosed}) {
  const [values, setValues] = useState({lastMonth: '', reason: ''});
  const [step, setStep] = useState('edit');
  const [error, setError] = useState(null);
  if (rule.last_month) return <p className="rp-muted">{monthText(rule.last_month)}で終了（理由: {rule.closed_reason}）</p>;
  const invalid = !/^\d{4}-\d{2}$/.test(values.lastMonth) || !values.reason.trim();
  async function submit() {
    setStep('saving');
    try {
      await request(`/progress/rules/${rule.id}/close`, {method: 'POST', body: JSON.stringify(values)});
      onClosed?.();
    } catch (cause) { setError(cause); setStep('edit'); }
  }
  return (
    <div className="stack">
      <p className="rp-muted">この規則を終えるときは、最後に報告が届く対象月と理由を記録します。記録は取り消せません（条件を変えるときは、終了してから新しく登録します）。</p>
      {step === 'edit' && (
        <div className="two">
          <FormField type="month" label="最後の対象月" required value={values.lastMonth} onChange={(v) => setValues((x) => ({...x, lastMonth: v}))} />
          <FormField type="text" label="終了の理由" required value={values.reason} onChange={(v) => setValues((x) => ({...x, reason: v}))} />
          <div className="on-form-actions"><button type="button" disabled={invalid} onClick={() => setStep('confirm')}>終了の内容を確かめる</button></div>
        </div>
      )}
      {step !== 'edit' && (
        <Notice tone="warn" title="この内容で終了しますか" message={`${rule.partner_name}・${rule.kind_label}：${monthText(values.lastMonth)}の対象期間までで終了（理由: ${values.reason}）`}
          actions={<>
            <button type="button" disabled={step === 'saving'} onClick={submit}>{step === 'saving' ? '記録中…' : 'この内容で終了する'}</button>
            <button type="button" className="secondary" onClick={() => setStep('edit')}>戻って直す</button>
          </>} />
      )}
      {error && <Notice error={error} />}
    </div>
  );
}

export function ProgressMatrix({data, fiscal, onNavigate}) {
  const shell = useShell();
  const request = shell.request;
  const navigate = onNavigate || shell.navigate;
  const values = useConditions(CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth});
  const pstate = shell.getParam('pstate', '');
  const [state, setState] = useState({});
  const [rules, setRules] = useState(null);
  const [revision, setRevision] = useState(0);
  const query = useMemo(() => (values.from && values.to ? new URLSearchParams({from: values.from, to: values.to}).toString() : ''), [values.from, values.to]);

  useEffect(() => {
    if (!query || !values.valid) { setState({}); return undefined; }
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request(`/progress/matrix?${query}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [query, values.valid, request, revision]);
  useEffect(() => {
    let live = true;
    request('/progress/rules').then((body) => live && setRules(body.rules)).catch(() => live && setRules([]));
    return () => { live = false; };
  }, [request, revision]);

  const body = state.body;
  const rows = body ? filterRows(body.rows, pstate) : [];
  const partners = data?.partners || [];
  const works = data?.works || [];
  const title = '月次の受領進捗';

  function openCell(row, cell) {
    if (cell.code === 'missing' || cell.code === 'missing_overdue') {
      navigate('原本取り込み', {partner: String(row.partner_id), kind: row.kind}, row.work_id ? {workId: row.work_id} : undefined);
    } else if (cell.code === 'billed' || cell.code === 'partly_billed') {
      navigate('帳票センター', {report: 'receivables'});
    } else if (cell.code !== 'none') {
      navigate('売上', {period: 'custom', from: cell.accountingFrom || cell.month, to: cell.accountingTo || cell.month, partnerId: String(row.partner_id)});
    }
  }

  function sheets() {
    const conditions = describeConditions(values, CONDITIONS);
    const dataAsOf = `判定日 ${body.today}`;
    const columns = [
      {key: 'partner_name', label: '取引先', type: 'text'}, {key: 'kind_label', label: '報告の種類', type: 'text'},
      {key: 'work_title', label: '作品', type: 'text'}, {key: 'frequencyLabel', label: '頻度', type: 'text'},
      ...body.months.map((month, index) => ({key: `m${index}`, label: monthText(month), type: 'text'})),
    ];
    const sheetRows = rows.map((row) => ({...row, work_title: row.work_title || 'すべての作品', ...Object.fromEntries(row.cells.map((cell, index) => [`m${index}`, cell.code === 'none' ? '' : cell.short]))}));
    return [
      {name: '受領進捗', title, conditions, dataAsOf, columns, rows: sheetRows, freezeCols: 2, notes: [body.basis, '空欄は対象外の月（頻度や有効期間の外）です。']},
      {name: '届くはずの報告', title: '届くはずの報告（受領進捗の母集合）', conditions, dataAsOf, columns: RULE_COLUMNS.map((c) => ({...c, render: undefined})), rows: rules || []},
    ];
  }

  return (
    <div className="stack">
      <section className="card rp-report" aria-label={title}>
        <header className="rp-head">
          <div>
            <h2>{title}</h2>
            <p className="rp-muted">届くはずの報告ごとに、月の欄へ受領・請求・入金の状態を出します。報告が0円の月と、報告がまだ届いていない月を区別するための表です。欄を押すと、取込・売上明細・売掛へ移ります。</p>
          </div>
          {body && <ReportOutputBar sheets={sheets} name="月次の受領進捗" period={values.from && values.to ? `${values.from}〜${values.to}` : ''} title={title} subtitle={values.periodLabel} />}
        </header>
        <ConditionBar conditions={CONDITIONS} values={values} fiscalConfirmed={fiscal?.confirmed} />
        {state.error && <Notice error={state.error} />}
        {state.loading && !body && <p className="rp-muted" aria-busy="true">集計中…</p>}
        {body && (
          <>
            <div className="rp-tiles pm-cards" role="group" aria-label="状態で絞り込む">
              {CARDS.map((card) => (
                <button key={card.code} type="button" className={`pm-card is-${CELL_STATUS[card.code].tone}`} aria-pressed={pstate === card.code}
                  onClick={() => shell.setParam('pstate', pstate === card.code ? null : card.code)}>
                  <span>{card.label}</span><strong>{body.counts[card.code]}</strong>
                </button>
              ))}
            </div>
            {pstate && <p className="on-conditions-summary">絞込: {CARDS.find((c) => c.code === pstate)?.label}（{rows.length}件の報告） <button type="button" className="text" onClick={() => shell.setParam('pstate', null)}>絞込を解除</button></p>}
            {!body.rows.length && <Notice tone="info" message="届くはずの報告がまだ登録されていません。下の「届くはずの報告」から、取引先と報告の種類・頻度を登録してください。" />}
            {body.rows.length > 0 && (
              <div className="pm-scroll" role="region" aria-label="受領進捗の表" tabIndex={0}>
                <table className="pm-table">
                  <thead>
                    <tr>
                      <th scope="col" className="pm-sticky">取引先・報告</th>
                      {body.months.map((month) => <th key={month} scope="col">{`${Number(month.slice(5, 7))}月`}<small>{month.slice(0, 4)}</small></th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <th scope="row" className="pm-sticky">
                          <span>{row.partner_name}</span>
                          <small>{row.kind_label}・{row.frequencyLabel}{row.work_title ? `・${row.work_title}` : ''}</small>
                        </th>
                        {row.cells.map((cell) => (
                          <td key={cell.month} className={`pm-cell is-${cell.tone}`}>
                            {cell.code === 'none' ? <span className="pm-none" aria-label="対象外">·</span> : (
                              <button type="button" onClick={() => openCell(row, cell)} disabled={shell.readOnly}
                                title={`${monthText(cell.month)}: ${cell.label}（期限 ${dateJst(cell.due)}）${cell.reportIds.length ? `・報告 ${cell.reportIds.map((id) => body.reportKeys[id] || id).join('、')}` : ''}`}>
                                {cell.short}
                              </button>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="rp-muted">{body.basis} 判定日 {dateJst(body.today)}。</p>
          </>
        )}
      </section>

      <section className="card rp-report" aria-label="届くはずの報告">
        <header className="rp-head">
          <div>
            <h2>届くはずの報告（{rules ? rules.length : '…'}件）</h2>
            <p className="rp-muted">取引先から定期的に届く報告を登録します。登録した内容は変更できません。条件が変わったら、行を開いて終了し、新しく登録します。</p>
          </div>
        </header>
        {rules && <DataGrid columns={RULE_COLUMNS} rows={rules} rowKey="id" persistKey="progress-rules" emptyText="まだ登録がありません"
          renderDetail={(rule) => (
            <div className="rp-drill">
              <p className="rp-muted">登録: {dateTimeJst(rule.created_at)}・{rule.created_by_name || ''}</p>
              {!shell.readOnly && <CloseRule rule={rule} request={request} onClosed={() => setRevision((n) => n + 1)} />}
            </div>
          )} />}
        {!shell.readOnly && (
          <RecordForm mode="create" openLabel="＋届くはずの報告を登録" title="届くはずの報告を登録" submitLabel="登録する" successMessage="登録しました"
            fields={[
              {name: 'partnerId', label: '取引先', type: 'entity', required: true, items: toEntityItems(partners)},
              {name: 'kind', label: '報告の種類', type: 'select', required: true, options: KIND_OPTIONS},
              {name: 'workId', label: '作品（空欄はすべての作品）', type: 'entity', items: toEntityItems(works)},
              {name: 'frequency', label: '頻度', type: 'select', required: true, options: FREQUENCY_OPTIONS, defaultValue: 'monthly'},
              {name: 'dueDay', label: '届く日（翌月の何日まで。空欄は翌月末）', type: 'int', hint: '例: 20'},
              {name: 'activeFrom', label: '開始月（最初の対象月）', type: 'month', required: true},
              {name: 'note', label: '備考', type: 'textarea', wide: true},
            ]}
            onSubmit={(v) => request('/progress/rules', {method: 'POST', body: JSON.stringify(v)})}
            onSaved={() => setRevision((n) => n + 1)} />
        )}
      </section>
    </div>
  );
}

export default ProgressMatrix;
