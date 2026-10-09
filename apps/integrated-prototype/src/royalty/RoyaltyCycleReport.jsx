// ロイヤリティ報告書（権利者×締め月）。確定版（/api/royalty/statements/:id）と、確定前の下書き（…/preview）を同じ形で出す。
// 表紙／作品×種別の前回まで・当期・累計／明細／経費の控除／前払金と繰越／調整（イレギュラー）／保留／報告と支払の記録／照合／前提。Excel と印刷。
// 帳票センターの「ロイヤリティ報告書（権利者×締め月）」はこの部品に権利者と締め月の選択を足したもの。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {FormField} from '../ui/FormField.jsx';
import {Notice} from '../ui/Notice.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {yen, dateJst, dateTimeJst, month as monthText} from '../ui/format.mjs';
import {rateText} from './royalty-model.mjs';
import {todayJst} from './royalty-ui.mjs';
import {StatusBadge, ErrorNotice, ReasonAction} from './RoyaltyParts.jsx';
import '../reports/reports.css';
import './royalty.css';

const fig = (pick, label, extra = {}) => ({type: 'yen', total: 'sum', ...extra, label, value: (row) => pick(row)});
const ROW_COLUMNS = [
  {key: 'workTitle', label: '作品', type: 'text', sticky: true},
  {key: 'categoryLabel', label: '種別', type: 'text'},
  {key: 'agreementCode', label: '契約', type: 'code'},
  {key: 'rateText', label: '料率・方法', type: 'text'},
  {key: 'priorAmount', ...fig((r) => r.prior.amountYen, '前回までの額')},
  {key: 'currentSales', ...fig((r) => r.current.salesYen, '当期の売上')},
  {key: 'currentFee', ...fig((r) => r.current.windowFeeYen, '当期の窓口手数料', {hidden: true})},
  {key: 'currentExpense', ...fig((r) => r.current.expenseYen, '当期の経費の控除')},
  {key: 'currentIncome', ...fig((r) => r.current.committeeIncomeYen, '当期の本委員会収入', {hidden: true})},
  {key: 'currentBase', ...fig((r) => r.current.baseYen, '当期の基礎')},
  {key: 'currentAmount', ...fig((r) => r.current.amountYen, '当期の額')},
  {key: 'cumulativeSales', ...fig((r) => r.cumulative.salesYen, '累計の売上', {hidden: true})},
  {key: 'cumulativeAmount', ...fig((r) => r.cumulative.amountYen, '累計の額')},
];
// 調整・前払金の充当の行には売上・基礎が無い（0として「—」を出す。未確認と区別する）
const figure = (key) => (r) => (r.lineKind === 'adjustment' || r.lineKind === 'advance_recoup' ? 0 : r[key] ?? 0);
const LINE_COLUMNS = [
  {key: 'lineNo', label: '行', type: 'int', total: 'none', sticky: true},
  {key: 'lineKindLabel', label: '種類', type: 'text'},
  {key: 'agreementCode', label: '契約', type: 'code', value: (r) => r.agreementCode || '（権利者全体）'},
  {key: 'workTitle', label: '作品', type: 'text', value: (r) => r.workTitle || '—'},
  {key: 'accrualMonth', label: '計上月', type: 'text', value: (r) => (r.accrualMonth ? monthText(r.accrualMonth) : '—')},
  {key: 'salesYen', label: '売上', type: 'yen', value: figure('salesYen')},
  {key: 'windowFeeYen', label: '窓口手数料', type: 'yen', value: figure('windowFeeYen')},
  {key: 'expenseYen', label: '経費', type: 'yen', value: figure('expenseYen')},
  {key: 'committeeIncomeYen', label: '本委員会収入', type: 'yen', hidden: true, value: figure('committeeIncomeYen')},
  {key: 'baseYen', label: '基礎', type: 'yen', value: figure('baseYen')},
  {key: 'rate', label: '料率', type: 'text', value: (r) => (r.rateBps === null || r.rateBps === undefined ? '—' : rateText(r.rateBps))},
  {key: 'amountYen', label: '額', type: 'yen'},
  {key: 'note', label: '備考', type: 'text', wrap: true, value: (r) => r.note || ''},
];
const EXPENSE_COLUMNS = [
  {key: 'accrualMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'agreementCode', label: '契約', type: 'code'},
  {key: 'workTitle', label: '作品', type: 'text'},
  {key: 'category', label: '費目', type: 'text'},
  {key: 'description', label: '内容', type: 'text', wrap: true, value: (r) => r.description || ''},
  {key: 'source', label: '出どころ', type: 'text', value: (r) => (r.source === 'committee' ? '委員会の経費' : '作品の経費')},
  {key: 'amount', label: '控除した額', type: 'yen'},
];
const ADVANCE_COLUMNS = [
  {key: 'agreementCode', label: '契約', type: 'code', sticky: true},
  {key: 'workTitle', label: '作品', type: 'text'},
  {key: 'advanceYen', label: '前払金', type: 'yen'},
  {key: 'cumulativeAfter', label: '報告済みの累計発生額（当期まで）', type: 'yen'},
  {key: 'recoupedBefore', label: '前回までの充当', type: 'yen'},
  {key: 'recoupedNow', label: '当期の充当', type: 'yen'},
  {key: 'remainingYen', label: '前払金の残り', type: 'yen'},
];
const ADJUST_COLUMNS = [
  {key: 'closeMonth', label: '締め月', type: 'month', sticky: true},
  {key: 'agreementCode', label: '契約', type: 'code', value: (r) => r.agreementCode || '（権利者全体）'},
  {key: 'amountYen', label: '額', type: 'yen'},
  {key: 'reason', label: '理由', type: 'text', wrap: true},
  {key: 'sourceReference', label: '根拠の資料', type: 'text', value: (r) => r.sourceReference || ''},
  {key: 'note', label: '備考', type: 'text', wrap: true, value: (r) => r.note || ''},
];
const HOLD_COLUMNS = [
  {key: 'accrualMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'agreementCode', label: '契約', type: 'code'},
  {key: 'workTitle', label: '作品', type: 'text'},
  {key: 'kind', label: '保留の範囲', type: 'text', value: (r) => (r.partial ? '売上の一部' : '発生額すべて')},
  {key: 'holdSalesYen', label: '保留の対象売上', type: 'yen'},
  {key: 'royaltyYen', label: '計算できた額（保留中）', type: 'yen', total: 'none'},
  {key: 'reasons', label: '保留の理由', type: 'text', wrap: true, value: (r) => (r.reasons || []).join('／')},
];
const EVENT_COLUMNS = [
  {key: 'occurredOn', label: '日付', type: 'date', sticky: true},
  {key: 'kindLabel', label: '記録', type: 'text', value: (r) => (r.isReversal ? `${r.kindLabel}の取消` : r.reversed ? `${r.kindLabel}（取消済み）` : r.kindLabel)},
  {key: 'amount', label: '支払額', type: 'yen', value: (r) => (r.amountYen === null ? null : r.isReversal ? -r.amountYen : r.amountYen)},
  {key: 'reference', label: '識別番号', type: 'code', value: (r) => r.reference || ''},
  {key: 'note', label: 'メモ・理由', type: 'text', wrap: true, value: (r) => r.note || ''},
  {key: 'createdByName', label: '記録した人', type: 'text', value: (r) => r.createdByName || ''},
];
const CHECK_COLUMNS = [{key: 'item', label: '照合', type: 'text'}, {key: 'value', label: '差額', type: 'yen', total: 'none'}];
const KV_COLUMNS = [{key: 'k', label: '項目', type: 'text'}, {key: 'v', label: '内容', type: 'text', wrap: true, width: 80}];

function EventForms({statement, request, onSaved}) {
  const shell = useShell();
  const [reportedOn, setReportedOn] = useState(todayJst());
  const remaining = Math.max(0, statement.payableYen - statement.paidYen);
  const [paid, setPaid] = useState({occurredOn: todayJst(), amountYen: remaining ? String(remaining) : '', reference: '', note: ''});
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  if (shell.readOnly || statement.voided) return null;
  async function send(payload, message) {
    setPending(payload.kind);
    setError(null);
    try {
      await request(`/royalty/statements/${statement.id}/events`, {method: 'POST', body: JSON.stringify(payload)});
      onSaved?.(message);
    } catch (cause) { setError(cause); } finally { setPending(null); }
  }
  return (
    <div className="two">
      <section className="subform" aria-label="報告の記録">
        <h4>報告の記録</h4>
        {statement.reportedOn
          ? <p className="rp-muted">{dateJst(statement.reportedOn)}に報告済みです。日付を直すときは、上の記録の行を開いて取り消してから記録します。</p>
          : (
            <div className="ry-actions">
              <FormField type="date" label="報告した日" required value={reportedOn} onChange={setReportedOn} />
              <button type="button" disabled={!reportedOn || pending} onClick={() => send({kind: 'reported', occurredOn: reportedOn}, '報告の日を記録しました')}>{pending === 'reported' ? '記録中…' : '報告を記録'}</button>
            </div>
          )}
      </section>
      <section className="subform" aria-label="支払の記録">
        <h4>支払の記録</h4>
        {statement.payableYen === 0 ? <p className="rp-muted">この期の支払予定額は0円です（翌期へ繰り越し）。</p> : remaining === 0 ? <p className="rp-muted">支払予定額をすべて支払済みです。</p> : (
          <div className="on-form-grid">
            <FormField type="date" label="支払日" required value={paid.occurredOn} onChange={(v) => setPaid((x) => ({...x, occurredOn: v}))} />
            <FormField type="yen" label={`支払額（残り ${yen(remaining)}）`} required value={paid.amountYen} onChange={(v) => setPaid((x) => ({...x, amountYen: v}))} />
            <FormField type="text" label="支払の識別番号（振込の番号など）" required value={paid.reference} onChange={(v) => setPaid((x) => ({...x, reference: v}))} />
            <FormField type="text" label="メモ" value={paid.note} onChange={(v) => setPaid((x) => ({...x, note: v}))} />
            <div className="on-form-actions">
              <button type="button" disabled={!paid.occurredOn || !paid.amountYen || !paid.reference.trim() || pending}
                onClick={() => send({kind: 'paid', occurredOn: paid.occurredOn, amountYen: paid.amountYen, reference: paid.reference, note: paid.note}, '支払を記録しました')}>
                {pending === 'paid' ? '記録中…' : '支払を記録'}
              </button>
            </div>
          </div>
        )}
      </section>
      <ErrorNotice error={error} />
    </div>
  );
}

// statementId があれば確定版、無ければ holderId・closeMonth の下書き
export function RoyaltyStatementView({statementId, holderId, closeMonth, asOf, onNavigate, onChanged}) {
  const shell = useShell();
  const request = shell.request;
  const navigate = onNavigate || shell.navigate;
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState('idle');
  const [createError, setCreateError] = useState(null);
  const [eventDone, setEventDone] = useState('');
  const path = statementId ? `/royalty/statements/${statementId}` : holderId && closeMonth
    ? `/royalty/statements/preview?${new URLSearchParams({holderId: String(holderId), closeMonth, ...(asOf ? {asOf} : {})})}` : null;
  useEffect(() => {
    if (!path) { setState({}); return undefined; }
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request(path).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [path, request, revision]);

  const body = state.body;
  const confirmed = Boolean(body && !body.preview && body.statement);
  const calc = confirmed ? body.calculation : body?.statement;
  const record = confirmed ? body.statement : null;
  const holderName = calc?.holder?.name || '';
  const title = calc ? `ロイヤリティ報告書（${holderName} 様・${monthText(calc.closeMonth)}締め）` : 'ロイヤリティ報告書';
  const reload = () => { setRevision((n) => n + 1); onChanged?.(); };

  if (!path) return <Notice tone="info" message="権利者と締め月を選ぶと、報告書が出ます。" />;
  if (state.error) return <ErrorNotice error={state.error} />;
  if (state.loading && !body) return <p className="rp-muted" aria-busy="true">集計中…</p>;
  if (body && body.preview === false && body.statementId) {
    return <RoyaltyStatementView statementId={body.statementId} asOf={asOf} onNavigate={onNavigate} onChanged={onChanged} />;
  }
  if (!calc) return null;
  const t = calc.totals;
  const checksOk = calc.checks.every((check) => check.value === 0);
  const accrualRange = calc.accrualFrom ? `${monthText(calc.accrualFrom)}〜${monthText(calc.accrualTo)}の計上` : '当期の計上なし';
  const coverRows = [
    {k: '宛先', v: `${holderName} 様`},
    {k: '締め月（対象期間）', v: `${monthText(calc.closeMonth)}締め（${accrualRange}）`},
    {k: '報告期限', v: calc.reportDueOn ? dateJst(calc.reportDueOn) : '未設定'},
    {k: '支払予定日', v: calc.paymentDueOn ? dateJst(calc.paymentDueOn) : '未設定'},
    {k: '支払予定額', v: yen(t.payableYen)},
    {k: '状態', v: confirmed ? `確定版 第${record.versionNo}版（${record.statusLabel}）` : '下書き（未確定）'},
    ...(confirmed ? [{k: '作成', v: `${dateTimeJst(record.createdAt)}・${record.createdByName || ''}（基準日 ${dateJst(record.asOf)}）`}] : []),
    ...(record?.voided ? [{k: '取消', v: `${dateTimeJst(record.voided.createdAt)}・理由: ${record.voided.reason}`}] : []),
  ];
  const carryRows = [
    {k: '前期繰越', v: yen(t.carriedInYen)}, {k: '当期の発生額（報告後の修正を含む）', v: yen(t.royaltyYen)}, {k: '調整（イレギュラー）', v: yen(t.adjustmentYen)},
    {k: '前払金の充当', v: yen(-t.advanceRecoupedYen)}, {k: '残高', v: yen(t.balanceYen)}, {k: '支払の下限', v: t.minPaymentYen ? yen(t.minPaymentYen) : 'なし'},
    {k: '支払予定額', v: yen(t.payableYen)}, {k: '翌期繰越', v: yen(t.carriedOutYen)}, ...(t.carryReason ? [{k: '繰越の理由', v: t.carryReason}] : []),
  ];

  function sheets() {
    const conditions = [['権利者', holderName], ['締め月', monthText(calc.closeMonth)], ['状態', confirmed ? `確定版 第${record.versionNo}版` : '下書き（未確定）']];
    const dataAsOf = confirmed ? record.createdAt : new Date().toISOString();
    const spec = (name, sheetTitle, notes) => ({name, title: sheetTitle, conditions, dataAsOf, notes});
    const list = [
      {name: '表紙', title, conditions, dataAsOf, columns: KV_COLUMNS, rows: coverRows, freezeCols: 1},
      gridSheetSpec({columns: ROW_COLUMNS.map((c) => ({...c, hidden: false})), rows: calc.rows, exportSpec: spec('作品×種別', `${title} 作品×種別（前回まで・当期・累計）`)}),
      gridSheetSpec({columns: LINE_COLUMNS.map((c) => ({...c, hidden: false})), rows: calc.lines, showTotals: false, exportSpec: spec('明細', `${title} 明細`)}),
      gridSheetSpec({columns: EXPENSE_COLUMNS, rows: calc.expenses, exportSpec: spec('経費の控除', '経費の控除')}),
      {name: '前払金と繰越', title: '前払金の充当と繰越', conditions, dataAsOf, columns: KV_COLUMNS, rows: carryRows, freezeCols: 1},
      gridSheetSpec({columns: ADVANCE_COLUMNS, rows: calc.advance, showTotals: false, exportSpec: spec('前払金', '前払金の充当（契約ごと）')}),
      gridSheetSpec({columns: ADJUST_COLUMNS, rows: calc.adjustments, exportSpec: spec('調整', '調整（イレギュラー）')}),
      gridSheetSpec({columns: HOLD_COLUMNS, rows: calc.holds, exportSpec: spec('保留', '保留（0円にせず別に示す）')}),
    ];
    if (confirmed) list.push(gridSheetSpec({columns: EVENT_COLUMNS, rows: record.events, showTotals: false, exportSpec: spec('報告と支払', '報告と支払の記録')}));
    list.push({name: '照合', title: '照合', conditions, dataAsOf, columns: CHECK_COLUMNS, rows: calc.checks, freezeCols: 1});
    list.push({name: '前提', title: '前提', conditions, dataAsOf, columns: [{key: 'v', label: '前提', type: 'text', wrap: true, width: 100}], rows: calc.assumptions.map((v) => ({v}))});
    return list;
  }

  async function createNow() {
    setCreating('saving');
    setCreateError(null);
    try {
      const result = await request('/royalty/statements/generate', {method: 'POST', body: JSON.stringify({asOf: body.asOf, keys: [body.key], expectedHashes: {[body.key]: body.inputHash}, confirmed: true})});
      if (!result.created?.length) throw Object.assign(new Error(result.skipped?.[0]?.reason || '作成できませんでした'), {kind: 'validation'});
      setCreating('idle');
      onChanged?.();
      shell.setParam('statement', String(result.created[0].statementId), {replace: false});
    } catch (cause) { setCreateError(cause); setCreating('confirm'); }
  }

  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted">{confirmed ? '確定版です。内容は変わりません（直すときは取り消して作り直します）。' : '下書きです。いまの売上・経費・条件から計算しています。確定すると内容が固定されます。'}送付は人が行います。</p>
        </div>
        <ReportOutputBar sheets={sheets} name={`ロイヤリティ報告書_${holderName}_${calc.closeMonth}`} title={title} subtitle={accrualRange} formats={['xlsx', 'print', 'html']} />
      </header>
      {record?.voided && <Notice tone="warn" message={`この確定版は取り消されています（${record.voided.reason}）。`} />}
      <div className="ry-cover">
        <div className="ry-cover-head">
          <div>
            <h3>{holderName} 様</h3>
            <p>{monthText(calc.closeMonth)}締め・{accrualRange}</p>
          </div>
          <div>
            <span className="rp-muted">支払予定額</span>
            <div className="ry-payable">{yen(t.payableYen)}</div>
            {confirmed ? <StatusBadge status={record.status} label={record.statusLabel} /> : <StatusBadge status="pending" label="下書き" />}
          </div>
        </div>
        <dl className="ry-kv">
          <div><dt>報告期限</dt><dd>{calc.reportDueOn ? dateJst(calc.reportDueOn) : '未設定'}</dd></div>
          <div><dt>支払予定日</dt><dd>{calc.paymentDueOn ? dateJst(calc.paymentDueOn) : '未設定'}</dd></div>
          <div><dt>当期の発生額</dt><dd>{yen(t.royaltyYen)}</dd></div>
          <div><dt>調整</dt><dd>{yen(t.adjustmentYen)}</dd></div>
          <div><dt>前払金の充当</dt><dd>{yen(t.advanceRecoupedYen)}</dd></div>
          <div><dt>前期繰越 → 翌期繰越</dt><dd>{yen(t.carriedInYen)} → {yen(t.carriedOutYen)}</dd></div>
          {confirmed && <div><dt>報告日・支払済</dt><dd>{record.reportedOn ? dateJst(record.reportedOn) : '報告の記録なし'}・{yen(record.paidYen)}</dd></div>}
        </dl>
        {t.carryReason && <p className="rp-muted">{t.carryReason}</p>}
      </div>
      <div className="rp-meta">
        <span className={`rp-check ${checksOk ? 'is-ok' : 'is-bad'}`}>{checksOk ? '照合OK: 明細の和＝一覧、前回まで＋当期＝累計、支払予定額の検算、集計シートとの一致' : '照合NG: 照合の表を確かめてください'}</span>
        {!confirmed && body.canCreate && checksOk && !shell.readOnly && creating === 'idle' && <button type="button" onClick={() => setCreating('confirm')}>この期間の報告書を確定する</button>}
      </div>
      {!confirmed && (body.blockedReason || !checksOk) && (
        <Notice tone="warn" title="この下書きは確定できません"
          message={body.blockedReason || '照合に差額があります。下の「照合」の表で差額の元を確かめ、元のデータ（イレギュラーの台帳・サイクル・条件）を直してください。'}
          actions={<button type="button" className="secondary" onClick={() => document.getElementById('ry-checks')?.scrollIntoView({block: 'start'})}>照合の表へ移る</button>} />
      )}
      {!confirmed && creating !== 'idle' && (
        <Notice tone="warn" title="この内容で確定しますか" message={`${holderName} 様・${monthText(calc.closeMonth)}締め：支払予定額 ${yen(t.payableYen)}（当期 ${yen(t.royaltyYen)}・調整 ${yen(t.adjustmentYen)}・前払金の充当 ${yen(t.advanceRecoupedYen)}）。確定した報告書は変更できません。`}
          actions={<>
            <button type="button" disabled={creating === 'saving'} onClick={createNow}>{creating === 'saving' ? '作成中…' : 'この内容で確定する'}</button>
            <button type="button" className="secondary" disabled={creating === 'saving'} onClick={() => setCreating('idle')}>やめる</button>
          </>} />
      )}
      <ErrorNotice error={createError} />
      {t.holdCount > 0 && <Notice tone="warn" message={`保留が${t.holdCount}件あります（対象売上 ${yen(t.holdSalesYen)}）。0円として合計に混ぜず、下の「保留」に示しています。`} />}

      <div className="ry-section"><h3>作品×種別（前回まで・当期・累計）</h3>
        <DataGrid columns={ROW_COLUMNS} rows={calc.rows} rowKey="agreementId" persistKey="royalty-statement-rows" emptyText="この権利者の契約がありません" /></div>
      <div className="ry-section"><h3>明細</h3>
        <DataGrid columns={LINE_COLUMNS} rows={calc.lines} rowKey="lineNo" persistKey="royalty-statement-lines" showTotals={false} maxHeight="45vh" emptyText="当期の明細はありません（支払予定額は前期繰越だけです）" /></div>
      <div className="ry-section"><h3>経費の控除</h3>
        <DataGrid columns={EXPENSE_COLUMNS} rows={calc.expenses} rowKey={(r) => `${r.agreementId}:${r.accrualMonth}:${r.source}:${r.id ?? r.category}`} persistKey="royalty-statement-expenses" emptyText="当期に控除した経費はありません" /></div>
      <div className="ry-section"><h3>前払金と繰越</h3>
        <DataGrid columns={KV_COLUMNS} rows={carryRows} rowKey="k" showTotals={false} persistKey="royalty-statement-carry" />
        {calc.advance.length > 0 && <DataGrid columns={ADVANCE_COLUMNS} rows={calc.advance} rowKey="agreementId" showTotals={false} persistKey="royalty-statement-advance" />}</div>
      <div className="ry-section"><h3>調整（イレギュラー）</h3>
        <DataGrid columns={ADJUST_COLUMNS} rows={calc.adjustments} rowKey="entryId" persistKey="royalty-statement-adjust" emptyText="当期の調整はありません" /></div>
      <div className="ry-section"><h3>保留</h3>
        <DataGrid columns={HOLD_COLUMNS} rows={calc.holds} rowKey="key" persistKey="royalty-statement-holds" emptyText="保留はありません" /></div>
      {confirmed && (
        <div className="ry-section"><h3>報告と支払の記録</h3>
          <DataGrid columns={EVENT_COLUMNS} rows={record.events} rowKey="id" showTotals={false} persistKey="royalty-statement-events" emptyText="まだ記録がありません"
            renderDetail={(event) => (event.isReversal || event.reversed || record.voided || shell.readOnly ? <p className="rp-muted">この記録は取り消せません。</p> : (
              <ReasonAction label="この記録を取り消す" confirmTitle="この記録を取り消しますか" confirmText={`${event.kindLabel}（${dateJst(event.occurredOn)}${event.amountYen ? `・${yen(event.amountYen)}` : ''}）を取り消します`}
                onConfirm={(reason) => request(`/royalty/statements/${record.id}/events`, {method: 'POST', body: JSON.stringify({kind: 'reverse', eventId: event.id, reason})}).then(reload)} />
            ))} />
          <EventForms key={`${record.id}:${record.paidYen}:${record.reportedOn || ""}`} statement={record} request={request} onSaved={(message) => { setEventDone(message); reload(); }} />
          {eventDone && <Notice tone="ok" compact message={eventDone} onDismiss={() => setEventDone('')} />}
          {record.canVoid && !shell.readOnly && (
            <ReasonAction label="この確定版を取り消す" buttonClass="text" confirmTitle="確定版を取り消しますか"
              confirmText={`${holderName} 様・${monthText(calc.closeMonth)}締めの第${record.versionNo}版を取り消します。取り消すと、この期間は作成待ちに戻り、作り直せます`}
              onConfirm={(reason) => request(`/royalty/statements/${record.id}/void`, {method: 'POST', body: JSON.stringify({reason})}).then(reload)} />
          )}
          {!record.canVoid && !record.voided && <p className="rp-muted">取り消せるのは、この権利者の最新の確定版で、支払の記録が無いもの（取消済みを除く）だけです。</p>}
        </div>
      )}
      <div className="ry-section" id="ry-checks"><h3>照合</h3>
        <DataGrid columns={CHECK_COLUMNS} rows={calc.checks} rowKey="item" showTotals={false} persistKey="royalty-statement-checks" /></div>
      <div className="ry-section"><h3>前提</h3>
        <ul className="rp-muted">{calc.assumptions.map((item) => <li key={item}>{item}</li>)}</ul>
        {calc.previousCloseMonth && <p className="rp-muted">前の報告書: {monthText(calc.previousCloseMonth)}締め（前期繰越の元）</p>}
        {navigate && <button type="button" className="text" onClick={() => navigate('ロイヤリティ集計', {holder: String(calc.holder.id)})}>この権利者の集計シートを開く</button>}
      </div>
    </section>
  );
}

// 帳票センター: 権利者と締め月を選んで報告書を出す
export function RoyaltyCycleReport({onNavigate}) {
  const shell = useShell();
  const request = shell.request;
  const holderId = shell.getParam('holder', '');
  const closeMonth = shell.getParam('close', '');
  const statementId = shell.getParam('statement', '');
  const [periods, setPeriods] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    request('/royalty/periods').then((body) => live && setPeriods({body})).catch((error) => live && setPeriods({error}));
    return () => { live = false; };
  }, [request, revision]);
  const body = periods.body;
  const holderOptions = useMemo(() => (body?.holders || []).filter((h) => !h.restricted).map((h) => ({value: String(h.id), label: h.name})), [body]);
  const closeOptions = useMemo(() => (body?.periods || []).filter((p) => String(p.holderId) === String(holderId) && p.status !== 'merged')
    .sort((a, b) => b.closeMonth.localeCompare(a.closeMonth))
    .map((p) => ({value: p.closeMonth, label: `${monthText(p.closeMonth)}締め（${p.statusLabel}${p.statementId ? `・第${p.versionNo}版` : ''}）`})), [body, holderId]);
  const period = (body?.periods || []).find((p) => String(p.holderId) === String(holderId) && p.closeMonth === closeMonth);
  return (
    <div className="stack">
      <section className="card rp-report" aria-label="ロイヤリティ報告書の条件">
        <header className="rp-head">
          <div>
            <h2>ロイヤリティ報告書（権利者×締め月）</h2>
            <p className="rp-muted">契約のサイクルで締めた期間ごとの報告書です。作成済みの期間は確定版を、まだの期間は下書きを出します。</p>
          </div>
        </header>
        {periods.error && <ErrorNotice error={periods.error} />}
        <div className="on-conditions">
          <FormField type="select" label="権利者" value={holderId} blankLabel="選んでください" options={holderOptions}
            onChange={(value) => { shell.setParam('holder', value || null); shell.setParam('close', null); shell.setParam('statement', null); }} />
          <FormField type="select" label="締め月" value={closeMonth} blankLabel="選んでください" options={closeOptions}
            onChange={(value) => { shell.setParam('close', value || null); shell.setParam('statement', null); }} />
        </div>
        {body && !holderOptions.length && <Notice tone="info" message="ロイヤリティ契約がまだありません。「ロイヤリティ契約」で契約とサイクルを登録すると、ここに期間が並びます。"
          actions={onNavigate ? <button type="button" className="secondary" onClick={() => onNavigate('ロイヤリティ契約')}>ロイヤリティ契約を開く</button> : null} />}
      </section>
      {(statementId || (holderId && closeMonth)) && (
        <RoyaltyStatementView statementId={statementId || period?.statementId || null} holderId={holderId} closeMonth={closeMonth} onNavigate={onNavigate}
          onChanged={() => setRevision((n) => n + 1)} />
      )}
    </div>
  );
}

export default RoyaltyCycleReport;
