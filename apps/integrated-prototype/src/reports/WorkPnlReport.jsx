// 作品別収支（正式版）。作品と期間を選ぶと、作品計（売上・経費・差額）、流通別カード、月別表（合計行つき）、
// 未配賦の経費（作品計に含めない）を出す。売上は帳票センターの年間売上と同じ配賦・計上月・税抜で数える。
// 制作費（会計の対応で公開月一括のもの）は作品の経費として計上月で差し引く（作品別PLは公開月に一括）。条件は URL に残る。
// 画面の表・Excel・印刷は、API が返す1つの文書データ（accounting/work-pnl/work-pnl-document.mjs。計画の K-5）から出す。
// 画面の中で集計しない。照合（checks）が全部 OK でない文書は出力しない（report-output.mjs の documentExportBlock）。
// data-ready: 読んだ応答の sourceHash を、その応答を描き終えたときだけ付ける（読み込み中・条件を変えた直後・誤りのあいだは付けない）。
// 付けるかどうかは use-work-pnl-document.mjs（work-pnl-model.mjs の workPnlReadyHash）が決め、ここは渡された hash を描くだけ。
import React, {useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {useConditions, ConditionBar} from '../ui/ConditionBar.jsx';
import {DataGrid} from '../ui/DataGrid.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {Notice} from '../ui/Notice.jsx';
import {yen, int, dateTimeJst} from '../ui/format.mjs';
import {checkPassed, documentChecksOk} from '../report-output.mjs';
import {salesDetailParams, splitList, EXPENSE_ONLY_CARD} from './work-pnl-model.mjs';
import {useWorkPnlDocument} from './use-work-pnl-document.mjs';
import './reports.css';

// 基準（計上・入金。フェーズ1 #16）は URL の basis。既定は計上で、会社PLの内訳から開くと会社PLと同じ基準になる
const CONDITIONS = ['fiscalYear', 'period', 'cashBasis', 'work'];
const BPS_DENOMINATOR = 10000;
const HEAD_NOTES = Object.freeze({
  accrual: '作品計・流通別・月別の売上と経費、その差額です。売上は年間売上と同じ数え方（商品の作品配賦・計上月・税抜）。作品の決まっていない案件の経費は別の表に出し、差し引きません。',
  cash: '作品計・流通別・月別の入金と出金（税抜）、その差額です。売上は請求の入金を入金日の月に、経費は出金日の月に並べます。税抜にできない入出金は「未確定」の表に税込で出し、作品計に入れません（U-5）。',
});

const tableOf = (doc, name) => doc?.tables?.find((table) => table.name === name) || {columns: [], rows: []};
const summaryOf = (doc) => Object.fromEntries(tableOf(doc, 'summary').rows.map((row) => [row.code, row]));

// 文書データの列 → 表（DataGrid）の列。表示の指定（固定・隠す・折り返し・合計）だけを足す。率（bp）は表示のときだけ割合にする
function gridColumns(table, hints = {}) {
  return table.columns.map((column) => {
    const hint = hints[column.key] || {};
    const spec = {key: column.key, label: column.label, type: column.type === 'bps' ? 'rate' : column.type, total: column.type === 'yen' ? 'sum' : 'none', ...hint};
    if (column.type === 'bps') spec.value = (row) => (row[column.key] == null ? null : row[column.key] / BPS_DENOMINATOR);
    return spec;
  });
}
const LINE_HINTS = {accounting_month: {sticky: true}, description: {wrap: true}, quantity: {hidden: true, total: 'sum'}, report_key: {hidden: true}, source_row: {hidden: true}, product_sku: {hidden: true}};
const EXPENSE_HINTS = {accounting_month: {sticky: true}, description: {wrap: true}, tax_amount: {hidden: true}, actual_inc_tax: {hidden: true}};
// 入金ベースの明細（入金日・出金日を先頭に固定し、元の計上月と記録の番号は隠す）
const CASH_LINE_HINTS = {received_on: {sticky: true}, description: {wrap: true}, accounting_month: {hidden: true}, receipt_id: {hidden: true}, invoice_id: {hidden: true}, report_key: {hidden: true}};
const CASH_EXPENSE_HINTS = {paid_on: {sticky: true}, description: {wrap: true}, accounting_month: {hidden: true}, expense_id: {hidden: true}};
const UNSETTLED_HINTS = {on: {sticky: true}, reasonLabel: {wrap: true}, ref: {hidden: true}};
// 明細の行の識別（入金ベースは入金×売上明細×日付、計上は売上明細×配賦率）
const lineKey = (row) => (row.receipt_id == null ? `${row.id}:${row.allocation_bps}` : `${row.receipt_id}:${row.id}:${row.received_on}`);

const negative = (value) => (value < 0 ? {color: 'var(--bad)'} : undefined);

function CardFigures({card, nullText}) {
  return (
    <dl className="sl-detail">
      <div><dt>売上（税抜）</dt><dd>{card.kind === 'distribution' ? yen(card.sales) : '—'}</dd></div>
      <div><dt>経費（税抜）</dt><dd>{card.expense === null ? nullText : yen(card.expense)}</dd></div>
      <div><dt>差額</dt><dd style={negative(card.balance)}>{yen(card.balance)}</dd></div>
    </dl>
  );
}

// 文書データだけから描く部分（試験はここを文字列に描いて確かめる）。readyHash はその文書の sourceHash と同じときだけ data-ready に付ける
export function WorkPnlDocumentView({doc, readyHash = null, onOpenSales}) {
  const [openCard, setOpenCard] = useState(null);
  const summary = summaryOf(doc);
  const distributions = tableOf(doc, 'distributions');
  const monthly = tableOf(doc, 'monthly');
  const lines = tableOf(doc, 'lines');
  const expenses = tableOf(doc, 'expenses');
  const unallocated = tableOf(doc, 'unallocated');
  const cash = doc.basis === 'cash';
  const unsettled = cash ? tableOf(doc, 'unsettled') : null;
  const ok = documentChecksOk(doc);
  const cardCount = distributions.rows.filter((row) => row.kind === 'distribution').length;
  const monthColumns = useMemo(() => gridColumns(monthly, Object.fromEntries(monthly.columns.map((column) => (
    [column.key, column.key === 'month' ? {sticky: true} : column.key.startsWith('d:') ? {hidden: cardCount > 4} : {}]
  )))), [monthly, cardCount]);
  const lineColumns = useMemo(() => gridColumns(lines, cash ? CASH_LINE_HINTS : LINE_HINTS), [lines, cash]);
  const expenseColumns = useMemo(() => gridColumns(expenses, cash ? CASH_EXPENSE_HINTS : EXPENSE_HINTS), [expenses, cash]);
  const unallocatedColumns = useMemo(() => gridColumns(unallocated, cash ? CASH_EXPENSE_HINTS : EXPENSE_HINTS), [unallocated, cash]);
  const unsettledColumns = useMemo(() => (unsettled ? gridColumns(unsettled, UNSETTLED_HINTS) : []), [unsettled]);
  const expenseNullText = distributions.columns.find((column) => column.key === 'expense')?.nullText ?? '—';
  const production = summary.productionCost || {};
  const keyOf = (card) => card.code ?? EXPENSE_ONLY_CARD;
  const open = openCard ? distributions.rows.find((card) => keyOf(card) === openCard) : null;
  const note = (code) => doc.notes?.find((item) => item.code === code)?.text;
  const checks = doc.checks || [];

  return (
    <div className="rp-document" data-source-hash={doc.sourceHash || undefined} data-ready={readyHash && readyHash === doc.sourceHash ? readyHash : undefined}>
      <div className="rp-tiles">
        <div><span>{summary.sales?.item || '売上（税抜）'}</span><strong>{yen(summary.sales?.amount)}</strong></div>
        <div><span>{summary.expense?.item || '経費（税抜・作品に付いた分）'}</span><strong>{yen(summary.expense?.amount)}</strong></div>
        <div><span>差額（売上−経費）</span><strong style={negative(summary.balance?.amount)}>{yen(summary.balance?.amount)}</strong></div>
        <div><span>経費のうち制作費</span><strong>{yen(production.amount)}</strong><span>{production.status !== 'included' ? 'この期間の経費なし' : cash ? '出金した月で差し引き済み（作品別PLの計上は公開月に一括）' : '計上月で差し引き済み（作品別PLは公開月に一括）'}</span></div>
        {cash && (
          <div className={summary.unsettledIn?.amount || summary.unsettledOut?.amount ? 'is-warn' : ''}>
            <span>未確定の入金・出金（税込）</span><strong>{yen(summary.unsettledIn?.amount)}・{yen(summary.unsettledOut?.amount)}</strong><span>作品計に入れていません（U-5）</span>
          </div>
        )}
      </div>
      <div className="rp-meta">
        <span className={`rp-check ${ok ? 'is-ok' : 'is-bad'}`}>{ok ? '照合OK: 月別・流通別・明細の和＝作品計' : '照合NG: 下の照合の内訳を確かめてください'}</span>
        <span>データ時点: {doc.dataAsOf?.label || '最終取込'} {doc.dataAsOf?.at ? dateTimeJst(doc.dataAsOf.at) : 'なし'}（JST）</span>
        <span>{cash ? '入金の明細' : '売上明細'} {int(lines.rows.length)}件・{cash ? '経費の出金' : '経費'} {int(expenses.rows.length)}件</span>
        <span>{(doc.conditions || []).map((item) => `${item.label} ${item.value}`).join(' ／ ')}</span>
      </div>
      {cash && note('unsettled') && <Notice tone="warn" compact message={note('unsettled')} />}
      {cash && note('unattached_receipts') && <Notice tone="warn" compact message={note('unattached_receipts')} />}
      {note('production_cost') && <p className="rp-muted">{note('production_cost')}</p>}
      {note('production_cost_exceeds') && <Notice tone="warn" compact message={note('production_cost_exceeds')} />}
      {unallocated.rows.length > 0 && (
        <Notice tone="info" compact message={`作品の決まっていない案件の経費が${int(unallocated.rows.length)}件（${yen(summary.unallocated?.amount)}）あります。作品計には含めていません（下の「未配賦の経費」）。`} />
      )}

      <h3 className="rp-group-title">{distributions.title || '流通別'}</h3>
      {distributions.rows.length === 0
        ? <p className="empty">この期間の売上・経費はありません。</p>
        : (
          <ul className="rp-cards" aria-label="流通別の収支">
            {distributions.rows.map((card) => {
              const key = keyOf(card);
              const expanded = openCard === key;
              return (
                <li key={key}>
                  <article className={`rp-card${expanded ? ' is-selected' : ''}`} aria-label={card.label}>
                    <span className="rp-card-title">{card.label}</span>
                    <CardFigures card={card} nullText={expenseNullText} />
                    {card.deals && (
                      <span className="rp-card-formats">{splitList(card.deals).map((deal) => <span key={deal} className="rp-badge">取引区分: {deal}</span>)}</span>
                    )}
                    <span className="rp-card-desc">
                      {card.kind === 'distribution'
                        ? `売上明細 ${int(card.lineCount)}件${card.partners ? `・${card.partners}` : ''}`
                        : `作品の経費 ${int(card.expenseCount)}件（経費には流通の区分がありません）`}
                    </span>
                    <div className="rp-filter">
                      <button type="button" className="secondary" aria-expanded={expanded} onClick={() => setOpenCard((previous) => (previous === key ? null : key))}>
                        {expanded ? '明細を閉じる' : 'この画面で明細を開く'}
                      </button>
                      {card.kind === 'distribution' && onOpenSales && (
                        <button type="button" className="secondary" onClick={() => onOpenSales(card.code)}>明細を見る（売上明細へ）</button>
                      )}
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      {open && (
        <div className="rp-drill">
          <p className="rp-drill-head"><strong>{open.label}</strong>の明細</p>
          {open.kind === 'distribution'
            ? <DataGrid columns={lineColumns} rows={lines.rows.filter((line) => line.distribution_code === open.code)} rowKey={lineKey}
              persistKey={cash ? 'work-pnl-cash-lines' : 'work-pnl-lines'} maxHeight="40vh" emptyText="この流通の明細はありません" ariaLabel={`${open.label}の${lines.title || '売上明細'}`} />
            : <DataGrid columns={expenseColumns} rows={expenses.rows} rowKey="id" persistKey="work-pnl-expenses" maxHeight="40vh" emptyText="経費はありません" ariaLabel="作品の経費" />}
        </div>
      )}

      <h3 className="rp-group-title">{monthly.title || '月別'}（合計行つき）</h3>
      <DataGrid columns={monthColumns} rows={monthly.rows} rowKey="month" persistKey="work-pnl-monthly" totalLabel="合計" ariaLabel="月別の収支" />

      <h3 className="rp-group-title">{expenses.title || '作品の経費'}（明細）</h3>
      <DataGrid columns={expenseColumns} rows={expenses.rows} rowKey="id" persistKey="work-pnl-expenses" maxHeight="40vh" emptyText="この期間の作品の経費はありません" ariaLabel="作品の経費" />

      <h3 className="rp-group-title">{unallocated.title || '未配賦の経費'}（作品計に含めていません）</h3>
      <DataGrid columns={unallocatedColumns} rows={unallocated.rows} rowKey="id" persistKey="work-pnl-unallocated" maxHeight="40vh"
        emptyText="この期間に、作品の決まっていない経費はありません" ariaLabel="未配賦の経費" />
      {unsettled && (
        <>
          <h3 className="rp-group-title">{unsettled.title}</h3>
          <DataGrid columns={unsettledColumns} rows={unsettled.rows} rowKey={(row) => `${row.kind}:${row.ref}:${row.on}`} persistKey="work-pnl-unsettled" maxHeight="40vh" showTotals={false}
            emptyText="この期間に、税抜にできない入出金はありません" ariaLabel="未確定の入出金" />
        </>
      )}
      {note('out_of_scope') && <p className="rp-muted">{note('out_of_scope')}</p>}

      <details className="rp-checks" open={!ok}>
        <summary>照合の内訳（{int(checks.length)}項目・{ok ? 'すべてOK' : `NG ${int(checks.filter((check) => !checkPassed(check)).length)}件`}）</summary>
        <ul>
          {checks.map((check, index) => (
            <li key={check?.code ?? index}>{checkPassed(check) ? 'OK' : 'NG'}: {check?.label || check?.code}{checkPassed(check) ? '' : `（差額 ${check?.value == null ? '—' : yen(check.value)}）`}</li>
          ))}
        </ul>
        <p className="rp-muted">定義の版 {doc.definitionVersion} ／ 出典の hash {doc.sourceHash ? doc.sourceHash.slice(0, 12) : 'なし'}</p>
      </details>
    </div>
  );
}

export function WorkPnlReport({data, fiscal, onNavigate}) {
  const shell = useShell();
  const navigate = onNavigate || shell.navigate;
  const defaults = useMemo(() => (shell.workId ? {work: String(shell.workId)} : {}), [shell.workId]);
  const values = useConditions(CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth, defaults});
  const works = data?.works || [];

  const query = useMemo(() => (values.workId && values.from && values.to
    ? new URLSearchParams({workId: values.workId, from: values.from, to: values.to, basis: values.cashBasis}).toString() : ''), [values.workId, values.from, values.to, values.cashBasis]);
  const {state, doc, hash, reload} = useWorkPnlDocument({request: shell.request, query, valid: values.valid});
  const openSales = navigate && doc ? (code) => navigate('売上', salesDetailParams({workId: state.body.work.id, from: values.from, to: values.to, distribution: code})) : undefined;

  return <WorkPnlReportScreen state={state} doc={doc} readyHash={hash} values={values} works={works} fiscal={fiscal} onRetry={reload} onOpenSales={openSales} />;
}

// 画面の枠（見出し・出力ボタン・条件・知らせ・文書）。状態は WorkPnlReport（use-work-pnl-document.mjs）から受け取るだけ（試験はここを文字列に描く）
export function WorkPnlReportScreen({state = {}, doc = null, readyHash = null, values = {}, works = [], fiscal, onRetry, onOpenSales}) {
  const workTitle = state.body?.work?.title || works.find((w) => String(w.id) === String(values.workId))?.title || '';
  const title = doc?.title || (workTitle ? `作品別収支（${workTitle}）` : '作品別収支');
  // 見出しの基準は、表示中の文書の基準（読み込み中に条件だけ先に変わっても、出している数字の基準を出す）
  const basis = doc?.basis || values.cashBasis || 'accrual';
  const basisText = doc?.conditions?.find((item) => item.key === 'basis')?.value || (basis === 'cash' ? '入金' : '計上');

  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted rp-basis" data-basis={basis}><strong>基準: {basisText}</strong></p>
          <p className="rp-muted">{HEAD_NOTES[basis] || HEAD_NOTES.accrual}</p>
        </div>
        {doc && <ReportOutputBar document={doc} name={`作品別収支_${workTitle}`} period={`${values.from}〜${values.to}`} formats={['xlsx', 'print', 'html', 'csv']} />}
      </header>
      <ConditionBar conditions={CONDITIONS} values={values} works={works} fiscalConfirmed={fiscal?.confirmed} labels={{work: '作品（必須）'}} />
      {!works.length && <Notice tone="info" message="閲覧できる作品がありません。作品の財務権限がある案件のメンバーになると、ここで収支を確かめられます。" />}
      {works.length > 0 && !values.workId && <Notice tone="info" message="作品を選ぶと、作品計・流通別・月別の収支が出ます。" />}
      {state.error && <Notice error={state.error} onRetry={onRetry} />}
      {state.failure && <Notice tone="error" message={state.failure} />}
      {state.loading && !doc && <p className="rp-muted" aria-busy="true">集計中…</p>}
      {state.body && !doc && <Notice tone="error" message="作品別収支の文書データが応答にありません。画面を読み込み直してください。" />}
      {doc && (
        <WorkPnlDocumentView key={state.query} doc={doc} readyHash={readyHash} onOpenSales={onOpenSales} />
      )}
    </section>
  );
}

export default WorkPnlReport;
