// 月次の報告（春川の単位）。PL・BS を先月・前年同月と比べ、差から課題の候補を出す。原因・打ち手・期限はこの画面で書き、Excel・印刷に載せて代表が会社へ送る。
// 計算は monthly-report-model.mjs（純関数）。数字は /api/reports/pl-bs（計上・税抜）を2回読む（当月までの13か月の PL と当月末の BS、前の月末の BS）。
// 課題の書き込みはまだ保存しない（保存と共有の記録は移行を足す次の段。計画の香盤表 #8）。ページを閉じると消えるので、書いたら出力する。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {yen} from '../ui/format.mjs';
import {monthLabel} from '../reports/pl-bs-model.mjs';
import {buildMonthlyReport, monthlyQueries, monthlySheets, bpsLabel, isMonth} from './monthly-report-model.mjs';

const yenCol = (key, label, extra = {}) => ({key, label, type: 'yen', ...extra});
const PL_COLUMNS = [
  {key: 'label', label: '科目', type: 'text', sticky: true},
  yenCol('actual', '当月'), yenCol('prev', '先月'), yenCol('diffPrev', '先月との差'),
  {key: 'ratePrevBps', label: '先月比', type: 'text', value: (r) => bpsLabel(r.ratePrevBps)},
  yenCol('lastYear', '前年同月'), yenCol('diffLastYear', '前年同月との差'),
];
const BS_COLUMNS = [{key: 'label', label: '科目', type: 'text', sticky: true}, yenCol('value', '月末'), yenCol('prev', '前の月末'), yenCol('diff', '増減')];
const signed = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${yen(Math.abs(v))}`);

function useMonthly(month) {
  const shell = useShell();
  const [state, setState] = useState({});
  useEffect(() => {
    if (!isMonth(month)) { setState({}); return undefined; }
    let live = true;
    const q = monthlyQueries(month);
    setState({loading: true});
    Promise.all([q.current, q.previous].map((c) => shell.request(`/reports/pl-bs?${new URLSearchParams(c)}`)))
      .then(([currentBody, previousBody]) => { if (live) setState({report: buildMonthlyReport({month, currentBody, previousBody})}); })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [month]);
  return state;
}

export function MonthlyReport({defaultMonth}) {
  const shell = useShell();
  const param = shell.getParam('reportMonth', '');
  const month = isMonth(param) ? param : defaultMonth;
  const state = useMonthly(month);
  const [notes, setNotes] = useState({});
  const report = state.report;
  const setNote = (key, field, value) => setNotes((all) => ({...all, [key]: {...(all[key] || {}), [field]: value}}));
  const worse = report ? report.issues.filter((i) => i.worse) : [];
  const better = report ? report.issues.filter((i) => !i.worse) : [];
  const written = useMemo(() => worse.filter((i) => notes[i.key]?.cause && notes[i.key]?.action).length, [worse, notes]);
  const renderIssue = (issue) => (
    <div key={issue.key} className={`plbs-issue${issue.worse ? ' is-worse' : ''}`}>
      <strong>{issue.title}</strong>
      <div className="plbs-issue-fields">
        <FormField label="原因" value={notes[issue.key]?.cause || ''} onChange={(v) => setNote(issue.key, 'cause', v)} />
        <FormField label="打ち手" value={notes[issue.key]?.action || ''} onChange={(v) => setNote(issue.key, 'action', v)} />
        <FormField type="date" label="期限" value={notes[issue.key]?.due || ''} onChange={(v) => setNote(issue.key, 'due', v)} />
      </div>
    </div>
  );

  return (
    <section className="card rp-report plbs-monthly" aria-label="月次の報告">
      <header className="rp-head">
        <div>
          <h2>月次の報告{report ? `（${monthLabel(report.month)}）` : ''}</h2>
          <p className="rp-muted">計上・税抜</p>
        </div>
        <FormField type="month" label="月" value={month || ''} onChange={(value) => { if (!value || isMonth(value)) shell.setParam('reportMonth', value || null, {replace: true}); }} />
      </header>
      {state.error && <Notice error={state.error} />}
      {!report && !state.error && <p className="rp-muted">{state.loading ? '集計中…' : '月未選択'}</p>}
      {report && (
        <>
          {report.notes.map((n) => <Notice key={n} tone="warn" message={n} />)}
          <div className="rp-tiles">
            {report.kpis.map((k) => (
              <div key={k.key} className={k.diffPrev < 0 ? 'is-warn' : ''}>
                <span>{k.label}</span>
                <strong>{k.type === 'bps' ? bpsLabel(k.value) : yen(k.value)}</strong>
                <small>先月比 {k.type === 'bps' ? (k.diffPrev === null ? '—' : `${k.diffPrev >= 0 ? '+' : ''}${bpsLabel(k.diffPrev)}`.replace('%', 'pt')) : signed(k.diffPrev)}</small>
              </div>
            ))}
          </div>
          <h3>PL</h3>
          <DataGrid columns={PL_COLUMNS} rows={report.plRows} rowKey="key" showTotals={false} ariaLabel="月次のPL" exportSpec={{name: '月次のPL'}} />
          <h3>BS（{monthLabel(report.month)}末）</h3>
          {report.bsRows.length ? <DataGrid columns={BS_COLUMNS} rows={report.bsRows} rowKey="key" showTotals={false} ariaLabel="月次のBS" exportSpec={{name: '月次のBS'}} />
            : <p className="rp-muted">BSなし</p>}
          <h3>課題 <span className="rp-muted">{worse.length ? `原因と打ち手 ${written}/${worse.length}` : '悪い向きの差はありません'}</span></h3>
          {worse.map(renderIssue)}
          {better.length > 0 && (
            <details className="plbs-rules">
              <summary>良い向きの差（{better.length}件。書いたものだけ報告に載る）</summary>
              {better.map(renderIssue)}
            </details>
          )}
          <p className="rp-muted">原因・打ち手は保存されません。閉じる前に Excel・印刷で出力してください。</p>
          <ReportOutputBar sheets={() => monthlySheets(report, notes)} name="月次の報告" period={report.month} title={`月次の報告 ${monthLabel(report.month)}`} formats={['xlsx', 'print']} />
        </>
      )}
    </section>
  );
}

export default MonthlyReport;
