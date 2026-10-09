// 入金登録の論理（純関数）。「請求・入金」と「月別入金表」の入金フォーム（ReceiptForm）が同じものを使う。
// - 請求の元データは /api/receipt-sheet の rows（events 付き）でも /api/billing の invoices（receipts 付き）でもよい。
//   どちらも normalizeInvoice で同じ形に直すので、同じ入力なら同じ消込先・同じ登録内容になる。
// - 既定の消込額 = min(入金の未充当, 請求の未消込)。利用者が消込額を直した請求はその額を保つ（触るまでは既定に追従）。
// - 二重登録の検出: 同じ取引先・入金日・金額・参照番号の有効な入金があれば警告し、理由がなければ登録へ進ませない。
// - サーバー（POST /api/billing/receipts）の条件に合わせる: 消込先は10請求まで、消込合計＝入金額、請求日≦入金日。
// node:* を使わない（ブラウザ・Node・Worker で同じに動く）。
import {parseYen, formatNumberInput, isBlankInput} from '../ui/parse-input.mjs';
import {labelOf} from '../ui/labels.mjs';

export const MAX_ALLOCATIONS = 10;
export const REFERENCE_MAX = 160;
export const NOTE_MAX = 2000;
// 入金フォームは「いまの未消込」を使う。基準日を遠い未来にすると、取消済みでない入金をすべて差し引いた残高になる。
export const OPEN_BALANCE_AS_OF = '9999-12-31';
export const DUPLICATE_NOTE_PREFIX = '二重登録ではない理由: ';

const DAY_MS = 24 * 3600 * 1000;
const toInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

export function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(to).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

// 請求1件を共通の形に直す。allocated は取消していない入金の消込額の合計（入金日を問わない）。
export function normalizeInvoice(row) {
  const events = Array.isArray(row?.events) ? row.events : Array.isArray(row?.receipts) ? row.receipts : [];
  const amount = toInt(row?.amount_inc_tax ?? row?.amount ?? 0);
  const allocated = events.filter((event) => !event.reversed_on).reduce((sum, event) => sum + toInt(event.amount_yen), 0);
  const isVoid = row?.status === 'void' || Boolean(row?.voided_on) || Boolean(row?.isVoid);
  const dueDate = row?.due_date ?? row?.dueDate ?? '';
  return {
    invoiceId: toInt(row?.id ?? row?.invoiceId),
    invoiceNumber: row?.invoice_number ?? row?.invoiceNumber ?? '',
    partnerId: toInt(row?.partner_id ?? row?.partnerId),
    partnerName: row?.partner_name ?? row?.partnerName ?? '',
    invoiceDate: row?.invoice_date ?? row?.invoiceDate ?? '',
    dueDate,
    plannedDate: row?.plannedDate || dueDate,
    amount,
    allocated,
    open: isVoid ? 0 : Math.max(0, amount - allocated),
    isVoid,
  };
}

const byDue = (a, b) => (a.plannedDate || '').localeCompare(b.plannedDate || '') || (a.invoiceDate || '').localeCompare(b.invoiceDate || '') || a.invoiceId - b.invoiceId;

// 消し込める請求（取消済みでなく、未消込が残るもの）。期日の古い順。
// receivedOn を渡すと、請求日が入金日より後の請求は eligible=false と理由を付ける（サーバーが拒否するため）。
export function receiptCandidates(rows, {partnerId = null, receivedOn = ''} = {}) {
  const partner = partnerId === null || partnerId === undefined || partnerId === '' ? null : toInt(partnerId);
  return (Array.isArray(rows) ? rows : []).map(normalizeInvoice)
    .filter((invoice) => !invoice.isVoid && invoice.open > 0 && (partner === null || invoice.partnerId === partner))
    .map((invoice) => {
      const eligible = !receivedOn || !invoice.invoiceDate || invoice.invoiceDate <= receivedOn;
      return {...invoice, eligible, reason: eligible ? '' : `請求日（${invoice.invoiceDate}）より前の入金日には消し込めません`};
    })
    .sort(byDue);
}

// 未消込の請求がある取引先の選択肢（名称順）。
export function partnerOptions(rows) {
  const map = new Map();
  for (const invoice of receiptCandidates(rows)) {
    const entry = map.get(invoice.partnerId) || {value: String(invoice.partnerId), name: invoice.partnerName, count: 0, open: 0};
    entry.count += 1;
    entry.open += invoice.open;
    map.set(invoice.partnerId, entry);
  }
  return [...map.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    .map((entry) => ({value: entry.value, label: `${entry.name}（未消込 ${entry.count}件・${formatNumberInput(entry.open)}円）`, name: entry.name, count: entry.count, open: entry.open}));
}

// 登録済みの入金（入金ごと）。amount は見えている請求への消込額の合計。
export function existingReceipts(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const invoice = normalizeInvoice(row);
    const events = Array.isArray(row?.events) ? row.events : Array.isArray(row?.receipts) ? row.receipts : [];
    for (const event of events) {
      const id = toInt(event.receipt_id);
      const entry = map.get(id) || {
        receiptId: id, partnerId: invoice.partnerId, partnerName: invoice.partnerName, receivedOn: event.received_on,
        reference: event.reference ?? '', amount: 0, invoiceNumbers: [], reversed: Boolean(event.reversed_on), reversedOn: event.reversed_on || null,
      };
      entry.amount += toInt(event.amount_yen);
      if (invoice.invoiceNumber && !entry.invoiceNumbers.includes(invoice.invoiceNumber)) entry.invoiceNumbers.push(invoice.invoiceNumber);
      map.set(id, entry);
    }
  }
  return [...map.values()].sort((a, b) => (a.receivedOn || '').localeCompare(b.receivedOn || '') || a.receiptId - b.receiptId);
}

// 参照番号は全角・空白・大文字小文字の違いを同じとみなす。
export function normalizeReference(text) {
  return String(text ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

// 同じ取引先・入金日・金額・参照番号の入金。取消済みの入金は重複に数えず、参考として返す。
export function findDuplicateReceipts(receipts, {partnerId, receivedOn, amount, reference}) {
  const key = normalizeReference(reference);
  const partner = toInt(partnerId);
  const value = toInt(amount);
  if (!partner || !receivedOn || !value || !key) return {duplicates: [], reversed: []};
  const same = (Array.isArray(receipts) ? receipts : []).filter((receipt) => receipt.partnerId === partner && receipt.receivedOn === receivedOn
    && receipt.amount === value && normalizeReference(receipt.reference) === key);
  return {duplicates: same.filter((receipt) => !receipt.reversed), reversed: same.filter((receipt) => receipt.reversed)};
}

// 既定の消込額 = min(未充当, 未消込)。未充当が未定（入金額が未入力）のときは未消込の全額。
export function defaultAllocation(unallocated, open) {
  const cap = Math.max(0, toInt(open));
  if (unallocated === null || unallocated === undefined || !Number.isFinite(Number(unallocated))) return cap;
  return Math.max(0, Math.min(toInt(unallocated), cap));
}

export function parseAmount(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (isBlankInput(text)) return null;
  const parsed = parseYen(text, {allowNegative: false});
  return parsed.ok ? parsed.value : null;
}

// フォームの状態: {partnerId, receivedOn, amountText, reference, note, duplicateReason, lines: {[invoiceId]: {selected, touched, text}}}
export function initialReceiptState({partnerId = '', invoiceId = null, receivedOn = todayJst(), rows = []} = {}) {
  const state = {partnerId: partnerId ? String(partnerId) : '', receivedOn, amountText: '', reference: '', note: '', duplicateReason: '', lines: {}};
  if (invoiceId === null || invoiceId === undefined || invoiceId === '') return state;
  const invoice = receiptCandidates(rows).find((row) => row.invoiceId === toInt(invoiceId));
  if (!invoice) return state;
  // 請求の行から開いたときは、その請求の未消込を入金額の初期値にして全額を配分する（直せる）。
  return recomputeDefaults({
    ...state,
    partnerId: String(invoice.partnerId),
    amountText: formatNumberInput(invoice.open),
    lines: {[invoice.invoiceId]: {selected: true, touched: false, text: ''}},
  }, receiptCandidates(rows, {partnerId: invoice.partnerId}));
}

const lineOf = (state, id) => state.lines[id] || {selected: false, touched: false, text: ''};

// 触っていない（既定に追従する）消込額を、期日の古い順に min(未充当, 未消込) で入れ直す。
export function recomputeDefaults(state, candidates) {
  const amount = parseAmount(state.amountText);
  const selected = candidates.filter((invoice) => lineOf(state, invoice.invoiceId).selected);
  const touchedTotal = selected.filter((invoice) => lineOf(state, invoice.invoiceId).touched)
    .reduce((sum, invoice) => sum + (parseAmount(lineOf(state, invoice.invoiceId).text) || 0), 0);
  let remaining = amount === null ? null : amount - touchedTotal;
  const lines = {...state.lines};
  for (const invoice of selected) {
    const line = lineOf(state, invoice.invoiceId);
    if (line.touched) continue;
    const value = defaultAllocation(remaining, invoice.open);
    if (remaining !== null) remaining -= value;
    lines[invoice.invoiceId] = {...line, text: value ? formatNumberInput(value) : ''};
  }
  return {...state, lines};
}

export function setReceiptField(state, key, value, candidates) {
  const next = {...state, [key]: value};
  if (key === 'partnerId') return {...next, lines: {}};
  if (key === 'amountText') return recomputeDefaults(next, candidates);
  return next;
}

// 請求を選ぶ・外す。選んだ請求は既定の消込額（min(未充当, 未消込)）で入る。
export function toggleInvoice(state, candidates, invoiceId, selected) {
  const id = toInt(invoiceId);
  const lines = {...state.lines, [id]: selected ? {selected: true, touched: false, text: ''} : {selected: false, touched: false, text: ''}};
  return recomputeDefaults({...state, lines}, candidates);
}

// 消込額を手で直す。以後この請求は既定に追従しない（ほかの未変更の請求は残りで入れ直す）。
// 空欄にしても既定で埋め直さない（入力中に値が戻らないように）。既定に戻すのは autoAllocate。
export function setAllocationText(state, candidates, invoiceId, text) {
  const id = toInt(invoiceId);
  const lines = {...state.lines, [id]: {selected: true, touched: true, text}};
  return recomputeDefaults({...state, lines}, candidates);
}

// 期日の古い順に、消し込める請求へ入金額を配分する（手で直した額も既定に戻す）。
export function autoAllocate(state, candidates) {
  const amount = parseAmount(state.amountText);
  if (amount === null || amount <= 0) return state;
  let remaining = amount;
  const lines = {};
  for (const invoice of candidates) {
    if (!invoice.eligible || remaining <= 0 || Object.keys(lines).length >= MAX_ALLOCATIONS) continue;
    const value = defaultAllocation(remaining, invoice.open);
    if (value <= 0) continue;
    remaining -= value;
    lines[invoice.invoiceId] = {selected: true, touched: false, text: formatNumberInput(value)};
  }
  return {...state, lines};
}

// 入金額・配分合計・未充当と、選んだ請求ごとの消込額・消込後の未消込。
export function summarizeReceipt(state, candidates) {
  const amount = parseAmount(state.amountText);
  const lines = candidates.filter((invoice) => lineOf(state, invoice.invoiceId).selected).map((invoice) => {
    const line = lineOf(state, invoice.invoiceId);
    const value = parseAmount(line.text);
    return {...invoice, amount: value, touched: line.touched, text: line.text, after: invoice.open - (value || 0)};
  });
  const allocated = lines.reduce((sum, line) => sum + (line.amount || 0), 0);
  return {amount, allocated, unallocated: amount === null ? null : amount - allocated, lines, count: lines.filter((line) => line.amount > 0).length};
}

// 登録前の検査。errors は項目ごと（lines は請求ごと）の日本語の理由。blocking は理由がない限り進めない二重登録。
export function validateReceipt(state, candidates, receipts = []) {
  const errors = {};
  const lineErrors = {};
  const summary = summarizeReceipt(state, candidates);
  if (!state.partnerId) errors.partnerId = '取引先を選んでください';
  if (!state.receivedOn || !/^\d{4}-\d{2}-\d{2}$/.test(state.receivedOn)) errors.receivedOn = '入金日を選んでください';
  if (isBlankInput(state.amountText)) errors.amount = '入金額を入力してください';
  else {
    const parsed = parseYen(state.amountText, {allowNegative: false});
    if (!parsed.ok) errors.amount = parsed.error;
    else if (!(parsed.value > 0)) errors.amount = '1円以上の入金額を入力してください';
  }
  const reference = String(state.reference ?? '').trim();
  if (!reference) errors.reference = '通帳・入金明細の参照番号を入力してください（二重登録の確認に使います）';
  else if (reference.length > REFERENCE_MAX) errors.reference = `参照番号は${REFERENCE_MAX}文字以内にしてください`;
  for (const line of summary.lines) {
    if (isBlankInput(line.text)) lineErrors[line.invoiceId] = '消込額を入力するか、この請求の選択を外してください';
    else if (line.amount === null) lineErrors[line.invoiceId] = parseYen(line.text, {allowNegative: false}).error || '消込額は数字で入力してください';
    else if (line.amount <= 0) lineErrors[line.invoiceId] = '1円以上を入力するか、この請求の選択を外してください';
    else if (line.amount > line.open) lineErrors[line.invoiceId] = `未消込（${formatNumberInput(line.open)}円）を超えています`;
    else if (!line.eligible) lineErrors[line.invoiceId] = line.reason;
  }
  const active = summary.lines.filter((line) => line.amount > 0);
  if (!summary.lines.length) errors.allocations = '消し込む請求を1件以上選んでください';
  else if (active.length > MAX_ALLOCATIONS) errors.allocations = `1回の入金で消し込めるのは${MAX_ALLOCATIONS}請求までです。入金を分けて登録してください`;
  else if (summary.amount !== null && !errors.amount && summary.allocated !== summary.amount) {
    errors.allocations = summary.allocated < summary.amount
      ? `未充当が${formatNumberInput(summary.amount - summary.allocated)}円あります。消込額の合計を入金額（${formatNumberInput(summary.amount)}円）に合わせてください（未充当のままは登録できません）`
      : `消込額の合計（${formatNumberInput(summary.allocated)}円）が入金額（${formatNumberInput(summary.amount)}円）を超えています`;
  }
  if (Object.keys(lineErrors).length) errors.lines = lineErrors;
  const duplicate = findDuplicateReceipts(receipts, {partnerId: state.partnerId, receivedOn: state.receivedOn, amount: summary.amount, reference});
  const reason = String(state.duplicateReason ?? '').trim();
  const blocking = duplicate.duplicates.length > 0 && !reason;
  if (blocking) errors.duplicateReason = '同じ入金が登録済みです。別の入金として登録する理由を書いてください';
  const ok = Object.keys(errors).length === 0;
  return {ok, errors, summary, duplicate, blocking, payload: ok ? buildReceiptPayload(state, summary, duplicate) : null};
}

// POST /api/billing/receipts の本文。二重登録を承知で登録するときは理由を注記に残す。
export function buildReceiptPayload(state, summary, duplicate = {duplicates: []}) {
  const reason = String(state.duplicateReason ?? '').trim();
  const notes = [String(state.note ?? '').trim()];
  if (duplicate.duplicates?.length && reason) notes.push(`${DUPLICATE_NOTE_PREFIX}${reason}`);
  const note = notes.filter(Boolean).join('\n').slice(0, NOTE_MAX);
  return {
    partnerId: toInt(state.partnerId),
    reference: String(state.reference ?? '').trim(),
    receivedOn: state.receivedOn,
    amountYen: summary.amount,
    allocations: summary.lines.filter((line) => line.amount > 0).map((line) => ({invoiceId: line.invoiceId, amountYen: line.amount})),
    note: note || null,
  };
}

// 入力中かどうか（未保存の変更として外枠に知らせる）。
export function receiptDirty(state, initial) {
  return JSON.stringify(state) !== JSON.stringify(initial);
}

// 請求の状態（色＋文字）。asOf 時点。期日超過は入金予定日（承認済みの変更を反映。無ければ支払期日）から数える。
// 返り値 {key, label, tone: ok|warn|bad|info, overdueDays}
export function invoiceState({amount, paid = 0, balance, isVoid = false, invoiceDate, dueDate, plannedDate, asOf}) {
  if (isVoid) return {key: 'void', label: '取消済み', tone: 'info', overdueDays: null};
  if (invoiceDate && asOf && invoiceDate > asOf) return {key: 'future', label: '請求日前', tone: 'info', overdueDays: null};
  const rest = balance === null || balance === undefined ? toInt(amount) - toInt(paid) : toInt(balance);
  if (rest <= 0) return {key: 'paid', label: '入金済み', tone: 'ok', overdueDays: null};
  const days = daysBetween(plannedDate || dueDate, asOf);
  const partial = toInt(paid) > 0;
  if (days !== null && days > 0) {
    return {key: partial ? 'partial-overdue' : 'overdue', label: `${partial ? '一部入金・' : ''}期日超過${days}日`, tone: 'bad', overdueDays: days};
  }
  if (partial) return {key: 'partial', label: '一部入金', tone: 'warn', overdueDays: days === null ? null : days};
  return {key: 'open', label: days === 0 ? '未入金（本日期日）' : '未入金', tone: 'info', overdueDays: days === null ? null : days};
}

// 入金予定の変更申請の状態。
export function planRequestState(history) {
  if (history?.decision === 'approved') return {key: 'approved', label: '承認済み', tone: 'ok'};
  if (history?.decision === 'rejected') return {key: 'rejected', label: '却下', tone: 'info'};
  return {key: 'pending', label: '承認待ち', tone: 'warn'};
}

// ---- 請求・入金・税の画面の表の行（純関数）----

// 月別入金表（/api/receipt-sheet）の行。月の列は m0〜m11（入金のない月は 0 のまま。空欄にするのは表示側）。
export function receiptSheetRows(result) {
  const asOf = result?.asOf || '';
  return (Array.isArray(result?.rows) ? result.rows : []).map((row) => {
    const amount = toInt(row.amount_inc_tax);
    const paid = toInt(row.paid);
    const balance = row.isVoid ? 0 : toInt(row.balance);
    const state = invoiceState({amount, paid, balance, isVoid: Boolean(row.isVoid), invoiceDate: row.invoice_date, dueDate: row.due_date, plannedDate: row.plannedDate, asOf});
    const history = Array.isArray(row.history) ? row.history : [];
    const values = Array.isArray(row.values) ? row.values : [];
    return {
      key: String(row.id), invoiceId: toInt(row.id), invoiceNumber: row.invoice_number || '', partnerId: toInt(row.partner_id), partnerName: row.partner_name || '',
      invoiceDate: row.invoice_date || '', dueDate: row.due_date || '', plannedDate: row.plannedDate || row.due_date || '',
      planChanged: Boolean(row.plannedDate && row.plannedDate !== row.due_date), planVersion: toInt(row.planVersion),
      amount, paid, balance, isVoid: Boolean(row.isVoid), state, stateLabel: state.label, tone: state.tone,
      pendingRequests: history.filter((item) => !item.decision).length, history, events: Array.isArray(row.events) ? row.events : [],
      canReceive: !row.isVoid && balance > 0, canRequestChange: !row.isVoid && balance > 0,
      ...Object.fromEntries(values.map((value, index) => [`m${index}`, toInt(value)])),
    };
  });
}

// 月別入金表の月ごとの合計（実入金計・残額の入金予定）を、表の2行にする。
export function receiptSheetTotals(result) {
  const totals = Array.isArray(result?.totals) ? result.totals : [];
  return [
    {key: 'actual', label: '実入金計', ...Object.fromEntries(totals.map((row, index) => [`m${index}`, toInt(row.actual)]))},
    {key: 'planned', label: '残額の入金予定', ...Object.fromEntries(totals.map((row, index) => [`m${index}`, toInt(row.plannedRemaining)]))},
  ];
}

// 承認待ちの入金予定の変更（全請求）。申請の古い順。
export function pendingPlanRequests(result) {
  const list = [];
  for (const row of Array.isArray(result?.rows) ? result.rows : []) {
    for (const item of Array.isArray(row.history) ? row.history : []) {
      if (item.decision) continue;
      list.push({
        id: toInt(item.id), invoiceId: toInt(row.id), invoiceNumber: row.invoice_number || '', partnerName: row.partner_name || '',
        previousDueDate: item.previous_due_date || '', proposedDueDate: item.proposed_due_date || '', reason: item.reason || '', createdAt: item.created_at || '',
      });
    }
  }
  return list.sort((a, b) => a.id - b.id);
}

// 「請求・入金」（/api/billing）の請求の行。状態は基準日時点。
export function billingInvoiceRows(state) {
  const asOf = state?.asOf || '';
  const invoices = Array.isArray(state?.invoices) ? state.invoices : [];
  // 入金ごとに、どの請求へ消し込んだかを集める（入金の取消は入金全体に及ぶので、取消の前に示す）
  const receiptSpread = new Map();
  for (const invoice of invoices) {
    for (const receipt of Array.isArray(invoice.receipts) ? invoice.receipts : []) {
      const list = receiptSpread.get(receipt.receipt_id) || [];
      if (!list.includes(invoice.invoice_number)) list.push(invoice.invoice_number);
      receiptSpread.set(receipt.receipt_id, list);
    }
  }
  return invoices.map((invoice) => {
    const isVoid = invoice.statusAsOf === 'void';
    const paid = toInt(invoice.paidAsOf);
    const balance = invoice.balanceAsOf === null || invoice.balanceAsOf === undefined ? null : toInt(invoice.balanceAsOf);
    const stateOf = invoiceState({amount: invoice.amount_inc_tax, paid, balance: balance ?? 0, isVoid, invoiceDate: invoice.invoice_date, dueDate: invoice.due_date, plannedDate: invoice.planned_date || invoice.due_date, asOf});
    const receipts = (Array.isArray(invoice.receipts) ? invoice.receipts : []).map((receipt) => ({
      receiptId: toInt(receipt.receipt_id), reference: receipt.reference || '', receivedOn: receipt.received_on || '', amount: toInt(receipt.amount_yen),
      reversedOn: receipt.reversed_on || null, reversalReason: receipt.reversal_reason || '',
      otherInvoices: (receiptSpread.get(receipt.receipt_id) || []).filter((number) => number !== invoice.invoice_number),
    }));
    return {
      key: String(invoice.id), invoiceId: toInt(invoice.id), invoiceNumber: invoice.invoice_number || '', partnerId: toInt(invoice.partner_id), partnerName: invoice.partner_name || '',
      invoiceDate: invoice.invoice_date || '', dueDate: invoice.due_date || '', plannedDate: invoice.planned_date || invoice.due_date || '', amount: toInt(invoice.amount_inc_tax), amountExTax: toInt(invoice.amount_ex_tax), taxAmount: toInt(invoice.tax_amount),
      paid, balance: isVoid || stateOf.key === 'future' ? null : balance, state: stateOf, stateLabel: stateOf.label, tone: stateOf.tone,
      version: toInt(invoice.version), recordStatus: invoice.status, voidedOn: invoice.voided_on || null, voidReason: invoice.void_reason || '', note: invoice.note || '',
      receipts, canVoid: invoice.status === 'issued' && receipts.every((receipt) => receipt.reversedOn),
      canReceive: invoice.status === 'issued' && !invoice.voided_on && normalizeInvoice(invoice).open > 0,
    };
  });
}

// 請求・入金の見出しの数（基準日時点）。取消済み・請求日前は残高に数えない。請求日前（基準日より後の請求日）は件数にも入れない
export function billingSummary(rows) {
  const open = rows.filter((row) => row.balance !== null && row.balance > 0);
  const issued = rows.filter((row) => row.state?.key !== 'future');
  const overdue = open.filter((row) => row.state.overdueDays > 0);
  return {
    count: issued.length, openCount: open.length, balance: open.reduce((sum, row) => sum + row.balance, 0),
    overdueCount: overdue.length, overdue: overdue.reduce((sum, row) => sum + row.balance, 0),
  };
}

// 入金の履歴（入金×請求の1行ずつ）。画面の出力（Excel）に使う。
export function receiptHistoryRows(invoiceRows) {
  const list = [];
  for (const invoice of Array.isArray(invoiceRows) ? invoiceRows : []) {
    for (const receipt of invoice.receipts) {
      list.push({
        key: `${receipt.receiptId}:${invoice.invoiceId}`, receiptId: receipt.receiptId, receivedOn: receipt.receivedOn, partnerName: invoice.partnerName, reference: receipt.reference,
        invoiceNumber: invoice.invoiceNumber, amount: receipt.amount, reversed: Boolean(receipt.reversedOn), stateLabel: receipt.reversedOn ? `取消済み（${receipt.reversedOn}）` : '有効', reversalReason: receipt.reversalReason,
      });
    }
  }
  return list.sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.receiptId - b.receiptId || a.invoiceNumber.localeCompare(b.invoiceNumber));
}

// 「税額を計算して確認」を押せない理由。空なら押せる。action:'rules' は税ルールの登録へ案内する。
// rules: {loading, total（登録済みの版の数）, resolved（請求日・取引先に使えるルールがあるか）, error}
export function taxCalculateBlockers({selectedCount = 0, lineCount = 0, unratedCount = 0, invoiceDate = '', sourcesLoading = false, rules = {}} = {}) {
  const list = [];
  if (!selectedCount) list.push({key: 'reports', message: '請求する売上報告を選んでください'});
  else if (sourcesLoading) list.push({key: 'loading', message: '対象の明細を読み込んでいます'});
  else if (!lineCount) list.push({key: 'lines', message: '選んだ報告に請求できる明細がありません'});
  if (lineCount && unratedCount) list.push({key: 'rates', message: `税区分が未確認の明細が${unratedCount}件あります。各明細の税区分を選んでください`});
  if (!invoiceDate) list.push({key: 'invoiceDate', message: '請求日を入力してください'});
  if (rules.error) list.push({key: 'rules-error', message: `税ルールを確かめられませんでした（${rules.error}）`});
  else if (!rules.loading && rules.total === 0) {
    list.push({key: 'no-rules', action: 'rules', message: '税ルールが1件も登録されていません。組織標準の税ルール（計算の起点・端数処理）を登録すると計算できます'});
  } else if (!rules.loading && rules.total > 0 && rules.resolved === false && invoiceDate) {
    list.push({key: 'no-effective-rule', action: 'rules', message: `請求日（${invoiceDate}）に使える税ルールがありません。適用開始日がこの日以前の版を登録してください`});
  }
  return list;
}

// 税計算台帳の「基準日時点の有効計」。知らない項目は出さない（生の項目名を画面に出さない）。
const LEDGER_TOTAL_ITEMS = [
  ['count', '有効な請求', 'count'], ['amountExTax', '請求本体', 'yen'], ['billedTax', '請求税額', 'yen'], ['amountIncTax', '税込請求', 'yen'],
  ['sourceTax', '元報告の税額', 'yen'], ['delta', '税額差', 'yen'], ['unknownCount', '計算由来不明', 'count'],
];
export function taxLedgerTotals(totals) {
  return LEDGER_TOTAL_ITEMS.filter(([key]) => totals && totals[key] !== undefined && totals[key] !== null)
    .map(([key, label, type]) => ({key, label, type, value: Number(totals[key])}));
}

// 税計算台帳の行。状態・根拠を日本語にする。
export function taxLedgerRows(ledger) {
  return (Array.isArray(ledger?.rows) ? ledger.rows : []).map((row) => ({
    key: String(row.invoice_id ?? row.invoiceId), invoiceId: toInt(row.invoice_id ?? row.invoiceId), invoiceNumber: row.invoice_number || row.invoiceNumber || '',
    partnerName: row.partner_name || row.partnerName || '', invoiceDate: row.invoice_date || row.invoiceDate || '',
    stateLabel: row.statusAsOf === 'void' ? '取消済み' : row.statusAsOf === 'future' ? '基準日後' : '有効', tone: row.statusAsOf === 'void' ? 'info' : 'ok',
    amountExTax: row.amount_ex_tax ?? row.amountExTax ?? null, sourceTax: row.sourceTax ?? null, billedTax: row.billedTax ?? null, delta: row.delta ?? null,
    amountIncTax: row.amount_inc_tax ?? row.amountIncTax ?? null, provenance: row.provenance, provenanceLabel: row.provenance === 'unknown' ? '計算由来不明' : '計算履歴あり',
    snapshotId: row.snapshot_id ?? row.snapshotId ?? null, reissued: Boolean(row.priorInvoiceId), reissueReason: row.reissueReason || '',
  }));
}

// 税ルールの行（取引先名・日本語の選択値）。組織標準を先に、次に取引先名順・版の順。partners: [{id, name}]
export function taxRuleRows(rules, partners = []) {
  const names = new Map((Array.isArray(partners) ? partners : []).map((partner) => [toInt(partner.id), partner.name]));
  return (Array.isArray(rules) ? rules : []).map((rule) => ({
    key: String(rule.id), id: toInt(rule.id), partnerId: rule.partner_id ? toInt(rule.partner_id) : null,
    scopeLabel: rule.partner_id ? names.get(toInt(rule.partner_id)) || '取引先（名称未確認）' : '組織標準',
    version: toInt(rule.version), effectiveFrom: rule.effective_from || '', effectiveTo: rule.effective_to || '',
    basisLabel: labelOf('taxBasis', rule.basis), groupingLabel: labelOf('taxGrouping', rule.grouping || rule.grouping_mode),
    roundingLabel: labelOf('roundingMode', rule.rounding || rule.rounding_mode), precision: toInt(rule.precision), reason: rule.reason || '', evidence: rule.evidence || '',
  })).sort((a, b) => Number(a.partnerId !== null) - Number(b.partnerId !== null) || a.scopeLabel.localeCompare(b.scopeLabel, 'ja') || a.version - b.version);
}

// 適用先（取引先 or 組織標準）の最新の版番号。新しい版の baseVersion に使う。
export function latestRuleVersion(rules, partnerId) {
  const target = partnerId === '' || partnerId === null || partnerId === undefined ? null : toInt(partnerId);
  return (Array.isArray(rules) ? rules : []).filter((rule) => (rule.partner_id ? toInt(rule.partner_id) : null) === target)
    .reduce((max, rule) => Math.max(max, toInt(rule.version)), 0);
}

// 税ルールの登録前の検査（サーバーと同じ条件を、項目の直下に日本語で先に示す）。
export function validateTaxRule(form) {
  const errors = {};
  if (!form?.effectiveFrom) errors.effectiveFrom = '適用開始日を入力してください';
  if (form?.effectiveTo && form.effectiveFrom && form.effectiveTo < form.effectiveFrom) errors.effectiveTo = '適用終了日は適用開始日以後にしてください';
  const precision = Number(form?.precision);
  if (String(form?.precision ?? '').trim() === '' || !Number.isInteger(precision) || precision < 0 || precision > 4) errors.precision = '小数の桁数は0〜4で入力してください';
  if (!String(form?.reason ?? '').trim()) errors.reason = '採用・変更の理由を入力してください';
  if (!String(form?.evidence ?? '').trim()) errors.evidence = '根拠資料（契約条項・確認日など）を入力してください';
  return {ok: Object.keys(errors).length === 0, errors};
}
