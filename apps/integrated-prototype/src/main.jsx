import {ExpensePaymentsPanel} from './pl-bs/ExpensePayments.jsx';
import BroadcastWorkspace from "./BroadcastWorkspace.jsx";
import ProductionWorkspace from "./ProductionWorkspace.jsx";
import AnalyticsWorkspace from "./AnalyticsWorkspace.jsx";
import MgLedger from "./MgLedger.jsx";
import TaxLedger from "./TaxLedger.jsx";
import WorkCatalog from "./WorkCatalog.jsx";
import Definitions from "./Definitions.jsx";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import IncomeDashboard from "./IncomeDashboard.jsx";
import Settlement from "./Settlement.jsx";
import RightsIntake from "./RightsIntake.jsx";
import ReportMapping from "./ReportMapping.jsx";
import Committee from "./Committee.jsx";
import RightsReports from "./RightsReports.jsx";
import SalesOperations from "./SalesOperations.jsx";
import SalesMaterials from "./SalesMaterials.jsx";
import Billing from "./Billing.jsx";
import "./styles.css";
import { createApi } from "./ui/api-client.mjs";
import { DataGrid } from "./ui/DataGrid.jsx";
import { Notice as UiNotice } from "./ui/Notice.jsx";
import { ResourceList, lookupsFrom } from "./ui/ResourceList.jsx";
import { inferColumns } from "./ui/grid-model.mjs";
import { AppShell } from "./shell/AppShell.jsx";
import { hiddenPagesForRole } from "./shell/nav-model.mjs";
import { ORG_LOAD_FAILED_TITLE, loadFailurePlan, loadSessionData, logoutDestination, openOrgChannel, orgNameOf, orgSyncedNotice, usesLocalLogin } from "./shell/org-model.mjs";
import { useAppShellState, LocalShellProvider, useShell, missingWorkNotice } from "./shell/context.mjs";
import { EntityPicker } from "./ui/EntityPicker.jsx";
import { toEntityItems } from "./ui/entity-match.mjs";
import { ReceiptSheet, SalesCatalog } from "./ReportCenter.jsx";
import { ReportCatalog } from "./reports/ReportCatalog.jsx";
import { ExpenseSheet } from "./expense-sheet/ExpenseSheet.jsx";
import { SalesSheet } from "./sales-sheet/SalesSheet.jsx";
import { BulkImportPanel } from "./bulk/BulkImportPanel.jsx";
import { SalesPage } from "./sales/SalesPage.jsx";
import { SalesImportWizard } from "./import/SalesImportWizard.jsx";
import { SalesViewSwitch } from "./sales-ops/PipelineBoard.jsx";
import { ReleaseWindowsPage } from "./sales-ops/ReleaseWindowsPage.jsx";
import { PartnerListsPage } from "./sales-ops/PartnerListsPage.jsx";
import { ProposalsPage } from "./sales-ops/ProposalsPage.jsx";
import { month as monthText, dateJst } from "./ui/format.mjs";
import { optionsOf, labelOf } from "./ui/labels.mjs";
import { HomeQueue } from "./HomeQueue.jsx";
import { DataBrowser } from "./admin/DataBrowser.jsx";
import { ImportHistory } from "./admin/ImportHistory.jsx";
import { ErPage } from "./admin/ErPage.jsx";
import { ExtensionsPage } from "./admin/ExtensionsPage.jsx";
import { TeamPage } from "./admin/TeamPage.jsx";
import { PartnersPage } from "./partners/PartnersPage.jsx";
import { ExpensesPage } from "./work/ExpensesPage.jsx";
import { PlBsPage } from "./pl-bs/PlBsPage.jsx";
import { RecordForm } from "./ui/RecordForm.jsx";
import DesignCanvas from "./DesignCanvas.jsx";
import { ScriptWorkflow } from "./Workflow.jsx";
import { RoyaltyPeriodsPage } from "./royalty/RoyaltyPeriodsPage.jsx";
import { RoyaltyLedgerPage } from "./royalty/RoyaltyLedgerPage.jsx";
import { RoyaltyStatementsPage } from "./royalty/RoyaltyStatementsPage.jsx";
import { RoyaltyAgreementsPage } from "./royalty/RoyaltyAgreementsPage.jsx";
import { CommitteeMonthlyPage } from "./committee/CommitteeMonthlyPage.jsx";
import Workbench from "./Workbench.jsx";
import DemoSamples from "./DemoSamples.jsx";
import { destinationAfterOrgChange, afterOrgChangeOptions } from "./demo-guide.mjs";
import { allocationsFromRows, bpsToPercentText, describeAllocations, rowsFromAllocations, sameAllocations, totalBpsOfRows } from "./work/allocation.mjs";
import { exposureRows, observationRows, publicityForWork } from "./work/publicity-model.mjs";
// 画面が描いている組織。毎回の API 要求に X-On-Org で載せ、サーバーが別の組織で処理しようとしたら 409 で止めてもらう
// （別のタブで組織を切り替えた・選んでいた組織の所属が無効になった）。409 を受けたら App が今の組織で開き直す（onMismatch）
const orgContext = { renderedOrgId: null, onMismatch: null };
const api = createApi({ orgId: () => orgContext.renderedOrgId, onOrgMismatch: (error) => orgContext.onMismatch?.(error) });
const yen = (value) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(Number(value || 0));
const localDateTime = (date = /* @__PURE__ */ new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
function Login({ onLogin }) {
  const [email, setEmail] = useState("admin@openingnight.invalid"), [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    setError("");
    try {
      await api("/local/login", { method: "POST", body: JSON.stringify({ email }) });
      onLogin();
    } catch (x) {
      setError(x.message);
    }
  }
  return <main className="login"><section className="card login-card"><p className="eyebrow">ローカルの試作環境（架空データ）</p><h1>業務基幹・売上基幹</h1><p>企画から宣伝分析まで、同じ作品と共通DBでつなぎます。</p><form onSubmit={submit}><label>架空メンバー<input list="fixture-users" value={email} onChange={(e) => setEmail(e.target.value)} /><datalist id="fixture-users"><option value="admin@openingnight.invalid" /><option value="editor@openingnight.invalid" /><option value="production@openingnight.invalid" /><option value="outsider@other.invalid" /></datalist></label><button>ローカルで参加</button></form>{error && <p className="error">{error}</p>}<small>承認したローカル招待の .invalid メールも直接入力できます。この入口は127.0.0.1専用で、外部送信は行いません。</small></section></main>;
}
function Field({ label, name, type = "text", options, required = true, value, onChange, placeholder, hidden = false, readOnly = false }) {
  if (hidden) return <input type="hidden" name={name} value={value} />;
  return <label>{label}{options ? <select name={name} required={required} value={value} onChange={onChange}><option value="">選択</option>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select> : <input name={name} type={type} required={required} value={value} onChange={onChange} placeholder={placeholder} readOnly={readOnly} />}</label>;
}
function DataTable({ rows, empty = "まだ登録がありません", bootstrap, resource, persistKey }) {
  const list = Array.isArray(rows) ? rows : [];
  const columns = useMemo(() => inferColumns(list, { resource, lookups: lookupsFrom(bootstrap) }), [list, resource, bootstrap]);
  const hasRaw = list.some((row) => row && row.raw_text != null);
  return <DataGrid columns={columns} rows={list} rowKey="id" emptyText={empty} persistKey={persistKey} renderDetail={hasRaw ? (row) => row.raw_text != null ? <details><summary>原文を表示</summary><pre>{String(row.raw_text)}</pre></details> : null : undefined} />;
}
function Notice({ message, error, tone }) {
  return message ? <UiNotice tone={tone || (error ? "error" : "ok")} message={message} /> : null;
}
const EDITABLE_RESOURCES = new Set(["scenes", "campaigns", "exposures", "expenses", "opportunities"]);
function toRecordField(field, resource) {
  const base = { name: field.name, label: field.label, defaultValue: field.defaultValue, required: field.required !== false, placeholder: field.placeholder };
  if (field.hidden) return { ...base, hidden: true, type: field.type === "number" ? "int" : "text", required: false };
  if (resource === "expenses" && field.name === "actual_inc_tax") return { ...base, type: "yen", required: false, derived: (values) => values.actual_ex_tax == null && values.tax_amount == null ? null : Number(values.actual_ex_tax || 0) + Number(values.tax_amount || 0), hint: "税抜＋税額で自動計算します" };
  if (field.options) return { ...base, type: "select", options: field.options };
  if (field.type === "number") return { ...base, type: /_yen$|^amount|tax|^actual_/.test(field.name) ? "yen" : "int", allowNegative: /^amount|^actual_|tax/.test(field.name) };
  if (["date", "month"].includes(field.type)) return { ...base, type: field.type };
  return { ...base, type: "text", suggestions: field.suggestions, hint: field.hint };
}
function ResourcePanel({ title, resource, fields = [], bootstrap, onChanged, filter, readonly = false, description }) {
  const query = bootstrap?.selectedWorkId && ["sales", "reports"].includes(resource) ? `?workId=${bootstrap.selectedWorkId}` : "";
  const recordFields = useMemo(() => fields.map((field) => toRecordField(field, resource)), [fields, resource]);
  return <ResourceList title={title} description={description} resource={resource} request={api} bootstrap={bootstrap} fields={readonly ? [] : recordFields} query={query} filter={filter} onChanged={onChanged} readonly={readonly} editable={!readonly && EDITABLE_RESOURCES.has(resource)} reloadKey={bootstrap?.selectedWorkId} />;
}
function Planning({ data, reload, onNavigate }) {
  const [revision, setRevision] = useState(0);
  const refresh = async () => {
    await reload();
    setRevision((value) => value + 1);
  };
  const projectOptions = data.projects.map((x) => ({ value: x.id, label: `${x.code}｜${x.title}` }));
  return <div className="stack"><div className="two"><BulkImportPanel entity="projects" label="案件" onCommitted={refresh} /><BulkImportPanel entity="works" label="作品" onCommitted={refresh} /></div><section className="card toolbar"><p className="note">登録済みの作品の名称・形式・売上見込は「マスタの表編集」で直し、承認して反映します（コードは変えられません）。案件は登録後に変更しません。</p>{data.currentUser?.role !== "production" && <button type="button" className="secondary" onClick={() => onNavigate?.("業務データ編集")}>作品を表で直す</button>}</section><div className="two" key={`planning-${revision}`}><ResourcePanel title="案件" resource="projects" bootstrap={data} onChanged={reload} fields={[{ name: "code", label: "案件コード" }, { name: "title", label: "案件名" }, { name: "status", label: "状態", options: optionsOf("projectStatus") }, { name: "budget_yen", label: "予算（円）", type: "number", required: false }]} /><ResourcePanel title="作品" resource="works" bootstrap={data} onChanged={reload} fields={[{ name: "project_id", label: "案件", options: projectOptions }, { name: "code", label: "作品コード" }, { name: "title", label: "作品名" }, { name: "format", label: "形式", options: [{ value: "film", label: "映画" }, { value: "series", label: "シリーズ" }] }, { name: "forecast_yen", label: "売上見込（円）", type: "number", required: false }]} /></div></div>;
}
function ProductAllocation({ data, onChanged }) {
  const [productId, setProductId] = useState(data.products[0]?.id || ""), [current, setCurrent] = useState(null), [rows, setRows] = useState([]), [notice, setNotice] = useState(null), [busy, setBusy] = useState(false), loadNo = useRef(0);
  useEffect(() => {
    if (!productId && data.products[0]) setProductId(data.products[0].id);
  }, [data.products.length]);
  async function load(id) {
    const n = ++loadNo.current;
    setCurrent(null);
    if (!id) {
      setRows([]);
      return;
    }
    try {
      const result = await api(`/product-works?productId=${id}`);
      if (n !== loadNo.current) return;
      setCurrent(result);
      setRows(rowsFromAllocations(result.allocations, data.selectedWorkId));
    } catch (e) {
      if (n === loadNo.current) setNotice({ message: e.message, error: true });
    }
  }
  useEffect(() => {
    setNotice(null);
    load(productId);
  }, [productId]);
  const locked = !current || current.locked || busy, parsed = allocationsFromRows(rows), totalBps = totalBpsOfRows(rows), changed = Boolean(current) && (parsed.errors.length > 0 || !sameAllocations(parsed.allocations, current.allocations));
  const rowErrors = (index) => parsed.errors.filter((x) => x.index === index).map((x) => x.message);
  const setRow = (index, patch) => setRows(rows.map((row, n) => n === index ? { ...row, ...patch } : row));
  async function save() {
    if (parsed.errors.length) {
      setNotice({ message: parsed.errors.map((x) => x.message).join("／"), error: true });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await api("/product-works", { method: "POST", body: JSON.stringify({ productId, allocations: parsed.allocations, baseAllocations: current.allocations }) });
      setNotice({ message: `作品配賦を保存しました（${describeAllocations(parsed.allocations, data.works)}）`, error: false });
      await onChanged?.();
      await load(productId);
    } catch (e) {
      setNotice({ message: e.message, error: true });
    } finally {
      setBusy(false);
    }
  }
  return <section className="card"><header className="section-head"><h2>商品と作品の配賦</h2><span className={totalBps === 1e4 ? "success" : "error"}>合計 {bpsToPercentText(totalBps)}%{totalBps === 1e4 ? "" : "（100%にしてください）"}</span></header><label>商品<select value={productId} onChange={(e) => setProductId(Number(e.target.value))}>{data.products.map((x) => <option key={x.id} value={x.id}>{x.sku}｜{x.name}</option>)}</select></label>{!current ? <p className="note">{productId ? "配賦を読み込んでいます。" : "商品を登録すると配賦を設定できます。"}</p> : <>{current.locked && <p role="status" style={{ margin: 0, padding: "10px 12px", borderRadius: "var(--radius)", borderLeft: "3px solid var(--warn)", background: "var(--warn-soft)", color: "var(--warn)", fontSize: 13 }}>{current.lockReasons.join("／")}</p>}{!current.locked && !current.allocations.length && <p className="note">この商品はまだ作品に配賦されていません。選択中の作品に100%を入れてあります。</p>}{rows.map((row, index) => <div className="allocation" key={index}><label>作品<select value={row.workId} disabled={locked} onChange={(e) => setRow(index, { workId: e.target.value ? Number(e.target.value) : "" })}><option value="">作品を選択</option>{data.works.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label><label>配賦（%）<input inputMode="decimal" value={row.percent} disabled={locked} aria-invalid={rowErrors(index).length > 0} onChange={(e) => setRow(index, { percent: e.target.value })} /></label>{rows.length > 1 && !locked && <button type="button" className="secondary" onClick={() => setRows(rows.filter((_, n) => n !== index))}>この行を外す</button>}{rowErrors(index).map((text) => <small key={text} className="error">{text}</small>)}</div>)}<div className="toolbar">{!locked && <button type="button" className="secondary" onClick={() => setRows([...rows, { workId: "", percent: totalBps < 1e4 ? bpsToPercentText(1e4 - totalBps) : "" }])}>作品行を追加</button>}<button type="button" disabled={locked || !changed || parsed.errors.length > 0} onClick={save}>{busy ? "保存中…" : "配賦を保存"}</button><button type="button" className="secondary" disabled={busy} onClick={() => {
    setNotice(null);
    load(productId);
  }}>最新の配賦を読み込む</button></div></>}<Notice message={notice?.message} error={notice?.error} /></section>;
}
function Products({ data, reload }) {
  const [salesRevision, setSalesRevision] = useState(0), refreshProducts = async () => {
    await reload();
    setSalesRevision((value) => value + 1);
  };
  return <div className="stack"><BulkImportPanel entity="products" label="商品" onCommitted={refreshProducts} /><ResourcePanel key={`products-${salesRevision}`} title="商品" resource="products" bootstrap={data} onChanged={refreshProducts} fields={[{ name: "sku", label: "SKU" }, { name: "name", label: "商品名" }, { name: "channel", label: "流通", options: optionsOf("productChannel").filter((x) => x.value !== "broadcast") }]} /><ProductAllocation data={data} onChanged={refreshProducts} /><SalesOperations key={`${data.selectedWorkId}-${salesRevision}`} data={data} request={api} /></div>;
}
function Partners({ data, reload }) {
  const creation = <section className="card"><h2>取引先を1件登録する</h2><RecordForm openLabel="＋取引先を登録" title="取引先の新規登録" fields={[{ name: "code", label: "取引先コード", type: "text", required: true, hint: "登録後は変更できません" }, { name: "name", label: "名称", type: "text", required: true }, { name: "kind", label: "種類", type: "select", domain: "partnerKind", required: true }, { name: "region", label: "地域", type: "text" }]} onSubmit={(values) => api("/partners", { method: "POST", body: JSON.stringify(values) })} onSaved={() => reload()} /></section>;
  return <PartnersPage data={data} bulkSlot={<BulkImportPanel entity="partners" label="取引先" onCommitted={reload} />} creationSlot={creation} />;
}
function ImportPanel({ data, publicity = false, onCommitted }) {
  const kinds = publicity ? ["publicity"] : ["theatrical", "digital", "package"], [kind, setKind] = useState(kinds[0]), [text, setText] = useState(""), [preview, setPreview] = useState(null), [message, setMessage] = useState("");
  useEffect(() => {
    setPreview(null);
    setText("");
    setMessage("");
  }, [data.selectedWorkId]);
  async function download() {
    try {
      // api 経由で読む（画面の組織を載せる。誤りは日本語の ApiError になる）
      const response = await api(`/downloads/${kind}?workId=${data.selectedWorkId}`, { raw: true });
      const blob = await response.blob(), a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${kind}-sample.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setMessage(e.message);
    }
  }
  async function previewNow() {
    try {
      const out = await api("/imports/preview", { method: "POST", body: JSON.stringify({ kind, workId: data.selectedWorkId, text }) });
      setPreview(out);
      setMessage(out.ok ? "登録前の内容を確認してください" : "エラーを修正してください");
    } catch (e) {
      setMessage(e.message);
    }
  }
  async function commit() {
    try {
      await api("/imports/commit", { method: "POST", body: JSON.stringify({ token: preview.token }) });
      setMessage("全行を一括登録しました");
      setPreview(null);
      setText("");
      onCommitted?.();
    } catch (e) {
      setMessage(e.message);
    }
  }
  function changeText(value) {
    setText(value);
    setPreview(null);
    setMessage("CSVが変わりました。もう一度プレビューしてください。");
  }
  return <section className="card"><header className="section-head"><h2>{publicity ? "宣伝観測CSV" : "売上報告CSV"}</h2><span className="badge">原本をそのまま保存・全行をまとめて登録</span></header><div className="toolbar"><label>種類<select value={kind} onChange={(e) => {
    setKind(e.target.value);
    setPreview(null);
    setText("");
  }}>{kinds.map((x) => <option key={x} value={x}>{labelOf("reportKind", x)}</option>)}</select></label><button className="secondary" onClick={download}>選択作品のサンプルを取得</button></div>{publicity && <p className="note">先に同じ作品の施策と露出を登録すると、その有効なIDを入れたサンプルを取得できます。</p>}{!publicity && <p className="income-caution">新しいCSVは計上基準・対応日・根拠から実計上月を検証します。計上基準は会計・税務上の正しさを自動保証しません。複数の計上月は報告を分割してください。</p>}<label>CSV原文<textarea rows="9" value={text} onChange={(e) => changeText(e.target.value)} placeholder="サンプルCSVを貼り付けるか、ファイルを読み込んでください" /></label><input aria-label="CSVファイル" type="file" accept=".csv,text/csv" onChange={async (e) => changeText(await e.target.files?.[0]?.text() || "")} /><button onClick={previewNow} disabled={!text}>取込内容を確認</button><Notice message={message} error={/エラー|権限|失敗|不明/.test(message)} />{preview && <div className="preview">{preview.recognition && <><h3>計上基準と実計上月</h3><DataTable rows={[preview.recognition]} /></>}{preview.errors?.length > 0 ? <><h3>直す必要がある行（{preview.errors.length}件）</h3><DataTable rows={preview.errors} /></> : <><h3>登録する行（{preview.rows.length}件）</h3><DataTable rows={preview.rows.map((r) => ({ 行: r.rowNo, ...r.data }))} /><button onClick={commit}>表示中の全行を登録</button></>}<details><summary>技術情報（登録先の列）</summary><code>{preview.destinationColumns.join(" / ")}</code></details></div>}</section>;
}
// 1件入力の既定の月は、いま（日本時間）の月
const thisMonthJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
const monthEndJst = (month) => { const [y, m] = month.split("-").map(Number); return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
function ManualSale({ data, onSaved }) {
  const linkedIds = new Set((data.productAllocations || []).filter((x) => x.work_id === data.selectedWorkId).map((x) => x.product_id)), linkedProducts = data.products.filter((x) => linkedIds.has(x.id));
  const makeInitial = () => ({ kind: "digital", report_key: `manual-${data.selectedWorkId}-${Date.now()}`, partner_id: data.partners[0]?.id || "", product_id: "", period_from: `${thisMonthJst()}-01`, period_to: monthEndJst(thisMonthJst()), recognition_basis_id: "1", sales_month: thisMonthJst(), report_received_on: "", contract_start_on: "", license_start_on: "", broadcast_on: "", basis_reason: "販売実績が発生した単月で計上", accounting_month: thisMonthJst(), description: "手入力売上", quantity: "", amount_ex_tax: "0", tax_amount: "0", amount_inc_tax: "0" }), [form, setForm] = useState(makeInitial), [message, setMessage] = useState("");
  useEffect(() => {
    setForm(makeInitial());
    setMessage("");
  }, [data.selectedWorkId]);
  function resolvedMonth(next) {
    const source = { 1: next.sales_month, 2: next.report_received_on, 3: next.contract_start_on, 4: next.license_start_on, 5: next.broadcast_on }[next.recognition_basis_id] || "";
    return next.recognition_basis_id === "1" ? source : source.slice(0, 7);
  }
  async function save(e) {
    e.preventDefault();
    try {
      await api("/sales", { method: "POST", body: JSON.stringify({ ...form, workId: data.selectedWorkId }) });
      setMessage("売上を登録しました");
      setForm(makeInitial());
      onSaved();
    } catch (x) {
      setMessage(x.message);
    }
  }
  const set = (name) => (e) => {
    const next = { ...form, [name]: e.target.value };
    if (["amount_ex_tax", "tax_amount"].includes(name)) next.amount_inc_tax = Number(next.amount_ex_tax || 0) + Number(next.tax_amount || 0);
    if (["recognition_basis_id", "sales_month", "report_received_on", "contract_start_on", "license_start_on", "broadcast_on"].includes(name)) next.accounting_month = resolvedMonth(next);
    setForm(next);
  };
  const basisOptions = (data.recognitionBases || []).map((row) => ({ value: row.id, label: row.name })), basis = Number(form.recognition_basis_id);
  return <section className="card"><header className="section-head"><div><h2>売上の手入力</h2><p className="note">計上基準と対応する月・日付から、実計上月をサーバーでも再計算します。</p></div><span className="badge">会計状態：未確認</span></header><form className="grid-form" onSubmit={save}><Field label="報告キー" value={form.report_key} onChange={set("report_key")} /><Field label="種類" options={["theatrical", "digital", "package"].map((x) => ({ value: x, label: labelOf("reportKind", x) }))} value={form.kind} onChange={set("kind")} /><Field label="取引先" options={data.partners.map((x) => ({ value: x.id, label: x.name }))} value={form.partner_id} onChange={set("partner_id")} /><Field label="商品（作品配賦済みのみ・任意）" required={false} options={linkedProducts.map((x) => ({ value: x.id, label: x.name }))} value={form.product_id} onChange={set("product_id")} /><Field label="販売期間開始" type="date" value={form.period_from} onChange={set("period_from")} /><Field label="販売期間終了" type="date" value={form.period_to} onChange={set("period_to")} /><Field label="計上基準" options={basisOptions} value={form.recognition_basis_id} onChange={set("recognition_basis_id")} /><Field label={`販売月（YYYY-MM）${basis === 1 ? "・必須" : "・任意"}`} type="month" required={basis === 1} value={form.sales_month} onChange={set("sales_month")} /><Field label={`報告受領日${basis === 2 ? "・必須" : "・任意"}`} type="date" required={basis === 2} value={form.report_received_on} onChange={set("report_received_on")} /><Field label={`契約開始日${basis === 3 ? "・必須" : "・任意"}`} type="date" required={basis === 3} value={form.contract_start_on} onChange={set("contract_start_on")} /><Field label={`ライセンス利用開始日${basis === 4 ? "・必須" : "・任意"}`} type="date" required={basis === 4} value={form.license_start_on} onChange={set("license_start_on")} /><Field label={`放送日${basis === 5 ? "・必須" : "・任意"}`} type="date" required={basis === 5} value={form.broadcast_on} onChange={set("broadcast_on")} /><Field label="計上根拠" value={form.basis_reason} onChange={set("basis_reason")} /><Field label="実計上月（自動）" type="month" value={form.accounting_month} onChange={set("accounting_month")} readOnly /><Field label="内容" value={form.description} onChange={set("description")} /><Field label="数量（未確認可）" required={false} type="number" value={form.quantity} onChange={set("quantity")} /><Field label="税抜（返品は負数）" type="number" value={form.amount_ex_tax} onChange={set("amount_ex_tax")} /><Field label="税額" type="number" value={form.tax_amount} onChange={set("tax_amount")} /><Field label="税込（自動）" type="number" value={form.amount_inc_tax} onChange={set("amount_inc_tax")} readOnly /><button>売上を登録</button></form><p className="income-caution">計上基準の選択は、会計・税務上の正しさを自動で保証しません。契約開始・ライセンス利用開始・放送の各基準も管理試作で、収益認識の確定ではありません。</p>{!linkedProducts.length && <p className="note">この作品に配賦した商品はありません。商品を空欄にして作品へ直接計上できます。</p>}<Notice message={message} error={!/登録しました/.test(message)} /></section>;
}
// 売上画面（会社全体）での1件入力・CSV取込は、登録先の作品を画面に出して必ず選ばせる（見えない作品へ計上しない）。
// 既定は条件バーで絞っている作品。絞っていなければ未選択から始める
function SalesEntryTarget({ data, children }) {
  const shell = useShell();
  const filterWork = Number(shell.getParam?.("workId")) || null;
  const [workId, setWorkId] = useState(filterWork);
  useEffect(() => { if (filterWork) setWorkId(filterWork); }, [filterWork]);
  const items = useMemo(() => toEntityItems(data.works || []), [data.works]);
  const work = (data.works || []).find((x) => x.id === workId) || null;
  return <div className="stack"><section className="card"><EntityPicker label="登録先の作品" required items={items} value={workId} onChange={(value) => setWorkId(value ? Number(value) : null)}
    hint="この画面は会社全体の一覧です。登録する売上は、ここで選んだ作品に計上します" /></section>
    {work ? children({ ...data, selectedWorkId: work.id, selectedWork: work }) : <p className="empty">登録先の作品を選ぶと、入力欄が出ます。</p>}</div>;
}
function Expenses({ data }) {
  return <ExpensesPage data={data} renderList={({onChanged}) => <ExpensePaymentsPanel work={data.selectedWork} onChanged={onChanged} />} />;
}
function ManualObservation({ data, campaigns = [], exposures = [], onSaved }) {
  const blank = () => ({ exposure_id: "", metric_definition_id: data.metrics[0]?.id || "", period_from: `${thisMonthJst()}-01`, period_to: monthEndJst(thisMonthJst()), granularity: "month", value: "", verification: "unverified", acquired_at: localDateTime(), paid_organic: "unknown", source: "", region: "" }), [form, setForm] = useState(blank), [notice, setNotice] = useState(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    setForm(blank());
    setNotice(null);
  }, [data.selectedWorkId]);
  const metric = data.metrics.find((x) => x.id === Number(form.metric_definition_id));
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const numeric = metric?.value_type !== "text" && form.value !== "" ? Number(form.value) : null, payload = { exposure_id: form.exposure_id, metric_definition_id: form.metric_definition_id, period_from: form.period_from, period_to: form.period_to, granularity: form.granularity, value_number: numeric, value_text: metric?.value_type === "text" && form.value !== "" ? form.value : null, verification: form.verification, acquired_at: new Date(form.acquired_at).toISOString(), paid_organic: form.paid_organic, source: form.source || null, region: form.region || null };
      await api("/observations", { method: "POST", body: JSON.stringify(payload) });
      setForm({ ...form, value: "" });
      setNotice({ message: `指標観測（${metric?.label || "指標"}）を登録しました`, error: false });
      onSaved?.();
    } catch (error) {
      setNotice({ message: error.message, error: true });
    } finally {
      setBusy(false);
    }
  }
  const set = (name) => (event) => setForm({ ...form, [name]: event.target.value });
  return <section className="card"><header className="section-head"><div><h2>指標観測の手入力</h2><p className="note">未取得の値は空欄のまま「未確認」で登録できます。数量から金額は推測しません。</p></div><span className="badge">{metric ? `${metric.label}｜${metric.unit || "単位なし"}` : "指標を選択"}</span></header>{exposures.length ? <form className="grid-form" onSubmit={save}><Field label="露出" name="exposure_id" options={exposures.map((x) => ({ value: x.id, label: `${campaigns.find((c) => c.id === x.campaign_id)?.name || "施策"}｜${x.medium}` }))} value={form.exposure_id} onChange={set("exposure_id")} /><Field label="指標" name="metric_definition_id" options={data.metrics.map((x) => ({ value: x.id, label: `${x.label}（${x.unit || "単位なし"}）` }))} value={form.metric_definition_id} onChange={set("metric_definition_id")} /><Field label="期間開始" type="date" value={form.period_from} onChange={set("period_from")} /><Field label="期間終了" type="date" value={form.period_to} onChange={set("period_to")} /><Field label="粒度" options={["day", "week", "month", "event", "unknown"].map((x, i) => ({ value: x, label: ["日", "週", "月", "露出単位", "未確認"][i] }))} value={form.granularity} onChange={set("granularity")} /><Field label={`値${metric?.unit ? `（${metric.unit}）` : ""}`} type={metric?.value_type === "text" ? "text" : "number"} required={false} value={form.value} onChange={set("value")} /><Field label="確認状態" options={[{ value: "unverified", label: "未確認" }, { value: "verified", label: "確認済み" }]} value={form.verification} onChange={set("verification")} /><Field label="取得日時" type="datetime-local" value={form.acquired_at} onChange={set("acquired_at")} /><Field label="広告・自然" options={[{ value: "unknown", label: "未確認" }, { value: "paid", label: "広告" }, { value: "organic", label: "自然" }, { value: "mixed", label: "混在" }]} value={form.paid_organic} onChange={set("paid_organic")} /><Field label="出典" required={false} value={form.source} onChange={set("source")} /><Field label="地域" required={false} value={form.region} onChange={set("region")} /><button disabled={busy}>{busy ? "登録中…" : "指標観測を登録"}</button></form> : <p className="note">先にこの作品の露出を登録してください。</p>}<Notice message={notice?.message} error={notice?.error} /></section>;
}
function ExposurePanel({ data, campaigns = [], exposures = [], onChanged }) {
  const blank = () => ({ campaign_id: "", medium: "", asset_version: "", scheduled_at: "", happened_at: "", source_url: "", region: "" }), [form, setForm] = useState(blank), [notice, setNotice] = useState(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    setForm(blank());
    setNotice(null);
  }, [data.selectedWorkId]);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await api("/exposures", { method: "POST", body: JSON.stringify(Object.fromEntries(Object.entries(form).filter(([, value]) => value !== ""))) });
      setNotice({ message: `露出（${campaigns.find((x) => x.id === Number(form.campaign_id))?.name || "施策"}｜${form.medium}）を登録しました`, error: false });
      setForm(blank());
      onChanged?.();
    } catch (x) {
      setNotice({ message: x.message, error: true });
    } finally {
      setBusy(false);
    }
  }
  const set = (name) => (event) => setForm({ ...form, [name]: event.target.value }), rows = exposureRows(exposures, campaigns);
  return <section className="card"><header className="section-head"><h2>露出</h2><span className="count">{rows.length}件</span></header>{campaigns.length ? <form className="grid-form" onSubmit={submit}><Field label="施策" name="campaign_id" options={campaigns.map((x) => ({ value: x.id, label: x.name }))} value={form.campaign_id} onChange={set("campaign_id")} /><Field label="媒体" name="medium" value={form.medium} onChange={set("medium")} /><Field label="素材版" name="asset_version" required={false} value={form.asset_version} onChange={set("asset_version")} /><Field label="予定日時" name="scheduled_at" type="datetime-local" required={false} value={form.scheduled_at} onChange={set("scheduled_at")} /><Field label="実施日時" name="happened_at" type="datetime-local" required={false} value={form.happened_at} onChange={set("happened_at")} /><Field label="出典URL" name="source_url" required={false} value={form.source_url} onChange={set("source_url")} /><Field label="地域" name="region" required={false} value={form.region} onChange={set("region")} /><button disabled={busy}>{busy ? "登録中…" : "露出を登録"}</button></form> : <p className="note">先にこの作品の宣伝施策を登録してください。</p>}<Notice message={notice?.message} error={notice?.error} /><DataTable rows={rows} empty="この作品の露出はまだありません" /></section>;
}
function PublicityAnalytics({ data, revision, campaigns = [] }) {
  const [result, setResult] = useState(null), [error, setError] = useState(""), [filters, setFilters] = useState({ medium: "", region: "", campaignId: "" });
  useEffect(() => {
    setFilters({ medium: "", region: "", campaignId: "" });
  }, [data.selectedWorkId]);
  useEffect(() => {
    let live = true;
    const query = new URLSearchParams({ workId: String(data.selectedWorkId) });
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
    setError("");
    api(`/analytics/publicity?${query}`).then((x) => live && setResult(x)).catch((x) => live && setError(x.message));
    return () => {
      live = false;
    };
  }, [data.selectedWorkId, revision, filters.medium, filters.region, filters.campaignId]);
  const media = [...new Set((result?.rows || []).map((x) => x.medium).filter(Boolean))], regions = [...new Set((result?.rows || []).map((x) => x.region || "unverified"))], groupRows = (result?.groups || []).map((x) => ({ 指標: x.label, 単位: x.unit || "単位なし", 期間: `${dateJst(x.periodFrom)}〜${dateJst(x.periodTo)}`, 粒度: { day: "日", week: "週", month: "月", event: "露出単位", unknown: "未確認" }[x.granularity] || x.granularity, 媒体: x.medium, 地域: x.region === "unverified" ? "未確認" : x.region, 広告区分: { paid: "広告", organic: "自然", mixed: "混在", unknown: "未確認" }[x.paidOrganic] || x.paidOrganic, 既知小計: x.knownSubtotal, 集計結果: x.result, 未取得: x.unknown })), salesRows = (result?.salesReference || []).map((x) => ({ 売上明細: x.id, 作品: data.works.find((w) => w.id === x.work_id)?.title || x.work_id, 販売期間: `${dateJst(x.sales_period_from)}〜${dateJst(x.sales_period_to)}`, 税抜: Number(x.amount_ex_tax), 取引先: x.partner, 地域: x.region || "未確認", 流通: x.channel ? labelOf("channel", x.channel) : "未確認", 元粒度: x.grain === "day" ? "日次" : "期間単位", 地域の意味: "取引先の登録地域（観客所在地ではありません）" }));
  return <section className="card"><h2>宣伝と実績期間の比較</h2><div className="filter-bar"><label>施策<select value={filters.campaignId} onChange={(e) => setFilters({ ...filters, campaignId: e.target.value })}><option value="">すべて</option>{campaigns.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>媒体<select value={filters.medium} onChange={(e) => setFilters({ ...filters, medium: e.target.value })}><option value="">すべて</option>{media.map((x) => <option key={x}>{x}</option>)}</select></label><label>地域<select value={filters.region} onChange={(e) => setFilters({ ...filters, region: e.target.value })}><option value="">すべて</option>{regions.map((x) => <option key={x} value={x}>{x === "unverified" ? "未確認" : x}</option>)}</select></label></div>{error && <Notice message={`比較を読み込めませんでした: ${error}`} error />}<p className="note">{result?.salesNote || "施策と売上は同じ作品・期間の比較候補です。因果を確定しません。地域は取引先登録地域で、観客所在地ではありません。"}</p><h3>指標（単位・期間別）</h3><DataTable rows={groupRows} /><h3>同じ作品の売上参照</h3><DataTable rows={salesRows} empty="制作担当には財務参照を表示しません。該当する有効売上がない場合も空になります。" /></section>;
}
function Publicity({ data }) {
  const [revision, setRevision] = useState(0), bump = () => setRevision((x) => x + 1), [lists, setLists] = useState({ workId: null, campaigns: [], exposures: [], observations: [] }), [loadError, setLoadError] = useState(""), loadNo = useRef(0);
  useEffect(() => {
    const n = ++loadNo.current, workId = data.selectedWorkId;
    setLoadError("");
    Promise.all([api("/campaigns"), api("/exposures"), api("/observations")]).then(([campaignResult, exposureResult, observationResult]) => {
      if (n === loadNo.current) setLists({ workId, ...publicityForWork({ campaigns: campaignResult.rows, exposures: exposureResult.rows, observations: observationResult.rows }, workId) });
    }).catch((error) => {
      if (n === loadNo.current) setLoadError(error.message);
    });
  }, [data.selectedWorkId, revision]);
  const own = lists.workId === data.selectedWorkId ? lists : { campaigns: [], exposures: [], observations: [] }, observationTable = observationRows(own.observations, own.exposures, own.campaigns, data.metrics);
  return <div className="stack">{loadError && <Notice message={`宣伝の一覧を読み込めませんでした: ${loadError}`} error />}<div className="two"><ResourcePanel title="宣伝施策" resource="campaigns" bootstrap={data} onChanged={bump} filter={(x) => x.work_id === data.selectedWorkId} fields={[{ name: "project_id", label: "案件ID", defaultValue: data.selectedWork?.project_id, type: "number", hidden: true }, { name: "work_id", label: "作品ID", defaultValue: data.selectedWorkId, type: "number", hidden: true }, { name: "name", label: "施策名" }, { name: "objective", label: "目的" }, { name: "audience_hypothesis", label: "対象仮説", required: false }, { name: "starts_on", label: "開始日", type: "date" }, { name: "ends_on", label: "終了日", type: "date" }, { name: "target_region", label: "対象地域", required: false }, { name: "target_channel", label: "対象流通", required: false }]} /><ExposurePanel data={data} campaigns={own.campaigns} exposures={own.exposures} onChanged={bump} /></div><ManualObservation data={data} campaigns={own.campaigns} exposures={own.exposures} onSaved={bump} /><ImportPanel data={data} publicity onCommitted={bump} /><section className="card"><header className="section-head"><h2>指標観測</h2><span className="count">{observationTable.length}件</span></header><DataTable rows={observationTable} empty="この作品の指標観測はまだありません" /></section><PublicityAnalytics data={data} revision={revision} campaigns={own.campaigns} /></div>;
}
function Income({ data }) {
  const [overview, setOverview] = useState(null), [detail, setDetail] = useState(null), [selectedMonth, setSelectedMonth] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const overviewRequest = useRef(0), detailRequest = useRef(0), currentWork = useRef(data.selectedWorkId);
  currentWork.current = data.selectedWorkId;
  useEffect(() => {
    if (!data.selectedWorkId) return;
    const requestId = ++overviewRequest.current, workId = data.selectedWorkId;
    detailRequest.current++;
    setOverview(null);
    setDetail(null);
    setSelectedMonth("");
    setError("");
    setLoading(true);
    api(`/analytics/income?workId=${workId}`).then((result) => {
      if (requestId === overviewRequest.current && workId === currentWork.current) setOverview(result);
    }).catch((reason) => {
      if (requestId === overviewRequest.current && workId === currentWork.current) setError(reason.message);
    }).finally(() => {
      if (requestId === overviewRequest.current && workId === currentWork.current) setLoading(false);
    });
  }, [data.selectedWorkId]);
  async function selectMonth(month) {
    setSelectedMonth(month);
    setDetail(null);
    setError("");
    const requestId = ++detailRequest.current, workId = data.selectedWorkId;
    try {
      const result = await api(`/analytics/income?workId=${workId}&month=${month}`);
      if (requestId === detailRequest.current && workId === currentWork.current) setDetail(result);
    } catch (reason) {
      if (requestId === detailRequest.current && workId === currentWork.current) setError(reason.message);
    }
  }
  const allocationRows = (detail?.allocatedLines || []).map((line) => ({ 売上明細: line.sale_id, 配賦先作品: data.works.find((work) => work.id === line.allocated_work_id)?.title || `作品 ${line.allocated_work_id}`, 配賦率: `${(Number(line.allocation_bps) / 100).toFixed(2)}%`, 税抜: yen(line.amount_ex_tax), 税額: yen(line.tax_amount), 税込: yen(line.amount_inc_tax) }));
  return <div className="stack">
    {loading && <section className="card"><p className="empty" aria-live="polite">月別収支を読み込んでいます。</p></section>}
    <Notice message={error} error />
    {overview && <>
      <section className="card income-summary"><header><h2>作品収支</h2><p className="income-caution">登録済みデータの集計です。報告の網羅性は未確認で、分配・仕入・代理店手数料は未反映です。差引は「売上報告額 − 登録経費」で、代理店利益ではありません。</p></header><div className="stats"><div><strong>{overview.monthly?.length ? yen(overview.sales.exTax) : "未登録"}</strong><span>売上報告額（税抜）</span></div><div><strong>{overview.monthly?.length ? yen(overview.expenses.exTax) : "未登録"}</strong><span>登録経費（税抜）</span></div><div><strong>{overview.monthly?.length ? yen(overview.profitExTax) : "未登録"}</strong><span>差引（税抜）</span></div></div></section>
      <IncomeDashboard monthly={overview.monthly} selectedMonth={selectedMonth} onSelectMonth={selectMonth} workTitle={data.selectedWork?.title} />
      <section className="card income-detail"><header className="section-head"><div><h2>月別明細</h2><p className="note">{selectedMonth ? `${monthText(selectedMonth)}の会計計上明細` : "グラフまたは数値表から会計の計上月を選択してください。"}</p></div></header>{selectedMonth && !detail && <p className="empty" aria-live="polite">明細を読み込んでいます。</p>}{detail && <><div className="stats"><div><strong>{yen(detail.sales.exTax)}</strong><span>月の売上報告額（税抜）</span></div><div><strong>{yen(detail.expenses.exTax)}</strong><span>月の登録経費（税抜）</span></div><div><strong>{yen(detail.profitExTax)}</strong><span>月の差引（税抜）</span></div></div><DataTable rows={allocationRows} bootstrap={data} empty="この月の売上明細は未登録です。" /></>}</section>
    </>}
  </div>;
}
// 制作担当に出さない画面。営業基幹・売上基幹の画面（EIGYO_PAGES・SALES_PAGES）は全部、ほかは財務・取引に触れる業務基幹の画面と管理者の画面。
// 営業基幹・売上基幹に画面を足せば自動で隠れる（一覧は nav-model.mjs の hiddenPagesForRole）
const HIDDEN_FOR_PRODUCTION = hiddenPagesForRole("production");
const HIDDEN_FOR_EDITOR = hiddenPagesForRole("editor");
const HIDDEN_FOR_ADMIN = hiddenPagesForRole("admin");
function readTheme() {
  try {
    return localStorage.getItem("on-theme") || "auto";
  } catch {
    return "auto";
  }
}
function LoadFailure({ error, title, onRetry }) {
  return <main className="login"><section className="card login-card"><UiNotice title={title} error={error} onRetry={onRetry} retryLabel="再接続する" /></section></main>;
}
// Worker（Cloudflare Access）で認証が切れたときの表示。ローカルの架空メンバーのログイン画面は出さない
function SignedOut() {
  return <main className="login"><section className="card login-card"><p className="eyebrow">OpeningNight</p><h1>業務基幹・売上基幹</h1><p>サインインが必要です。もう一度入ると、Cloudflare Access で本人確認をしてから開きます。</p><p><button type="button" onClick={() => window.location.assign("/")}>もう一度入る</button></p></section></main>;
}
function App() {
  const [session, setSession] = useState(void 0), [bootstrap, setBootstrap] = useState(null), [theme, setTheme] = useState(readTheme), [loadError, setLoadError] = useState(null);
  const [mode, setMode] = useState(null);
  const [orgs, setOrgs] = useState([]), [orgsError, setOrgsError] = useState(null), [orgSwitching, setOrgSwitching] = useState(false), [orgReloading, setOrgReloading] = useState(false), [orgError, setOrgError] = useState(""), [orgNotice, setOrgNotice] = useState("");
  const nav = useAppShellState({ request: api, works: bootstrap?.works || [] });
  const navRef = useRef(nav), syncing = useRef(null), syncRef = useRef(null), channelRef = useRef(null);
  navRef.current = nav;
  // 組織が変わるときは前の組織の画面・条件・作品を持ち越さない（force で未保存の登録と確認待ちも消す）
  const goHomeForOrgChange = () => {
    try { navRef.current.navigate("ホーム", {}, { force: true, clearWork: true }); } catch {}
  };
  // 組織を切り替えて読み直したあとに、指定の画面（after: {page, params, workCode}）へ移る。作品は作品コードで今の組織の作品から引く
  const openAfterOrgChange = (after, loaded) => {
    const target = destinationAfterOrgChange(after, loaded?.bootstrap?.works || []);
    if (!target) return;
    if (target.missing) setOrgNotice(`切り替えた組織に作品 ${target.workCode} が見つからないため、ホームを開きました。`);
    try { navRef.current.navigate(target.page, target.params, afterOrgChangeOptions(target)); } catch {}
  };
  // 画面を読み直す。まず /api/session で今の組織を知り、その組織で作品・取引先などを読む（shell/org-model.mjs の loadSessionData）。
  // orgTransition は組織が変わる読み直し（切替・別の画面での切替に合わせる）。失敗したら前の組織の画面とデータを残さない。
  // 成功したら読み込んだ内容を返し、失敗したら null を返す
  async function refreshAll({ orgTransition = false } = {}) {
    const renderedOrgId = orgContext.renderedOrgId;
    try {
      const loaded = await loadSessionData(api);
      if (renderedOrgId != null && loaded.session.orgId !== renderedOrgId && !orgTransition) {
        // 読み直したら組織が変わっていた（別のタブで切り替えた等）。切替と同じくホームから開き直す
        goHomeForOrgChange();
        setOrgNotice(orgSyncedNotice({ orgName: orgNameOf(loaded), reset: loaded.orgReset }));
      }
      orgContext.renderedOrgId = loaded.session.orgId;
      setMode(loaded.mode);
      setSession(loaded.session);
      setBootstrap({ ...loaded.bootstrap, workflowMappingAi: { enabled: loaded.capabilities.mappingAiEnabled }, workflowExtractionEnabled: loaded.capabilities.extractionEnabled });
      if (loaded.orgs) setOrgs(loaded.orgs);
      setOrgsError(loaded.orgsError || null);
      setLoadError(null);
      return loaded;
    } catch (error) {
      const plan = loadFailurePlan({ error, orgTransition, rendered: renderedOrgId != null });
      if (plan === "signed-out") {
        orgContext.renderedOrgId = null;
        setSession(null);
        setBootstrap(null);
        setLoadError(null);
        // ログイン画面（ローカル）かサインアウトの表示（Worker）かを決めるため、処理環境を確かめる（認証なしで読める）
        if (mode == null) api("/health", { orgId: null }).then((health) => setMode(health?.mode || "unknown"), () => setMode("unknown"));
      } else if (plan === "discard") {
        orgContext.renderedOrgId = null;
        setBootstrap(null);
        setLoadError({ error, title: ORG_LOAD_FAILED_TITLE });
      } else {
        setLoadError({ error });
      }
      return null;
    }
  }
  // 画面部品に渡す読み直し（引数は受け取らない）
  const reload = () => refreshAll();
  async function reloadOrgs() {
    try {
      const result = await api("/session/orgs", { orgId: null });
      setOrgs(Array.isArray(result?.orgs) ? result.orgs : []);
      setOrgsError(null);
    } catch (error) {
      setOrgsError(error);
    }
  }
  // サーバーの今の組織で開き直す。組織の食い違い（409）を受けたとき・別のタブで切り替えたと分かったときに呼ぶ。同時に何度呼ばれても1回だけ
  function syncToServerOrg({ rejected = false } = {}) {
    if (syncing.current) return syncing.current;
    syncing.current = (async () => {
      setOrgReloading(true);
      goHomeForOrgChange();
      const loaded = await refreshAll({ orgTransition: true });
      if (loaded) setOrgNotice(orgSyncedNotice({ orgName: orgNameOf(loaded), reset: loaded.orgReset, rejected }));
    })().finally(() => {
      setOrgReloading(false);
      syncing.current = null;
    });
    return syncing.current;
  }
  syncRef.current = syncToServerOrg;
  orgContext.onMismatch = () => {
    if (orgContext.renderedOrgId != null) syncRef.current?.({ rejected: true });
  };
  useEffect(() => {
    refreshAll();
    // 別のタブで組織を切り替えたら、このタブも開き直す（BroadcastChannel）。タブに戻ったときも今の組織を確かめる
    channelRef.current = openOrgChannel((orgId) => {
      if (orgContext.renderedOrgId != null && orgId !== orgContext.renderedOrgId) syncRef.current?.({ rejected: false });
    });
    const onVisible = async () => {
      if (document.visibilityState !== "visible" || orgContext.renderedOrgId == null || syncing.current) return;
      try {
        const current = await api("/session", { orgId: null, notifyOrgMismatch: false });
        const orgId = Number(current?.user?.orgId);
        if (orgContext.renderedOrgId != null && Number.isSafeInteger(orgId) && orgId !== orgContext.renderedOrgId) syncRef.current?.({ rejected: false });
      } catch {}
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("on-theme", theme);
    } catch {
    }
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  // 組織を切り替える（上部の「組織」で選んで「切り替える」を押したとき・デモ資料などの「組織を切り替えて開く」）。
  // 未保存の変更は先に確かめ、切り替えたらホームへ移って作品・取引先などを読み直す。after を渡すと、読み直したあとにその画面へ移る。
  // 切り替えたら true、取りやめ・失敗は false
  async function switchOrg(orgId, { after = null } = {}) {
    if (!Number.isInteger(orgId) || orgId === session?.orgId || orgSwitching) return false;
    const unsaved = nav.unsaved || { count: 0, items: [] };
    if (unsaved.count > 0) {
      const names = [...new Set(unsaved.items.map((item) => item.label))].join("・");
      if (!window.confirm(`未保存の変更があります（${names || "入力中の内容"}）。組織を切り替えると失われます。切り替えますか？`)) return false;
    }
    setOrgError("");
    setOrgNotice("");
    setOrgSwitching(true);
    try {
      await api("/session/org", { method: "POST", body: JSON.stringify({ orgId }), orgId: null });
    } catch (error) {
      setOrgError(error.message || "組織を切り替えられませんでした");
      setOrgSwitching(false);
      return false;
    }
    // ほかのタブにも知らせる（そのタブは今の組織で開き直す）
    channelRef.current?.post(orgId);
    // 切り替えが済んだら、前の組織の画面を閉じてから読み直す。読み直せなければ前の組織の画面は出さず、読み込みの失敗を出す
    setOrgReloading(true);
    goHomeForOrgChange();
    try {
      const loaded = await refreshAll({ orgTransition: true });
      if (loaded && after) openAfterOrgChange(after, loaded);
    } finally {
      setOrgReloading(false);
      setOrgSwitching(false);
    }
    return true;
  }
  async function logout() {
    // 未保存の入力があれば、退出の前に確かめる（確かめずにセッションを消すと入力が黙って消える）
    const unsaved = nav.unsaved || { count: 0, items: [] };
    if (unsaved.count > 0) {
      const names = [...new Set(unsaved.items.map((item) => item.label))].join("・");
      if (!window.confirm(`未保存の変更があります（${names || "入力中の内容"}）。退出すると失われます。退出しますか？`)) return;
    }
    try {
      await api("/session", { method: "DELETE", orgId: null });
    } catch {}
    // 次に入る人（別の役割のこともある）が前の人の画面・領域から始まらないよう、ホームへ戻してから退出する
    // force で未保存の登録と確認待ちを消す（次に入る人に前の人の確認を残さない）
    try { nav.navigate("ホーム", {}, { replace: true, force: true }); } catch {}
    orgContext.renderedOrgId = null;
    // Worker は Cloudflare Access からサインアウトする（Access のセッションが残ると、再読込だけで同じ権限で入れてしまう）。
    // ローカルの架空メンバーのログイン画面は、ローカルの試作でだけ出す
    const destination = logoutDestination(mode);
    if (destination) {
      window.location.assign(destination);
      return;
    }
    setSession(null);
  }
  if (loadError && !bootstrap) return <LoadFailure error={loadError.error} title={loadError.title} onRetry={reload} />;
  if (session === void 0) return <main className="login" aria-busy="true">読込中…</main>;
  if (!session) {
    if (mode == null) return <main className="login" aria-busy="true">読込中…</main>;
    return usesLocalLogin(mode) ? <Login onLogin={reload} /> : <SignedOut />;
  }
  if (!bootstrap) return null;
  const selectedWorkId = nav.workId;
  const data = { ...bootstrap, currentUser: session, selectedWorkId, selectedWork: bootstrap.works.find((w) => w.id === selectedWorkId) };
  const hidden = session.role === "production" ? HIDDEN_FOR_PRODUCTION : session.role === "admin" ? HIDDEN_FOR_ADMIN : HIDDEN_FOR_EDITOR;
  const navigate = nav.navigate;
  const screens = { "番販・放送": <BroadcastWorkspace data={data} request={api} onNavigate={nav.navigate} onSelect={nav.selectWork} />, "分析・Lightdash": <AnalyticsWorkspace request={api} data={data} />, "業務データ編集": <Workbench data={data} request={api} initialDataset="works" />, "売上データ編集": <Workbench data={data} request={api} initialDataset="sales_import" />, "MG契約・台帳": <MgLedger data={data} request={api} />, "権利先・MG帳票": <RightsReports data={data} request={api} />, "税ルール・台帳": <TaxLedger data={data} request={api} onNavigate={nav.navigate} />, "作品・商品マスタ": <div className="stack"><div className="two"><BulkImportPanel entity="works" label="作品" onCommitted={reload} /><BulkImportPanel entity="products" label="商品" onCommitted={reload} /></div><WorkCatalog request={api} data={data} onSelect={nav.selectWork} reload={reload} /></div>, "設計・定義": <Definitions onNavigate={nav.navigate} />, "台本・香盤": <ScriptWorkflow key={selectedWorkId} data={data} request={api} reload={reload} />, "原本取り込み": <SalesImportWizard data={data} request={api} reload={reload} onNavigate={nav.navigate} />, "帳票センター": <ReportCatalog data={data} onNavigate={nav.navigate} onSwitchOrg={switchOrg} />, "経費集計シート": <ExpenseSheet />, "売上集計シート": <SalesSheet data={data} onSwitchOrg={switchOrg} />, "月別消込": <ReceiptSheet data={data} request={api} onNavigate={nav.navigate} />, "営業作品一覧": <SalesCatalog data={data} request={api} />, "全作品のウィンドウ": <ReleaseWindowsPage request={api} />, "取引先別リスト": <PartnerListsPage request={api} />, "提案資料": <ProposalsPage request={api} />, ホーム: <HomeQueue data={data} />, "企画・作品": <Planning data={data} reload={reload} onNavigate={nav.navigate} />, 制作: <ProductionWorkspace key={selectedWorkId} data={data} request={api} onNavigate={nav.navigate} onSwitchOrg={switchOrg} />, "商品・営業": <SalesViewSwitch request={api} workTitle={data.selectedWork?.title} workView={<Products data={data} reload={reload} />} />, 営業資料: <SalesMaterials data={data} request={api} />, 取引先: <Partners data={data} reload={reload} />, 売上: <SalesPage data={data} onNavigate={nav.navigate} manualSlot={(refresh) => <SalesEntryTarget data={data}>{(target) => <ManualSale data={target} onSaved={() => { reload(); refresh(); }} />}</SalesEntryTarget>} legacySlot={(refresh) => <SalesEntryTarget data={data}>{(target) => <ImportPanel data={target} onCommitted={() => { reload(); refresh(); }} />}</SalesEntryTarget>} />, "請求・入金": <Billing data={data} request={api} onNavigate={nav.navigate} />, "報告書マッピング": <ReportMapping data={data} request={api} />, 経費: <Expenses data={data} />, 宣伝: <Publicity data={data} />, 収支: <Income data={data} />, "PL・BS": <PlBsPage data={data} onNavigate={nav.navigate} />, "調達・権利": <RightsIntake data={data} request={api} />, "権利・分配": <Settlement data={data} request={api} />, 製作委員会: <Committee data={data} request={api} />, "ロイヤリティ作成": <RoyaltyPeriodsPage data={data} onNavigate={nav.navigate} />, "ロイヤリティ集計": <RoyaltyLedgerPage data={data} onNavigate={nav.navigate} />, "ロイヤリティ報告書": <RoyaltyStatementsPage data={data} onNavigate={nav.navigate} />, "ロイヤリティ契約": <RoyaltyAgreementsPage data={data} onNavigate={nav.navigate} />, "委員会月次収支": <CommitteeMonthlyPage data={data} onNavigate={nav.navigate} />, 拡張項目: <ExtensionsPage data={data} reload={reload} />, チーム: <TeamPage data={data} />, ER: <ErPage data={data} /> };
  screens["データ一覧"] = <DataBrowser />;
  screens["取込履歴"] = <ImportHistory />;
  screens["デモ資料"] = <DemoSamples onNavigate={nav.navigate} works={data.works} partners={data.partners} products={data.products} request={api} currentOrgId={session.orgId} currentOrgName={orgs.find((org) => org.id === session.orgId)?.name || ""} onSwitchOrg={switchOrg} />;
  screens["設計キャンバス"] = <DesignCanvas screenKeys={Object.keys(screens)} request={api} currentUser={session} onNavigate={nav.navigate} renderScreen={(name) => hidden.has(name) ? <p>この役割では参照できません</p> : <LocalShellProvider readOnly>{screens[name]}</LocalShellProvider>} />;
  // 組織を切り替えたあと読み直す間は画面を描かない（前の組織の画面が新しい組織のデータを読みにいかないように）。組織が変わったら外枠ごと作り直す
  if (orgReloading) return <main className="login" aria-busy="true">組織を切り替えています…</main>;
  const shellNotice = orgNotice || loadError || nav.missingWork ? <>
    {orgNotice && <UiNotice tone="info" message={orgNotice} onDismiss={() => setOrgNotice("")} />}
    {nav.missingWork && <UiNotice tone="warn" message={missingWorkNotice(nav.missingWork, data.selectedWork?.title, { canSwitchOrg: orgs.length >= 2 && !orgsError })} onDismiss={nav.dismissMissingWork} />}
    {loadError && <UiNotice title="最新の内容を読み込めませんでした。表示は前に読み込んだ内容です" error={loadError.error} onRetry={reload} retryLabel="読み直す" onDismiss={() => setLoadError(null)} />}
  </> : null;
  return <AppShell key={`org-${session.orgId}`} state={nav} session={session} bootstrap={bootstrap} screens={screens} hiddenPages={hidden} theme={theme} onTheme={setTheme} orgs={orgs} orgsError={orgsError} onRetryOrgs={reloadOrgs} onSwitchOrg={switchOrg} orgSwitching={orgSwitching} orgError={orgError} notice={shellNotice} onLogout={logout} />;
}
createRoot(document.getElementById("root")).render(<App />);
