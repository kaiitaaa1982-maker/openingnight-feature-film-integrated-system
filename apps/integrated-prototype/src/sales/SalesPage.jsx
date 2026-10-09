// 売上明細。会社全体（閲覧権限内）の登録済み売上を表で確かめ、絞込・合計・Excel/CSVで出す。
// 登録の入口は「売上報告の取込」（Excel・CSV・PDF）と「1件入力」。訂正は元の報告を選んで訂正版を取り込む。
// 列セット（URL の sheet）を選ぶと、同じ条件のまま売上集計シート（83列）の列で見る（サーバー側でページに分ける）。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {useConditions, ConditionBar} from '../ui/ConditionBar.jsx';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {describeConditions} from '../ui/condition-model.mjs';
import {labelOf} from '../ui/labels.mjs';
import {dateTimeJst, yen} from '../ui/format.mjs';
import {useFiscal} from '../reports/use-fiscal.mjs';
import {SalesSheet} from '../sales-sheet/SalesSheet.jsx';
import {COLUMN_SETS, COLUMN_SET_LABELS, ALL_SET} from '../sales-sheet/column-registry.mjs';
import '../reports/reports.css';

const CONDITIONS = ['fiscalYear', 'period', 'work', 'partner'];
const SHEET_OPTIONS = [{value: '', label: '売上明細（標準の列）'}, ...[...COLUMN_SETS.map((set) => set.key), ALL_SET].map((key) => ({value: key, label: `売上集計シート：${COLUMN_SET_LABELS[key]}`}))];
const COLUMNS = [
  {key: 'accounting_month', label: '計上月', type: 'month', sticky: true},
  {key: 'partner_name', label: '取引先', type: 'text'},
  {key: 'work_titles', label: '作品', type: 'text', wrap: true},
  {key: 'product_name', label: '商品', type: 'text'},
  {key: 'kind_label', label: '報告の種類', type: 'text'},
  {key: 'description', label: '内容', type: 'text', wrap: true},
  {key: 'quantity', label: '数量', type: 'int', total: 'sum'},
  {key: 'amount_ex_tax', label: '税抜', type: 'yen', total: 'sum'},
  {key: 'tax_amount', label: '税額', type: 'yen', total: 'sum'},
  {key: 'amount_inc_tax', label: '税込', type: 'yen', total: 'sum'},
  {key: 'billing_status', label: '請求', type: 'text'},
  {key: 'receipt_status', label: '入金', type: 'text'},
  {key: 'sales_month', label: '販売月', type: 'month', hidden: true},
  {key: 'sales_period', label: '販売期間', type: 'text', hidden: true},
  {key: 'invoice_number', label: '請求番号', type: 'code', hidden: true},
  {key: 'report_key', label: '報告キー', type: 'code', hidden: true},
  {key: 'source_row', label: '原本の行', type: 'int', total: 'none', hidden: true},
  {key: 'product_sku', label: '商品SKU', type: 'code', hidden: true},
  {key: 'partner_code', label: '取引先コード', type: 'code', hidden: true},
  {key: 'created_at', label: '登録日時', type: 'datetime', hidden: true},
  {key: 'id', label: '売上ID', type: 'id', hidden: true},
];

export function SalesPage({data, manualSlot, legacySlot, onNavigate}) {
  const shell = useShell();
  const [fiscal] = useFiscal(shell.request);
  const values = useConditions(CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth});
  const [billing, setBilling] = useState(shell.getParam('billing', ''));
  const q = shell.getParam('q', '');
  const distribution = shell.getParam('distribution', '');
  const productParam = shell.getParam('productId', '');
  const deal = shell.getParam('deal', '');
  const sheetSet = shell.getParam('sheet', '');
  const [state, setState] = useState({loading: true});
  const [showManual, setShowManual] = useState(false);
  // 1件入力・CSV取込で登録したら、この画面の一覧を読み直す（manualSlot・legacySlot は onSaved を受け取る関数でもよい）
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((n) => n + 1);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (values.from) params.set('from', values.from);
    if (values.to) params.set('to', values.to);
    if (values.workId) params.set('workId', values.workId);
    if (values.partnerId) params.set('partnerId', values.partnerId);
    if (billing) params.set('billing', billing);
    if (q) params.set('q', q);
    if (distribution) params.set('distribution', distribution);
    if (productParam) params.set('productId', productParam);
    if (deal) params.set('deal', deal);
    return params.toString();
  }, [values.from, values.to, values.workId, values.partnerId, billing, q, distribution, productParam, deal]);

  useEffect(() => {
    if (!values.valid || sheetSet) return undefined;
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    shell.request(`/sales-lines?${query}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [query, values.valid, shell, revision, sheetSet]);

  const body = state.body;
  const names = useMemo(() => ({
    work: Object.fromEntries((data?.works || []).map((w) => [String(w.id), w.title])),
    partner: Object.fromEntries((data?.partners || []).map((p) => [String(p.id), p.name])),
  }), [data]);
  const productRow = (data?.products || []).find((p) => String(p.id) === productParam);
  const productLabel = productParam === 'none' ? '商品未登録（作品に直接計上）' : productRow ? `${productRow.sku}｜${productRow.name}` : productParam;
  const dealLabel = deal ? labelOf('dealType', deal) : '';
  const conditions = [...describeConditions(values, CONDITIONS, {names}), ...(billing ? [['請求', billing === 'unbilled' ? '未請求のみ' : '請求済のみ']] : []), ...(q ? [['検索', q]] : []), ...(distribution ? [['流通', body?.distribution?.label || distribution]] : []), ...(productParam ? [['商品', productLabel]] : []), ...(deal ? [['取引区分', dealLabel]] : [])];

  return (
    <div className="stack">
      <section className="card rp-intro">
        <div className="rp-intro-head">
          <div>
            <h2>売上を登録する</h2>
            <p className="rp-muted">取引先から届いた報告（Excel・CSV・PDF）は原本ごと取り込みます。報告が無い売上は1件ずつ入力できます。</p>
          </div>
          <div className="on-form-actions">
            <button type="button" onClick={() => onNavigate?.('原本取り込み')}>Excel・CSV・PDFから取り込む</button>
            <button type="button" className="secondary" aria-expanded={showManual} onClick={() => setShowManual((value) => !value)}>{showManual ? '1件入力を閉じる' : '1件入力'}</button>
            <button type="button" className="secondary" onClick={() => onNavigate?.('売上データ編集')}>表で直す（売上の表編集）</button>
          </div>
        </div>
        {showManual && (typeof manualSlot === 'function' ? manualSlot(refresh) : manualSlot)}
        {legacySlot && <details className="rp-legacy"><summary>CSVを貼り付けて取り込む（従来の方法）</summary>{typeof legacySlot === 'function' ? legacySlot(refresh) : legacySlot}</details>}
      </section>
      <section className="card rp-report" aria-label="売上明細">
        <header className="rp-head">
          <div>
            <h2>売上明細</h2>
            <p className="rp-muted">{body?.scope || '閲覧権限のある作品の売上明細'}。行を押すと全項目と元の報告が見られます。</p>
          </div>
        </header>
        <ConditionBar conditions={CONDITIONS} values={values} works={data?.works || []} partners={data?.partners || []} fiscalConfirmed={fiscal?.confirmed}>
          <FormField type="select" label="請求" value={billing} blankLabel="すべて" options={[{value: 'unbilled', label: '未請求のみ'}, {value: 'billed', label: '請求済のみ'}]}
            onChange={(value) => { setBilling(value); shell.setParam('billing', value || null); }} />
          <FormField type="select" label="列セット" value={sheetSet} includeBlank={false} options={SHEET_OPTIONS} onChange={(value) => shell.setParam('sheet', value || null)} />
          {q && <p className="on-conditions-summary">検索: 「{q}」 <button type="button" className="text" onClick={() => shell.setParam('q', null)}>検索を解除</button></p>}
          {distribution && <p className="on-conditions-summary">流通: {body?.distribution?.label || distribution} <button type="button" className="text" onClick={() => shell.setParam('distribution', null)}>流通の絞込を解除</button></p>}
          {productParam && <p className="on-conditions-summary">商品: {productLabel} <button type="button" className="text" onClick={() => shell.setParam('productId', null)}>商品の絞込を解除</button></p>}
          {deal && <p className="on-conditions-summary">取引区分: {dealLabel} <button type="button" className="text" onClick={() => shell.setParam('deal', null)}>取引区分の絞込を解除</button></p>}
        </ConditionBar>
        {sheetSet && (
          <SalesSheet embedded setKey={sheetSet} title={`売上集計シートの列で見る：${COLUMN_SET_LABELS[sheetSet] || sheetSet}`}
            conditions={{from: values.from, to: values.to, workId: values.workId, partnerId: values.partnerId, q, distribution, billing, productId: productParam, deal}} />
        )}
        {!sheetSet && state.error && <Notice error={state.error} />}
        {!sheetSet && body && (
          <>
            <div className="rp-tiles">
              <div><span>明細数</span><strong>{body.count.toLocaleString('ja-JP')}</strong></div>
              <div><span>税抜</span><strong>{yen(body.totals.amount_ex_tax)}</strong></div>
              <div><span>税額</span><strong>{yen(body.totals.tax_amount)}</strong></div>
              <div><span>税込</span><strong>{yen(body.totals.amount_inc_tax)}</strong></div>
            </div>
            <DataGrid columns={COLUMNS} rows={body.rows} rowKey="id" persistKey="sales-lines" emptyText="この条件の売上明細はありません"
              exportSpec={{name: '売上明細', title: '売上明細', period: values.from && values.to ? `${values.from}〜${values.to}` : '', conditions, dataAsOf: new Date().toISOString()}}
              renderDetail={(row) => (
                <div className="rp-drill">
                  <dl className="sl-detail">
                    {[['販売期間', row.sales_period], ['販売月', row.sales_month || '（報告に記載なし）'], ['報告キー', row.report_key], ['原本の行', row.source_row ?? '—'],
                      ['請求番号', row.invoice_number || '—'], ['登録日時', dateTimeJst(row.created_at)], ['訂正版', row.corrected ? '訂正版の報告' : '—'], ['売上ID', row.id]]
                      .map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
                  </dl>
                  <div className="on-form-actions">
                    <button type="button" className="secondary" onClick={() => onNavigate?.('原本取り込み', {supersedes: row.report_id})}>この報告の訂正版を取り込む</button>
                    <button type="button" className="text" onClick={() => onNavigate?.('帳票センター', {report: 'annual-sales', partnerId: row.partner_id})}>この取引先の年間売上を見る</button>
                  </div>
                </div>
              )} />
          </>
        )}
        {!sheetSet && state.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
      </section>
    </div>
  );
}

export default SalesPage;
