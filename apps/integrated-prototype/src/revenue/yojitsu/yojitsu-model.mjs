// 案件収支の予実（YOJITSU）の純関数。目標・計画の版と期間、行動の設定（フェーズ1の仕様書 #11、移行 0014）の分: 期間の月、
// 年の値の月割り、目標の版の入力の読み取り（倍率の既定）、有効な版の選び方、読む人に返す形（本人だけの額）。
// 語を選ぶ設定と月の設定（採用するシナリオなど。移行 0018）の入力の読み取りと有効な版、予実の4段（目標→行動→予測→実績）と達成率・進みの組み立て（#14）。
// 要件は docs/requirements/revenue/project-cashflow-forecast-actual.md の FR-REV-YOJITSU-002〜014・016・017・021・028・033・038・045。
// DB・時刻・環境変数を読まない（docs/rules/architecture.md）。金額は整数の円、率は整数の bp、倍率は100倍の整数（docs/rules/money.md）
import {signedRateAmount} from '../../royalty/royalty-model.mjs';
import {isCalendarDate} from '../../planning/project/project-model.mjs';
import {DEFAULT_MARKUP_BPS} from '../../planning/contract-production/contract-production-model.mjs';
import {ceilBpsQuotient, rateChain, ratioBps} from './money-yojitsu.mjs';

// 期間は1〜5年目で、各年目は月初の日に始まる12か月（FR-REV-YOJITSU-003）。通算（5年）は列に持たず、5つの期間の合計
export const PERIOD_YEARS = 5;
export const MONTHS_PER_PERIOD = 12;
// 目標の種類（本人・会社）・範囲（全体・制作の取り分）・単位（期間の合計・毎月）・根拠の種類（額・人件費×倍率）。移行 0014 の CHECK と同じ並び
export const TARGET_KINDS = Object.freeze(['self', 'company']);
export const TARGET_KIND_LABELS = Object.freeze({self: '本人', company: '会社'});
export const TARGET_SCOPES = Object.freeze(['all', 'production_share']);
export const TARGET_UNITS = Object.freeze(['period_total', 'monthly']);
export const TARGET_BASIS_KINDS = Object.freeze(['amount', 'labor_cost_multiple']);
// 目標・計画の版の状態（確認済み・仮置き）。「有効・改めた」は列に持たず、最新の版・採用の記録から導く
export const VERSION_STATUSES = Object.freeze(['confirmed', 'provisional']);
// 倍率の既定（100倍の整数）。目標（本人）＝人件費×3、目標（会社）＝人件費×2（D-039 の 2026-10-10 の追記2、行動指標の計画 K2-18）
export const DEFAULT_MULTIPLIER_X100 = Object.freeze({self: 300, company: 200});
// 5つの源泉（earning_types.profit_source。1 制作受託・2 自社出資・3 製作委員会・4 買付・5 販売委託）と、目標の版の源泉別の列
export const SOURCE_NUMBERS = Object.freeze([1, 2, 3, 4, 5]);
// 設定の行の範囲と値の列（移行 0014 の yojitsu_setting_versions）。値の列はちょうど1つが埋まる
export const SETTING_SCOPES = Object.freeze(['all', 'earning_type', 'earning_type_step', 'project', 'channel']);
export const SETTING_VALUE_KINDS = Object.freeze(['bps', 'x100', 'months', 'yen']);

const MAX_YEN = Number.MAX_SAFE_INTEGER;
const isInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const num = (value) => (value === null || value === undefined ? null : Number(value));
// 整数の円の和（安全な整数を超えたら止める。丸めない）
function sumYen(values) {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(MAX_YEN)) throw new Error('合計が安全な整数を超えます');
  return Number(total);
}

// 月初の日（YYYY-MM-01。暦の日付の判定は案件の model と同じ）
export const isMonthStart = (value) => isCalendarDate(value) && value.endsWith('-01');

// 月初の日に n か月を足した月初の日（n は整数。負も可）
export function addMonths(monthStart, n) {
  if (!isMonthStart(monthStart) || !Number.isSafeInteger(n)) throw new Error('月初の日と整数の月数で呼んでください');
  const [year, month] = monthStart.split('-').map(Number);
  const k = year * 12 + (month - 1) + n;
  const y = (k - (k % 12)) / 12;
  return `${String(y).padStart(4, '0')}-${String((k % 12) + 1).padStart(2, '0')}-01`;
}

// 期間の12か月（月初の日の並び）
export const periodMonths = (startsOn) => Array.from({length: MONTHS_PER_PERIOD}, (_, i) => addMonths(startsOn, i));

// 1年目の始まりから、1〜5年目の始まり（n年目は n−1年目のちょうど12か月後。移行 0014 の yojitsu_periods_contiguous と同じ決まり）
export const periodStarts = (firstStartsOn) => Array.from({length: PERIOD_YEARS}, (_, i) => addMonths(firstStartsOn, i * MONTHS_PER_PERIOD));

// 期間の合計を12か月に整数で均等に割り、端数は最後の月に寄せる（FR-REV-YOJITSU-010。12か月の合計は元の値と一致する）。
// 式は人へ上げる変更として、フェーズ1 #11 の PR で代表が確かめる
export function splitAcrossMonths(total) {
  if (!isInt(total, 0, MAX_YEN)) throw new Error('期間の合計は0以上の整数で渡してください');
  const base = Number(BigInt(total) / BigInt(MONTHS_PER_PERIOD));
  return [...Array(MONTHS_PER_PERIOD - 1).fill(base), total - base * (MONTHS_PER_PERIOD - 1)];
}

// 単位ごとの12か月の値。期間の合計は splitAcrossMonths、毎月は同じ額を12か月
export function monthlyAmounts(amount, unit) {
  if (unit === 'period_total') return splitAcrossMonths(amount);
  if (unit === 'monthly') {
    if (!isInt(amount, 0, MAX_YEN)) throw new Error('毎月の額は0以上の整数で渡してください');
    return Array(MONTHS_PER_PERIOD).fill(amount);
  }
  throw new Error(`単位は ${TARGET_UNITS.join('・')} のどれかです`);
}

// 目標の版の入力（受け口・種が渡す形）を、store に渡す値にそろえる。根拠が人件費×倍率で倍率が無ければ、種類の既定（本人 300・会社 200）を入れる。
// 移行 0014 の CHECK と同じ決まりを先に見て、項目ごとの誤りを返す。返り値: {ok, value, errors:[{field, message}]}
export function normalizeTargetInput(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const err = (field, message) => errors.push({field, message});
  if (!isInt(src.periodId, 1, MAX_YEN)) err('periodId', '期間を選んでください');
  if (!isInt(src.previousVersionNo ?? 0, 0, MAX_YEN)) err('previousVersionNo', '前の版の番号は0以上の整数です');
  if (!TARGET_KINDS.includes(src.kind)) err('kind', '目標の種類は本人か会社です');
  const scope = src.scope ?? 'all';
  if (!TARGET_SCOPES.includes(scope)) err('scope', '目標の範囲は全体か制作の取り分です');
  const unit = src.unit ?? 'period_total';
  if (!TARGET_UNITS.includes(unit)) err('unit', '単位は期間の合計か毎月です');
  if (!TARGET_BASIS_KINDS.includes(src.basisKind)) err('basisKind', '根拠の種類は額か人件費×倍率です');
  let amountYen = src.amountYen ?? null;
  let multiplierX100 = src.multiplierX100 ?? null;
  if (src.basisKind === 'amount') {
    if (!isInt(amountYen, 0, MAX_YEN)) err('amountYen', '目標の額は0以上の整数の円で入れてください');
    if (multiplierX100 !== null) err('multiplierX100', '根拠が額の目標は倍率を持ちません');
  } else if (src.basisKind === 'labor_cost_multiple') {
    // 人件費×倍率の額は持たず、報酬の行から読むたびに計算する（FR-REV-YOJITSU-009）
    if (amountYen !== null) err('amountYen', '根拠が人件費×倍率の目標は額を持ちません（報酬の行から読むたびに計算します）');
    if (multiplierX100 === null && TARGET_KINDS.includes(src.kind)) multiplierX100 = DEFAULT_MULTIPLIER_X100[src.kind];
    if (!isInt(multiplierX100, 1, 10000)) err('multiplierX100', '倍率は 0.01〜100 倍（100倍の整数で 1〜10000）です');
    if (scope !== 'all') err('scope', '人件費×倍率の目標は範囲が全体だけです');
    if (unit !== 'period_total') err('unit', '人件費×倍率の目標は単位が期間の合計だけです');
  }
  const sources = {};
  for (const n of SOURCE_NUMBERS) {
    const value = src.sources?.[n] ?? null;
    if (value !== null && !isInt(value, 0, MAX_YEN)) err(`sources.${n}`, '源泉別の目標は0以上の整数の円です');
    if (value !== null && scope !== 'all') err(`sources.${n}`, '源泉別の目標は範囲が全体の目標だけが持ちます');
    sources[n] = value;
  }
  const status = src.status ?? 'provisional';
  if (!VERSION_STATUSES.includes(status)) err('status', '状態は確認済みか仮置きです');
  if (!isCalendarDate(src.decidedOn)) err('decidedOn', '決めた日は YYYY-MM-DD の日付で入れてください');
  if (!isInt(src.ownerUserId, 1, MAX_YEN)) err('ownerUserId', '目標の持ち主（本人）を選んでください');
  const text = (value, max, field, label) => {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
    if (typeof value !== 'string' || value.trim().length > max) { err(field, `${label}は${max}文字までの文字です`); return null; }
    return value.trim();
  };
  const basis = text(src.basis, 1000, 'basis', '根拠');
  const decidedBy = text(src.decidedBy, 200, 'decidedBy', '決めた人');
  return {ok: errors.length === 0, errors, value: {periodId: src.periodId, previousVersionNo: src.previousVersionNo ?? 0, kind: src.kind, scope, unit,
    basisKind: src.basisKind, amountYen, multiplierX100, sources, status, decidedOn: src.decidedOn, decidedBy, basis, ownerUserId: src.ownerUserId}};
}

// ---------- 有効な版 ----------

// 目標の版の行から、期間×種類×範囲ごとの最新の version_no の行の id（有効な目標。K-8・FR-REV-YOJITSU-008）
export function latestTargetIds(rows) {
  const best = new Map();
  for (const row of rows) {
    const key = `${row.period_id}|${row.target_kind}|${row.target_scope}`;
    const current = best.get(key);
    if (!current || Number(row.version_no) > Number(current.version_no)) best.set(key, row);
  }
  return new Set([...best.values()].map((row) => Number(row.id)));
}

// 採用の記録から、期間ごとの最新の seq の行が指す計画の版の id（有効な計画。FR-REV-YOJITSU-012）
export function adoptedPlanVersionIds(adoptions) {
  const best = new Map();
  for (const row of adoptions) {
    const current = best.get(Number(row.period_id));
    if (!current || Number(row.seq) > Number(current.seq)) best.set(Number(row.period_id), row);
  }
  return new Set([...best.values()].map((row) => Number(row.plan_version_id)));
}

// 設定の行から、変数×範囲ごとの最新の version_no の行（有効な設定。FR-REV-YOJITSU-014）
export function latestSettings(rows) {
  const best = new Map();
  for (const row of rows) {
    const key = [row.variable_key, row.scope, row.earning_type ?? '', row.step ?? '', row.project_id ?? '', row.channel_code ?? ''].join('|');
    const current = best.get(key);
    if (!current || Number(row.version_no) > Number(current.version_no)) best.set(key, row);
  }
  return [...best.values()];
}

// 設定の行の値（埋まっている値の列の種類と値）
export function settingValue(row) {
  const filled = SETTING_VALUE_KINDS.filter((kind) => row[`value_${kind}`] !== null && row[`value_${kind}`] !== undefined);
  if (filled.length !== 1) throw new Error('設定の行の値の列はちょうど1つが埋まります');
  return {kind: filled[0], value: Number(row[`value_${filled[0]}`])};
}

// ---------- 読む人に返す形（FR-REV-YOJITSU-006・009） ----------

const isOwnerOf = (row, viewerUserId) => viewerUserId !== null && viewerUserId !== undefined && Number(row.owner_user_id) === Number(viewerUserId);

// 目標の版の行を、読む人に返す形にする。額・倍率・源泉別の目標・根拠の文は owner 本人にだけ返し、本人以外には項目を残して null にする
// （resolution: 'owner_only'）。本人には、根拠が額ならその値（'amount'）、人件費×倍率なら報酬の12か月の合計×倍率（料率の額と同じく truncate。
// 'labor_cost'）、報酬の行がまだ無い（annualCompensationYen が null。フェーズ1 #17 の前）なら null（'unconnected'）を返す
export function targetView(row, {viewerUserId, annualCompensationYen = null, effective}) {
  const view = {id: Number(row.id), periodId: Number(row.period_id), yearNo: num(row.year_no), kind: row.target_kind, scope: row.target_scope,
    versionNo: Number(row.version_no), effective: Boolean(effective), unit: row.unit, basisKind: row.basis_kind, status: row.status,
    decidedOn: row.decided_on, decidedBy: row.decided_by ?? null, isOwner: isOwnerOf(row, viewerUserId)};
  if (!view.isOwner) return {...view, resolution: 'owner_only', amountYen: null, multiplierX100: null, sources: null, basis: null};
  const sources = Object.fromEntries(SOURCE_NUMBERS.map((n) => [n, num(row[`source${n}_yen`])]));
  const owned = {...view, multiplierX100: num(row.multiplier_x100), sources, basis: row.basis ?? null};
  if (row.basis_kind === 'amount') return {...owned, resolution: 'amount', amountYen: Number(row.amount_yen)};
  if (annualCompensationYen === null || annualCompensationYen === undefined) return {...owned, resolution: 'unconnected', amountYen: null};
  // 倍率は100倍の整数なので、bp（1万分率）にすると ×100
  return {...owned, resolution: 'labor_cost', amountYen: signedRateAmount(annualCompensationYen, Number(row.multiplier_x100) * 100)};
}

// 計画の版のヘッダと子表の行を、読む人に返す形にする。第1版（version_no 1）の額は目標（会社）の額の仮置きで、報酬が割り戻せるので
// owner 本人にだけ返し、本人以外には稼ぎ方の行を残して額・合計・根拠の文を null にする（visibility: 'owner_only'。FR-REV-YOJITSU-006・013）。
// 第2版以降の額は財務の権限のある人に見える（権限の絞りは受け口）。amounts は子表の行（earning_type・amount_yen）で、並びは呼び出し側が決める
export function planView(version, amounts, {viewerUserId, effective}) {
  const isOwner = isOwnerOf(version, viewerUserId);
  const hidden = Number(version.version_no) === 1 && !isOwner;
  const lines = amounts.map((a) => ({earningType: a.earning_type, amountYen: hidden ? null : Number(a.amount_yen)}));
  return {id: Number(version.id), periodId: Number(version.period_id), yearNo: num(version.year_no), versionNo: Number(version.version_no),
    effective: Boolean(effective), status: version.status, createdOn: version.created_on, isOwner, visibility: hidden ? 'owner_only' : 'visible',
    basis: hidden ? null : (version.basis ?? null), amounts: lines, totalYen: hidden ? null : sumYen(lines.map((a) => a.amountYen))};
}

// ---------- 語を選ぶ設定と月の設定（移行 0018。FR-REV-YOJITSU-045・034、要確認15） ----------

// 設定ごとの値。採用するシナリオは予測の行のシナリオ（移行 0015。forecast-model の FORECAST_SCENARIOS）と同じ語、
// 月別の表に入れる案件の範囲は 企画中も含む（all）・着地（landing）・契約済み（contracted）。締めた月は月初の日。移行 0016 の CHECK と同じ並び
export const CHOICE_KEYS = Object.freeze(['adopted_scenario', 'monthly_scope', 'closed_month']);
export const CHOICE_CODES = Object.freeze({adopted_scenario: Object.freeze(['even', 'good', 'max', 'single']), monthly_scope: Object.freeze(['all', 'landing', 'contracted'])});
const CHOICE_NAMES = Object.freeze({adopted_scenario: 'adoptedScenario', monthly_scope: 'monthlyScope', closed_month: 'closedMonth'});

// 設定の版の入力（受け口・種が渡す形）を、store に渡す値にそろえる。choiceKey は CHOICE_KEYS、value は語の設定なら語、締めた月なら月初の日。
// 版の番号は画面が見ていた版の次（previousVersionNo + 1。ほかの画面が先に足していれば DB が断る）。返り値: {ok, value, errors:[{field, message}]}
export function normalizeChoiceInput(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const err = (field, message) => errors.push({field, message});
  if (!CHOICE_KEYS.includes(src.choiceKey)) err('choiceKey', '設定は 採用するシナリオ・月別の表に入れる案件の範囲・締めた月 のどれかです');
  const previousVersionNo = src.previousVersionNo ?? 0;
  if (!isInt(previousVersionNo, 0, MAX_YEN)) err('previousVersionNo', '前の版の番号は0以上の整数です');
  let valueCode = null;
  let valueMonth = null;
  if (src.choiceKey === 'closed_month') {
    if (!isMonthStart(src.value)) err('value', '締めた月は月初の日（YYYY-MM-01）で入れてください');
    else valueMonth = src.value;
  } else if (CHOICE_KEYS.includes(src.choiceKey)) {
    if (!CHOICE_CODES[src.choiceKey].includes(src.value)) err('value', `値は ${CHOICE_CODES[src.choiceKey].join('・')} のどれかです`);
    else valueCode = src.value;
  }
  let basis = null;
  if (src.basis !== null && src.basis !== undefined && !(typeof src.basis === 'string' && src.basis.trim() === '')) {
    if (typeof src.basis !== 'string' || src.basis.trim().length > 1000) err('basis', '根拠は1000文字までの文字です');
    else basis = src.basis.trim();
  }
  return {ok: errors.length === 0, errors, value: {choiceKey: src.choiceKey, previousVersionNo, valueCode, valueMonth, basis}};
}

// 設定の版の行（choice_key・version_no・value_code・value_month）から、設定ごとの最新の版（有効な設定）。設定の無いものは null
export function latestChoices(rows) {
  const best = new Map();
  for (const row of rows) {
    const current = best.get(row.choice_key);
    if (!current || Number(row.version_no) > Number(current.version_no)) best.set(row.choice_key, row);
  }
  return Object.fromEntries(CHOICE_KEYS.map((key) => {
    const row = best.get(key);
    return [CHOICE_NAMES[key], row ? {value: row.value_code ?? row.value_month, versionNo: Number(row.version_no)} : null];
  }));
}

// ---------- 予実の4段（フェーズ1 #14。FR-REV-YOJITSU-002・004・006・007・013・016・017・021・028・033・038） ----------

// 4段の定義の版（応答の definitionVersion と sourceHash の元に入る）。式・行・端数を変えたら上げる
export const YOJITSU_DEFINITION_VERSION = 'yojitsu-4stage/1';
// 行動の3ステップ（移行 0012 の action_steps の親の無い3行）。次の段へ進む率（conversion_rate）の step は、面談→提案が meeting、提案→契約が proposal
export const ACTION_STEPS = Object.freeze(['meeting', 'proposal', 'contract']);
const STEP_LABELS = Object.freeze({meeting: '面談', proposal: '提案', contract: '契約'});

// 値の無いところは null のまま（0 で埋めない。FR-REV-YOJITSU-007）。足すときだけ 0 から始め、安全な整数を超えたら止める
function plus(a, b) {
  const out = (a ?? 0) + b;
  if (!Number.isSafeInteger(out)) throw new Error('合計が安全な整数を超えます');
  return out;
}
// 流れの値（予測・入金・件数）の合計: 値のある所だけを足し、どこにも値が無ければ null
const sumPresent = (values) => values.reduce((sum, v) => (v === null ? sum : plus(sum, v)), null);
// 年の値（目標・計画・目標件数）の合計: 1つでも値が無ければ null（一部の期間だけを足した値を「通算」と出さない）
const sumAll = (values) => (values.length && values.every((v) => v !== null) ? values.reduce((sum, v) => plus(sum, v), 0) : null);

// 行動の目標件数の逆算（FR-REV-YOJITSU-016。K-19）: 契約＝計画の額÷（1件あたりの額×売上率）の切り上げ、提案＝契約÷提案→契約の率の切り上げ、
// 面談＝提案÷面談→提案の率の切り上げ。割り算は整数の bps。どれかが無い・0以下なら null（件数を作らない）
export function actionTargetCounts({planYen, unitYen, revenueRateBps, toProposalBps, toContractBps}) {
  const values = [planYen, unitYen, revenueRateBps, toProposalBps, toContractBps];
  if (values.some((v) => v === null || v === undefined)) return null;
  if (planYen < 0 || unitYen <= 0 || revenueRateBps <= 0 || toProposalBps <= 0 || toContractBps <= 0) return null;
  const contract = ceilBpsQuotient(planYen, BigInt(unitYen) * BigInt(revenueRateBps));
  const proposal = ceilBpsQuotient(contract, toContractBps);
  const meeting = ceilBpsQuotient(proposal, toProposalBps);
  return {meeting, proposal, contract};
}

// 流れの値の行（予測・入金・件数）。months は期間の月の並び（月初の日）と同じ長さ、periods は期間（年目の順）と同じ長さ
function flowRow(meta, months, slices) {
  const periods = slices.map(([from, to]) => sumPresent(months.slice(from, to)));
  return {...meta, months, periods, total: sumPresent(periods), hiddenYears: []};
}

// 年の値から作る行（目標・計画・目標件数）。perPeriod は期間ごとの {annual, months（12か月）, hidden, state, provisional}
function annualRow(meta, perPeriod, yearNos) {
  return {...meta, months: perPeriod.flatMap((p) => p.months ?? Array(MONTHS_PER_PERIOD).fill(null)), periods: perPeriod.map((p) => p.annual),
    total: sumAll(perPeriod.map((p) => p.annual)), hiddenYears: yearNos.filter((_, i) => perPeriod[i].hidden),
    states: perPeriod.map((p) => p.state), provisionalYears: yearNos.filter((_, i) => perPeriod[i].provisional)};
}

// 比の行（bps）。monthScale は月の分子に掛ける数（件数の月の目標は100倍の整数なので、件数の実績を100倍してから割る）
function ratioRow(meta, numerator, denominator, {monthScale = 1} = {}) {
  return {...meta, unit: 'bps',
    months: numerator.months.map((n, i) => ratioBps(n === null ? null : n * monthScale, denominator.months[i])),
    periods: numerator.periods.map((n, i) => ratioBps(n, denominator.periods[i])),
    total: ratioBps(numerator.total, denominator.total),
    hiddenYears: [...new Set([...numerator.hiddenYears, ...denominator.hiddenYears])].sort((a, b) => a - b)};
}

const findSetting = (settings, variableKey, {scope, earningType = null, step = null}) =>
  settings.find((s) => s.variableKey === variableKey && s.scope === scope && (s.earningType ?? null) === earningType && (s.step ?? null) === step) ?? null;
const settingNumber = (setting, kind) => (setting && setting.value?.kind === kind ? Number(setting.value.value) : null);

// 予実の4段と達成率・進みを組み立てる（入金ベース固定・税別。D-039 の 2026-10-09 の追記3）。input は受け口が store と model から集めたもの:
// - periods: [{id, yearNo, startsOn}]（store の listPeriods の形）
// - targets: 目標の読み取り関数（store の readTargets）の有効な行。額は owner 本人にだけ入っている（本人以外は resolution 'owner_only' で null）
// - plans: 有効な計画（期間ごとの最新の採用の記録が指す版）の planView。第1版の額は owner 本人にだけ入っている（本人以外は visibility 'owner_only'）
// - settings: 有効な設定の行（store の readEffectiveSettings の形。1件あたりの額・次の段へ進む率・着地に数える確度）
// - choices: latestChoices の値（採用するシナリオ）
// - earningTypes: 稼ぎ方の参照表の行と既定の売上率の最新の版（code・label・rate_source・sort_order・default_rate_bps・default_rate_status）
// - projects: 読む人が財務の権限を持つ案件（id・code・earning_type・probability_bps〈段階の確度。段階が無ければ null〉）
// - bases: revenue-class-model の revenueClassBases の Map（案件 id → 稼ぎ方と使う売上率 rate.bps〈決まらなければ null と理由〉）
// - forecastSums: 有効な予測の版の、予測に使う・売上の元になる区分の行の、案件×月×シナリオの和（store の readYojitsuSources の forecastSums）
// - inflows: receipt-inflow-model の linkReceiptsToProjects の値（請求どおりの入金の税抜額と、請求額と違う入金）
// - activity: activity-model の countActivitySteps の値（ステップ×月と稼ぎ方×ステップ×年目の件数）
// 式: 着地予測＝確度が着地確度以上の案件の、採用するシナリオか単一の予測の売上の元の区分の額×使う売上率（FR-REV-YOJITSU-028）、
// 確度加重予測＝同じ額×売上率×確度の全案件の和、実績＝請求どおりの入金の税抜額×使う売上率（FR-REV-YOJITSU-033）。
// 料率の額は案件×月ごとに税別の額を足してから1回だけ truncate（golden の利益額の決まりと同じ）、比は bps の truncate（要確認11 の仮）。
// 値の元になる行が無い月・期間は 0 でなく null（未着・未到来。FR-REV-YOJITSU-007）。目標と目標に由来する値（達成率）、第1版を指す期間の計画と
// それに由来する値（進み・行動の目標件数と達成率）は、読む人が owner 本人でなければ項目を残して null にし、hiddenYears に年目を出す（FR-REV-YOJITSU-006）
export function buildYojitsuView(input) {
  const periods = [...input.periods].map((p) => ({id: Number(p.id), yearNo: Number(p.yearNo), startsOn: p.startsOn})).sort((a, b) => a.yearNo - b.yearNo);
  const yearNos = periods.map((p) => p.yearNo);
  const months = periods.flatMap((p) => periodMonths(p.startsOn));
  const monthIndex = new Map(months.map((m, i) => [m, i]));
  const slices = periods.map((_, i) => [i * MONTHS_PER_PERIOD, (i + 1) * MONTHS_PER_PERIOD]);
  const earningTypes = [...input.earningTypes].sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || String(a.code).localeCompare(String(b.code)));
  const settings = input.settings ?? [];
  const notes = [{code: 'basis_cash_fixed', text: '予実の4段は入金ベース固定・税別です（計上の基準では出しません。D-039）'}];
  const blank = () => Array(months.length).fill(null);

  // ---- 1. 目標（本人・会社）。目標の読み取り関数の有効な版（範囲は全体） ----
  const targetRow = (key, kind, label, role) => annualRow({key, section: 'target', label, unit: 'yen', role, kind}, periods.map((p) => {
    const t = (input.targets ?? []).find((x) => x.effective && x.periodId === p.id && x.kind === kind && x.scope === 'all');
    if (!t) return {annual: null, months: null, hidden: false, state: 'unset'};
    if (t.resolution === 'owner_only') return {annual: null, months: null, hidden: true, state: 'owner_only'};
    if (t.amountYen === null || t.amountYen === undefined) return {annual: null, months: null, hidden: false, state: t.resolution};
    const values = monthlyAmounts(t.amountYen, t.unit);
    return {annual: sumAll(values), months: values, hidden: false, state: t.resolution, provisional: t.status === 'provisional'};
  }), yearNos);
  const targetSelf = targetRow('target_self', 'self', '目標（本人）', 'main');
  const targetCompany = targetRow('target_company', 'company', '目標（会社）', 'aux');

  // ---- 3. 計画（有効な計画の合計と稼ぎ方ごと）。第1版の額は本人だけ ----
  const planOf = new Map((input.plans ?? []).map((plan) => [Number(plan.periodId), plan]));
  const planCell = (p, amountOf) => {
    const plan = planOf.get(p.id);
    if (!plan) return {annual: null, months: null, hidden: false, state: 'unset'};
    if (plan.visibility === 'owner_only') return {annual: null, months: null, hidden: true, state: 'owner_only', provisional: plan.status === 'provisional'};
    const amount = amountOf(plan);
    if (amount === null || amount === undefined) return {annual: null, months: null, hidden: false, state: 'unset'};
    return {annual: amount, months: splitAcrossMonths(amount), hidden: false, state: 'visible', provisional: plan.status === 'provisional'};
  };
  const planRow = annualRow({key: 'plan', section: 'forecast', label: '計画', unit: 'yen', role: 'main'}, periods.map((p) => planCell(p, (plan) => plan.totalYen)), yearNos);
  const planAmountOf = (plan, code) => plan.amounts.find((a) => a.earningType === code)?.amountYen ?? null;
  const planByType = new Map(earningTypes.map((e) => [e.code, annualRow({key: `plan:${e.code}`, section: 'by_earning_type', label: `${e.label}の計画`, unit: 'yen', role: 'main',
    earningType: e.code}, periods.map((p) => planCell(p, (plan) => planAmountOf(plan, e.code))), yearNos)]));

  // ---- 3. 予測（着地予測・確度加重予測）。採用するシナリオと単一の行、案件×月ごとに足してから率を掛ける ----
  const scenario = input.choices?.adoptedScenario?.value ?? null;
  const landingSetting = findSetting(settings, 'landing_probability', {scope: 'all'});
  const landingBps = settingNumber(landingSetting, 'bps');
  if (scenario === null) notes.push({code: 'scenario_unset', text: '採用するシナリオが設定に無いので、着地予測と確度加重予測を出していません'});
  if (landingBps === null) notes.push({code: 'landing_probability_unset', text: '着地に数える確度が設定に無いので、着地予測を出していません'});
  const projects = new Map((input.projects ?? []).map((p) => [Number(p.id), p]));
  const bases = input.bases ?? new Map();
  const forecastByProject = new Map();
  let outsideForecast = 0;
  if (scenario !== null) {
    for (const row of input.forecastSums ?? []) {
      if (row.scenario !== scenario && row.scenario !== 'single') continue;
      const i = monthIndex.get(row.forecast_month);
      if (i === undefined) { outsideForecast += 1; continue; }
      const projectId = Number(row.project_id);
      if (!forecastByProject.has(projectId)) forecastByProject.set(projectId, new Map());
      const byMonth = forecastByProject.get(projectId);
      byMonth.set(i, plus(byMonth.get(i), Number(row.amount_yen)));
    }
  }
  const landing = blank();
  const weighted = blank();
  const landingByType = new Map(earningTypes.map((e) => [e.code, blank()]));
  const unrated = new Map(); // 案件 id → 理由（売上率が決まらない）
  const noStage = new Set();
  for (const [projectId, byMonth] of forecastByProject) {
    const basis = bases.get(projectId);
    const rate = basis?.rate ?? null;
    if (!rate || rate.bps === null) { unrated.set(projectId, rate?.reason ?? 'no_basis'); continue; }
    const probability = projects.get(projectId)?.probability_bps;
    if (probability === null || probability === undefined) { noStage.add(projectId); continue; }
    const inLanding = landingBps !== null && Number(probability) >= landingBps;
    for (const [i, amount] of byMonth) {
      weighted[i] = plus(weighted[i], rateChain(amount, [rate.bps, Number(probability)]));
      if (!inLanding) continue;
      const sales = rateChain(amount, [rate.bps]);
      landing[i] = plus(landing[i], sales);
      const byType = landingByType.get(basis.earningType);
      if (byType) byType[i] = plus(byType[i], sales);
    }
  }
  const landingRow = flowRow({key: 'landing', section: 'forecast', label: '着地予測', unit: 'yen', role: 'main'}, landingBps === null ? blank() : landing, slices);
  const weightedRow = flowRow({key: 'weighted', section: 'forecast', label: '確度加重予測', unit: 'yen', role: 'aux'}, weighted, slices);

  // ---- 4. 実績（請求どおりの入金の税抜額×使う売上率）と参考の入金 ----
  const inflowSums = new Map(); // 案件 id → (月の位置 → 税抜額)
  let outsideInflow = 0;
  for (const row of input.inflows?.settled ?? []) {
    const i = monthIndex.get(row.month);
    if (i === undefined) { outsideInflow += 1; continue; }
    if (!inflowSums.has(row.projectId)) inflowSums.set(row.projectId, new Map());
    const byMonth = inflowSums.get(row.projectId);
    byMonth.set(i, plus(byMonth.get(i), row.exTaxYen));
  }
  const actual = blank();
  const inflow = blank();
  const inflowUnrated = blank();
  const actualByType = new Map(earningTypes.map((e) => [e.code, blank()]));
  for (const [projectId, byMonth] of inflowSums) {
    const basis = bases.get(projectId);
    const rate = basis?.rate ?? null;
    for (const [i, amount] of byMonth) {
      inflow[i] = plus(inflow[i], amount);
      if (!rate || rate.bps === null) { inflowUnrated[i] = plus(inflowUnrated[i], amount); unrated.set(projectId, rate?.reason ?? 'no_basis'); continue; }
      const sales = rateChain(amount, [rate.bps]);
      actual[i] = plus(actual[i], sales);
      const byType = actualByType.get(basis.earningType);
      if (byType) byType[i] = plus(byType[i], sales);
    }
  }
  const unsettled = blank();
  let unsettledCount = 0;
  for (const row of input.inflows?.unsettled ?? []) {
    const i = monthIndex.get(row.month);
    if (i === undefined) { outsideInflow += 1; continue; }
    unsettledCount += 1;
    unsettled[i] = plus(unsettled[i], row.amountYen);
  }
  const actualRow = flowRow({key: 'actual', section: 'actual', label: '実績（売上）', unit: 'yen', role: 'main'}, actual, slices);
  const inflowRow = flowRow({key: 'inflow', section: 'actual', label: '参考: 入金の総額（売上率を掛ける前・税別）', unit: 'yen', role: 'reference'}, inflow, slices);
  // 案件に結べない入金（請求の無い入金・支援金）は、入金の確認の計画 #6 の表が入るまで記録の形が無い（消込は請求を必ず指す）
  const inflowUnlinkedRow = flowRow({key: 'inflow_unlinked', section: 'actual', label: '参考: 案件に結びつかない入金（売上に数えない）', unit: 'yen', role: 'reference'}, blank(), slices);
  const inflowUnsettledRow = flowRow({key: 'inflow_unsettled', section: 'actual', label: '参考: 未確定の入金（請求額と違う入金。税込。U-5）', unit: 'yen', role: 'reference'}, unsettled, slices);
  const inflowUnratedRow = flowRow({key: 'inflow_unrated', section: 'actual', label: '参考: 売上率の決まらない案件の入金（税別。売上に数えない）', unit: 'yen', role: 'reference'}, inflowUnrated, slices);

  // ---- 2. 行動（面談・提案・契約の目標件数・実績件数・達成率） ----
  const activity = input.activity ?? {byPeriod: new Map(), byMonth: new Map(), skipped: {noStep: 0, noEarningType: 0}};
  const actionTypes = earningTypes.map((e) => {
    const unit = findSetting(settings, 'unit_amount', {scope: 'earning_type', earningType: e.code});
    const toProposal = findSetting(settings, 'conversion_rate', {scope: 'earning_type_step', earningType: e.code, step: 'meeting'});
    const toContract = findSetting(settings, 'conversion_rate', {scope: 'earning_type_step', earningType: e.code, step: 'proposal'});
    // 1件の売上に掛ける売上率は稼ぎ方の既定（golden の行動の上の表）。制作受託は受託費率の既定（J-4 (a)。案件の率は受託の契約の版）
    const rateBps = e.rate_source === 'contract' ? DEFAULT_MARKUP_BPS : (e.default_rate_bps === null || e.default_rate_bps === undefined ? null : Number(e.default_rate_bps));
    const unitYen = settingNumber(unit, 'yen');
    const toProposalBps = settingNumber(toProposal, 'bps');
    const toContractBps = settingNumber(toContract, 'bps');
    const statuses = [unit?.status, toProposal?.status, toContract?.status, e.rate_source === 'contract' ? null : e.default_rate_status].filter(Boolean);
    const plan = planByType.get(e.code);
    const byPeriod = periods.map((p, pi) => {
      const targets = actionTargetCounts({planYen: plan.periods[pi], unitYen, revenueRateBps: rateBps, toProposalBps, toContractBps});
      const actuals = Object.fromEntries(ACTION_STEPS.map((step) => [step, activity.byPeriod.get(`${e.code}|${step}|${p.yearNo}`) ?? null]));
      return {yearNo: p.yearNo, hidden: plan.hiddenYears.includes(p.yearNo), planYen: plan.periods[pi],
        targets: Object.fromEntries(ACTION_STEPS.map((step) => [step, targets?.[step] ?? null])), actuals,
        rates: Object.fromEntries(ACTION_STEPS.map((step) => [step, ratioBps(actuals[step], targets?.[step] ?? null)]))};
    });
    return {earningType: e.code, label: e.label, unitAmountYen: unitYen, revenueRateBps: rateBps, revenueRateSource: e.rate_source === 'contract' ? 'contract_default' : 'default',
      unitRevenueYen: unitYen === null || rateBps === null ? null : rateChain(unitYen, [rateBps]), toProposalBps, toContractBps,
      provisional: statuses.includes('provisional'), periods: byPeriod};
  });
  const actionRows = ACTION_STEPS.flatMap((step) => {
    const perPeriod = periods.map((p, pi) => {
      const annual = sumAll(actionTypes.map((t) => t.periods[pi].targets[step]));
      const hidden = actionTypes.some((t) => t.periods[pi].hidden);
      return {annual, months: annual === null ? null : splitAcrossMonths(annual * 100), hidden, state: hidden ? 'owner_only' : annual === null ? 'unset' : 'visible',
        provisional: annual !== null && actionTypes.some((t) => t.provisional)};
    });
    const target = {...annualRow({key: `action_target:${step}`, section: 'action', label: `${STEP_LABELS[step]}の目標件数`, unit: 'count', role: 'main', step}, perPeriod, yearNos),
      monthUnit: 'count_x100'};
    const actualMonths = months.map((m) => activity.byMonth.get(`${step}|${m.slice(0, 7)}`) ?? null);
    const actualCounts = flowRow({key: `action_actual:${step}`, section: 'action', label: `${STEP_LABELS[step]}の実績件数`, unit: 'count', role: 'aux', step}, actualMonths, slices);
    const rate = ratioRow({key: `action_rate:${step}`, section: 'action', label: `${STEP_LABELS[step]}の達成率`, role: 'rate', step}, actualCounts, target, {monthScale: 100});
    return [target, actualCounts, rate];
  });

  // ---- 比の行と稼ぎ方ごとの行 ----
  const rows = [
    targetSelf, targetCompany,
    ...actionRows,
    planRow,
    ratioRow({key: 'plan_rate', section: 'forecast', label: '計画の達成率（計画÷目標（本人））', role: 'rate'}, planRow, targetSelf),
    landingRow,
    ratioRow({key: 'landing_progress', section: 'forecast', label: '進み（着地予測÷計画）', role: 'rate'}, landingRow, planRow),
    weightedRow,
    actualRow,
    ratioRow({key: 'actual_progress', section: 'actual', label: '進み（実績÷計画）', role: 'rate'}, actualRow, planRow),
    ratioRow({key: 'actual_rate', section: 'actual', label: '達成率（実績÷目標（本人））', role: 'rate'}, actualRow, targetSelf),
    inflowRow, inflowUnlinkedRow, inflowUnsettledRow, inflowUnratedRow,
    ...earningTypes.flatMap((e) => {
      const plan = planByType.get(e.code);
      const meta = {section: 'by_earning_type', earningType: e.code};
      const landingE = flowRow({...meta, key: `landing:${e.code}`, label: `${e.label}の着地予測`, unit: 'yen', role: 'main'}, landingBps === null ? blank() : landingByType.get(e.code), slices);
      const actualE = flowRow({...meta, key: `actual:${e.code}`, label: `${e.label}の実績（売上）`, unit: 'yen', role: 'main'}, actualByType.get(e.code), slices);
      return [plan, landingE, actualE, ratioRow({...meta, key: `actual_progress:${e.code}`, label: `${e.label}の進み（実績÷計画）`, role: 'rate'}, actualE, plan)];
    }),
  ];

  // ---- 注記と照合 ----
  const codeOf = (id) => projects.get(id)?.code ?? String(id);
  if (rows.some((r) => r.hiddenYears.length)) notes.push({code: 'owner_only', text: '目標と、目標に由来する値（達成率）、第1版の計画とそれに由来する値（進み・行動の目標件数と達成率）は、目標・計画の持ち主だけに出します'});
  if (rows.some((r) => (r.states ?? []).includes('unconnected'))) notes.push({code: 'target_unconnected', text: '人件費×倍率の目標は、報酬の行（フェーズ1 #17）が入るまで出しません（未接続）'});
  if (rows.some((r) => (r.provisionalYears ?? []).length) || actionTypes.some((t) => t.provisional) || landingSetting?.status === 'provisional') {
    notes.push({code: 'provisional', text: '仮置きの計画・率・確度を使っています（印の付いた行と年目）'});
  }
  if (unrated.size) {
    notes.push({code: 'unrated_projects', text: `売上率の決まらない案件 ${unrated.size}件（${[...unrated.keys()].map(codeOf).join('・')}）の予測と入金は、着地予測・確度加重予測・実績に入れていません`,
      projects: [...unrated].map(([id, reason]) => ({projectId: id, code: codeOf(id), reason}))});
  }
  if (noStage.size) notes.push({code: 'no_stage_projects', text: `段階の無い案件 ${noStage.size}件（${[...noStage].map(codeOf).join('・')}）は確度が無いので、着地予測と確度加重予測に入れていません`});
  if (unsettledCount) notes.push({code: 'unsettled_receipts', text: `請求額と違う額の入金 ${unsettledCount}件は、税抜の出し方（U-5）が決まるまで実績に入れず「未確定」の行に税込で出しています`});
  if (outsideForecast || outsideInflow) notes.push({code: 'outside_periods', text: `期間（1〜5年目）の外の月の予測 ${outsideForecast}件・入金 ${outsideInflow}件は4段に入れていません`});
  if (activity.skipped?.noStep || activity.skipped?.noEarningType) {
    notes.push({code: 'activity_skipped', text: `ステップの無い活動記録 ${activity.skipped.noStep ?? 0}件と稼ぎ方の決まらない活動記録 ${activity.skipped.noEarningType ?? 0}件は数えていません`});
  }
  notes.push({code: 'rounding', text: '料率の額は案件×月ごとに税別の額を足してから1回だけ切り捨て、達成率・進みは bp の切り捨てです（要件の要確認11 の仮）。月の目標・計画は年÷12 で端数は最後の月、月の目標件数は100倍の整数です'});

  const byKey = new Map(rows.map((r) => [r.key, r]));
  const cells = (row) => [...row.months, ...row.periods, row.total];
  const sameSum = (key, parts) => cells(byKey.get(key)).every((v, i) => v === sumPresent(parts.map((p) => cells(p)[i])));
  const checks = [
    {code: 'landing_by_earning_type', label: '稼ぎ方ごとの着地予測の和＝着地予測', ok: sameSum('landing', earningTypes.map((e) => byKey.get(`landing:${e.code}`)))},
    {code: 'actual_by_earning_type', label: '稼ぎ方ごとの実績の和＝実績', ok: sameSum('actual', earningTypes.map((e) => byKey.get(`actual:${e.code}`)))},
    {code: 'plan_by_earning_type', label: '稼ぎ方ごとの計画の和＝計画（見える期間）', ok: periods.every((p, pi) => planRow.periods[pi] === null
      || planRow.periods[pi] === sumPresent(earningTypes.map((e) => planByType.get(e.code).periods[pi])))},
    {code: 'action_actual_by_table', label: '行動の表（稼ぎ方×ステップ×年目）の実績件数の和＝4段の実績件数', ok: ACTION_STEPS.every((step) => periods.every((p, pi) =>
      byKey.get(`action_actual:${step}`).periods[pi] === sumPresent(actionTypes.map((t) => t.periods[pi].actuals[step]))))},
  ];

  return {
    title: '予実（目標→行動→予測→実績）',
    basis: 'cash',
    basisLabel: '入金ベース固定',
    taxLabel: '税別',
    definitionVersion: YOJITSU_DEFINITION_VERSION,
    conditions: [
      {key: 'scenario', label: '採用するシナリオ', value: scenario, versionNo: input.choices?.adoptedScenario?.versionNo ?? null},
      {key: 'landingProbabilityBps', label: '着地に数える確度', value: landingBps, provisional: landingSetting?.status === 'provisional'},
      {key: 'projectCount', label: '読んだ案件', value: projects.size},
    ],
    periods: periods.map((p) => ({yearNo: p.yearNo, startsOn: p.startsOn, lastMonth: addMonths(p.startsOn, MONTHS_PER_PERIOD - 1)})),
    months,
    earningTypes: earningTypes.map((e) => ({code: e.code, label: e.label})),
    rows,
    action: {steps: ACTION_STEPS.map((step) => ({code: step, label: STEP_LABELS[step]})), earningTypes: actionTypes},
    notes,
    checks,
  };
}
