// 税計算台帳と税ルール、および「請求・入金」で使う請求の作成（TaxInvoice）。
// - 台帳は表（DataGrid）。行を押すと、その請求の固定保存した計算履歴を直下に開く。Excel・CSV・印刷で出力できる。
// - 税ルールが無いと税額を計算できない。「税額を計算して確認」が押せない理由と、税ルールの登録への導線をその場に出す。
// - 請求の確定は取り消せない記録なので、計算結果を確かめてから「この内容で請求を確定する／戻って直す」の2段にする。
// 押せない理由・行の組み立ては billing/receipt-model.mjs（node で試験）。
import React, {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {useShell} from './shell/context.mjs';
import {DataGrid} from './ui/DataGrid.jsx';
import {FormField} from './ui/FormField.jsx';
import {Notice} from './ui/Notice.jsx';
import {labelOf} from './ui/labels.mjs';
import {yen, int, dateJst, dateTimeJst, month as monthText} from './ui/format.mjs';
import {parseInteger} from './ui/parse-input.mjs';
import {GridDetailFrame} from './billing/ReceiptForm.jsx';
import {
  todayJst, taxCalculateBlockers, taxLedgerTotals, taxLedgerRows, taxRuleRows, latestRuleVersion, validateTaxRule,
} from './billing/receipt-model.mjs';
import './reports/reports.css';
import './tax.css';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const amount = (v) => (v == null ? '—' : Number(v).toLocaleString('ja-JP', {maximumFractionDigits: 4}));
export const basisLabels = {exclusive: '税抜起点', inclusive: '税込起点'};
export const roundingLabels = {truncate: '切り捨て（絶対値の端数を除く）', half_up: '四捨五入', ceil: '切り上げ（絶対値の端数を上げる）'};
const groupingLabels = {invoice: '請求書番号ごと（月次）', voucher: '伝票番号ごと'};
const categoryLabel = (code) => labelOf('taxCategory', code);
const CATEGORY_OPTIONS = ['standard', 'reduced', 'zero', 'exempt', 'non_taxable'].map((value) => ({value, label: categoryLabel(value)}));
const ruleScope = (rule) => (rule?.partner_id ? '取引先別' : '組織標準');

function downloadBlob(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

// 固定保存した税計算の記録（台帳の行の直下に出す）。識別番号・保存値の全項目は折りたたみへ。
function TaxAudit({detail}) {
  const {snapshot: s = {}, rule: r = {}, calculation, lines = []} = detail;
  return (
    <>
      <dl className="tax-audit-meta">
        <dt>計算日時</dt><dd>{dateTimeJst(s.created_at)}</dd>
        <dt>使った税ルール</dt><dd>{ruleScope(r)}・第{r.version}版（{basisLabels[r.basis] || labelOf('taxBasis', r.basis)}・{roundingLabels[r.rounding || r.rounding_mode] || labelOf('roundingMode', r.rounding || r.rounding_mode)}）</dd>
        <dt>元計算の単位・桁</dt><dd>{groupingLabels[r.grouping || r.grouping_mode] || '未確認'}・小数{r.precision}桁</dd>
        <dt>採用理由・根拠</dt><dd>{r.reason}<br />{r.evidence}</dd>
        <dt>元の売上の対象期間</dt><dd>{dateJst(s.source_period_from)} 〜 {dateJst(s.source_period_to)}</dd>
      </dl>
      {calculation && <TaxBreakdown preview={{...calculation, rule: {...r, rounding: r.rounding || r.rounding_mode}}} />}
      <div className="bl-table-wrap">
        <table className="bl-table">
          <caption>計算の対象にした売上明細（{lines.length}行）</caption>
          <thead><tr><th scope="col">伝票番号</th><th scope="col">税区分</th><th scope="col" className="num">元の税抜</th><th scope="col" className="num">元の税額</th><th scope="col" className="num">元の税込</th><th scope="col" className="num">丸める前の税額（分数・円）</th></tr></thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.sale_id}><td>{line.voucher_id || '未確認'}</td><td>{categoryLabel(line.category)}</td><td className="num">{amount(line.amount_ex_tax)}</td><td className="num">{amount(line.source_tax)}</td>
                <td className="num">{amount(line.amount_inc_tax)}</td><td className="num">{line.exact_numerator} / {line.exact_denominator}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>記録の識別情報と保存値の全項目</summary>
        <dl className="tax-audit-meta">
          <dt>計算履歴の番号</dt><dd>{s.id}</dd>
          <dt>請求の番号（内部）</dt><dd>{s.invoice_id}</dd>
          <dt>実行した利用者の番号</dt><dd>{s.created_by}</dd>
          <dt>税ルールの番号</dt><dd>{r.id}</dd>
          <dt>計算日時（保存値）</dt><dd>{s.created_at}</dd>
        </dl>
        <pre className="tax-audit">{JSON.stringify(detail, null, 2)}</pre>
      </details>
    </>
  );
}

function SnapshotDetail({request, snapshotId}) {
  const [state, setState] = useState({loading: true});
  const load = useCallback(() => {
    let live = true;
    setState({loading: true});
    request(`/tax/snapshots/${snapshotId}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [request, snapshotId]);
  useEffect(() => load(), [load]);
  if (state.error) return <Notice error={state.error} onRetry={load} />;
  if (!state.body) return <p className="rp-muted" aria-busy="true">計算履歴を読み込んでいます…</p>;
  return <TaxAudit detail={state.body} />;
}

export function TaxBreakdown({preview}) {
  if (!preview) return null;
  const rule = preview.rule || {};
  const reference = preview.reference;
  // 参考税額は小数の桁（precision）だけ桁上げした整数で保存されている
  const referenceTax = reference ? Number(reference.taxScaled ?? reference.taxAmount) / (10 ** (reference.precision || 0)) : null;
  return (
    <div className="tax-preview">
      <h3>請求時の税計算</h3>
      <p>{ruleScope(rule)}の税ルール 第{rule.version ?? '—'}版・{basisLabels[rule.basis] || '起点未確認'}。請求書×税区分・税率ごとに1回、整数円で{roundingLabels[rule.rounding] || '端数処理'}します。</p>
      <div className="bl-table-wrap">
        <table className="bl-table">
          <thead><tr><th scope="col">税区分</th><th scope="col" className="num">請求本体</th><th scope="col" className="num">丸める前の税額（分数・円）</th><th scope="col" className="num">請求税額</th><th scope="col" className="num">元報告の税額</th><th scope="col" className="num">税額差</th></tr></thead>
          <tbody>
            {(preview.billed?.rateTotals || []).map((row, index) => (
              <tr key={index}><td>{categoryLabel(row.category)}</td><td className="num">{amount(row.amountExTax)}</td><td className="num">{row.exactNumerator} / {row.exactDenominator}</td>
                <td className="num">{amount(row.taxAmount ?? row.billedTax)}</td><td className="num">{amount(row.sourceTax)}</td><td className="num">{amount(row.delta)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rp-tiles">
        <div><span>請求本体</span><strong>{yen(preview.billed?.amountExTax)}</strong></div>
        <div><span>請求税額</span><strong>{yen(preview.billed?.taxAmount)}</strong></div>
        <div><span>税込請求</span><strong>{yen(preview.billed?.amountIncTax)}</strong></div>
      </div>
      <p className="rp-muted">元報告の税抜 {yen(preview.sourceTotals?.amountExTax)}・税額 {yen(preview.sourceTotals?.taxAmount)}・税込 {yen(preview.sourceTotals?.amountIncTax)}。
        請求本体との差 {yen((preview.billed?.amountExTax || 0) - (preview.sourceTotals?.amountExTax || 0))}。元の売上は変えません。</p>
      {reference && (
        <details>
          <summary>元の計算方法による参考税額: {amount(referenceTax)}円</summary>
          <p className="rp-muted">元の伝票・請求の単位で計算した参考値です。請求税額と足し合わせません。</p>
          <div className="bl-table-wrap">
            <table className="bl-table">
              <thead><tr><th scope="col">計算の単位</th><th scope="col">税区分</th><th scope="col" className="num">税抜</th><th scope="col" className="num">参考税額</th></tr></thead>
              <tbody>
                {(reference.groups || []).map((group, index) => (
                  <tr key={index}><td>{group.voucherId ? `伝票 ${group.voucherId}` : '請求書'}</td><td>{categoryLabel(group.category)}</td><td className="num">{amount(group.amountExTax)}</td>
                    <td className="num">{amount((group.taxScaled ?? group.taxAmount) / (10 ** (group.precision || 0)))}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

export function TaxInvoice({data, state, request: requestProp, onCreated, onNavigate}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const navigate = onNavigate || shell.navigate;
  const readOnly = Boolean(shell.readOnly || request?.readOnly);
  const isAdmin = data?.currentUser?.role === 'admin';
  const [selected, setSelected] = useState([]);
  const [lines, setLines] = useState([]);
  const [rates, setRates] = useState({});
  const [preview, setPreview] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [rules, setRules] = useState({loading: true});
  const [form, setForm] = useState({invoiceDate: todayJst(), dueDate: '', sourceAmountBasis: '', note: '', reissueOfInvoiceId: '', reissueReason: ''});
  const [bulk, setBulk] = useState('');
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; }; }, []);
  // 報告を選んでいるあいだ（明細ごとの税区分・期日などの入力を含む）は未保存として外枠に登録し、画面移動・作品の切替で確認を出す
  const unsavedId = `taxinvoice${useId().replace(/:/g, '')}`;
  const registerUnsaved = shell.registerUnsaved;
  const invoiceDirty = selected.length > 0;
  useEffect(() => { registerUnsaved?.(unsavedId, invoiceDirty ? 1 : 0, '請求の作成'); }, [invoiceDirty, unsavedId, registerUnsaved]);
  useEffect(() => () => registerUnsaved?.(unsavedId, 0, '請求の作成'), [unsavedId, registerUnsaved]); // eslint-disable-line react-hooks/exhaustive-deps

  const candidates = state?.candidates || [];
  const partnerName = (id) => data?.partners?.find((partner) => partner.id === id)?.name || '取引先（名称未確認）';
  const partnerId = candidates.find((row) => selected.includes(row.id))?.partner_id ?? null;
  const invalidate = () => { generation.current += 1; setPreview(null); };
  const change = (key) => (value) => { invalidate(); setForm((previous) => ({...previous, [key]: value})); };
  const toggle = (id) => { invalidate(); setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])); };

  useEffect(() => {
    let active = true;
    invalidate();
    setLines([]);
    setRates({});
    setBulk('');
    if (!selected.length) return undefined;
    setSourcesLoading(true);
    request(`/tax/sources?workId=${data.selectedWorkId}&reportIds=${selected.join(',')}`)
      .then((body) => { if (active) setLines(body.lines || []); })
      .catch((error) => { if (active) setNotice({tone: 'error', error}); })
      .finally(() => { if (active) setSourcesLoading(false); });
    return () => { active = false; };
  }, [selected.join(','), data.selectedWorkId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 使える税ルールの確認（0件・請求日に使える版が無い、を押せない理由として出す）
  useEffect(() => {
    let live = true;
    setRules((previous) => ({...previous, loading: true, error: null}));
    (async () => {
      const all = await request('/tax/rules');
      const total = (all.rules || []).length;
      let resolved;
      let rule = null;
      if (total && partnerId && DATE.test(form.invoiceDate || '')) {
        const scoped = await request(`/tax/rules?partnerId=${partnerId}&asOf=${form.invoiceDate}`);
        rule = scoped.resolvedRule || null;
        resolved = Boolean(rule);
      }
      if (live) setRules({loading: false, total, resolved, rule});
    })().catch((error) => { if (live) setRules({loading: false, error: error?.message || '読み込めませんでした'}); });
    return () => { live = false; };
  }, [request, partnerId, form.invoiceDate]);

  const unrated = lines.filter((line) => !rates[line.id]).length;
  const blockers = taxCalculateBlockers({selectedCount: selected.length, lineCount: lines.length, unratedCount: unrated, invoiceDate: form.invoiceDate, sourcesLoading, rules});
  const finalizeBlockers = [
    !form.dueDate ? '支払期日を入力してください' : null,
    form.dueDate && form.dueDate < form.invoiceDate ? '支払期日は請求日以後にしてください' : null,
    form.sourceAmountBasis !== 'platform_net' ? '「報告額の基準」でPF控除後の受取報告額であることを確かめてください' : null,
    form.reissueOfInvoiceId && !form.reissueReason.trim() ? '再発行の理由を入力してください' : null,
  ].filter(Boolean);

  const assignment = (category, saleId) => ({saleId, category, rateBps: category === 'standard' ? 1000 : category === 'reduced' ? 800 : 0});
  const payload = () => ({workId: data.selectedWorkId, reportIds: selected, invoiceDate: form.invoiceDate, lineRates: lines.map((line) => assignment(rates[line.id], line.id))});

  async function calculate() {
    if (blockers.length) return;
    const token = ++generation.current;
    setBusy(true);
    setNotice(null);
    setPreview(null);
    try {
      const result = await request('/tax/preview', {method: 'POST', body: JSON.stringify(payload())});
      if (mounted.current && generation.current === token) setPreview(result);
    } catch (error) {
      if (mounted.current && generation.current === token) setNotice({tone: 'error', error});
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function finalize() {
    if (!preview || finalizeBlockers.length || busy || readOnly) return;
    setBusy(true);
    setNotice(null);
    try {
      const body = {...form, ...payload(), tax: {previewHash: preview.previewHash, ruleVersionId: preview.rule.id, lineRates: payload().lineRates},
        reissueOfInvoiceId: form.reissueOfInvoiceId ? Number(form.reissueOfInvoiceId) : undefined, reissueReason: form.reissueReason || undefined};
      const result = await request('/billing/invoices', {method: 'POST', body: JSON.stringify(body)});
      if (!mounted.current) return;
      setPreview(null);
      setSelected([]);
      setNotice({tone: 'ok', message: `${result.invoiceNumber}を確定しました（税込 ${yen(result.amountIncTax)}）。税計算の記録を固定保存し、請求の一覧に加えました。`});
      await onCreated?.(result);
    } catch (error) {
      if (mounted.current) { setPreview(null); setNotice({tone: 'error', error}); }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const voided = (state?.invoices || []).filter((invoice) => invoice.status === 'void');
  return (
    <div className="tax-invoice">
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      <fieldset disabled={busy}>
        <legend>1. 請求する売上報告と請求の条件</legend>
        {!candidates.length && <p className="empty">この作品の売上報告はまだありません。売上を登録すると、ここから請求を作成できます。</p>}
        <div className="billing-candidates">
          {candidates.map((row) => (
            <label className={`billing-candidate ${row.eligible ? '' : 'disabled'}`} key={row.id}>
              <input type="checkbox" disabled={!row.eligible} checked={selected.includes(row.id)} onChange={() => toggle(row.id)} />
              <span>
                <strong>報告 {row.report_key}｜{partnerName(row.partner_id)}</strong>
                <small className="tax-candidate-meta">計上月 {monthText(row.accounting_month)}・{int(row.lineCount)}明細</small>
                <em>{row.eligible ? `元の税抜 ${yen(row.amountExTax)}・元の税額 ${yen(row.taxAmount)}` : `請求できません: ${String(row.reason || '理由未確認').replace(/（gross）/g, '（総額）')}`}</em>
              </span>
            </label>
          ))}
        </div>
        <div className="on-form-grid">
          <FormField type="date" label="請求日" required value={form.invoiceDate} onChange={change('invoiceDate')} />
          <FormField type="date" label="支払期日" required value={form.dueDate} onChange={change('dueDate')} hint="請求日以後の日付" />
          <FormField type="select" label="報告額の基準" required value={form.sourceAmountBasis} onChange={change('sourceAmountBasis')} blankLabel="未確認"
            options={[{value: 'platform_net', label: 'PF控除後の受取報告額と確認した'}]} hint="控除前（総額）の報告はそのまま請求できません" />
          <FormField label="注記" value={form.note} onChange={change('note')} maxLength={2000} />
          <FormField type="select" label="訂正元（取消済みの請求）" value={form.reissueOfInvoiceId} onChange={change('reissueOfInvoiceId')} blankLabel="新しい請求"
            options={voided.map((invoice) => ({value: String(invoice.id), label: invoice.invoice_number}))} />
          {form.reissueOfInvoiceId && <FormField label="再発行の理由" required value={form.reissueReason} onChange={change('reissueReason')} maxLength={1000} />}
        </div>
      </fieldset>
      <fieldset disabled={busy || sourcesLoading}>
        <legend>2. 明細の税区分を確かめる</legend>
        {sourcesLoading ? <p className="rp-muted" aria-busy="true">対象の明細を読み込んでいます…</p> : lines.length ? (
          <>
            <div className="tax-bulk">
              <FormField type="select" label="全明細へ設定する税区分" value={bulk} onChange={setBulk} options={CATEGORY_OPTIONS} blankLabel="選択してください" />
              <button type="button" className="secondary" disabled={!bulk} onClick={() => { invalidate(); setRates(Object.fromEntries(lines.map((line) => [line.id, bulk]))); }}>選んだ税区分を全明細へ設定</button>
            </div>
            <div className="bl-table-wrap">
              <table className="bl-table">
                <thead><tr><th scope="col">摘要</th><th scope="col" className="num">元の税抜</th><th scope="col" className="num">元の税額</th><th scope="col">税区分</th></tr></thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.description || '摘要なし'}</td>
                      <td className="num">{amount(line.amount_ex_tax)}</td>
                      <td className="num">{amount(line.tax_amount)}</td>
                      <td>
                        <select aria-label={`${line.description || '明細'}の税区分`} value={rates[line.id] || ''} onChange={(event) => { invalidate(); setRates((previous) => ({...previous, [line.id]: event.target.value})); }}>
                          <option value="">未確認</option>
                          {CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="rp-muted">元の税額から税率は推定しません。明細ごとに税区分を選んでください。</p>
          </>
        ) : <p className="rp-muted">上で請求する売上報告を選ぶと、明細が出ます。</p>}
        <div className="tax-calc-actions">
          <button type="button" disabled={blockers.length > 0 || busy} onClick={calculate}>税額を計算して確認</button>
          {!blockers.length && rules.rule && <span className="rp-muted">使う税ルール: {ruleScope(rules.rule)}・第{rules.rule.version}版（{basisLabels[rules.rule.basis]}・{roundingLabels[rules.rule.rounding]}）</span>}
        </div>
        {blockers.length > 0 && (
          <ul className="tax-blockers" aria-label="「税額を計算して確認」を押せない理由">
            {blockers.map((blocker) => (
              <li key={blocker.key}>
                {blocker.message}
                {blocker.action === 'rules' && (
                  <button type="button" className="secondary" onClick={() => navigate?.('税ルール・台帳', {rule: 'new'})}>
                    {isAdmin ? '税ルールを登録する' : '税ルールの画面を開く（登録は管理者）'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {preview && (
        <div className="bl-confirm" aria-label="請求の確定">
          <TaxBreakdown preview={preview} />
          <Notice tone="warn" title="この内容で請求を確定します"
            message={`税込 ${yen(preview.billed?.amountIncTax)}・請求日 ${dateJst(form.invoiceDate)}・支払期日 ${form.dueDate ? dateJst(form.dueDate) : '未入力'}。確定した請求は削除できません。誤りは「請求を取り消す」で打ち消し、作り直します。`} />
          {finalizeBlockers.length > 0 && (
            <ul className="tax-blockers" aria-label="確定できない理由">{finalizeBlockers.map((text) => <li key={text}>{text}</li>)}</ul>
          )}
          <div className="on-form-actions">
            <button type="button" onClick={finalize} disabled={busy || readOnly || finalizeBlockers.length > 0}>{busy ? '確定しています…' : 'この内容で請求を確定する'}</button>
            <button type="button" className="secondary" onClick={() => setPreview(null)} disabled={busy}>戻って直す</button>
            {readOnly && <span className="rp-muted">確認専用の表示では確定できません。</span>}
          </div>
        </div>
      )}
    </div>
  );
}

const RULE_DEFAULTS = () => ({partnerId: '', effectiveFrom: todayJst(), effectiveTo: '', basis: 'exclusive', grouping: 'invoice', rounding: 'truncate', precision: '0', reason: '', evidence: ''});

function TaxRuleForm({data, rules, request, readOnly, onSaved, onClose}) {
  const shell = useShell();
  const [form, setForm] = useState(RULE_DEFAULTS);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const unsavedId = `taxrule${useId().replace(/:/g, '')}`;
  const register = shell.registerUnsaved;
  const dirty = Boolean(form.reason.trim() || form.evidence.trim());
  useEffect(() => { register?.(unsavedId, dirty ? 1 : 0, '税ルールの登録'); }, [dirty, unsavedId, register]);
  useEffect(() => () => register?.(unsavedId, 0, '税ルールの登録'), [unsavedId, register]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = latestRuleVersion(rules, form.partnerId);
  const set = (key) => (value) => { setForm((previous) => ({...previous, [key]: value})); setErrors((previous) => ({...previous, [key]: undefined})); };
  const target = form.partnerId ? data?.partners?.find((partner) => String(partner.id) === form.partnerId)?.name || '取引先' : '組織標準';

  async function save(event) {
    event.preventDefault();
    if (busy || readOnly) return;
    const precision = parseInteger(form.precision, {allowNegative: false});
    const checked = validateTaxRule({...form, precision: precision.ok && precision.value !== null ? String(precision.value) : form.precision});
    setErrors(checked.errors);
    if (!checked.ok) { setError({message: `${Object.keys(checked.errors).length}項目を確認してください`}); return; }
    setBusy(true);
    setError(null);
    try {
      await request('/tax/rules', {method: 'POST', body: JSON.stringify({
        partnerId: form.partnerId ? Number(form.partnerId) : null, baseVersion: base, effectiveFrom: form.effectiveFrom, effectiveTo: form.effectiveTo || null,
        basis: form.basis, grouping: form.grouping, rounding: form.rounding, precision: precision.value ?? 0, reason: form.reason.trim(), evidence: form.evidence.trim(),
      })});
      setForm(RULE_DEFAULTS());
      onSaved?.(`${target}の税ルールを第${base + 1}版として登録しました（適用開始 ${dateJst(form.effectiveFrom)}）。確定済みの請求の計算は変わりません。`);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="tax-rule-form" onSubmit={save} noValidate aria-label="税ルールの登録・改訂">
      <p className="rp-muted">請求の税額は、税区分・税率ごとに整数円へ1回丸めます。下の「元計算の単位・桁」は元の報告の計算を再現する参考に使います。</p>
      <fieldset className="on-form-grid" disabled={busy || readOnly}>
        <FormField type="select" label="適用先" value={form.partnerId} onChange={set('partnerId')} blankLabel="組織標準（取引先別のルールが無いときに使う）"
          options={(data?.partners || []).map((partner) => ({value: String(partner.id), label: partner.name}))} />
        <FormField type="date" label="適用開始日" required value={form.effectiveFrom} onChange={set('effectiveFrom')} error={errors.effectiveFrom} />
        <FormField type="date" label="適用終了日" value={form.effectiveTo} onChange={set('effectiveTo')} error={errors.effectiveTo} hint="空欄なら次の版が始まるまで" />
        <FormField type="select" label="計算の起点" includeBlank={false} value={form.basis} onChange={set('basis')} options={Object.entries(basisLabels).map(([value, label]) => ({value, label}))} />
        <FormField type="select" label="元計算の単位" includeBlank={false} value={form.grouping} onChange={set('grouping')} options={Object.entries(groupingLabels).map(([value, label]) => ({value, label}))} />
        <FormField type="int" label="元計算で残す小数の桁" value={form.precision} onChange={set('precision')} error={errors.precision} hint="0〜4" />
        <FormField type="select" label="端数処理" includeBlank={false} value={form.rounding} onChange={set('rounding')} options={Object.entries(roundingLabels).map(([value, label]) => ({value, label}))} />
        <FormField label="採用・変更の理由" required wide value={form.reason} onChange={set('reason')} error={errors.reason} maxLength={1000} />
        <FormField label="根拠資料" required wide value={form.evidence} onChange={set('evidence')} error={errors.evidence} maxLength={4000} placeholder="契約条項・確認日・資料番号" />
      </fieldset>
      <p className="rp-muted">登録する版: {target}の第{base + 1}版。前の版と確定済みの請求の計算は変わりません。</p>
      {error && <Notice tone="error" message={error.message} error={error instanceof Error ? error : undefined} />}
      <div className="on-form-actions">
        <button type="submit" disabled={busy || readOnly}>{busy ? '登録しています…' : '新しい版として登録'}</button>
        {onClose && <button type="button" className="secondary" onClick={onClose} disabled={busy}>閉じる</button>}
      </div>
    </form>
  );
}

const LEDGER_COLUMNS = [
  {key: 'invoiceNumber', label: '請求番号', type: 'code', sticky: true, width: 17},
  {key: 'partnerName', label: '取引先', type: 'text'},
  {key: 'invoiceDate', label: '請求日', type: 'date'},
  {key: 'stateLabel', label: '状態', type: 'text', render: (row) => <span className={`bl-state is-${row.tone}`}>{row.stateLabel}</span>},
  {key: 'amountExTax', label: '請求本体', type: 'yen'},
  {key: 'sourceTax', label: '元報告の税額', type: 'yen'},
  {key: 'billedTax', label: '請求税額', type: 'yen'},
  {key: 'delta', label: '税額差', type: 'yen'},
  {key: 'provenanceLabel', label: '計算の根拠', type: 'text',
    render: (row) => (row.provenance === 'unknown' ? <span className="bl-state is-warn">計算由来不明</span> : <span className="bl-state is-ok">計算履歴あり（行を押すと開く）</span>)},
];

const RULE_COLUMNS = [
  {key: 'scopeLabel', label: '適用先', type: 'text', sticky: true},
  {key: 'version', label: '版', type: 'int', total: 'none'},
  {key: 'effectiveFrom', label: '適用開始', type: 'date'},
  {key: 'effectiveTo', label: '適用終了', type: 'date', value: (row) => row.effectiveTo || null, render: (row) => (row.effectiveTo ? dateJst(row.effectiveTo) : '次の版まで')},
  {key: 'basisLabel', label: '計算の起点', type: 'text'},
  {key: 'groupingLabel', label: '元計算の単位', type: 'text'},
  {key: 'precision', label: '元計算の小数の桁', type: 'text', value: (row) => `小数${row.precision}桁`},
  {key: 'roundingLabel', label: '端数処理', type: 'text'},
  {key: 'reason', label: '採用・変更の理由', type: 'text', wrap: true},
  {key: 'evidence', label: '根拠資料', type: 'text', wrap: true},
];

export default function TaxLedger({data, request: requestProp, onNavigate}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const navigate = onNavigate || shell.navigate;
  const readOnly = Boolean(shell.readOnly || request?.readOnly);
  const isAdmin = data?.currentUser?.role === 'admin';

  const [local, setLocal] = useState(() => ({month: todayJst().slice(0, 7), asOf: todayJst()}));
  const urlMonth = shell.getParam('month', null);
  const urlAsOf = shell.getParam('asOf', null);
  const month = MONTH.test(urlMonth || '') ? urlMonth : local.month;
  const asOf = DATE.test(urlAsOf || '') ? urlAsOf : local.asOf;
  const setCondition = (key, value, valid) => {
    if (!valid.test(value || '')) return;
    setLocal((previous) => ({...previous, [key]: value}));
    shell.setParam(key, value, {replace: true});
  };

  const [ledger, setLedger] = useState({loading: true});
  const [rulesState, setRulesState] = useState({loading: true, rules: []});
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState(null);
  const [ruleNotice, setRuleNotice] = useState(null);
  const [ruleFormOpen, setRuleFormOpen] = useState(() => shell.getParam('rule', null) === 'new');

  const loadRules = useCallback(() => {
    let live = true;
    setRulesState((previous) => ({...previous, loading: true, error: null}));
    request('/tax/rules').then((body) => live && setRulesState({loading: false, rules: body.rules || []})).catch((error) => live && setRulesState({loading: false, rules: [], error}));
    return () => { live = false; };
  }, [request]);
  useEffect(() => loadRules(), [loadRules, revision]);

  const loadLedger = useCallback(() => {
    let live = true;
    setLedger((previous) => ({...previous, loading: true, error: null}));
    request(`/tax/ledger?month=${month}&asOf=${asOf}`).then((body) => live && setLedger({loading: false, body})).catch((error) => live && setLedger({loading: false, error}));
    return () => { live = false; };
  }, [request, month, asOf]);
  useEffect(() => loadLedger(), [loadLedger, revision]);

  const rows = useMemo(() => taxLedgerRows(ledger.body), [ledger.body]);
  const totals = useMemo(() => taxLedgerTotals(ledger.body?.totals), [ledger.body]);
  const ruleRows = useMemo(() => taxRuleRows(rulesState.rules, data?.partners), [rulesState.rules, data?.partners]);
  const noRules = !rulesState.loading && !rulesState.error && rulesState.rules.length === 0;
  const totalsNote = totals.map((item) => `${item.label} ${item.type === 'yen' ? yen(item.value) : `${int(item.value)}件`}`).join('・');

  async function downloadDetailCsv() {
    try {
      const response = await request(`/tax/ledger?month=${month}&asOf=${asOf}&format=csv`, {raw: true});
      downloadBlob(await response.blob(), `税計算台帳_計算の明細_${month}_${asOf}.csv`);
    } catch (error) {
      setNotice({tone: 'error', error});
    }
  }

  function renderDetail(row) {
    if (!row.snapshotId) {
      return <GridDetailFrame><Notice tone="info" compact message="この請求には税計算の記録がありません（計算由来不明）。元の報告の税額のまま作成された請求です。" /></GridDetailFrame>;
    }
    return <GridDetailFrame><SnapshotDetail request={request} snapshotId={row.snapshotId} /></GridDetailFrame>;
  }

  return (
    <div className="stack tax-ledger">
      <section className="card rp-report" aria-label="税計算台帳">
        <header className="rp-head">
          <div>
            <h2>税計算台帳</h2>
            <p className="rp-muted">請求月ごとに、請求税額と元報告の税額、使った税ルールの版を並べます。元の売上の計上月は変えず、取消済み・計算由来不明の請求も記録として残します。</p>
          </div>
          <div className="bl-actions">
            <button type="button" onClick={() => navigate?.('請求・入金')}>請求・入金で請求を作成</button>
            <button type="button" className="secondary" onClick={() => navigate?.('設計キャンバス')}>概念・ER・画面の対応を見る</button>
          </div>
        </header>
        <section className="on-conditions" aria-label="条件">
          <FormField type="month" label="請求月" value={month} onChange={(value) => setCondition('month', value, MONTH)} />
          <FormField type="date" label="確認基準日" value={asOf} onChange={(value) => setCondition('asOf', value, DATE)} hint="この日までの取消を反映します" />
        </section>
        {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
        {ledger.error && <Notice error={ledger.error} onRetry={loadLedger} />}
        {ledger.body && (
          <>
            <div className="rp-tiles" aria-label="基準日時点の有効計">
              {totals.map((item) => (
                <div key={item.key} className={item.key === 'unknownCount' && item.value > 0 ? 'is-warn' : undefined}>
                  <span>{item.label}</span><strong>{item.type === 'yen' ? yen(item.value) : `${int(item.value)}件`}</strong>
                </div>
              ))}
            </div>
            <p className="rp-muted">上の合計は{dateJst(asOf)}時点で有効な請求だけ（取消済みを除く）です。下の表には取消済みの請求も残します。</p>
            <DataGrid columns={LEDGER_COLUMNS} rows={rows} rowKey="key" persistKey="tax-ledger" renderDetail={renderDetail} showTotals={false} ariaLabel="税計算台帳"
              emptyText={`${monthText(month)}の請求はありません。「請求・入金」で税額を計算して請求を確定すると、ここに記録されます。`}
              exportSpec={{name: '税計算台帳', title: `税計算台帳（${monthText(month)}）`, period: month, conditions: [['請求月', monthText(month)], ['確認基準日', dateJst(asOf)]],
                notes: [`基準日時点の有効計: ${totalsNote}`, '取消済みの請求も記録として含みます。計算由来不明は、税計算の記録なしに作成された請求です。']}}
              toolbar={<button type="button" className="secondary" onClick={downloadDetailCsv}>計算の明細CSV（ルール・丸める前の値）</button>} />
          </>
        )}
        {ledger.loading && !ledger.body && <p className="rp-muted" aria-busy="true">台帳を読み込んでいます…</p>}
      </section>
      <section className="card" aria-label="税ルール">
        <header className="section-head">
          <div>
            <h3>税ルール（取引先別・組織標準）</h3>
            <p className="rp-muted">請求日に有効な取引先別のルールを優先し、なければ組織標準を使います。改訂は新しい適用開始日から有効になり、確定済みの請求の計算は保たれます。</p>
          </div>
          {isAdmin && !ruleFormOpen && <button type="button" onClick={() => setRuleFormOpen(true)} disabled={readOnly}>税ルールを登録</button>}
        </header>
        {ruleNotice && <Notice tone={ruleNotice.tone} message={ruleNotice.message} onDismiss={() => setRuleNotice(null)} />}
        {rulesState.error && <Notice error={rulesState.error} onRetry={loadRules} />}
        {noRules && (
          <Notice tone="warn" title="税ルールがまだありません"
            message={isAdmin ? '組織標準の税ルールを1件登録すると、請求の税額を計算できるようになります（例: 税抜起点・切り捨て）。' : '税ルールが無いため、請求の税額を計算できません。管理者に組織標準の税ルールの登録を依頼してください。'} />
        )}
        {!rulesState.loading && ruleRows.length > 0 && (
          <DataGrid columns={RULE_COLUMNS} rows={ruleRows} rowKey="key" persistKey="tax-rules" showTotals={false} ariaLabel="税ルール"
            exportSpec={{name: '税ルール', title: '税ルール（取引先別・組織標準）'}} />
        )}
        {!isAdmin && <p className="rp-muted">税ルールの登録・改訂は管理者が行います。</p>}
        {isAdmin && (ruleFormOpen || noRules) && (
          <TaxRuleForm data={data} rules={rulesState.rules} request={request} readOnly={readOnly}
            onSaved={(message) => { setRuleNotice({tone: 'ok', message}); setRuleFormOpen(false); shell.setParam('rule', null, {replace: true}); setRevision((value) => value + 1); }}
            onClose={noRules ? undefined : () => { setRuleFormOpen(false); shell.setParam('rule', null, {replace: true}); }} />
        )}
      </section>
    </div>
  );
}
