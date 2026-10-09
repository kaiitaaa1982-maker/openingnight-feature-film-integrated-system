// 配給委託の精算報告書（権利元×期間。旧「ロイヤリティ報告書」。監督料・脚本料などのロイヤリティは royalty/ の報告書）。権利元を選ぶと送付用の報告書（表紙・一覧・明細・保留・支払記録）、
// 選ばないと会社全体の権利元別の一覧。前回まで／当期／累計と、支払済・未払残を出す。下書き（未発行）。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {useConditions, ConditionBar} from '../ui/ConditionBar.jsx';
import {DataGrid} from '../ui/DataGrid.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {yen, dateTimeJst} from '../ui/format.mjs';
import {describeConditions} from '../ui/condition-model.mjs';
import {IssuePanel} from './IssuePanel.jsx';
import './reports.css';

const CONDITIONS = ['fiscalYear', 'period', 'work'];

const HOLDER_COLUMNS = [
  {key: 'holderName', label: '権利元', type: 'text', sticky: true},
  {key: 'contracts', label: '契約数', type: 'int', total: 'sum'},
  {key: 'prior', label: '前回までの権利元額', type: 'yen', total: 'sum'},
  {key: 'current', label: '当期の権利元額', type: 'yen', total: 'sum'},
  {key: 'cumulative', label: '累計の権利元額', type: 'yen', total: 'sum'},
  {key: 'paid', label: '累計の支払', type: 'yen', total: 'sum'},
  {key: 'unpaid', label: '未払残', type: 'yen', total: 'sum'},
  {key: 'advance', label: 'MG前払（充当未確認）', type: 'yen', total: 'sum'},
  {key: 'holdCount', label: '保留（HOLD）件数', type: 'int', total: 'sum'},
  {key: 'holdReported', label: '保留の対象売上', type: 'yen', total: 'sum'},
];
const CONTRACT_COLUMNS = [
  {key: 'contractCode', label: '契約', type: 'code', sticky: true},
  {key: 'title', label: '契約名', type: 'text'},
  {key: 'workTitle', label: '作品', type: 'text'},
  {key: 'typeLabel', label: '契約の種類', type: 'text', hidden: true},
  {key: 'reportedCurrent', label: '当期の対象売上', type: 'yen', total: 'sum', value: (r) => r.current.reported},
  {key: 'deductionCurrent', label: '当期のPF控除', type: 'yen', total: 'sum', value: (r) => r.current.platformDeduction},
  {key: 'feeCurrent', label: '当期の手数料', type: 'yen', total: 'sum', value: (r) => r.current.agencyFee},
  {key: 'holderPrior', label: '前回までの権利元額', type: 'yen', total: 'sum', value: (r) => r.prior.holderAmount},
  {key: 'holderCurrent', label: '当期の権利元額', type: 'yen', total: 'sum', value: (r) => r.current.holderAmount},
  {key: 'holderCumulative', label: '累計の権利元額', type: 'yen', total: 'sum', value: (r) => r.cumulative.holderAmount},
  {key: 'paidPrior', label: '前回までの支払', type: 'yen', total: 'sum', value: (r) => r.prior.paid},
  {key: 'paidCurrent', label: '当期の支払', type: 'yen', total: 'sum', value: (r) => r.current.paid},
  {key: 'paidCumulative', label: '累計の支払', type: 'yen', total: 'sum', value: (r) => r.cumulative.paid},
  {key: 'unpaid', label: '未払残', type: 'yen', total: 'sum'},
  {key: 'advanceCumulative', label: 'MG前払（充当未確認）', type: 'yen', total: 'sum', value: (r) => r.cumulative.advance},
  {key: 'holdCount', label: '保留件数', type: 'int', total: 'sum', value: (r) => r.cumulative.holdCount},
];
const DETAIL_COLUMNS = [
  {key: 'accountingMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'period', label: '区分', type: 'text'},
  {key: 'contractCode', label: '契約', type: 'code'},
  {key: 'workTitle', label: '作品', type: 'text'},
  {key: 'description', label: '内容', type: 'text', wrap: true},
  {key: 'reportBasis', label: '報告の基準', type: 'text'},
  {key: 'reportedAmount', label: '対象売上', type: 'yen', total: 'sum'},
  {key: 'platformDeduction', label: 'PF控除', type: 'yen', total: 'sum'},
  {key: 'agencyFee', label: '手数料', type: 'yen', total: 'sum'},
  {key: 'holderAmount', label: '権利元額', type: 'yen', total: 'sum'},
  {key: 'status', label: '状態', type: 'text'},
  {key: 'holdReason', label: '保留の理由', type: 'text', wrap: true, hidden: true},
  {key: 'sourceRow', label: '原本の行', type: 'int', total: 'none', hidden: true},
];
const PAYMENT_COLUMNS = [
  {key: 'paidOn', label: '支払日', type: 'date', sticky: true},
  {key: 'period', label: '区分', type: 'text'},
  {key: 'contractCode', label: '契約', type: 'code'},
  {key: 'kind', label: '種類', type: 'text'},
  {key: 'amount', label: '金額', type: 'yen', total: 'sum'},
  {key: 'reference', label: '支払の識別番号', type: 'code'},
  {key: 'reason', label: '根拠', type: 'text', wrap: true},
];

export function RoyaltyStatement({data, fiscal, onNavigate}) {
  const shell = useShell();
  const request = shell.request;
  const values = useConditions(CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth});
  const holderId = shell.getParam('holder', '');
  const [holders, setHolders] = useState([]);
  const [state, setState] = useState({loading: true});

  useEffect(() => {
    let live = true;
    request('/reports/royalty-statement/holders').then((body) => live && setHolders(body.holders || [])).catch(() => {});
    return () => { live = false; };
  }, [request]);
  const query = useMemo(() => {
    const p = new URLSearchParams({from: values.from || '', to: values.to || ''});
    if (holderId) p.set('holderId', holderId);
    if (values.workId) p.set('workId', values.workId);
    return p.toString();
  }, [values.from, values.to, values.workId, holderId]);
  useEffect(() => {
    if (!values.valid || !values.from) return undefined;
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request(`/reports/royalty-statement?${query}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [query, values.valid, values.from, request]);

  const body = state.body;
  const holderName = body?.holder?.name;
  const title = holderName ? `配給委託の精算報告書（${holderName} 様）` : '配給委託の精算報告書（権利元別の一覧）';
  const holderOptions = holders.map((h) => ({value: String(h.id), label: `${h.name}（${h.contracts}契約${h.mgContracts ? `・うちMG ${h.mgContracts}` : ''}）`}));
  const names = useMemo(() => ({work: Object.fromEntries((data?.works || []).map((w) => [String(w.id), w.title]))}), [data]);

  function sheets() {
    const conditions = [...describeConditions(values, CONDITIONS, {names}), ['権利元', holderName || 'すべての権利元']];
    const dataAsOf = body.dataAsOf?.latestImportAt;
    const cover = {name: '表紙', title, conditions, dataAsOf, columns: [{key: 'k', label: '項目', type: 'text'}, {key: 'v', label: '内容', type: 'text', wrap: true, width: 80}],
      rows: [
        {k: '宛先', v: holderName ? `${holderName} 様` : '（権利元を選んでいません。会社内の一覧です）'}, {k: '対象期間', v: values.periodLabel},
        {k: '作成日', v: dateTimeJst(body.dataAsOf.generatedAt)}, {k: '状態', v: '下書き（未発行）'},
        {k: '当期の権利元額', v: yen(body.totals.current)}, {k: '累計の権利元額', v: yen(body.totals.cumulative)},
        {k: '累計の支払', v: yen(body.totals.paid)}, {k: '未払残', v: yen(body.totals.unpaid)},
        ...(body.totals.advance ? [{k: 'MG前払（充当未確認）', v: `${yen(body.totals.advance)}（未払残と相殺していません）`}] : []),
        {k: '保留（HOLD）', v: `${body.totals.holdCount}件・対象売上 ${yen(body.totals.holdReported)}（権利元額に含めていません）`},
        ...body.assumptions.map((a, i) => ({k: i === 0 ? '前提' : '', v: a})),
      ], freezeCols: 1};
    return [
      cover,
      gridSheetSpec({columns: holderName ? CONTRACT_COLUMNS : HOLDER_COLUMNS, rows: holderName ? body.rows : body.holders, exportSpec: {name: '一覧', title: `${title} 一覧`, conditions, dataAsOf}}),
      gridSheetSpec({columns: DETAIL_COLUMNS.map((c) => ({...c, hidden: false})), rows: body.details, exportSpec: {name: '明細', title: `${title} 明細（売上1件×契約1件）`, conditions, dataAsOf}}),
      gridSheetSpec({columns: DETAIL_COLUMNS.map((c) => ({...c, hidden: false})), rows: body.hold, exportSpec: {name: '保留（HOLD）', title: '権利元額を算定できない明細', conditions, dataAsOf}}),
      gridSheetSpec({columns: PAYMENT_COLUMNS, rows: body.payments, exportSpec: {name: '支払記録', title: '支払と取消の記録', conditions, dataAsOf}}),
      {name: '照合', title: '照合', conditions, dataAsOf, columns: [{key: 'item', label: '項目', type: 'text'}, {key: 'value', label: '差額', type: 'yen'}], rows: body.checks, freezeCols: 1},
    ];
  }

  const allOk = body?.checks?.every((c) => c.value === 0);
  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted">個別権利契約の分配の試算と支払記録から、前回まで・当期・累計と未払残を出します。下書き（未発行）です。発行は下の「発行の記録」で行います。送付は人が行います。</p>
        </div>
        {body && <ReportOutputBar sheets={sheets} name={holderName ? `配給委託の精算報告書_${holderName}` : '配給委託の精算報告書_一覧'} period={values.from && values.to ? `${values.from}〜${values.to}` : ''} title={title} subtitle={values.periodLabel} />}
      </header>
      <ConditionBar conditions={CONDITIONS} values={values} works={data?.works || []} fiscalConfirmed={fiscal?.confirmed}>
        <FormField type="select" label="権利元" value={holderId} blankLabel="すべての権利元（一覧）" options={holderOptions} wide onChange={(value) => shell.setParam('holder', value || null)} />
      </ConditionBar>
      {state.error && <Notice error={state.error} />}
      {!holders.length && !state.loading && <Notice tone="info" message="権利元のある個別権利契約がまだありません。「配給委託の精算」で契約を登録し、報告と紐付けると、ここに報告書が出ます。"
        actions={onNavigate ? <button type="button" className="secondary" onClick={() => onNavigate('権利・分配')}>配給委託の精算を開く</button> : null} />}
      {body && (
        <>
          <div className="rp-tiles">
            <div><span>当期の権利元額</span><strong>{yen(body.totals.current)}</strong></div>
            <div><span>累計の権利元額</span><strong>{yen(body.totals.cumulative)}</strong></div>
            <div><span>累計の支払</span><strong>{yen(body.totals.paid)}</strong></div>
            <div><span>未払残</span><strong>{yen(body.totals.unpaid)}</strong></div>
            {body.totals.advance ? <div><span>MG前払（充当未確認）</span><strong>{yen(body.totals.advance)}</strong></div> : null}
            <div><span>保留（HOLD）</span><strong>{body.totals.holdCount}件</strong></div>
          </div>
          <div className="rp-meta">
            <span className={`rp-check ${allOk ? 'is-ok' : 'is-bad'}`}>{allOk ? '照合OK: 前回まで＋当期＝累計、明細の和＝一覧、支払記録の和＝一覧' : '照合NG: 照合シートを確かめてください'}</span>
            <span>前提: {body.assumptions.slice(0, 3).join('・')}</span>
          </div>
          {body.totals.holdCount > 0 && <Notice tone="warn" message={`権利元額を算定できない明細が${body.totals.holdCount}件あります（対象売上 ${yen(body.totals.holdReported)}）。0円として合計に混ぜず、保留として別に示しています。`} />}
          <h3 className="rp-group-title">{holderName ? '契約ごとの一覧' : '権利元ごとの一覧（行を押すとその権利元の報告書）'}</h3>
          {holderName
            ? <DataGrid columns={CONTRACT_COLUMNS} rows={body.rows} rowKey="contractId" persistKey="royalty-contracts" emptyText="この期間の対象はありません" />
            : <DataGrid columns={HOLDER_COLUMNS} rows={body.holders} rowKey="holderId" persistKey="royalty-holders" emptyText="この期間の対象はありません"
              onRowClick={(row) => shell.setParam('holder', String(row.holderId), {replace: false})} />}
          <h3 className="rp-group-title">明細（売上1件×契約1件）</h3>
          <DataGrid columns={DETAIL_COLUMNS} rows={body.details} rowKey="key" persistKey="royalty-details" maxHeight="50vh" emptyText="この期間の明細はありません" />
          <h3 className="rp-group-title">支払と取消の記録</h3>
          <DataGrid columns={PAYMENT_COLUMNS} rows={body.payments} rowKey="key" persistKey="royalty-payments" maxHeight="40vh" emptyText="支払の記録はありません" />
          <IssuePanel kind="royalty" conditions={{from: values.from, to: values.to, holderId, workId: values.workId}} recipientName={holderName} />
        </>
      )}
      {state.loading && !body && <p className="rp-muted" aria-busy="true">集計中…</p>}
    </section>
  );
}

export default RoyaltyStatement;
