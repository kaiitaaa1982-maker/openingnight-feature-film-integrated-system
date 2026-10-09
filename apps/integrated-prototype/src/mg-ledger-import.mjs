// MG台帳（受取MG・支払MG）の画面とExcel取込が共有する純関数と、取込のルート（プレビュー・登録・履歴）。
// - 金額の呼び名は mg.mjs の MG_AMOUNT_LABELS（消化対象・実充当・超過報告・計上）に1つにそろえる。
// - 当期報告の候補: 実充当＝min(消化対象, この報告の前の未消化残高)、超過報告＝消化対象−実充当。計上は方針が未確定のため候補を出さない。
// - 取込の各行は、書式の揺れ（全角・カンマ・¥・2026/9/1 など）を吸収したあと、手入力（POST /api/mg/ledger）と同じ
//   検証関数（mgLedgerReview → 訂正元の確認 → mgLedgerValues）を同じ順に通す。訂正は既存の訂正版の規則
//   （同じ条件版・商品の報告だけ、1つの報告に訂正版は1つだけ、元の行は残す）に従う。1行でもエラーがあれば登録しない。
// ブラウザ・Node・Worker で同じに動く（node:* を使わない）。
import {isUniqueViolation} from './data-platform/db-errors.mjs';
import {allIn} from './sql-in.mjs';
import {MG_AMOUNT_LABELS, mgLedgerReview, mgLedgerValues, canContractVersion, newMgId, MG_LEDGER_INSERT_SQL} from './mg.mjs';
import {parseYen, parseDate, parseMonth, parseInteger} from './ui/parse-input.mjs';
import {importLimits, limitReason} from './import/limits.mjs';

export {MG_AMOUNT_LABELS};
export const MG_AMOUNT_KEYS = Object.freeze(['reportedEligibleYen', 'appliedRecoupYen', 'reportedOverageYen', 'recognizedYen']);
export const MG_AMOUNT_COLUMNS = Object.freeze({reportedEligibleYen: 'reported_eligible_yen', appliedRecoupYen: 'applied_recoup_yen', reportedOverageYen: 'reported_overage_yen', recognizedYen: 'recognized_yen'});
export const MG_STATUS_LABELS = Object.freeze({unverified: '未確認', reviewed: '手動確認済み'});
export const MG_DIRECTION_LABELS = Object.freeze({incoming: '受取MG（販売先）', outgoing: '支払MG（権利元）'});
export const MG_DIRECTION_SHORT = Object.freeze({incoming: '受取MG', outgoing: '支払MG'});
export const MG_MODE_LABELS = Object.freeze({single: '単品契約', cross: 'クロスリクープ', special: '特殊条件（未確認・手動）'});
export const MG_IMPORT_KIND = 'mg_ledger';

const DIRECTIONS = ['incoming', 'outgoing'];
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const norm = (value) => String(value ?? '').normalize('NFKC').replace(/[\s​]+/g, '').toLowerCase();
const cellString = (value) => (value === null || value === undefined ? '' : typeof value === 'string' ? value.trim() : String(value).trim());
const isIsoDate = (text) => /^\d{4}-\d{2}-\d{2}$/.test(text);
const isIsoMonth = (text) => /^\d{4}-\d{2}$/.test(text);

// ---- 台帳の見方（画面と取込で共通） ----

export function contractIdOf(row, direction) {
  const value = direction === 'incoming' ? row?.incoming_contract_id : row?.outgoing_contract_id;
  return value ? Number(value) : null;
}

export function directionOf(row) {
  if (row?.incoming_contract_id) return 'incoming';
  if (row?.outgoing_contract_id) return 'outgoing';
  return null;
}

// 訂正版が付いた報告（訂正前）の id。集計・候補・残高から外す。GET /api/mg/ledger の isSuperseded も尊重する。
export function supersededIds(ledger = []) {
  const ids = new Set(ledger.map((row) => Number(row.id)));
  const gone = new Set();
  for (const row of ledger) {
    if (row.reverses_entry_id && ids.has(Number(row.reverses_entry_id))) gone.add(Number(row.reverses_entry_id));
    if (Number(row.isSuperseded)) gone.add(Number(row.id));
  }
  return gone;
}

export function effectiveLedger(ledger = []) {
  const gone = supersededIds(ledger);
  return ledger.filter((row) => !gone.has(Number(row.id)));
}

const chronological = (a, b) => String(a.accounting_month).localeCompare(String(b.accounting_month))
  || String(a.period_from).localeCompare(String(b.period_from)) || num(a.id) - num(b.id);

export function latestVersion(contract) {
  return [...(contract?.versions || [])].sort((a, b) => num(b.version) - num(a.version))[0] || null;
}

// 契約1件の回収状況。保証額は最新の条件版。累計は訂正前を除いた全報告の実充当（計上月を問わない）。
export function contractProgress(contract, ledger = [], direction = 'incoming') {
  const version = latestVersion(contract);
  const guaranteeYen = num(version?.mg_amount_yen);
  const rows = effectiveLedger(ledger.filter((row) => contractIdOf(row, direction) === Number(contract?.id)));
  const sum = (column) => rows.reduce((total, row) => total + num(row[column]), 0);
  const appliedYen = sum('applied_recoup_yen');
  const rate = guaranteeYen > 0 ? appliedYen / guaranteeYen : null;
  let status;
  if (guaranteeYen === 0) status = {code: 'zero', label: '保証額0円'};
  else if (!rows.length) status = {code: 'none', label: '報告なし'};
  else if (appliedYen >= guaranteeYen) status = {code: 'reached', label: '到達済'};
  else status = {code: 'open', label: '未到達'};
  const months = rows.map((row) => row.accounting_month).filter(Boolean).sort();
  return {
    contractId: Number(contract?.id), termVersion: version?.version ?? null, mode: version?.mode ?? null, special: version?.mode === 'special',
    guaranteeYen, cumulativeAppliedYen: appliedYen, cumulativeEligibleYen: sum('reported_eligible_yen'),
    cumulativeOverageYen: sum('reported_overage_yen'), cumulativeRecognizedYen: sum('recognized_yen'),
    remainingYen: Math.max(0, guaranteeYen - appliedYen), exceedYen: Math.max(0, appliedYen - guaranteeYen),
    rate, barPercent: rate === null ? 0 : Math.min(100, Math.round(rate * 1000) / 10), status,
    entryCount: rows.length, unverifiedCount: rows.filter((row) => row.status !== 'reviewed').length, lastAccountingMonth: months.at(-1) || null,
  };
}

export function progressTotals(list = []) {
  const sum = (key) => list.reduce((total, item) => total + num(item[key]), 0);
  const guaranteeYen = sum('guaranteeYen');
  const cumulativeAppliedYen = sum('cumulativeAppliedYen');
  return {
    contractCount: list.length, guaranteeYen, cumulativeAppliedYen, remainingYen: sum('remainingYen'), exceedYen: sum('exceedYen'),
    cumulativeRecognizedYen: sum('cumulativeRecognizedYen'), unverifiedCount: sum('unverifiedCount'),
    rate: guaranteeYen > 0 ? cumulativeAppliedYen / guaranteeYen : null,
  };
}

// この報告の前までの実充当（同じ契約の有効な報告。訂正する元の報告は除く）。
export function priorAppliedYen(ledger = [], {direction, contractId, excludeEntryIds = []} = {}) {
  const skip = new Set(excludeEntryIds.filter((value) => value !== null && value !== undefined).map(Number));
  return effectiveLedger(ledger.filter((row) => contractIdOf(row, direction) === Number(contractId)))
    .filter((row) => !skip.has(Number(row.id)))
    .reduce((total, row) => total + num(row.applied_recoup_yen), 0);
}

// 当期報告の候補。消化対象が未入力・不正なら null。
export function mgCandidate({eligibleYen, guaranteeYen, priorAppliedYen: prior}) {
  if (eligibleYen === null || eligibleYen === undefined || eligibleYen === '') return null;
  const eligible = Number(eligibleYen);
  if (!Number.isSafeInteger(eligible) || eligible < 0) return null;
  const remainingBeforeYen = Math.max(0, num(guaranteeYen) - Math.max(0, num(prior)));
  const appliedYen = Math.min(eligible, remainingBeforeYen);
  return {
    remainingBeforeYen, appliedYen, overageYen: eligible - appliedYen, remainingAfterYen: remainingBeforeYen - appliedYen,
    reachesNow: remainingBeforeYen > 0 && eligible >= remainingBeforeYen,
  };
}

// 空欄の実充当・超過報告を埋める。両方空欄なら候補、片方だけ入っていれば残り（消化対象−入れた方、0未満は0）。
export function fillAmounts({eligibleYen, appliedRecoupYen, reportedOverageYen, candidate}) {
  const has = (value) => value !== null && value !== undefined && value !== '';
  const numeric = (value) => has(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  let applied = appliedRecoupYen;
  let overage = reportedOverageYen;
  const filled = [];
  if (!has(applied) && !has(overage)) {
    if (candidate) {
      applied = candidate.appliedYen;
      overage = candidate.overageYen;
      filled.push('appliedRecoupYen', 'reportedOverageYen');
    }
  } else if (!has(overage) && numeric(eligibleYen) && numeric(applied)) {
    overage = Math.max(0, Number(eligibleYen) - Number(applied));
    filled.push('reportedOverageYen');
  } else if (!has(applied) && numeric(eligibleYen) && numeric(overage)) {
    applied = Math.max(0, Number(eligibleYen) - Number(overage));
    filled.push('appliedRecoupYen');
  }
  return {appliedRecoupYen: applied, reportedOverageYen: overage, filled};
}

// 入力値と候補の差（入力−候補）。未入力の項目は null。
export function candidateDifference(candidate, {appliedRecoupYen, reportedOverageYen} = {}) {
  if (!candidate) return null;
  const diff = (value, base) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value) - base);
  const appliedDiffYen = diff(appliedRecoupYen, candidate.appliedYen);
  const overageDiffYen = diff(reportedOverageYen, candidate.overageYen);
  return {appliedDiffYen, overageDiffYen, differs: Boolean(appliedDiffYen) || Boolean(overageDiffYen)};
}

export const signedYen = (value) => `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value).toLocaleString('ja-JP')}円`;

export function differenceText(difference) {
  if (!difference?.differs) return '';
  const parts = [];
  if (difference.appliedDiffYen) parts.push(`${MG_AMOUNT_LABELS.appliedRecoupYen} ${signedYen(difference.appliedDiffYen)}`);
  if (difference.overageDiffYen) parts.push(`${MG_AMOUNT_LABELS.reportedOverageYen} ${signedYen(difference.overageDiffYen)}`);
  return parts.join('・');
}

// 実充当＋超過報告が消化対象と一致しないときの注意（登録は止めない。原報告の確認を促す）。
export function sumMismatch({reportedEligibleYen, appliedRecoupYen, reportedOverageYen}) {
  const values = [reportedEligibleYen, appliedRecoupYen, reportedOverageYen];
  if (values.some((value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)))) return '';
  const total = Number(appliedRecoupYen) + Number(reportedOverageYen);
  if (total === Number(reportedEligibleYen)) return '';
  return `${MG_AMOUNT_LABELS.appliedRecoupYen}＋${MG_AMOUNT_LABELS.reportedOverageYen}（${total.toLocaleString('ja-JP')}円）が${MG_AMOUNT_LABELS.reportedEligibleYen}（${Number(reportedEligibleYen).toLocaleString('ja-JP')}円）と一致しません。原報告を確認してください`;
}

// 台帳の表示行。契約ごとに計上月の順で累計実充当と残高（その行の条件版の保証額−累計実充当、0未満は0）を積み上げる。
// 訂正前の行は累計に入れない（showHistory のときだけ表示）。絞込は累計を計算したあとに行う。
export function ledgerView({ledger = [], contracts = [], direction = 'incoming', showHistory = false, contractId = null, productId = null, month = ''} = {}) {
  const own = ledger.filter((row) => contractIdOf(row, direction));
  const gone = supersededIds(own);
  const contractById = new Map(contracts.map((contract) => [Number(contract.id), contract]));
  const versionById = new Map();
  for (const contract of contracts) for (const version of contract.versions || []) versionById.set(Number(version.id), version);
  const sourceById = new Map(own.map((row) => [Number(row.id), row.source_reference]));
  const running = new Map();
  const totals = new Map();
  for (const row of own.filter((item) => !gone.has(Number(item.id))).sort(chronological)) {
    const cid = contractIdOf(row, direction);
    const cumulative = (totals.get(cid) || 0) + num(row.applied_recoup_yen);
    totals.set(cid, cumulative);
    const guarantee = num(versionById.get(Number(row.term_version_id))?.mg_amount_yen);
    running.set(Number(row.id), {cumulativeAppliedYen: cumulative, remainingYen: Math.max(0, guarantee - cumulative)});
  }
  return own
    .filter((row) => contractById.has(contractIdOf(row, direction)))
    .filter((row) => showHistory || !gone.has(Number(row.id)))
    .filter((row) => !contractId || contractIdOf(row, direction) === Number(contractId))
    .filter((row) => !productId || Number(row.product_id) === Number(productId))
    .filter((row) => !month || row.accounting_month === month)
    .sort(chronological)
    .map((row) => {
      const contract = contractById.get(contractIdOf(row, direction));
      const superseded = gone.has(Number(row.id));
      const run = running.get(Number(row.id));
      return {
        key: String(row.id), id: Number(row.id), contractId: Number(contract.id), contractCode: contract.code, contractTitle: contract.title,
        contractLabel: `${contract.code}｜${contract.title}`, termVersionId: Number(row.term_version_id),
        termVersion: versionById.get(Number(row.term_version_id))?.version ?? null,
        productId: Number(row.product_id), productLabel: `${row.sku ?? ''}｜${row.product_name ?? ''}`,
        periodFrom: row.period_from, periodTo: row.period_to, accountingMonth: row.accounting_month, reportReceivedOn: row.report_received_on || null,
        sourceReference: row.source_reference, eligible: num(row.reported_eligible_yen), applied: num(row.applied_recoup_yen),
        overage: num(row.reported_overage_yen), recognized: num(row.recognized_yen),
        state: superseded ? 'superseded' : row.status === 'reviewed' ? 'reviewed' : 'unverified',
        stateLabel: superseded ? '訂正前（集計に含めない）' : MG_STATUS_LABELS[row.status] || MG_STATUS_LABELS.unverified,
        superseded, reversesEntryId: row.reverses_entry_id ? Number(row.reverses_entry_id) : null,
        reversesSource: row.reverses_entry_id ? sourceById.get(Number(row.reverses_entry_id)) ?? null : null,
        confirmationReason: row.confirmation_reason || null,
        cumulativeAppliedYen: run ? run.cumulativeAppliedYen : null, remainingYen: run ? run.remainingYen : null,
        raw: row,
      };
    });
}

// 締め日程のうち、この条件版・商品でまだ有効な報告がない最初の期間（すべて報告済みなら null）。
export function nextReportPeriod(periods = [], ledger = [], {termVersionId, productId} = {}) {
  const done = new Set(effectiveLedger(ledger)
    .filter((row) => Number(row.term_version_id) === Number(termVersionId) && Number(row.product_id) === Number(productId))
    .map((row) => `${row.period_from}|${row.period_to}`));
  return periods.find((period) => !done.has(`${period.periodFrom}|${period.periodTo}`)) || null;
}

// ---- 契約の登録フォーム（前回の版を既定値に、導出できる日付は入力させない） ----

const pad2 = (n) => String(n).padStart(2, '0');
const utc = (iso) => new Date(`${iso}T00:00:00Z`);
const isoOf = (date) => date.toISOString().slice(0, 10);
export function nextDayIso(iso) {
  if (!isIsoDate(String(iso || ''))) return '';
  const d = utc(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return isoOf(d);
}
function closeDateIn(year, monthIndex, closeDay) {
  // monthIndex が12以上（12月の翌月など）でも年を進めてから日付にする
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const y = first.getUTCFullYear(), m = first.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = closeDay === 'eom' ? last : Math.min(Number(closeDay) || last, last);
  return `${y}-${pad2(m + 1)}-${pad2(day)}`;
}
// 期間の開始日以降で最初の締め日（期間の終了日を超えるなら終了日）。
export function defaultFirstClose(startsOn, endsOn, closeDay = 'eom') {
  if (!isIsoDate(String(startsOn || ''))) return '';
  const d = utc(startsOn);
  let close = closeDateIn(d.getUTCFullYear(), d.getUTCMonth(), closeDay);
  if (close < startsOn) close = closeDateIn(d.getUTCFullYear(), d.getUTCMonth() + 1, closeDay);
  return isIsoDate(String(endsOn || '')) && close > endsOn ? endsOn : close;
}

// 日程の期間: 最初の開始日＝契約開始日、次の期間の開始日＝前の期間の終了日の翌日、最後の終了日＝契約終了日。
// 初回締め日が空欄、または期間の外なら既定の締め日にする。
export function derivePhases({startsOn, endsOn}, phases = []) {
  const out = [];
  phases.forEach((phase, index) => {
    const start = index === 0 ? startsOn : nextDayIso(out[index - 1].endsOn);
    const end = index === phases.length - 1 ? endsOn : phase.endsOn;
    const firstOk = isIsoDate(String(phase.firstCloseOn || '')) && phase.firstCloseOn >= start && (!isIsoDate(String(end || '')) || phase.firstCloseOn <= end);
    out.push({...phase, startsOn: start, endsOn: end, firstCloseOn: firstOk ? phase.firstCloseOn : defaultFirstClose(start, end, phase.closeDay || 'eom')});
  });
  return out;
}

export function emptyPhase() {
  return {endsOn: '', intervalMonths: 1, closeDay: 'eom', firstCloseOn: '', reportOffsetMonths: 1, reportDay: 31, payOffsetMonths: 2, payDay: 31};
}

export function emptyContractForm(today) {
  const year = String(today).slice(0, 4);
  return {
    code: '', title: '', partyId: '', contractDate: today, contractSourceReference: '', mgAmountYen: '', startsOn: today, endsOn: `${year}-12-31`,
    mode: 'single', reason: '', sourceReference: '', specialUnverified: false, products: [], phases: [emptyPhase()],
  };
}

// 条件の改訂の既定値は前回の版（金額・期間・回収方式・商品評価・日程・条件根拠）。改訂理由だけは新しく書く。
export function contractFormFromVersion(contract, version) {
  return {
    code: contract.code, title: contract.title, partyId: contract.party_id, contractDate: contract.contract_date,
    contractSourceReference: contract.source_reference, mgAmountYen: version.mg_amount_yen, startsOn: version.starts_on, endsOn: version.ends_on,
    mode: version.mode, reason: '', sourceReference: version.source_reference || '', specialUnverified: Boolean(version.special_unverified),
    products: (version.products || []).map((p) => ({productId: Number(p.product_id), evaluationYen: p.evaluation_yen})),
    phases: (version.phases || []).map((p) => ({
      endsOn: p.ends_on, intervalMonths: Number(p.interval_months), closeDay: String(p.close_day), firstCloseOn: p.first_close_on,
      reportOffsetMonths: Number(p.report_offset_months), reportDay: Number(p.report_day), payOffsetMonths: Number(p.pay_offset_months), payDay: Number(p.pay_day),
    })),
  };
}

// 商品評価額: 1商品なら契約MG額と同じ（入力させない）。複数なら合計と差額を示す。
export function evaluationState(form) {
  const amount = parseYen(form.mgAmountYen, {allowNegative: false});
  const amountYen = amount.ok ? amount.value : null;
  const derived = form.products.length === 1;
  const values = form.products.map((p) => {
    if (derived) return amountYen;
    const parsed = parseYen(p.evaluationYen, {allowNegative: false});
    return parsed.ok ? parsed.value : null;
  });
  const totalYen = values.reduce((total, value) => total + (value ?? 0), 0);
  return {amountYen, derived, values, totalYen, differenceYen: amountYen === null ? null : amountYen - totalYen, complete: values.every((value) => value !== null)};
}

export const evaluationGapText = (gap) => (gap > 0 ? `あと${gap.toLocaleString('ja-JP')}円足りません` : gap < 0 ? `${Math.abs(gap).toLocaleString('ja-JP')}円多すぎます` : '一致');

// 契約・条件の新版の送信内容。画面で分かる誤りは項目ごとの理由で返す（サーバーも同じ規則で検証する）。
export function buildContractPayload(form, {direction, editing = null} = {}) {
  const errors = {};
  const need = (key, label) => { if (!String(form[key] ?? '').trim()) errors[key] = `${label}を入力してください`; };
  if (!editing) {
    need('code', '契約コード');
    need('title', '契約名');
    if (!form.partyId) errors.partyId = direction === 'incoming' ? '販売先を選択してください' : '仕入先・権利元を選択してください';
    need('contractDate', '契約締結日');
    need('contractSourceReference', '契約資料の参照');
  }
  const amount = parseYen(form.mgAmountYen, {allowNegative: false});
  if (!amount.ok) errors.mgAmountYen = amount.error;
  else if (amount.value === null) errors.mgAmountYen = 'MG保証額を入力してください';
  need('startsOn', '契約開始日');
  need('endsOn', '契約終了日');
  if (form.startsOn && form.endsOn && form.endsOn < form.startsOn) errors.endsOn = '契約終了日は開始日以降にしてください';
  need('reason', editing ? '改訂の理由' : '登録の理由');
  need('sourceReference', '条件の根拠資料');
  if (!form.products.length) errors.products = '商品を1件以上選んでください';
  else if (form.mode === 'single' && form.products.length !== 1) errors.products = '単品契約は商品を1件だけ選んでください';
  const evaluation = evaluationState(form);
  if (form.products.length > 1) {
    if (!evaluation.complete) errors.products = '選んだ商品すべての評価額を入れてください';
    else if (evaluation.differenceYen !== 0 && evaluation.amountYen !== null) errors.products = `商品評価額の合計（${evaluation.totalYen.toLocaleString('ja-JP')}円）をMG保証額にそろえてください（${evaluationGapText(evaluation.differenceYen)}）`;
  }
  if (form.mode === 'special' && !form.specialUnverified) errors.specialUnverified = '特殊条件は計算式が未確認であることを確かめてください';
  const phases = derivePhases({startsOn: form.startsOn, endsOn: form.endsOn}, form.phases);
  phases.forEach((phase, index) => {
    if (index < phases.length - 1 && !isIsoDate(String(phase.endsOn || ''))) errors[`phase${index}`] = `期間${index + 1}の終了日を入力してください`;
    else if (phase.startsOn && phase.endsOn && phase.endsOn < phase.startsOn) errors[`phase${index}`] = `期間${index + 1}の終了日は開始日（${phase.startsOn}）以降にしてください`;
  });
  if (Object.keys(errors).length) return {ok: false, errors};
  const body = {
    direction, mgAmountYen: amount.value, startsOn: form.startsOn, endsOn: form.endsOn, mode: form.mode, reason: String(form.reason).trim(),
    sourceReference: String(form.sourceReference).trim(), specialUnverified: form.mode === 'special' ? Boolean(form.specialUnverified) : false,
    products: form.products.map((p, index) => ({productId: Number(p.productId), evaluationYen: evaluation.values[index]})),
    phases: phases.map((p) => ({
      startsOn: p.startsOn, endsOn: p.endsOn, intervalMonths: Number(p.intervalMonths), closeDay: String(p.closeDay), firstCloseOn: p.firstCloseOn,
      reportOffsetMonths: Number(p.reportOffsetMonths), reportDay: Number(p.reportDay), payOffsetMonths: Number(p.payOffsetMonths), payDay: Number(p.payDay),
    })),
  };
  if (editing) body.baseVersion = editing.baseVersion;
  else {
    Object.assign(body, {code: String(form.code).trim(), title: String(form.title).trim(), contractDate: form.contractDate, contractSourceReference: String(form.contractSourceReference).trim()});
    body[direction === 'incoming' ? 'partnerId' : 'supplierId'] = Number(form.partyId);
  }
  return {ok: true, body};
}

// ---- 当期報告の入力（画面） ----

// 画面の入力（文字）を POST /api/mg/ledger の本文にする。金額は全角・カンマ・¥を吸収する。
// 実充当・超過報告が候補と違うときは差の理由を必須にする（サーバーの検証の前に画面で止める）。
export function buildReportPayload(report, {candidate = null, special = false} = {}) {
  const errors = {};
  const amounts = {};
  for (const key of MG_AMOUNT_KEYS) {
    const parsed = parseYen(report[key], {allowNegative: false});
    if (!parsed.ok) errors[key] = parsed.error;
    else if (parsed.value === null) errors[key] = `${MG_AMOUNT_LABELS[key]}を入力してください`;
    else amounts[key] = parsed.value;
  }
  if (!String(report.sourceReference ?? '').trim()) errors.sourceReference = '報告資料の参照を入力してください';
  if (!report.periodFrom) errors.periodFrom = '対象開始日を入力してください';
  if (!report.periodTo) errors.periodTo = '対象終了日を入力してください';
  if (report.periodFrom && report.periodTo && report.periodTo < report.periodFrom) errors.periodTo = '対象終了日は対象開始日以降にしてください';
  const month = parseMonth(report.accountingMonth);
  if (!month.ok || !month.value) errors.accountingMonth = month.ok ? '計上月を入力してください' : month.error;
  if (report.status === 'reviewed' && !report.acknowledgement) errors.acknowledgement = '報告原本と入力値を照合したら印を付けてください';
  if ((report.status === 'reviewed' || report.reversesEntryId) && !String(report.confirmationReason ?? '').trim()) errors.confirmationReason = report.reversesEntryId ? '訂正の理由を入力してください' : '確認の理由を入力してください';
  const difference = candidateDifference(candidate, amounts);
  const needsReason = Boolean(difference?.differs) && !special;
  if (needsReason && !String(report.differenceReason ?? '').trim()) errors.differenceReason = `候補との差（${differenceText(difference)}）の理由を入力してください`;
  if (Object.keys(errors).length) return {ok: false, errors, difference};
  const body = {
    termVersionId: Number(report.termVersionId), productId: Number(report.productId), periodFrom: report.periodFrom, periodTo: report.periodTo,
    accountingMonth: month.value, reportReceivedOn: report.reportReceivedOn || '', sourceReference: String(report.sourceReference).trim(), ...amounts,
    status: report.status === 'reviewed' ? 'reviewed' : 'unverified', acknowledgement: report.status === 'reviewed' && report.acknowledgement === true,
    confirmationReason: String(report.confirmationReason ?? '').trim(), reversesEntryId: report.reversesEntryId || null,
  };
  if (String(report.differenceReason ?? '').trim()) body.differenceReason = String(report.differenceReason).trim();
  return {ok: true, body, difference};
}

// ---- Excel取込の列と読み取り ----

export const MG_IMPORT_COLUMNS = Object.freeze([
  {key: 'contractCode', header: '契約コード', required: true, type: 'code', hint: 'MG契約の契約コード（下の「契約と商品」シート）', example: 'MG-001', synonyms: ['契約', '契約番号', 'MG契約コード']},
  {key: 'version', header: '条件版', type: 'int', hint: '空欄なら対象期間に有効な最新の版（訂正は訂正元の版）', example: '', synonyms: ['版', '版番号']},
  {key: 'sku', header: '商品コード', required: true, type: 'code', hint: 'その条件版の対象商品', example: 'SKU-001', synonyms: ['商品', 'sku', '商品sku']},
  {key: 'periodFrom', header: '対象開始日', required: true, type: 'date', hint: '報告の対象期間の初日', example: '2026-10-01', synonyms: ['対象開始', '報告対象開始日', '期間開始']},
  {key: 'periodTo', header: '対象終了日', required: true, type: 'date', hint: '報告の対象期間の末日', example: '2026-12-31', synonyms: ['対象終了', '報告対象終了日', '期間終了']},
  {key: 'accountingMonth', header: '計上月', required: true, type: 'month', hint: '2026-11 の形', example: '2027-01', synonyms: ['計上年月']},
  {key: 'reportReceivedOn', header: '実報告受領日', type: 'date', hint: '報告書を受け取った日（任意）', example: '', synonyms: ['受領日', '報告受領日']},
  {key: 'sourceReference', header: '報告資料参照', required: true, type: 'text', hint: '報告書のファイル名・番号。同じ条件版・商品で重ならないこと', example: '2026Q4報告書', synonyms: ['資料参照', '報告資料', '報告資料・訂正資料の参照']},
  {key: 'reportedEligibleYen', header: MG_AMOUNT_LABELS.reportedEligibleYen, required: true, type: 'yen', hint: '当期の消化対象（累計ではない）', example: '120000', synonyms: ['消化対象額', '当期mg消化対象', '当期mg消化対象額', '分配金(当期mg消化対象額)', 'mg消化対象額']},
  {key: 'appliedRecoupYen', header: MG_AMOUNT_LABELS.appliedRecoupYen, type: 'yen', hint: '空欄なら候補（未消化残高と消化対象の小さい方）', example: '', synonyms: ['実充当額', 'mg充当', '当期mg充当額', '当期mg消化適用額']},
  {key: 'reportedOverageYen', header: MG_AMOUNT_LABELS.reportedOverageYen, type: 'yen', hint: '空欄なら候補（消化対象−実充当）', example: '', synonyms: ['超過報告額', '当期超過', '当期超過報告額']},
  {key: 'recognizedYen', header: MG_AMOUNT_LABELS.recognizedYen, required: true, type: 'yen', hint: '報告書の計上額（計上の方針は未確定のため候補を出しません）', example: '0', synonyms: ['計上額', '当期計上', '当期計上報告額', '当期認識額']},
  {key: 'status', header: '確認状態', type: 'select', options: ['未確認', '手動確認済み'], hint: '空欄は未確認', example: '未確認', synonyms: ['状態']},
  {key: 'acknowledgement', header: '原本と照合した', type: 'select', options: ['はい'], hint: '手動確認済みのときは「はい」', example: '', synonyms: ['照合', '照合済み']},
  {key: 'confirmationReason', header: '確認・訂正理由', type: 'text', hint: '手動確認済み・訂正のときに必須', example: '', synonyms: ['確認理由', '訂正理由']},
  {key: 'reversesSource', header: '訂正元の報告資料参照', type: 'text', hint: '訂正版のときだけ。元の報告は残ります', example: '', synonyms: ['訂正元', '訂正元資料参照']},
  {key: 'differenceReason', header: '候補との差の理由', type: 'text', hint: '実充当・超過報告が候補と違うときに必須', example: '', synonyms: ['差の理由']},
]);
const COLUMN_BY_KEY = new Map(MG_IMPORT_COLUMNS.map((column) => [column.key, column]));
const HEADER_OF = (key) => COLUMN_BY_KEY.get(key)?.header ?? key;
// 契約コード・条件版・商品コードだけの行（テンプレートの記入前の行）は読み飛ばす
const ENTRY_KEYS = MG_IMPORT_COLUMNS.map((column) => column.key).filter((key) => !['contractCode', 'version', 'sku'].includes(key));

const headerKey = (text) => norm(text).replace(/[（(]必須[)）]|[（(]任意[)）]|[（(]円[)）]|\*/g, '');
const SYNONYMS = new Map();
for (const column of MG_IMPORT_COLUMNS) for (const name of [column.header, ...(column.synonyms || [])]) SYNONYMS.set(headerKey(name), column.key);

export function mapMgImportHeaders(headers = []) {
  const columns = [];
  const ignored = [];
  const unknown = [];
  const duplicate = [];
  const seen = new Set();
  headers.forEach((raw, index) => {
    const text = cellString(raw);
    if (!text) return;
    if (/^参考[_＿]/.test(text.normalize('NFKC'))) { ignored.push(text); return; }
    const key = SYNONYMS.get(headerKey(text));
    if (!key) { unknown.push(text); return; }
    if (seen.has(key)) { duplicate.push(text); return; }
    seen.add(key);
    columns.push([index, key]);
  });
  const missingRequired = MG_IMPORT_COLUMNS.filter((column) => column.required && !seen.has(column.key)).map((column) => column.header);
  return {columns, ignored, unknown, duplicate, missingRequired};
}

// 見出しの行: 先頭20行のうち、必須の見出しが最も多く一致する行（2つ以上）。
export function detectMgHeaderRow(sheetRows = []) {
  let best = -1;
  let bestCount = 1;
  sheetRows.slice(0, 20).forEach((row, index) => {
    const mapping = mapMgImportHeaders(row || []);
    const count = mapping.columns.filter(([, key]) => COLUMN_BY_KEY.get(key).required).length;
    if (count > bestCount) { best = index; bestCount = count; }
  });
  return best;
}

export function sheetToMgImport(sheetRows = [], {fileName = '', sheetName = ''} = {}) {
  const headerIndex = detectMgHeaderRow(sheetRows);
  if (headerIndex < 0) throw new Error('見出しの行が見つかりません。テンプレートの見出し（契約コード・商品コード・対象開始日…）を消さずに使ってください');
  const headers = (sheetRows[headerIndex] || []).map(cellString);
  const rows = [];
  for (let index = headerIndex + 1; index < sheetRows.length; index += 1) {
    const values = headers.map((_, col) => cellString(sheetRows[index]?.[col]));
    if (values.every((value) => value === '')) continue;
    rows.push({rowNo: index + 1, values});
  }
  return {fileName, sheetName, headerRowNo: headerIndex + 1, headers, rows};
}

const SKIP_SHEETS = new Set(['記入ガイド', '契約と商品', '_meta', '_lists']);
// decodeXlsx の結果（[{name, rows}]）から取込用の表を取り出す。_meta シートで種類と受取・支払を確かめる。
export function workbookToMgImport(sheets = [], {fileName = ''} = {}) {
  const meta = sheets.find((sheet) => sheet.name === '_meta');
  const metaMap = meta ? Object.fromEntries((meta.rows || []).slice(1).map((row) => [cellString(row[0]), cellString(row[1])])) : {};
  const input = sheets.find((sheet) => sheet.name === '入力') || sheets.find((sheet) => !SKIP_SHEETS.has(sheet.name));
  if (!input) throw new Error('読み込めるシートがありません');
  const result = sheetToMgImport(input.rows || [], {fileName, sheetName: input.name});
  return {...result, meta: metaMap.kind ? {kind: metaMap.kind, direction: metaMap.direction || null, version: metaMap.version || null} : null};
}

export function splitCsv(text = '') {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  const source = String(text).replace(/^﻿/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { value += '"'; i += 1; } else if (char === '"') quoted = false; else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += char;
  }
  if (value !== '' || row.length) { row.push(value); rows.push(row); }
  return rows;
}

// 表の行（{rowNo, values}）を見出しの対応で {rowNo, cells:{key: 文字}} にする。
export function parseMgImportRows(headers = [], rows = []) {
  const mapping = mapMgImportHeaders(headers);
  const parsed = rows.map((row, index) => {
    const cells = {};
    for (const [col, key] of mapping.columns) cells[key] = cellString(row?.values?.[col]);
    return {rowNo: Number(row?.rowNo) || index + 2, cells};
  });
  return {mapping, parsed};
}

// ---- 取込の計画（純関数）。サーバーのプレビューと登録で同じ結果になる ----

const STATUS_WORDS = new Map([['未確認', 'unverified'], ['unverified', 'unverified'], ['手動確認済み', 'reviewed'], ['手動確認済', 'reviewed'], ['確認済み', 'reviewed'], ['確認済', 'reviewed'], ['reviewed', 'reviewed']].map(([k, v]) => [norm(k), v]));
const YES = new Set(['はい', '済', '済み', '照合済み', 'yes', 'true', '1', '○', '〇', '✓', '✔'].map(norm));
const NO = new Set(['いいえ', 'no', 'false', '0', '×'].map(norm));

const dateInput = (text) => {
  if (!text) return null;
  if (isIsoDate(text)) return text;
  const parsed = parseDate(text);
  return parsed.ok && parsed.value ? parsed.value : text;
};
const monthInput = (text) => {
  if (!text) return null;
  if (isIsoMonth(text)) return text;
  const parsed = parseMonth(text);
  return parsed.ok && parsed.value ? parsed.value : text;
};
const yenInput = (text) => {
  if (text === '' || text === null || text === undefined) return null;
  const parsed = parseYen(text, {allowNegative: true});
  return parsed.ok ? parsed.value : text;
};

// サーバーの検証文を列に対応づける（列が分からない文は行の注記に出す）。
const MESSAGE_COLUMNS = [
  [/計上月/, 'accountingMonth'], [/対象開始日/, 'periodFrom'], [/対象終了日/, 'periodTo'], [/実報告受領日/, 'reportReceivedOn'], [/報告資料参照/, 'sourceReference'],
  [/候補との差/, 'differenceReason'], [/確認・訂正理由/, 'confirmationReason'], [/了承/, 'acknowledgement'], [/確認状態/, 'status'], [/訂正/, 'reversesSource'],
  ...MG_AMOUNT_KEYS.map((key) => [new RegExp(`^${MG_AMOUNT_LABELS[key]}`), key]),
];
function columnOfMessage(message) {
  const hit = MESSAGE_COLUMNS.find(([pattern]) => pattern.test(message));
  return hit ? HEADER_OF(hit[1]) : null;
}

function pickVersion(contract, {versionNo, original, productSku, periodFrom, periodTo}) {
  const versions = [...(contract.versions || [])].sort((a, b) => num(b.version) - num(a.version));
  if (versionNo) return {version: versions.find((v) => Number(v.version) === versionNo) || null, auto: false};
  if (original) return {version: versions.find((v) => Number(v.id) === Number(original.term_version_id)) || null, auto: true};
  const withProduct = productSku ? versions.filter((v) => (v.products || []).some((p) => p.sku === productSku)) : versions;
  const from = isIsoDate(String(periodFrom || '')) ? periodFrom : null;
  const to = isIsoDate(String(periodTo || '')) ? periodTo : from;
  const covering = to ? withProduct.find((v) => v.starts_on <= to && v.ends_on >= (from || to)) : null;
  return {version: covering || withProduct[0] || versions[0] || null, auto: true};
}

const sameStored = (existing, values, review) => existing.period_from === values.periodFrom && existing.period_to === values.periodTo
  && existing.accounting_month === values.accountingMonth && (existing.report_received_on || null) === (values.reportReceivedOn || null)
  && MG_AMOUNT_KEYS.every((key) => num(existing[MG_AMOUNT_COLUMNS[key]]) === values[key])
  && existing.status === review.status && Number(existing.reverses_entry_id || 0) === Number(review.reversesEntryId || 0);

// contracts: [{id, code, title, permitted, versions:[{id, version, mode, mg_amount_yen, starts_on, ends_on, products:[{product_id, sku, name}]}]}]
// ledger: その向きの登録済み報告（訂正前を含む）。rows: parseMgImportRows の parsed。
export function planMgImport({direction, rows = [], contracts = [], ledger = []}) {
  if (!DIRECTIONS.includes(direction)) throw new Error('受取MGか支払MGを選んでください');
  const byCode = new Map(contracts.filter((contract) => contract.permitted !== false).map((contract) => [norm(contract.code), contract]));
  const own = ledger.filter((row) => contractIdOf(row, direction));
  const hasSuccessor = new Set(own.filter((row) => row.reverses_entry_id).map((row) => Number(row.reverses_entry_id)));
  const existingBySource = new Map(own.map((row) => [`${row.term_version_id}|${row.product_id}|${row.source_reference}`, row]));
  const fileSources = new Map();
  const fileCorrected = new Map();
  const fileApplied = new Map();
  const fileExcluded = new Map();
  const summary = {total: 0, insert: 0, correction: 0, unchanged: 0, error: 0, skipped: 0, filled: 0, warnings: 0};
  const out = [];
  for (const row of rows) {
    const cells = row.cells || {};
    const text = (key) => cellString(cells[key]);
    if (ENTRY_KEYS.every((key) => text(key) === '')) { summary.skipped += 1; continue; }
    summary.total += 1;
    const errors = [];
    const warnings = [];
    const add = (key, message) => errors.push({column: key ? HEADER_OF(key) : null, message});
    const code = text('contractCode');
    const sku = text('sku');
    const contract = code ? byCode.get(norm(code)) : null;
    if (!code) add('contractCode', '契約コードを入力してください');
    else if (!contract) add('contractCode', `契約コード「${code}」の${MG_DIRECTION_SHORT[direction]}の契約がありません（参照できる契約だけが対象です）`);
    if (!sku) add('sku', '商品コードを入力してください');
    let versionNo = null;
    if (text('version')) {
      const parsed = parseInteger(text('version'), {allowNegative: false});
      if (!parsed.ok || !parsed.value) add('version', '条件版は1以上の整数（例: 2）で入力してください');
      else versionNo = parsed.value;
    }
    const periodFrom = dateInput(text('periodFrom'));
    const periodTo = dateInput(text('periodTo'));
    let status = 'unverified';
    if (text('status')) {
      const code_ = STATUS_WORDS.get(norm(text('status')));
      if (!code_) add('status', '確認状態は「未確認」か「手動確認済み」を入れてください');
      else status = code_;
    }
    const ackText = text('acknowledgement');
    const acknowledgement = ackText ? YES.has(norm(ackText)) : false;
    if (ackText && !acknowledgement && !NO.has(norm(ackText))) add('acknowledgement', '「はい」か空欄にしてください');
    // 訂正元（同じ契約・同じ商品の、指定した報告資料参照の報告）
    let original = null;
    const reversesText = text('reversesSource');
    if (reversesText && contract) {
      const productIds = new Set((contract.versions || []).flatMap((v) => v.products || []).filter((p) => p.sku === sku).map((p) => Number(p.product_id)));
      let hits = own.filter((entry) => contractIdOf(entry, direction) === Number(contract.id) && productIds.has(Number(entry.product_id)) && entry.source_reference === reversesText);
      if (versionNo && hits.length > 1) hits = hits.filter((entry) => (contract.versions || []).some((v) => Number(v.id) === Number(entry.term_version_id) && Number(v.version) === versionNo));
      if (!hits.length) add('reversesSource', `訂正元の報告（報告資料参照「${reversesText}」・商品「${sku}」）が見つかりません`);
      else if (hits.length > 1) add('reversesSource', '訂正元が複数の条件版にあります。条件版を入れてください');
      else original = hits[0];
    }
    let version = null;
    let versionAuto = false;
    if (contract) {
      const picked = pickVersion(contract, {versionNo, original, productSku: sku, periodFrom, periodTo});
      version = picked.version;
      versionAuto = picked.auto;
      if (!version && versionNo) add('version', `第${versionNo}版はありません`);
    }
    const product = version && sku ? (version.products || []).find((p) => p.sku === sku) || null : null;
    if (version && sku && !product) add('sku', `商品「${sku}」は第${version.version}版の対象商品ではありません`);
    const base = {
      rowNo: row.rowNo, contractCode: contract?.code ?? code, contractTitle: contract?.title ?? '', termVersion: version?.version ?? null, versionAuto,
      sku, productName: product?.name ?? '', mode: version?.mode ?? null,
    };
    if (errors.length) {
      summary.error += 1;
      out.push({...base, action: 'error', errors, warnings, values: null, candidate: null, filled: [], difference: null, original: null, payload: null});
      continue;
    }
    const x = {
      termVersionId: Number(version.id), productId: Number(product.product_id), periodFrom, periodTo, accountingMonth: monthInput(text('accountingMonth')),
      reportReceivedOn: dateInput(text('reportReceivedOn')), sourceReference: text('sourceReference'),
      reportedEligibleYen: yenInput(text('reportedEligibleYen')), appliedRecoupYen: yenInput(text('appliedRecoupYen')),
      reportedOverageYen: yenInput(text('reportedOverageYen')), recognizedYen: yenInput(text('recognizedYen')),
      status, acknowledgement, confirmationReason: text('confirmationReason'), reversesEntryId: original ? Number(original.id) : null,
      differenceReason: text('differenceReason'),
    };
    let review = null;
    let values = null;
    let candidate = null;
    const filled = [];
    const key = `${x.termVersionId}|${x.productId}|${x.sourceReference}`;
    const existing = x.sourceReference ? existingBySource.get(key) : null;
    let action = original ? 'correction' : 'insert';
    try {
      // 手入力と同じ順: 確認状態・了承・訂正理由 → 訂正元 → 月・日付・資料参照・金額
      review = mgLedgerReview(x);
      if (original) {
        if (Number(original.term_version_id) !== x.termVersionId || Number(original.product_id) !== x.productId) throw new Error('訂正元は同じ条件版・商品の報告を指定してください');
        const sameCorrection = existing && Number(existing.reverses_entry_id) === Number(original.id);
        if (hasSuccessor.has(Number(original.id)) && !sameCorrection) throw new Error('この報告には既に訂正版があります');
        if (fileCorrected.has(Number(original.id))) throw new Error(`同じファイルの${fileCorrected.get(Number(original.id))}行目がこの報告を訂正しています`);
      }
      if (existing) {
        // 同じ報告資料参照の報告が登録済み。空欄の実充当・超過報告は登録済みの値として比べ、同じ内容なら取り込まない（再読込で件数が増えない）
        values = mgLedgerValues({
          ...x, appliedRecoupYen: x.appliedRecoupYen ?? existing.applied_recoup_yen, reportedOverageYen: x.reportedOverageYen ?? existing.reported_overage_yen,
        });
        if (sameStored(existing, values, review)) action = 'unchanged';
        else add('sourceReference', `同じ報告資料参照「${values.sourceReference}」の報告が登録済みで、内容が違います。直すときは「訂正元の報告資料参照」にこの資料参照を入れ、新しい資料参照で登録してください`);
      } else {
        const excluded = [...(fileExcluded.get(Number(contract.id)) || []), ...(original ? [Number(original.id)] : [])];
        const prior = priorAppliedYen(own, {direction, contractId: contract.id, excludeEntryIds: excluded}) + (fileApplied.get(Number(contract.id)) || 0);
        candidate = mgCandidate({eligibleYen: x.reportedEligibleYen, guaranteeYen: version.mg_amount_yen, priorAppliedYen: prior});
        const fill = fillAmounts({eligibleYen: x.reportedEligibleYen, appliedRecoupYen: x.appliedRecoupYen, reportedOverageYen: x.reportedOverageYen, candidate});
        x.appliedRecoupYen = fill.appliedRecoupYen;
        x.reportedOverageYen = fill.reportedOverageYen;
        filled.push(...fill.filled);
        values = mgLedgerValues(x);
        if (fileSources.has(key)) add('sourceReference', `同じファイルの${fileSources.get(key)}行目と報告資料参照が重なっています`);
      }
    } catch (error) {
      errors.push({column: columnOfMessage(error.message), message: error.message});
    }
    const difference = values && candidate ? candidateDifference(candidate, values) : null;
    if (!errors.length && action !== 'unchanged' && difference?.differs) {
      if (version.mode === 'special') warnings.push(`特殊条件のため候補は参考値です（候補との差: ${differenceText(difference)}）`);
      else if (!x.differenceReason) add('differenceReason', `${MG_AMOUNT_LABELS.appliedRecoupYen}・${MG_AMOUNT_LABELS.reportedOverageYen}が候補と違います（${differenceText(difference)}）。「候補との差の理由」を入れてください`);
    }
    if (values) {
      const mismatch = sumMismatch(values);
      if (mismatch) warnings.push(mismatch);
    }
    if (filled.length === 2) warnings.push(`${MG_AMOUNT_LABELS.appliedRecoupYen}・${MG_AMOUNT_LABELS.reportedOverageYen}は空欄のため候補を入れました`);
    else if (filled.length === 1) warnings.push(`${MG_AMOUNT_LABELS[filled[0]]}は空欄のため${MG_AMOUNT_LABELS.reportedEligibleYen}の残り（${MG_AMOUNT_LABELS.reportedEligibleYen}−${MG_AMOUNT_LABELS[filled[0] === 'appliedRecoupYen' ? 'reportedOverageYen' : 'appliedRecoupYen']}）を入れました`);
    if (versionAuto && version && !original && (contract.versions || []).length > 1) warnings.push(`条件版は空欄のため第${version.version}版を使いました`);
    if (errors.length) {
      summary.error += 1;
      out.push({...base, action: 'error', errors, warnings, values, candidate, filled, difference, original: original ? originalView(original) : null, payload: null});
      continue;
    }
    if (action === 'unchanged') {
      summary.unchanged += 1;
      out.push({...base, action, errors, warnings: ['同じ内容の報告が登録済みのため、取り込みません'], values, candidate, filled, difference, original: original ? originalView(original) : null, payload: null});
      continue;
    }
    fileSources.set(key, row.rowNo);
    if (original) {
      fileCorrected.set(Number(original.id), row.rowNo);
      if (!fileExcluded.has(Number(contract.id))) fileExcluded.set(Number(contract.id), new Set());
      fileExcluded.get(Number(contract.id)).add(Number(original.id));
    }
    fileApplied.set(Number(contract.id), (fileApplied.get(Number(contract.id)) || 0) + values.appliedRecoupYen);
    summary[action] += 1;
    if (filled.length) summary.filled += 1;
    if (warnings.length) summary.warnings += 1;
    out.push({
      ...base, action, errors, warnings, values, candidate, filled, difference, original: original ? originalView(original) : null,
      payload: {termVersionId: x.termVersionId, productId: x.productId, ...values, ...review, differenceReason: x.differenceReason || null},
    });
  }
  return {direction, rows: out, summary, canCommit: summary.error === 0 && summary.insert + summary.correction > 0};
}

function originalView(entry) {
  return {
    sourceReference: entry.source_reference, accountingMonth: entry.accounting_month, periodFrom: entry.period_from, periodTo: entry.period_to,
    ...Object.fromEntries(MG_AMOUNT_KEYS.map((key) => [key, num(entry[MG_AMOUNT_COLUMNS[key]])])), status: entry.status,
  };
}

// プレビューと登録の食い違いを見るための内容（サーバーでハッシュにする）。
export function planFingerprintSource(plan) {
  return JSON.stringify({
    direction: plan.direction, summary: plan.summary,
    rows: plan.rows.map((row) => [row.rowNo, row.action, row.payload, row.candidate, row.errors.map((error) => error.message)]),
  });
}

// ---- テンプレート（encodeReportXlsx に渡すシート定義） ----

const TEMPLATE_TYPE = {code: 'code', int: 'int', date: 'date', month: 'month', text: 'text', yen: 'yen', select: 'text'};
const TYPE_LABEL = {code: 'コード（文字）', int: '整数', date: '日付（2026-10-01）', month: '年月（2026-11）', text: '文字', yen: '金額（円・整数）', select: '選択'};

export function mgTemplateSheets({direction, contracts = [], ledger = [], parties = [], onlyContractId = null, generatedAt = new Date().toISOString()}) {
  const partyName = (contract) => parties.find((p) => Number(p.id) === Number(contract.party_id))?.name || '';
  const targets = onlyContractId ? contracts.filter((c) => Number(c.id) === Number(onlyContractId)) : contracts;
  const inputRows = [];
  for (const contract of targets) {
    const version = latestVersion(contract);
    const progress = contractProgress(contract, ledger, direction);
    for (const product of version?.products || []) {
      inputRows.push({contractCode: contract.code, sku: product.sku, ref_title: contract.title, ref_product: product.name, ref_remaining: progress.remainingYen});
    }
  }
  const input = {
    name: '入力', titleBand: false, freezeCols: 1,
    columns: [
      ...MG_IMPORT_COLUMNS.map((column) => ({key: column.key, label: column.header, type: TEMPLATE_TYPE[column.type] || 'text', width: column.type === 'text' ? 24 : undefined})),
      {key: 'ref_title', label: '参考_契約名', type: 'text', width: 24}, {key: 'ref_product', label: '参考_商品名', type: 'text', width: 24},
      {key: 'ref_remaining', label: '参考_未消化残高', type: 'yen'},
    ],
    rows: inputRows,
    headerKinds: {
      ...Object.fromEntries(MG_IMPORT_COLUMNS.map((column) => [column.key, column.required ? 'required' : 'optional'])),
      ref_title: 'reference', ref_product: 'reference', ref_remaining: 'reference',
    },
    validations: MG_IMPORT_COLUMNS.filter((column) => column.type === 'select').map((column) => ({key: column.key, list: column.options})),
  };
  const guide = {
    name: '記入ガイド', title: `${MG_DIRECTION_SHORT[direction]}台帳の取込 記入ガイド`,
    conditions: [['取り込むシート', '「入力」だけ'], ['向き', MG_DIRECTION_LABELS[direction]], ['記入前の行', '契約コード・商品コードだけの行は読み飛ばします']],
    columns: [{key: 'header', label: '列', type: 'text'}, {key: 'required', label: '必須', type: 'text'}, {key: 'type', label: '形式', type: 'text'},
      {key: 'hint', label: '説明', type: 'text', wrap: true, width: 50}, {key: 'example', label: '例', type: 'text'}],
    rows: MG_IMPORT_COLUMNS.map((column) => ({header: column.header, required: column.required ? '必須' : '任意', type: TYPE_LABEL[column.type] || '文字', hint: column.hint || '', example: column.example || ''})),
    notes: [
      `${MG_AMOUNT_LABELS.appliedRecoupYen}の候補は「この報告の前の未消化残高（保証額−登録済みの実充当の合計）」と${MG_AMOUNT_LABELS.reportedEligibleYen}の小さい方、${MG_AMOUNT_LABELS.reportedOverageYen}の候補は残りです。`,
      '候補と違う値を入れた行は「候補との差の理由」が必要です（特殊条件の契約は候補を参考値として扱います）。',
      '訂正は「訂正元の報告資料参照」に元の報告の資料参照を入れ、新しい資料参照で登録します。元の報告は消さずに残し、集計から外します。',
      '1行でもエラーがあれば、ファイル全体を登録しません。同じ内容の報告が登録済みの行は取り込みません。',
      '「参考_」で始まる列は読み込みません。数式のセルは読み込めません（値に変換してから保存してください）。',
    ],
    freezeCols: 1,
  };
  const reference = {
    name: '契約と商品', title: `${MG_DIRECTION_SHORT[direction]}の契約と商品（参照用）`,
    columns: [
      {key: 'code', label: '契約コード', type: 'code'}, {key: 'title', label: '契約名', type: 'text', width: 24}, {key: 'party', label: '相手先', type: 'text', width: 20},
      {key: 'version', label: '最新の版', type: 'int'}, {key: 'guarantee', label: 'MG保証額', type: 'yen'}, {key: 'remaining', label: '未消化残高', type: 'yen'},
      {key: 'sku', label: '商品コード', type: 'code'}, {key: 'product', label: '商品名', type: 'text', width: 24},
    ],
    rows: contracts.flatMap((contract) => {
      const version = latestVersion(contract);
      const progress = contractProgress(contract, ledger, direction);
      return (version?.products || []).map((product) => ({
        code: contract.code, title: contract.title, party: partyName(contract), version: version.version, guarantee: progress.guaranteeYen,
        remaining: progress.remainingYen, sku: product.sku, product: product.name,
      }));
    }),
    freezeCols: 1,
  };
  const meta = {
    name: '_meta', hidden: true, titleBand: false, freezeCols: 0,
    columns: [{key: 'k', label: 'key', type: 'text'}, {key: 'v', label: 'value', type: 'text'}],
    rows: [{k: 'kind', v: MG_IMPORT_KIND}, {k: 'direction', v: direction}, {k: 'version', v: '1'}, {k: 'generated_at', v: generatedAt}],
  };
  return [input, guide, reference, meta];
}

// ---- ルート ----

const json = (value) => JSON.stringify(value);

export function registerMgLedgerImportRoutes(app, {db, bad, body, settlementWork, sha256, mode = 'local'}) {
  const limits = importLimits(mode);

  async function load(identity, direction) {
    const contractRows = await db.all(`SELECT id, code, title FROM mg_${direction}_contracts WHERE org_id=? ORDER BY id`, [identity.org_id]);
    const versionRows = await db.all(`SELECT id, ${direction}_contract_id AS contract_id, version, mode, mg_amount_yen, starts_on, ends_on FROM mg_term_versions WHERE org_id=? AND ${direction}_contract_id IS NOT NULL ORDER BY version DESC`, [identity.org_id]);
    const productRows = await db.all(`SELECT vp.term_version_id, vp.product_id, p.sku, p.name FROM mg_version_products vp JOIN products p ON p.org_id=vp.org_id AND p.id=vp.product_id JOIN mg_term_versions v ON v.org_id=vp.org_id AND v.id=vp.term_version_id WHERE vp.org_id=? AND v.${direction}_contract_id IS NOT NULL`, [identity.org_id]);
    const contracts = [];
    for (const contract of contractRows) {
      const versions = versionRows.filter((v) => Number(v.contract_id) === Number(contract.id)).map((v) => ({...v, products: productRows.filter((p) => Number(p.term_version_id) === Number(v.id))}));
      const permitted = versions.length > 0 && await canContractVersion(db, identity, versions[0].id, settlementWork);
      contracts.push({...contract, versions, permitted});
    }
    const permittedIds = new Set(contracts.filter((c) => c.permitted).map((c) => Number(c.id)));
    const ledger = (await db.all(`SELECT l.*, v.incoming_contract_id, v.outgoing_contract_id FROM mg_ledger_entries l JOIN mg_term_versions v ON v.org_id=l.org_id AND v.id=l.term_version_id WHERE l.org_id=? AND v.${direction}_contract_id IS NOT NULL ORDER BY l.id`, [identity.org_id]))
      .filter((row) => permittedIds.has(contractIdOf(row, direction)));
    return {contracts, ledger};
  }

  function readInput(c, input) {
    const identity = c.get('identity');
    if (identity?.role === 'production') return {error: bad(c, '制作権限ではMG契約・台帳を参照できません', 403)};
    const direction = String(input.direction || '');
    if (!DIRECTIONS.includes(direction)) return {error: bad(c, '受取MGか支払MGを選んでください')};
    if (input.meta?.kind && input.meta.kind !== MG_IMPORT_KIND) return {error: bad(c, 'このファイルはMG台帳の取込用ではありません。MG台帳のテンプレートを使ってください')};
    if (input.meta?.direction && input.meta.direction !== direction) return {error: bad(c, `このファイルは${MG_DIRECTION_SHORT[input.meta.direction] || '別の向き'}用のテンプレートです。${MG_DIRECTION_SHORT[direction]}の画面で読み込むか、${MG_DIRECTION_SHORT[direction]}のテンプレートを使ってください`)};
    const headers = Array.isArray(input.headers) ? input.headers.map((h) => String(h ?? '')) : [];
    const rows = Array.isArray(input.rows) ? input.rows : [];
    if (!headers.length) return {error: bad(c, '見出しの行が見つかりません。テンプレートの「入力」シートの見出しを消さずに使ってください')};
    if (!rows.length) return {error: bad(c, '取り込む行がありません')};
    if (rows.length > limits.bulkRows) return {error: bad(c, `1回に取り込めるのは${limits.bulkRows.toLocaleString('ja-JP')}行までです（${limitReason(mode)}）。ファイルを分けてください`, 413)};
    const {mapping, parsed} = parseMgImportRows(headers, rows);
    if (mapping.missingRequired.length) return {error: bad(c, `必須の列がありません: ${mapping.missingRequired.join('、')}`, 400, {missingColumns: mapping.missingRequired})};
    return {identity, direction, headers, rows, mapping, parsed};
  }

  async function plan(read) {
    const {contracts, ledger} = await load(read.identity, read.direction);
    const result = planMgImport({direction: read.direction, rows: read.parsed, contracts, ledger});
    return {...result, fingerprint: await sha256(planFingerprintSource(result))};
  }

  app.post('/api/mg/ledger/import/preview', async (c) => {
    try {
      const read = readInput(c, await body(c));
      if (read.error) return read.error;
      const result = await plan(read);
      return c.json({
        ok: true, direction: read.direction, summary: result.summary, canCommit: result.canCommit, fingerprint: result.fingerprint,
        rows: result.rows.map(({payload, ...row}) => row), ignoredColumns: read.mapping.ignored, unknownColumns: read.mapping.unknown,
        duplicateColumns: read.mapping.duplicate, limits: {...limits, reason: limitReason(mode)},
      });
    } catch (error) {
      return bad(c, error.message || '取込の確認に失敗しました', error.status || 400, undefined, error);
    }
  });

  app.post('/api/mg/ledger/import/commit', async (c) => {
    try {
      const input = await body(c);
      if (input.confirmed !== true) return bad(c, '内容を確認したうえで登録してください');
      const read = readInput(c, input);
      if (read.error) return read.error;
      const result = await plan(read);
      if (String(input.fingerprint || '') !== result.fingerprint) return bad(c, 'プレビューの後に台帳か読み込んだ内容が変わりました。もう一度ファイルを読み込んで確かめてください', 409);
      if (!result.canCommit) return bad(c, result.summary.error ? 'エラーのある行があるため登録しません（1行でもエラーがあれば全件登録しません）' : '登録する新しい報告がありません', 400);
      const i = read.identity;
      const batch = crypto.randomUUID();
      const contentHash = await sha256(json({direction: read.direction, headers: read.headers, rows: read.rows}));
      const fileName = String(input.fileName || '（ファイル名なし）').slice(0, 200);
      const statements = [];
      const inserted = [];
      for (const row of result.rows) {
        if (row.action !== 'insert' && row.action !== 'correction') continue;
        const p = row.payload;
        const entryId = newMgId();
        inserted.push({rowNo: row.rowNo, entryId, sourceReference: p.sourceReference, action: row.action});
        statements.push({sql: MG_LEDGER_INSERT_SQL, params: [entryId, i.org_id, p.termVersionId, p.productId, p.periodFrom, p.periodTo, p.reportReceivedOn, p.accountingMonth, p.sourceReference, p.reportedEligibleYen, p.appliedRecoupYen, p.reportedOverageYen, p.recognizedYen, p.status, p.acknowledgement, p.confirmationReason, p.reversesEntryId, i.user_id]});
        statements.push({sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,version_hash,detail_json) VALUES(?,?,?,?,?,?,?)', params: [i.org_id, i.user_id, 'mg_ledger_import', 'mg_ledger_entries', String(entryId), contentHash, json({batch, direction: read.direction, fileName, rowNo: row.rowNo, action: row.action, candidate: row.candidate, filled: row.filled, differenceReason: p.differenceReason, reversesEntryId: p.reversesEntryId})]});
      }
      try {
        await db.batch(statements);
      } catch (error) {
        const message = isUniqueViolation(error) ? '同じ報告が同時に登録されました。もう一度ファイルを読み込んで確かめてください' : 'プレビューの後に台帳が変わりました。もう一度ファイルを読み込んで確かめてください';
        return bad(c, message, 409);
      }
      const ids = inserted.map((item) => item.entryId);
      const saved = ids.length ? await allIn(db, 'SELECT id, source_reference, accounting_month, reported_eligible_yen, applied_recoup_yen, reported_overage_yen, recognized_yen, reverses_entry_id FROM mg_ledger_entries WHERE org_id=? AND id IN (:in)', {before: [i.org_id], ids, sortBy: (a, b) => a.id - b.id}) : [];
      return c.json({ok: true, batch, fileName, summary: result.summary, inserted, saved}, 201);
    } catch (error) {
      return bad(c, error.message || '取込の登録に失敗しました', error.status || 400, undefined, error);
    }
  });

  // 取込の記録（ファイル単位）。前回の取込を画面で示す。
  app.get('/api/mg/ledger/import/history', async (c) => {
    const identity = c.get('identity');
    if (identity?.role === 'production') return bad(c, '制作権限ではMG契約・台帳を参照できません', 403);
    const direction = String(c.req.query('direction') || '');
    const rows = await db.all("SELECT a.detail_json, a.at, u.display_name, l.term_version_id FROM audit_log a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN mg_ledger_entries l ON l.org_id=a.org_id AND l.id=CAST(a.entity_id AS INTEGER) WHERE a.org_id=? AND a.action='mg_ledger_import' ORDER BY a.id DESC LIMIT 2000", [identity.org_id]);
    // 台帳の一覧と同じく、条件版の全商品の作品に財務権限がある行だけを数える（見えない契約の行は取込の記録にも出さない）
    const versionOk = new Map();
    const batches = new Map();
    for (const row of rows) {
      let detail;
      try { detail = JSON.parse(row.detail_json); } catch { continue; }
      if (direction && detail.direction !== direction) continue;
      if (row.term_version_id == null) continue;
      if (!versionOk.has(row.term_version_id)) versionOk.set(row.term_version_id, await canContractVersion(db, identity, row.term_version_id, settlementWork));
      if (!versionOk.get(row.term_version_id)) continue;
      if (!batches.has(detail.batch)) batches.set(detail.batch, {batch: detail.batch, direction: detail.direction, fileName: detail.fileName, at: row.at, userName: row.display_name || '', insert: 0, correction: 0});
      const item = batches.get(detail.batch);
      if (detail.action === 'correction') item.correction += 1; else item.insert += 1;
    }
    return c.json({ok: true, rows: [...batches.values()].slice(0, 10)});
  });
}
