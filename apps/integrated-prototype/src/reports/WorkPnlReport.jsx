// 作品別収支（正式版）。作品と期間を選ぶと、作品計（売上・経費・差額）、流通別カード、月別表（合計行つき）、
// 未配賦の経費（作品計に含めない）を出す。売上は帳票センターの年間売上と同じ配賦・計上月・税抜で数える。
// 制作費（会計の対応で公開月一括のもの）は作品の経費として計上月で差し引く（作品別PLは公開月に一括）。条件は URL に残る。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {useConditions, ConditionBar} from '../ui/ConditionBar.jsx';
import {DataGrid} from '../ui/DataGrid.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {Notice} from '../ui/Notice.jsx';
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {yen, int, dateTimeJst} from '../ui/format.mjs';
import {describeConditions} from '../ui/condition-model.mjs';
import {checksOk, salesDetailParams, EXPENSE_ONLY_CARD, OUT_OF_SCOPE_NOTE} from './work-pnl-model.mjs';
import './reports.css';

const CONDITIONS = ['fiscalYear', 'period', 'work'];

const CARD_COLUMNS = [
  {key: 'label', label: '流通', type: 'text', sticky: true},
  {key: 'sales', label: '売上（税抜）', type: 'yen', total: 'sum'},
  {key: 'expense', label: '経費（流通に紐づく分）', type: 'yen', total: 'sum'},
  {key: 'balance', label: '差額', type: 'yen', total: 'sum'},
  {key: 'lineCount', label: '売上明細の件数', type: 'int', total: 'sum'},
  {key: 'deals', label: '取引区分', type: 'text', value: (row) => (row.deals || []).join('、')},
  {key: 'partners', label: '取引先', type: 'text', wrap: true, value: (row) => (row.partners || []).join('、')},
];
const LINE_COLUMNS = [
  {key: 'accounting_month', label: '計上月', type: 'month', sticky: true},
  {key: 'distribution_label', label: '流通', type: 'text'},
  {key: 'partner_name', label: '取引先', type: 'text'},
  {key: 'product_name', label: '商品', type: 'text'},
  {key: 'description', label: '内容', type: 'text', wrap: true},
  {key: 'deal_label', label: '取引区分', type: 'text'},
  {key: 'allocation', label: '作品への配賦率', type: 'rate', total: 'none', value: (row) => (row.allocation_bps == null ? null : row.allocation_bps / 10000)},
  {key: 'amount', label: '売上（税抜・配賦後）', type: 'yen', total: 'sum'},
  {key: 'quantity', label: '数量', type: 'int', total: 'sum', hidden: true},
  {key: 'report_key', label: '報告キー', type: 'code', hidden: true},
  {key: 'source_row', label: '原本の行', type: 'int', total: 'none', hidden: true},
  {key: 'product_sku', label: '商品SKU', type: 'code', hidden: true},
];
const EXPENSE_COLUMNS = [
  {key: 'accounting_month', label: '計上月', type: 'month', sticky: true},
  {key: 'incurred_on', label: '発生日', type: 'date'},
  {key: 'category', label: '費目', type: 'text'},
  {key: 'description', label: '内容', type: 'text', wrap: true},
  {key: 'partner_name', label: '支払先', type: 'text'},
  {key: 'actual_ex_tax', label: '税抜', type: 'yen', total: 'sum'},
  {key: 'tax_amount', label: '税額', type: 'yen', total: 'sum', hidden: true},
  {key: 'actual_inc_tax', label: '税込', type: 'yen', total: 'sum', hidden: true},
];
const CHECK_COLUMNS = [{key: 'item', label: '項目', type: 'text'}, {key: 'value', label: '差額', type: 'yen'}];
const KV_COLUMNS = [{key: 'k', label: '項目', type: 'text'}, {key: 'v', label: '内容', type: 'text', wrap: true, width: 80}];

function monthColumns(cards) {
  const distributions = cards.filter((card) => card.kind === 'distribution');
  return [
    {key: 'month', label: '計上月', type: 'month', sticky: true},
    {key: 'sales', label: '売上（税抜）', type: 'yen', total: 'sum'},
    {key: 'expense', label: '経費（税抜）', type: 'yen', total: 'sum'},
    {key: 'balance', label: '差額（売上−経費）', type: 'yen', total: 'sum'},
    ...distributions.map((card) => ({
      key: `d:${card.code}`, label: `売上のうち ${card.label}`, type: 'yen', total: 'sum', hidden: distributions.length > 4,
      value: (row) => row.byDistribution?.[card.code] ?? 0,
    })),
  ];
}

const negative = (value) => (value < 0 ? {color: 'var(--bad)'} : undefined);

function CardFigures({card}) {
  return (
    <dl className="sl-detail">
      <div><dt>売上（税抜）</dt><dd>{card.kind === 'distribution' ? yen(card.sales) : '—'}</dd></div>
      <div><dt>経費（税抜）</dt><dd>{card.expenseLinked ? yen(card.expense) : '流通別の記録なし'}</dd></div>
      <div><dt>差額</dt><dd style={negative(card.balance)}>{yen(card.balance)}</dd></div>
    </dl>
  );
}

export function WorkPnlReport({data, fiscal, onNavigate}) {
  const shell = useShell();
  const request = shell.request;
  const navigate = onNavigate || shell.navigate;
  const defaults = useMemo(() => (shell.workId ? {work: String(shell.workId)} : {}), [shell.workId]);
  const values = useConditions(CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth, defaults});
  const [state, setState] = useState({});
  const [openCard, setOpenCard] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const works = data?.works || [];

  const query = useMemo(() => (values.workId && values.from && values.to
    ? new URLSearchParams({workId: values.workId, from: values.from, to: values.to}).toString() : ''), [values.workId, values.from, values.to]);

  useEffect(() => {
    setOpenCard(null);
    if (!query || !values.valid) { setState({}); return undefined; }
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null, failure: null}));
    request(`/reports/work-pnl?${query}`)
      .then((body) => { if (live) setState(body?.ok === false ? {failure: body.error || '集計できませんでした'} : {body}); })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [query, values.valid, request, reloadKey]);

  const body = state.body;
  const workTitle = body?.work?.title || works.find((w) => String(w.id) === String(values.workId))?.title || '';
  const title = workTitle ? `作品別収支（${workTitle}）` : '作品別収支';
  const names = useMemo(() => ({work: Object.fromEntries(works.map((w) => [String(w.id), w.title]))}), [works]);
  const columns = useMemo(() => monthColumns(body?.cards || []), [body]);
  const ok = body ? checksOk(body.checks) : false;
  const t = body?.totals;
  const open = body && openCard ? body.cards.find((card) => (card.code ?? EXPENSE_ONLY_CARD) === openCard) : null;

  function sheets() {
    const conditions = [...describeConditions(values, CONDITIONS, {names}), ['集計の基準', '計上月・税抜']];
    const dataAsOf = body.dataAsOf?.latestImportAt;
    const spec = (name, sheetTitle, notes) => ({name, title: sheetTitle, conditions, dataAsOf, notes});
    return [
      {name: '作品計', title, conditions, dataAsOf, columns: KV_COLUMNS, freezeCols: 1, rows: [
        {k: '作品', v: `${body.work.title}（${body.work.code}）`}, {k: '期間', v: values.periodLabel},
        {k: '売上（税抜）', v: yen(t.sales)}, {k: '経費（税抜・作品に付いた分）', v: yen(t.expense)}, {k: '差額（売上−経費）', v: yen(t.balance)},
        {k: '経費のうち制作費', v: `${yen(body.productionCost.amount)}（${body.productionCost.note}）`},
        {k: '未配賦の経費', v: `${int(body.unallocated.count)}件・${yen(body.unallocated.total)}（作品計に含めていません）`},
        {k: '集計の基準', v: body.basisNote}, {k: '範囲', v: body.scope}, {k: '範囲外', v: body.outOfScope || OUT_OF_SCOPE_NOTE},
        {k: '照合', v: ok ? '照合OK（月別・流通別・明細の和＝作品計）' : '照合NG（照合シートを確かめてください）'},
      ]},
      gridSheetSpec({columns: CARD_COLUMNS, rows: body.cards, exportSpec: spec('流通別', `${title} 流通別`,
        ['経費には流通の区分が無いため、作品の経費は「流通に紐づかない経費」の行にまとめています。'])}),
      gridSheetSpec({columns: columns.map((c) => ({...c, hidden: false})), rows: body.monthly, exportSpec: spec('月別', `${title} 月別`)}),
      gridSheetSpec({columns: LINE_COLUMNS.map((c) => ({...c, hidden: false})), rows: body.lines, exportSpec: spec('売上明細', `${title} 売上明細（作品へ配賦後）`)}),
      gridSheetSpec({columns: EXPENSE_COLUMNS.map((c) => ({...c, hidden: false})), rows: body.expenses, exportSpec: spec('経費明細', `${title} 経費明細`)}),
      gridSheetSpec({columns: EXPENSE_COLUMNS.map((c) => ({...c, hidden: false})), rows: body.unallocated.rows, exportSpec: spec('未配賦の経費', '作品の決まっていない案件の経費（作品計に含めていません）')}),
      {name: '照合', title: '照合', conditions, dataAsOf, columns: CHECK_COLUMNS, rows: body.checks, freezeCols: 1},
    ];
  }

  function toggleCard(card) {
    const key = card.code ?? EXPENSE_ONLY_CARD;
    setOpenCard((previous) => (previous === key ? null : key));
  }

  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted">作品計・流通別・月別の売上と経費、その差額です。売上は年間売上と同じ数え方（商品の作品配賦・計上月・税抜）。作品の決まっていない案件の経費は別の表に出し、差し引きません。</p>
        </div>
        {body && <ReportOutputBar sheets={sheets} name={`作品別収支_${body.work.title}`} period={`${values.from}〜${values.to}`} title={title} subtitle={values.periodLabel} formats={['xlsx', 'print', 'html', 'csv']} />}
      </header>
      <ConditionBar conditions={CONDITIONS} values={values} works={works} fiscalConfirmed={fiscal?.confirmed} labels={{work: '作品（必須）'}} />
      {!works.length && <Notice tone="info" message="閲覧できる作品がありません。作品の財務権限がある案件のメンバーになると、ここで収支を確かめられます。" />}
      {works.length > 0 && !values.workId && <Notice tone="info" message="作品を選ぶと、作品計・流通別・月別の収支が出ます。" />}
      {state.error && <Notice error={state.error} onRetry={() => setReloadKey((n) => n + 1)} />}
      {state.failure && <Notice tone="error" message={state.failure} />}
      {state.loading && !body && <p className="rp-muted" aria-busy="true">集計中…</p>}
      {body && (
        <>
          <div className="rp-tiles">
            <div><span>売上（税抜）</span><strong>{yen(t.sales)}</strong></div>
            <div><span>経費（税抜・作品に付いた分）</span><strong>{yen(t.expense)}</strong></div>
            <div><span>差額（売上−経費）</span><strong style={negative(t.balance)}>{yen(t.balance)}</strong></div>
            <div><span>経費のうち制作費</span><strong>{yen(body.productionCost.amount)}</strong><span>{body.productionCost.count ? '計上月で差し引き済み（作品別PLは公開月に一括）' : 'この期間の経費なし'}</span></div>
          </div>
          <div className="rp-meta">
            <span className={`rp-check ${ok ? 'is-ok' : 'is-bad'}`}>{ok ? '照合OK: 月別・流通別・明細の和＝作品計' : '照合NG: 照合シートを確かめてください'}</span>
            <span>データ時点: 最終取込 {body.dataAsOf.latestImportAt ? dateTimeJst(body.dataAsOf.latestImportAt) : 'なし'}（JST）</span>
            <span>売上明細 {int(body.lineCount)}件・経費 {int(body.expenseCount)}件</span>
          </div>
          <p className="rp-muted">{body.productionCost.label}: {body.productionCost.note}</p>
          {body.unallocated.count > 0 && (
            <Notice tone="info" compact message={`作品の決まっていない案件の経費が${int(body.unallocated.count)}件（${yen(body.unallocated.total)}）あります。作品計には含めていません（下の「未配賦の経費」）。`} />
          )}

          <h3 className="rp-group-title">流通別</h3>
          {body.cards.length === 0
            ? <p className="empty">この期間の売上・経費はありません。</p>
            : (
              <ul className="rp-cards" aria-label="流通別の収支">
                {body.cards.map((card) => {
                  const key = card.code ?? EXPENSE_ONLY_CARD;
                  const expanded = openCard === key;
                  return (
                    <li key={key}>
                      <article className={`rp-card${expanded ? ' is-selected' : ''}`} aria-label={card.label}>
                        <span className="rp-card-title">{card.label}</span>
                        <CardFigures card={card} />
                        {card.deals.length > 0 && <span className="rp-card-formats">{card.deals.map((deal) => <span key={deal} className="rp-badge">取引区分: {deal}</span>)}</span>}
                        <span className="rp-card-desc">
                          {card.kind === 'distribution'
                            ? `売上明細 ${int(card.lineCount)}件${card.partners.length ? `・${card.partners.join('、')}` : ''}`
                            : `作品の経費 ${int(card.expenseCount)}件（経費には流通の区分がありません）`}
                        </span>
                        <div className="rp-filter">
                          <button type="button" className="secondary" aria-expanded={expanded} onClick={() => toggleCard(card)}>
                            {expanded ? '明細を閉じる' : 'この画面で明細を開く'}
                          </button>
                          {card.kind === 'distribution' && navigate && (
                            <button type="button" className="secondary"
                              onClick={() => navigate('売上', salesDetailParams({workId: body.work.id, from: values.from, to: values.to, distribution: card.code}))}>
                              明細を見る（売上明細へ）
                            </button>
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
                ? <DataGrid columns={LINE_COLUMNS} rows={body.lines.filter((line) => line.distribution_code === open.code)} rowKey={(row) => `${row.id}:${row.allocation_bps}`}
                  persistKey="work-pnl-lines" maxHeight="40vh" emptyText="この流通の明細はありません" ariaLabel={`${open.label}の売上明細`} />
                : <DataGrid columns={EXPENSE_COLUMNS} rows={body.expenses} rowKey="id" persistKey="work-pnl-expenses" maxHeight="40vh" emptyText="経費はありません" ariaLabel="作品の経費" />}
            </div>
          )}

          <h3 className="rp-group-title">月別（合計行つき）</h3>
          <DataGrid columns={columns} rows={body.monthly} rowKey="month" persistKey="work-pnl-monthly" totalLabel="合計" ariaLabel="月別の収支" />

          <h3 className="rp-group-title">作品の経費（明細）</h3>
          <DataGrid columns={EXPENSE_COLUMNS} rows={body.expenses} rowKey="id" persistKey="work-pnl-expenses" maxHeight="40vh" emptyText="この期間の作品の経費はありません" ariaLabel="作品の経費" />

          <h3 className="rp-group-title">未配賦の経費（作品計に含めていません）</h3>
          <DataGrid columns={EXPENSE_COLUMNS} rows={body.unallocated.rows} rowKey="id" persistKey="work-pnl-unallocated" maxHeight="40vh"
            emptyText="この期間に、作品の決まっていない経費はありません" ariaLabel="未配賦の経費" />
          <p className="rp-muted">{body.outOfScope || OUT_OF_SCOPE_NOTE}</p>
        </>
      )}
    </section>
  );
}

export default WorkPnlReport;
