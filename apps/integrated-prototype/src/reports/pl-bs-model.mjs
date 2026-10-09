// PL・BS（管理会計の試算。決算書ではない）の計算。DB に依存しない純関数で、帳票 API・画面・Excel・試験が使う。
// 設計: docs/platform/team-development/pl-bs-design.md。
//
// 作品別PL（作品×計上月、累計も）:
//   自社作品  = 売上（流通別・商品の作品配賦・計上月・税抜）− ロイヤリティの発生額 − 作品の経費 − 制作費 ＝ 作品の利益。
//               制作費（経費の費目が「制作費」で始まるもの）は公開月に一括で費用にし、公開前は資産の「制作中の作品」に置く。
//   委員会作品 = 委員会の月次収支の自社（自社を表す取引先）の取得額（分配額＋窓口手数料の取り分＋幹事手数料）− 自社が負担する費用
//               （その作品に付けた手入力の費用）。委員会の経費・権利処理費は委員会の中で差し引き済みなので、自社の費用として引かない。
//               出資金は PL に入れず、BS の資産（払込の記録の額）に置き、回収率（累計取得額÷出資額）を並べる。
// 会社の月次PL = 作品別PLの合計 ＋ 作品の決まっていない案件の経費 ＋ 手入力の額（全社費用・営業外・特別・法人税等）。
// 会社の簡易BS（期末）: 期首の基準月（会社の設定）の月末残高（手入力）に、その後の動きを足す。複式の仕訳は持たないので、
//   最後に必ず「説明のつかない差額」（資産 −（負債＋純資産））を出し、その手がかり（期首の貸借差・現預金を動かさない手入力）を並べる。
//   現預金 = 期首残高 ＋ 請求の入金 ＋ 委員会からの受取 − 経費の出金 − ロイヤリティの支払 − 出資の払込
//            ＋ 手入力の収益（税込）− 手入力の費用（税込。現預金を動かす科目だけ）＋ 手入力の残高（借入金・資本金など）の増減。
//   未払ロイヤリティ = 期首残高 ＋ 発生額 − 前払金の充当 − 支払（前払金の支払そのものは記録していないので、前払金のある作品は未確定にする）。
//   BS の基準月が期首残高の基準月より前のときは、作品別の残高と会社BSを出さない（期首残高から積み上げられないため）。
//   委員会の資金は委員会の口座で扱う前提: 委員会作品の経費・ロイヤリティの支払は委員会の口座からの支払として自社の現預金に入れず（参考に未払を示す）、
//   自社が請求して受け取った委員会作品の売上は「委員会の預り金」、自社の取得額は受け取るまで「委員会からの未収」。
//   自社が立て替えて払う運用のときは、立替金を手入力の残高（その他の資産。増えた分は現預金の減少として扱う）で補う。
// 行ごとに由来（system システム・manual 手入力・unverified 未確定）を返す。未確定の額は0円で埋めず、分かる額と理由を示す。
import {CHANNEL_GROUPS, CHANNEL_LABELS} from '../sales/channel-group.mjs';

export const PL_BS_VERSION = 'pl-bs-v2-expense-accounts';
export const PL_BS_HEADING = '管理会計の試算（決算書ではありません）';
export const MAX_MONTHS = 600;
export const ORIGIN_LABELS = Object.freeze({system: 'システム', manual: '手入力', unverified: '未確定'});
export const SECTION_LABELS = Object.freeze({
  sales: '売上高', cogs: '売上原価', sga: '販売費及び一般管理費', non_operating_income: '営業外収益', non_operating_expense: '営業外費用',
  extraordinary_gain: '特別利益', extraordinary_loss: '特別損失', income_tax: '法人税等', asset: '資産', liability: '負債', equity: '純資産',
});
export const PL_SECTIONS = Object.freeze(['sales', 'cogs', 'sga', 'non_operating_income', 'non_operating_expense', 'extraordinary_gain', 'extraordinary_loss', 'income_tax']);
export const BS_SECTIONS = Object.freeze(['asset', 'liability', 'equity']);
const INCOME_SECTIONS = new Set(['sales', 'non_operating_income', 'extraordinary_gain']);
export const PAYMENT_METHODS = Object.freeze({transfer: '振込', cash: '現金', card: 'カード', offset: '相殺', other: 'その他'});
export const MANUAL_STATUS_LABELS = Object.freeze({unverified: '未確認', reviewed: '確認済み'});

// 勘定科目の共通の初期値。source=system の科目はシステムが計算する行（system_key で決まる）、manual は手入力で補う科目。
// cashEffect=false の手入力の科目（減価償却費・固定資産）は現預金を動かさない。
export const DEFAULT_ACCOUNTS = Object.freeze([
  {code: '4100', name: '売上高（自社作品）', section: 'sales', source: 'system', systemKey: 'own_sales', sortOrder: 100},
  {code: '4200', name: '委員会作品の自社の取得額', section: 'sales', source: 'system', systemKey: 'committee_share', sortOrder: 110},
  {code: '4900', name: 'その他の売上', section: 'sales', source: 'manual', sortOrder: 190},
  {code: '5100', name: 'ロイヤリティ（権利処理費）', section: 'cogs', source: 'system', systemKey: 'royalty', sortOrder: 200},
  {code: '5200', name: '作品の直接費', section: 'cogs', source: 'system', systemKey: 'direct_cost', sortOrder: 210},
  {code: '5300', name: '制作費（公開月に一括）', section: 'cogs', source: 'system', systemKey: 'production_cost', sortOrder: 220},
  {code: '5900', name: 'その他の売上原価', section: 'cogs', source: 'manual', sortOrder: 290},
  {code: '6100', name: '広告宣伝費（作品）', section: 'sga', source: 'system', systemKey: 'promotion', sortOrder: 300},
  {code: '6150', name: '作品のその他の経費', section: 'sga', source: 'system', systemKey: 'work_other_expense', sortOrder: 310},
  {code: '6210', name: '役員報酬', section: 'sga', source: 'manual', sortOrder: 320},
  {code: '6220', name: '給与手当', section: 'sga', source: 'manual', sortOrder: 330},
  {code: '6230', name: '法定福利費', section: 'sga', source: 'manual', sortOrder: 340},
  {code: '6240', name: '地代家賃', section: 'sga', source: 'manual', sortOrder: 350},
  {code: '6250', name: '通信費', section: 'sga', source: 'manual', sortOrder: 360},
  {code: '6260', name: '支払報酬', section: 'sga', source: 'manual', sortOrder: 370},
  {code: '6270', name: '旅費交通費', section: 'sga', source: 'manual', sortOrder: 380},
  {code: '6280', name: '減価償却費', section: 'sga', source: 'manual', cashEffect: false, sortOrder: 390, note: '現預金を動かさない費用。固定資産の月末残高も入れると差額が出ません'},
  {code: '6290', name: '雑費', section: 'sga', source: 'manual', sortOrder: 400},
  {code: '7100', name: '受取利息', section: 'non_operating_income', source: 'manual', sortOrder: 500},
  {code: '7190', name: '雑収入', section: 'non_operating_income', source: 'manual', sortOrder: 510},
  {code: '7500', name: '支払利息', section: 'non_operating_expense', source: 'manual', sortOrder: 550},
  {code: '7590', name: '雑損失', section: 'non_operating_expense', source: 'manual', sortOrder: 560},
  {code: '8100', name: '特別利益', section: 'extraordinary_gain', source: 'manual', sortOrder: 600},
  {code: '8500', name: '特別損失', section: 'extraordinary_loss', source: 'manual', sortOrder: 650},
  {code: '9100', name: '法人税、住民税及び事業税', section: 'income_tax', source: 'manual', sortOrder: 700},
  {code: '1100', name: '現預金', section: 'asset', source: 'system', systemKey: 'cash', sortOrder: 1000},
  {code: '1200', name: '売掛金', section: 'asset', source: 'system', systemKey: 'receivable', sortOrder: 1010},
  {code: '1250', name: '委員会からの未収', section: 'asset', source: 'system', systemKey: 'committee_receivable', sortOrder: 1020},
  {code: '1300', name: '制作中の作品', section: 'asset', source: 'system', systemKey: 'work_in_progress', sortOrder: 1040},
  {code: '1400', name: '委員会への出資金', section: 'asset', source: 'system', systemKey: 'committee_investment', sortOrder: 1050},
  {code: '1500', name: '固定資産', section: 'asset', source: 'manual', cashEffect: false, sortOrder: 1100, note: '減価償却で減る分は現預金を動かさない'},
  {code: '1900', name: 'その他の資産', section: 'asset', source: 'manual', sortOrder: 1190},
  {code: '2100', name: '未払金（経費）', section: 'liability', source: 'system', systemKey: 'expense_payable', sortOrder: 2000},
  {code: '2200', name: '未払ロイヤリティ', section: 'liability', source: 'system', systemKey: 'royalty_payable', sortOrder: 2010},
  {code: '2300', name: '未払消費税等（仮受−仮払）', section: 'liability', source: 'system', systemKey: 'consumption_tax', sortOrder: 2020},
  {code: '2400', name: '委員会の預り金', section: 'liability', source: 'system', systemKey: 'committee_deposit', sortOrder: 2030},
  {code: '2500', name: '借入金', section: 'liability', source: 'manual', sortOrder: 2100},
  {code: '2600', name: '前受金', section: 'liability', source: 'manual', sortOrder: 2110},
  {code: '2900', name: 'その他の負債', section: 'liability', source: 'manual', sortOrder: 2190},
  {code: '3100', name: '資本金', section: 'equity', source: 'manual', sortOrder: 3000},
  {code: '3200', name: '繰越利益剰余金', section: 'equity', source: 'system', systemKey: 'retained_earnings', sortOrder: 3010},
  {code: '3900', name: 'その他の純資産', section: 'equity', source: 'manual', sortOrder: 3090},
].map((row) => Object.freeze({cashEffect: true, note: null, systemKey: null, ...row})));
export const SYSTEM_KEYS = Object.freeze(DEFAULT_ACCOUNTS.filter((row) => row.source === 'system').map((row) => row.systemKey));

// 経費の科目は読取時に会計版・採用済みの完全一致対応から確定する。旧文字規則は採用の下見だけで使う。
export const EXPENSE_CLASS_LABELS = Object.freeze({production_cost: '制作費（公開月に一括）', promotion: '広告宣伝費', work_other_expense: 'その他の経費', direct_cost: '直接費'});

// ---------- 月・金額 ----------
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const isMonth = (value) => YM.test(String(value ?? ''));
export function addMonth(ym, n) {
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
export function monthsFromTo(from, to) {
  const out = [];
  for (let m = from; m <= to; m = addMonth(m, 1)) {
    out.push(m);
    if (out.length > MAX_MONTHS) throw new Error(`計算する月が${MAX_MONTHS}か月を超えています`);
  }
  return out;
}
export const monthOfDate = (date) => (DATE.test(String(date ?? '')) ? String(date).slice(0, 7) : null);
export function monthLabel(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  return match ? `${match[1]}年${Number(match[2])}月` : String(month ?? '');
}

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const MIN = BigInt(Number.MIN_SAFE_INTEGER);
function toSafe(big, label = '金額') {
  if (big > MAX || big < MIN) throw new Error(`${label}が安全な整数範囲を超えています`);
  return Number(big);
}
function asBig(value, label) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label || '金額'}に安全な整数でない値があります`);
  return BigInt(value);
}
export function sumOf(values, label = '金額の合計') {
  let total = 0n;
  for (const value of values) if (value !== null && value !== undefined) total += asBig(value, label);
  return toSafe(total, label);
}

// 重み（0以上の整数）で金額を分ける。端数は余りの大きい順、同じなら並び順。重みの合計が0なら null（分けられない）
export function splitByWeights(amount, weights) {
  const list = (weights || []).filter((row) => Number.isSafeInteger(row.weight) && row.weight > 0);
  const total = list.reduce((n, row) => n + BigInt(row.weight), 0n);
  if (!list.length || total <= 0n) return null;
  const sign = amount < 0 ? -1n : 1n;
  const whole = asBig(Math.abs(amount), '分ける金額');
  const parts = list.map((row, index) => ({key: row.key, index, base: whole * BigInt(row.weight) / total, rest: whole * BigInt(row.weight) % total}));
  let left = whole - parts.reduce((n, part) => n + part.base, 0n);
  const order = [...parts].sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  for (let j = 0; left > 0n; j += 1, left -= 1n) order[j % order.length].base += 1n;
  const out = new Map();
  for (const part of parts) out.set(part.key, toSafe((out.has(part.key) ? BigInt(out.get(part.key)) : 0n) + sign * part.base, '分けた金額'));
  return out;
}

// 月の並びに額を積む入れ物（BigInt で足し、最後に安全な整数へ戻す）
class Series {
  constructor(n) { this.values = Array.from({length: n}, () => 0n); }
  add(i, value, label) { if (i !== undefined && i !== null && i >= 0) this.values[i] += asBig(value, label); }
  numbers(label) { return this.values.map((value) => toSafe(value, label)); }
}

const byOrder = (list) => (a, b) => {
  const ia = list.indexOf(a), ib = list.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || String(a).localeCompare(String(b));
};

// ---------- 入力の整理 ----------
function normalizeAccounts(accounts = []) {
  const bySystemKey = new Map();
  const rows = [];
  for (const row of accounts) {
    const account = {id: row.id ?? null, code: String(row.code), name: String(row.name), section: row.section, source: row.source,
      systemKey: row.systemKey ?? null, cashEffect: row.cashEffect !== false && row.cashEffect !== 0, sortOrder: Number(row.sortOrder ?? 0), note: row.note ?? null};
    rows.push(account);
    if (account.systemKey) bySystemKey.set(account.systemKey, account);
  }
  // 組織が初期値を入れていないシステムの科目は、共通の初期値の名前・並びで出す（計算の行は科目の有無によらない）
  for (const def of DEFAULT_ACCOUNTS.filter((row) => row.source === 'system')) {
    if (!bySystemKey.has(def.systemKey)) {
      const account = {...def, id: null, builtIn: true};
      rows.push(account);
      bySystemKey.set(def.systemKey, account);
    }
  }
  rows.sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  return {rows, bySystemKey, byId: new Map(rows.filter((row) => row.id !== null).map((row) => [row.id, row]))};
}

function validateInput({from, to, asOf}) {
  if (!isMonth(from) || !isMonth(to)) throw new Error('期間（from・to）を「2026-05」の形で指定してください');
  if (from > to) throw new Error('期間の開始月が終了月より後になっています');
  if (asOf !== undefined && asOf !== null && !isMonth(asOf)) throw new Error('BSの基準月を「2026-05」の形で指定してください');
}

// ---------- 本体 ----------
export function buildPlBs(input = {}) {
  validateInput(input);
  const from = input.from, to = input.to, asOf = input.asOf || input.to;
  const end = asOf > to ? asOf : to;
  const profile = input.profile || null;
  const selfPartnerId = profile?.selfPartnerId ?? null;
  const openingMonth = isMonth(profile?.openingMonth) ? profile.openingMonth : null;
  const fiscal = {fiscalStartMonth: Number(input.fiscal?.fiscalStartMonth || 5), confirmed: Boolean(input.fiscal?.confirmed)};
  const accounts = normalizeAccounts(input.accounts);
  const works = (input.works || []).map((work) => ({
    id: Number(work.id), code: work.code, title: work.title, projectId: work.projectId ?? null, committee: Boolean(work.committee),
    releaseMonth: isMonth(work.releaseMonth) ? work.releaseMonth : null, releaseSource: work.releaseSource || null,
  })).sort((a, b) => String(a.code).localeCompare(String(b.code)) || a.id - b.id);
  const workById = new Map(works.map((work) => [work.id, work]));
  const committeeByWork = new Map((input.committee || []).map((row) => [Number(row.workId), row]));
  const manual = (input.manual || []).filter((row) => accounts.byId.has(row.accountId));
  const notes = [];
  // 会社全体の数字についての注意（会社全体を見られない人には返さない）
  const companyNotes = [];
  const bsBeforeOpening = Boolean(openingMonth && asOf < openingMonth);

  // 計算する月: 最初のデータの月（期首の基準月があればその翌月）から、期間の終わりか BS の基準月の遅い方まで
  const candidates = [from];
  if (openingMonth) candidates.push(addMonth(openingMonth, 1));
  const pushMonth = (month) => { if (isMonth(month) && month <= end) candidates.push(month); };
  for (const row of input.saleLines || []) pushMonth(row.month);
  for (const row of input.expenses || []) pushMonth(row.month);
  for (const row of input.royaltyAccruals || []) pushMonth(row.month);
  for (const row of input.committee || []) for (const item of row.acquisitions || []) pushMonth(item.month);
  for (const row of manual) if (row.kind === 'flow') pushMonth(row.month);
  // 入出金の日付の月も入れる（最初の売上・経費より前の出金や払込を落とさない）
  for (const row of input.expensePayments || []) pushMonth(monthOfDate(row.paidOn));
  for (const row of input.royaltyPayments || []) pushMonth(monthOfDate(row.paidOn));
  for (const row of input.receipts || []) pushMonth(monthOfDate(row.receivedOn));
  for (const row of input.investmentPayments || []) pushMonth(monthOfDate(row.paidOn));
  for (const row of input.committeeReceipts || []) pushMonth(monthOfDate(row.receivedOn));
  const start = candidates.reduce((min, month) => (month < min ? month : min), from);
  const months = monthsFromTo(start, end);
  const n = months.length;
  const index = new Map(months.map((month, i) => [month, i]));
  const idx = (month) => index.get(month);
  const dateIdx = (date) => index.get(monthOfDate(date));
  const periodIdx = months.map((month, i) => (month >= from && month <= to ? i : -1)).filter((i) => i >= 0);
  const cumulativeIdx = months.map((month, i) => (month <= to ? i : -1)).filter((i) => i >= 0);
  // BS に入れる動き: 期首の基準月より後で、基準月（asOf）まで。基準月が無ければ最初の月から
  const bsIdx = months.map((month, i) => ((!openingMonth || month > openingMonth) && month <= asOf ? i : -1)).filter((i) => i >= 0);
  const inBs = new Set(bsIdx);

  // ---------- 作品ごとの月次 ----------
  const S = () => new Series(n);
  const perWork = new Map(works.map((work) => [work.id, {
    work, salesBy: new Map(), sales: S(), salesTax: S(), salesInc: S(), royalty: S(), royaltyHoldMonths: new Set(),
    direct: S(), promotion: S(), workOther: S(), prodAccrued: S(), expenseInc: S(), expenseTax: S(), expensePaid: S(),
    acqDist: S(), acqWindowFee: S(), acqManagerFee: S(), acq: S(), manualBy: new Map(), manualUnverified: false,
    receipts: S(), royaltyPaid: S(), royaltyRecouped: S(), royaltyAdvanceYen: 0, investmentPaid: S(), committeeReceived: S(), committeeUnpaidExpense: S(),
    unverified: [],
  }]));
  const company = {
    unallocatedDirect: S(), unallocatedPromotion: S(), unallocatedOther: S(), unallocatedProduction: S(),
    unallocatedExpenseInc: S(), unallocatedExpenseTax: S(), unallocatedExpensePaid: S(),
    unallocatedReceipts: S(), unallocatedRoyaltyPaid: S(), manualBy: new Map(),
  };

  // 売上（作品へ配賦済み・税抜。税額も同じ配賦で分けたもの）。委員会作品の売上は委員会の売上なので自社の売上にしない
  for (const line of input.saleLines || []) {
    const w = perWork.get(Number(line.workId));
    const i = idx(line.month);
    if (!w || i === undefined) continue;
    if (w.work.committee) continue;
    const group = line.channelGroup || 'other';
    if (!w.salesBy.has(group)) w.salesBy.set(group, S());
    w.salesBy.get(group).add(i, line.amount, '売上');
    w.sales.add(i, line.amount, '売上');
    w.salesTax.add(i, line.tax || 0, '売上の税額');
    w.salesInc.add(i, line.amount + (line.tax || 0), '売上の税込額');
  }

  // 経費。委員会作品の経費は委員会の経費（分配の前に差し引き済み）なので自社の PL に入れない。出金も委員会の口座からの支払として自社の現預金に入れない
  const expenseById = new Map();
  const extraExpenses=new Map();
  const extraFor=(row,w)=>{const key=row.accountId??'unclassified';const holder=w??company;
    holder.expenseBy??=new Map();
    if(!holder.expenseBy.has(key))holder.expenseBy.set(key,{account:{id:key,name:row.accountName??'費用区分未整備',section:row.section??'sga',sortOrder:999},series:S(),accrued:S(),unverified:!row.accountId});
    return holder.expenseBy.get(key);
  };
  for (const row of input.expenses || []) {
    const i = idx(row.month);
    const w = row.workId == null ? null : perWork.get(Number(row.workId));
    const kind = row.systemKey || (row.accountId?`account:${row.accountId}`:'unclassified');
    const committeeExpense = Boolean(w?.work.committee);
    expenseById.set(Number(row.id), {row, w, committeeExpense, kind});
    if (row.workId != null && !w) continue; // 見えない作品の経費
    if (i === undefined) continue;
    if (committeeExpense) { w.committeeUnpaidExpense.add(i, row.incTax, '委員会の経費'); continue; }
    const target = w || null;
    if (target) {
      const series = {production_cost: target.prodAccrued, promotion: target.promotion, work_other_expense: target.workOther, direct_cost: target.direct}[kind];
      if(series && (kind==='production_cost'?row.recognitionTiming==='release_month_once':row.recognitionTiming==='incurred_month') && row.section===(['production_cost','direct_cost'].includes(kind)?'cogs':'sga'))series.add(i,row.exTax,'経費');
      else {const entry=extraFor(row,target);entry.accrued.add(i,row.exTax,'経費');const release=target?.work.releaseMonth;
        const recognized=row.recognitionTiming==='release_month_once'&&target?(release?(release>row.month?release:row.month):null):row.month;
        if(recognized)entry.series.add(idx(recognized),row.exTax,'経費');else target.unverified.push('公開月が未整備のため、公開月に一括の経費を制作中の作品に残しています');
      }
      target.expenseInc.add(i, row.incTax, '経費の税込額');
      target.expenseTax.add(i, row.tax, '経費の税額');
    } else {
      const series = {production_cost: company.unallocatedProduction, promotion: company.unallocatedPromotion, work_other_expense: company.unallocatedOther, direct_cost: company.unallocatedDirect}[kind];
      if(series && (kind==='production_cost'?row.recognitionTiming==='release_month_once':row.recognitionTiming==='incurred_month') && row.section===(['production_cost','direct_cost'].includes(kind)?'cogs':'sga'))series.add(i,row.exTax,'経費');
      else {const entry=extraFor(row,null);entry.accrued.add(i,row.exTax,'経費');entry.series.add(i,row.exTax,'経費');}
      company.unallocatedExpenseInc.add(i, row.incTax, '経費の税込額');
      company.unallocatedExpenseTax.add(i, row.tax, '経費の税額');
    }
  }
  for (const payment of input.expensePayments || []) {
    const found = expenseById.get(Number(payment.expenseId));
    const i = dateIdx(payment.paidOn);
    if (!found || i === undefined) continue;
    if (found.row.workId != null && !found.w) continue;
    if (found.committeeExpense) found.w.committeeUnpaidExpense.add(i, -payment.amount, '委員会の経費の出金');
    else if (found.w) found.w.expensePaid.add(i, payment.amount, '経費の出金');
    else company.unallocatedExpensePaid.add(i, payment.amount, '経費の出金');
  }

  // ロイヤリティの発生額（計上月・税抜）。委員会作品の分は委員会の権利処理費（分配の前に差し引き済み）
  for (const row of input.royaltyAccruals || []) {
    const w = perWork.get(Number(row.workId));
    const i = idx(row.month);
    if (!w || i === undefined || w.work.committee) continue;
    if (Number.isSafeInteger(row.royaltyYen)) w.royalty.add(i, row.royaltyYen, 'ロイヤリティ');
    if (!Number.isSafeInteger(row.royaltyYen) || (row.holdSalesYen || 0) !== 0) w.royaltyHoldMonths.add(row.month);
  }
  // ロイヤリティの支払（報告書ごと）を、報告書の明細の作品ごとの額の比で作品へ分ける。分けられない支払は会社の分。
  // 委員会作品の分は委員会の口座からの支払なので、自社の現預金・未払ロイヤリティに入れない（参考に委員会作品ごとの支払額を残す）
  const committeeRoyaltyPaid = new Map(works.map((work) => [work.id, S()]));
  for (const payment of input.royaltyPayments || []) {
    const i = dateIdx(payment.paidOn);
    if (i === undefined) continue;
    const split = splitByWeights(payment.amount, (payment.weights || []).map((row) => ({key: Number(row.workId), weight: row.weight})));
    if (!split) { company.unallocatedRoyaltyPaid.add(i, payment.amount, 'ロイヤリティの支払'); continue; }
    for (const [workId, amount] of split) {
      const w = perWork.get(workId);
      if (!w) continue; // 見えない作品の分
      if (w.work.committee) committeeRoyaltyPaid.get(workId).add(i, amount, '委員会作品のロイヤリティの支払');
      else w.royaltyPaid.add(i, amount, 'ロイヤリティの支払');
    }
  }

  // 前払金の充当（台帳と同じ式の月ごとの額）。自社作品の未払ロイヤリティから引く。委員会作品の分は委員会の権利処理費なので使わない
  for (const row of input.royaltyRecoups || []) {
    const w = perWork.get(Number(row.workId));
    const i = idx(row.month);
    if (!w || i === undefined || w.work.committee) continue;
    w.royaltyRecouped.add(i, row.amount, '前払金の充当');
  }
  for (const row of input.royaltyAdvances || []) {
    const w = perWork.get(Number(row.workId));
    if (w && !w.work.committee && Number.isSafeInteger(row.advanceYen)) w.royaltyAdvanceYen += row.advanceYen;
  }

  // 請求の入金（入金を請求書の作品ごとの税込額の比で分ける）。委員会作品の分は委員会の預り金
  for (const receipt of input.receipts || []) {
    const i = dateIdx(receipt.receivedOn);
    if (i === undefined) continue;
    const split = splitByWeights(receipt.amount, (receipt.weights || []).map((row) => ({key: Number(row.workId), weight: row.weight})));
    if (!split) { company.unallocatedReceipts.add(i, receipt.amount, '請求の入金'); continue; }
    for (const [workId, amount] of split) {
      const w = perWork.get(workId);
      if (w) w.receipts.add(i, amount, '請求の入金');
    }
  }

  // 委員会: 自社の取得額（月次収支の自社の行）・出資の払込・委員会からの受取
  for (const w of perWork.values()) {
    if (!w.work.committee) continue;
    const row = committeeByWork.get(w.work.id);
    if (!selfPartnerId) { w.unverified.push('自社を表す取引先が未設定のため、委員会作品の自社の取り分を計算していません'); continue; }
    if (!row) { w.unverified.push('委員会の月次収支を読めませんでした'); continue; }
    if (row.error) { w.unverified.push(`委員会の月次収支を計算できません: ${row.error}`); continue; }
    for (const item of row.acquisitions || []) {
      const i = idx(item.month);
      if (i === undefined) continue;
      w.acqDist.add(i, item.distribution || 0, '分配額');
      w.acqWindowFee.add(i, item.windowFee || 0, '窓口手数料の取り分');
      w.acqManagerFee.add(i, item.managerFee || 0, '幹事手数料');
      w.acq.add(i, item.acquisition || 0, '取得額');
    }
    if (row.holdNote) w.unverified.push(row.holdNote);
  }
  for (const payment of input.investmentPayments || []) {
    if (!selfPartnerId || Number(payment.partnerId) !== Number(selfPartnerId)) continue;
    const w = perWork.get(Number(payment.workId));
    const i = dateIdx(payment.paidOn);
    if (w && i !== undefined) w.investmentPaid.add(i, payment.amount, '出資の払込');
  }
  for (const receipt of input.committeeReceipts || []) {
    const w = perWork.get(Number(receipt.workId));
    const i = dateIdx(receipt.receivedOn);
    if (w && i !== undefined) w.committeeReceived.add(i, receipt.amount, '委員会からの受取');
  }

  // 手入力の発生額（PL）。作品を付けた額はその作品の PL に入れる
  const manualFlowSeries = (holder, account) => {
    if (!holder.manualBy.has(account.id)) holder.manualBy.set(account.id, {account, series: S(), tax: S(), unverified: false, count: 0});
    return holder.manualBy.get(account.id);
  };
  for (const row of manual) {
    if (row.kind !== 'flow') continue;
    const account = accounts.byId.get(row.accountId);
    if (account.source !== 'manual' || !PL_SECTIONS.includes(account.section)) continue;
    const i = idx(row.month);
    if (i === undefined) continue;
    const w = row.workId == null ? null : perWork.get(Number(row.workId));
    if (row.workId != null && !w) continue;
    const entry = manualFlowSeries(w || company, account);
    entry.series.add(i, row.amount, `${account.name}（手入力）`);
    // 消費税額（課税の費用は仮払・収益は仮受）。PL は税抜の額だけ、現預金と未払消費税等に税額を入れる。現預金を動かさない科目には税額を持たない
    if (account.cashEffect && Number.isSafeInteger(row.tax) && row.tax !== 0) entry.tax.add(i, row.tax, `${account.name}の消費税額（手入力）`);
    entry.count += 1;
    if (row.status !== 'reviewed') entry.unverified = true;
  }

  // 期首の残高（期首の基準月の月末残高の手入力）と、手入力の科目の月末残高
  const openingBy = new Map(); // `${systemKey|accountId}:${workId||''}` → 額
  const openingOf = (key, workId = null) => openingBy.get(`${key}:${workId ?? ''}`) || 0;
  const manualBalances = new Map(); // accountId → Map(month → {amount, unverified})
  let ignoredSystemBalances = 0;
  let openingUnverified = false;
  for (const row of manual) {
    if (row.kind !== 'balance') continue;
    const account = accounts.byId.get(row.accountId);
    if (!BS_SECTIONS.includes(account.section)) continue;
    if (account.source === 'system') {
      if (!openingMonth || row.month !== openingMonth) { ignoredSystemBalances += 1; continue; }
      const key = `${account.systemKey}:${row.workId ?? ''}`;
      openingBy.set(key, sumOf([openingBy.get(key) || 0, row.amount]));
      if (row.status !== 'reviewed') openingUnverified = true;
      continue;
    }
    if (!manualBalances.has(account.id)) manualBalances.set(account.id, new Map());
    const byMonth = manualBalances.get(account.id);
    const cell = byMonth.get(row.month) || {amount: 0, unverified: false, byWork: new Map()};
    cell.amount = sumOf([cell.amount, row.amount]);
    if (row.workId != null) cell.byWork.set(Number(row.workId), sumOf([cell.byWork.get(Number(row.workId)) || 0, row.amount]));
    if (row.status !== 'reviewed') cell.unverified = true;
    byMonth.set(row.month, cell);
  }
  if (ignoredSystemBalances) companyNotes.push(`システムが計算する科目の残高は、期首の基準月の分だけを使います（基準月以外の月に入れた${ignoredSystemBalances}件は使っていません）。`);
  // 手入力の科目の month 時点の残高（その月以前で最後に入れた月の額。無ければ0）
  const manualLevel = (accountId, month) => {
    const byMonth = manualBalances.get(accountId);
    if (!byMonth) return {amount: 0, month: null, unverified: false, byWork: new Map()};
    let best = null;
    for (const key of byMonth.keys()) if (key <= month && (!best || key > best)) best = key;
    return best ? {...byMonth.get(best), month: best} : {amount: 0, month: null, unverified: false, byWork: new Map()};
  };

  // 制作費: 公開月までは制作中の作品（資産）に積み、公開月に一括で費用にする。公開月の後に付いた制作費はその月の費用。
  // 公開月が分からない作品は資産に積んだまま（未確定）。
  // 期首の基準月では、それまでに積んだ額を手入力の期首の制作中の作品（作品付き）に置き換える（期首残高が正本）。
  // システムが基準月までに積んで、まだ費用にしていない額が期首残高と合わないときは、黙って落とさず未確定の理由と注意を出す
  let openingProductionGap = 0n;
  for (const w of perWork.values()) {
    w.prodExpensed = S();
    w.wip = Array.from({length: n}, () => 0n);
    if (w.work.committee) continue;
    // 期首の基準月が計算の最初の月より前なら、期首の制作中の作品（手入力の期首残高）から始める
    let running = openingMonth && openingMonth < months[0] ? BigInt(openingOf('work_in_progress', w.work.id)) : 0n;
    const release = w.work.releaseMonth;
    for (let i = 0; i < n; i += 1) {
      if (openingMonth && months[i] === openingMonth) {
        // 公開月が基準月以前なら、基準月までの制作費はすでに費用になっている（置き換える額は0のはず）
        const accumulated = release && release <= openingMonth ? 0n : running + w.prodAccrued.values[i];
        const opening = BigInt(openingOf('work_in_progress', w.work.id));
        if (accumulated !== 0n && accumulated !== opening) {
          openingProductionGap += accumulated;
          w.unverified.push(`期首の基準月（${monthLabel(openingMonth)}）までに計上した制作費 ${toSafe(accumulated).toLocaleString('ja-JP')}円が、期首の制作中の作品（手入力 ${toSafe(opening).toLocaleString('ja-JP')}円）と一致しません。公開月の制作費には期首の制作中の作品を使っています。作品を付けて期首残高を入れてください`);
        }
        running = opening;
      } else running += w.prodAccrued.values[i];
      if (release && months[i] >= release && running !== 0n) {
        w.prodExpensed.values[i] += running;
        running = 0n;
      }
      w.wip[i] = running;
    }
    const hasProduction = w.prodAccrued.values.some((value) => value !== 0n) || openingOf('work_in_progress', w.work.id) !== 0;
    if (hasProduction && !release) w.unverified.push('公開月が分からないため、制作費を制作中の作品に置いたままにしています（全作品のウィンドウに劇場公開の日付を登録してください）');
    else if (hasProduction && w.work.releaseSource !== 'window') w.unverified.push(`公開月（${monthLabel(release)}）は全作品のウィンドウに無いため、最初に売上を計上した月を公開月として扱っています`);
  }
  if (openingProductionGap !== 0n) notes.push(`期首の基準月（${monthLabel(openingMonth)}）までに計上した自社作品の制作費 ${toSafe(openingProductionGap).toLocaleString('ja-JP')}円が、作品付きの期首の制作中の作品と合いません。PLの制作費には期首残高を使っています（作品別PLの未確定の理由を確かめてください）。`);
  // 作品の決まっていない案件の制作費は、公開月が分からないのでその月の費用（直接費と同じ扱い）にする
  const companyProductionExpensed = company.unallocatedProduction;

  for(const w of perWork.values())for(const entry of w.expenseBy?.values()??[]){
    let running=0n;for(let i=0;i<n;i++){running+=entry.accrued.values[i]-entry.series.values[i];w.wip[i]+=running;}
    if(entry.unverified)w.unverified.push('費用区分未整備の経費を含みます');
  }

  // ---------- 作品の月次の数字 ----------
  const workMonthly = new Map();
  for (const w of perWork.values()) {
    const num = (series, label) => series.numbers(label);
    const manualIncome = S(), manualCost = S();
    for (const {account, series, unverified} of w.manualBy.values()) {
      const target = INCOME_SECTIONS.has(account.section) ? manualIncome : manualCost;
      series.values.forEach((value, i) => { target.values[i] += value; });
      if (unverified) w.manualUnverified = true;
    }
    const m = {
      sales: num(w.sales, '売上'), salesTax: num(w.salesTax, '売上の税額'), salesInc: num(w.salesInc, '売上の税込額'),
      acqDist: num(w.acqDist, '分配額'), acqWindowFee: num(w.acqWindowFee, '窓口手数料の取り分'), acqManagerFee: num(w.acqManagerFee, '幹事手数料'), acq: num(w.acq, '取得額'),
      royalty: num(w.royalty, 'ロイヤリティ'), direct: num(w.direct, '直接費'), production: num(w.prodExpensed, '制作費'), promotion: num(w.promotion, '広告宣伝費'),
      workOther: num(w.workOther, 'その他の経費'), additionalExpense:num((()=>{const total=S();for(const e of w.expenseBy?.values()??[])e.series.values.forEach((v,i)=>{total.values[i]+=v;});return total;})(),'追加科目の経費'), manualIncome: num(manualIncome, '手入力の収益'), manualCost: num(manualCost, '手入力の費用'),
    };
    m.revenue = m.sales.map((value, i) => toSafe(BigInt(value) + BigInt(m.acq[i]), '売上高'));
    const extraBySection=section=>Array.from({length:n},(_,i)=>[...w.expenseBy?.values()??[]].filter(e=>e.account.section===section).reduce((v,e)=>v+e.series.values[i],0n));
    const extraCogs=extraBySection('cogs'),extraSga=extraBySection('sga');
    m.cogs = m.royalty.map((value, i) => toSafe(BigInt(value) + BigInt(m.direct[i]) + BigInt(m.production[i])+extraCogs[i], '売上原価'));
    m.sga = m.promotion.map((value, i) => toSafe(BigInt(value) + BigInt(m.workOther[i])+extraSga[i], '販管費'));
    m.profit = m.revenue.map((value, i) => toSafe(BigInt(value) - BigInt(m.cogs[i]) - BigInt(m.sga[i]) + BigInt(m.manualIncome[i]) - BigInt(m.manualCost[i]) - (BigInt(m.additionalExpense[i])-extraCogs[i]-extraSga[i]), '作品の利益'));
    m.salesBy = new Map([...w.salesBy.entries()].sort(([a], [b]) => byOrder(CHANNEL_GROUPS)(a, b)).map(([group, series]) => [group, series.numbers('売上')]));
    workMonthly.set(w.work.id, m);
  }

  const sumIdx = (values, indices) => sumOf(indices.map((i) => values[i]));
  const PL_FIELDS = ['sales', 'acq', 'acqDist', 'acqWindowFee', 'acqManagerFee', 'revenue', 'royalty', 'direct', 'production', 'cogs', 'promotion', 'workOther', 'sga', 'manualIncome', 'manualCost', 'additionalExpense', 'profit'];
  const pick = (m, indices) => Object.fromEntries(PL_FIELDS.map((field) => [field, sumIdx(m[field], indices)]));

  // 作品の由来（未確定の理由があれば未確定、手入力があれば手入力、ほかはシステム）
  const periodMonths = months.filter((month) => month >= from && month <= to);
  const workOrigin = (w) => {
    const reasons = [...w.unverified];
    const holdMonths = [...w.royaltyHoldMonths].filter((month) => month <= to).sort();
    if (holdMonths.length) reasons.push(`ロイヤリティの発生額に算定できない月があります（${holdMonths.slice(0, 3).map(monthLabel).join('・')}${holdMonths.length > 3 ? `ほか${holdMonths.length - 3}か月` : ''}）`);
    if (w.manualUnverified) reasons.push('未確認の手入力の額を含みます');
    const origin = reasons.length ? 'unverified' : w.manualBy.size ? 'manual' : 'system';
    return {origin, reasons};
  };

  const workPl = works.map((work) => {
    const w = perWork.get(work.id);
    const m = workMonthly.get(work.id);
    const {origin, reasons} = workOrigin(w);
    return {
      workId: work.id, code: work.code, title: work.title, kind: work.committee ? 'committee' : 'own', kindLabel: work.committee ? '委員会作品（自社の取り分）' : '自社作品',
      releaseMonth: work.releaseMonth, releaseSource: work.releaseSource, origin, originLabel: ORIGIN_LABELS[origin], reasons,
      period: pick(m, periodIdx), cumulative: pick(m, cumulativeIdx),
      channels: [...m.salesBy.entries()].map(([group, values]) => ({group, label: CHANNEL_LABELS[group] || 'その他', period: sumIdx(values, periodIdx), cumulative: sumIdx(values, cumulativeIdx)})),
      monthly: periodMonths.map((month) => {
        const i = idx(month);
        return {month, ...Object.fromEntries(PL_FIELDS.map((field) => [field, m[field][i]])),
          salesBy: Object.fromEntries([...m.salesBy.entries()].map(([group, values]) => [group, values[i]]))};
      }),
    };
  });

  // 作品別PL の明細（行＝項目、列＝月・期間計・累計）。画面の作品の詳細と Excel が使う
  const workDetail = (workId) => {
    const m = workMonthly.get(workId);
    const w = perWork.get(workId);
    if (!m) return null;
    const cols = [...periodMonths.map((month) => ({key: `m:${month}`, label: monthLabel(month), indices: [idx(month)]})),
      {key: 'period', label: '期間計', indices: periodIdx}, {key: 'cumulative', label: '累計', indices: cumulativeIdx}];
    const values = (series) => Object.fromEntries(cols.map((col) => [col.key, sumIdx(series, col.indices)]));
    const rows = [];
    const push = (key, label, series, extra = {}) => rows.push({key, label, level: 0, emphasis: false, values: values(series), ...extra});
    if (w.work.committee) {
      push('acqDist', '委員会からの分配額（自社）', m.acqDist, {level: 1});
      push('acqWindowFee', '窓口手数料の取り分（自社）', m.acqWindowFee, {level: 1});
      push('acqManagerFee', '幹事手数料（自社）', m.acqManagerFee, {level: 1});
      push('revenue', '売上高（自社の取得額）', m.revenue, {emphasis: true});
    } else {
      for (const [group, series] of m.salesBy) push(`sales:${group}`, `売上｜${CHANNEL_LABELS[group] || 'その他'}`, series, {level: 1});
      push('revenue', '売上高', m.revenue, {emphasis: true});
      push('royalty', 'ロイヤリティの発生額', m.royalty, {level: 1});
      push('direct', '作品の直接費', m.direct, {level: 1});
      push('production', '制作費（公開月に一括）', m.production, {level: 1});
      push('cogs', '売上原価', m.cogs, {emphasis: true});
      push('promotion', '広告宣伝費', m.promotion, {level: 1});
      push('workOther', '作品のその他の経費', m.workOther, {level: 1});
    }
    for (const {account, series} of w.manualBy.values()) push(`manual:${account.id}`, `${account.name}（手入力・${INCOME_SECTIONS.has(account.section) ? '収益' : '費用'}）`, series.numbers(account.name), {level: 1, manual: true});
    for(const e of w.expenseBy?.values()??[])push(`expense:${e.account.id}`,e.account.name,e.series.numbers(e.account.name),{level:1,origin:e.unverified?'unverified':'system'});
    push('profit', '作品の利益', m.profit, {emphasis: true});
    return {columns: cols.map(({indices, ...col}) => col), rows};
  };

  // ---------- 会社の月次PL ----------
  const companyManualIncome = S(), companyManualCost = S();
  const plRows = [];
  const plMonthIdx = periodIdx;
  const plCols = [...periodMonths.map((month) => ({key: `m:${month}`, label: monthLabel(month), indices: [idx(month)]})), {key: 'period', label: '期間計', indices: plMonthIdx}];
  const colValues = (values) => Object.fromEntries(plCols.map((col) => [col.key, sumIdx(values, col.indices)]));
  const zero = () => Array.from({length: n}, () => 0);
  const add = (...arrays) => arrays[0].map((_, i) => toSafe(arrays.reduce((total, values) => total + BigInt(values[i]), 0n), '合計'));
  const neg = (values) => values.map((value) => -value);
  const allW = [...workMonthly.values()];
  const sumField = (field) => (allW.length ? add(...allW.map((m) => m[field])) : zero());
  const worksUnverified = workPl.filter((row) => row.origin === 'unverified');
  const anyUnverified = (predicate) => worksUnverified.some(predicate);
  const accountRow = (systemKey) => accounts.bySystemKey.get(systemKey);
  const pushPl = ({series, children, ...row}) => plRows.push({level: 0, emphasis: false, origin: 'system', ...row, originLabel: ORIGIN_LABELS[row.origin || 'system'], values: colValues(series)});

  const ownSalesByGroup = new Map();
  for (const m of allW) for (const [group, values] of m.salesBy) ownSalesByGroup.set(group, ownSalesByGroup.has(group) ? add(ownSalesByGroup.get(group), values) : values);
  const ownSales = sumField('sales');
  const committeeShare = sumField('acq');
  const royalty = sumField('royalty');
  const direct = add(sumField('direct'), company.unallocatedDirect.numbers('直接費'));
  const production = add(sumField('production'),companyProductionExpensed.numbers('制作費'));
  const promotion = add(sumField('promotion'), company.unallocatedPromotion.numbers('広告宣伝費'));
  const workOther = add(sumField('workOther'), company.unallocatedOther.numbers('その他の経費'));
  const ownUnverified = anyUnverified((row) => row.kind === 'own');
  const committeeUnverified = anyUnverified((row) => row.kind === 'committee');

  // 手入力の科目の行（作品の分と会社の分の合計）
  const manualAccountSeries = new Map();
  for (const holder of [company, ...perWork.values()]) {
    for (const {account, series, tax, unverified} of holder.manualBy.values()) {
      const entry = manualAccountSeries.get(account.id) || {account, values: zero(), taxValues: zero(), unverified: false};
      entry.values = add(entry.values, series.numbers(account.name));
      entry.taxValues = add(entry.taxValues, tax.numbers(`${account.name}の消費税額`));
      entry.unverified ||= unverified;
      manualAccountSeries.set(account.id, entry);
    }
  }
  for (const {account, values} of manualAccountSeries.values()) {
    if (INCOME_SECTIONS.has(account.section)) companyManualIncome.values.forEach((_, i) => { companyManualIncome.values[i] += BigInt(values[i]); });
    else companyManualCost.values.forEach((_, i) => { companyManualCost.values[i] += BigInt(values[i]); });
  }
  for(const holder of [company,...perWork.values()])for(const e of holder.expenseBy?.values()??[]){
    const entry=extraExpenses.get(e.account.id)??{account:e.account,values:zero(),unverified:e.unverified};entry.values=add(entry.values,e.series.numbers(e.account.name));extraExpenses.set(e.account.id,entry);
  }
  const sectionTotals = {};
  for (const section of PL_SECTIONS) {
    const parts = [];
    const systemRows = [];
    if (section === 'sales') {
      for (const [group, values] of [...ownSalesByGroup.entries()].sort(([a], [b]) => byOrder(CHANNEL_GROUPS)(a, b))) systemRows.push({key: `sales:${group}`, label: `　うち${CHANNEL_LABELS[group] || 'その他'}`, series: values, level: 2, origin: ownUnverified ? 'unverified' : 'system', detailOnly: true});
      parts.push({key: 'own_sales', label: accountRow('own_sales').name, series: ownSales, origin: ownUnverified ? 'unverified' : 'system', children: systemRows.splice(0)});
      parts.push({key: 'committee_share', label: accountRow('committee_share').name, series: committeeShare, origin: committeeUnverified ? 'unverified' : 'system'});
    }
    if (section === 'cogs') {
      parts.push({key: 'royalty', label: accountRow('royalty').name, series: royalty, origin: anyUnverified((row) => row.kind === 'own' && row.reasons.some((r) => r.startsWith('ロイヤリティ'))) ? 'unverified' : 'system'});
      parts.push({key: 'direct_cost', label: accountRow('direct_cost').name, series: direct, origin: 'system'});
      parts.push({key: 'production_cost', label: accountRow('production_cost').name, series: production, origin: anyUnverified((row) => row.kind === 'own' && row.reasons.some((r) => r.includes('公開月'))) ? 'unverified' : 'system'});
    }
    if (section === 'sga') {
      parts.push({key: 'promotion', label: accountRow('promotion').name, series: promotion, origin: 'system'});
      parts.push({key: 'work_other_expense', label: accountRow('work_other_expense').name, series: workOther, origin: 'system'});
    }
    for (const {account, values, unverified} of [...manualAccountSeries.values()].filter((entry) => entry.account.section === section).sort((a, b) => a.account.sortOrder - b.account.sortOrder || a.account.code.localeCompare(b.account.code))) {
      parts.push({key: `manual:${account.id}`, label: account.name, series: values, origin: unverified ? 'unverified' : 'manual', accountCode: account.code});
    }
    for(const e of extraExpenses.values())if(e.account.section===section)parts.push({key:`expense:${e.account.id}`,label:e.account.name,series:e.values,origin:e.unverified?'unverified':'system'});
    const total = parts.length ? add(...parts.map((part) => part.series)) : zero();
    sectionTotals[section] = total;
    for (const part of parts) {
      pushPl({key: part.key, section, label: part.label, series: part.series, level: 1, origin: part.origin, accountCode: part.accountCode ?? accounts.bySystemKey.get(part.key)?.code ?? null});
      for (const child of part.children || []) pushPl({...child, section});
    }
    const sectionOrigin = parts.some((part) => part.origin === 'unverified') ? 'unverified' : parts.some((part) => part.origin === 'manual') ? 'manual' : 'system';
    pushPl({key: `total:${section}`, section, label: `${SECTION_LABELS[section]}（計）`, series: total, emphasis: true, origin: sectionOrigin, subtotal: true});
    // 利益の行（それまでの区分の計から出す）。収益の区分は足し、費用の区分は引く
    const summary = {cogs: ['grossProfit', '売上総利益'], sga: ['operatingProfit', '営業利益'], non_operating_expense: ['ordinaryProfit', '経常利益'],
      extraordinary_loss: ['pretaxProfit', '税引前当期純利益'], income_tax: ['netIncome', '当期純利益']}[section];
    if (summary) {
      const upTo = PL_SECTIONS.slice(0, PL_SECTIONS.indexOf(section) + 1);
      const series = add(...upTo.map((key) => (INCOME_SECTIONS.has(key) ? sectionTotals[key] : neg(sectionTotals[key]))));
      const origin = plRows.some((row) => row.origin === 'unverified') ? 'unverified' : plRows.some((row) => row.origin === 'manual') ? 'manual' : 'system';
      pushPl({key: summary[0], label: summary[1], series, emphasis: true, profit: true, origin});
      sectionTotals[summary[0]] = series;
    }
  }
  const netIncome = sectionTotals.netIncome;

  // ---------- 作品別の残高（asOf 月末） ----------
  const sumBs = (values) => sumOf(bsIdx.map((i) => values[i]));
  const nums = (series, label) => series.numbers(label);
  const asOfIdx = idx(asOf);
  const cumulativeToAsOf = months.map((month, i) => (month <= asOf ? i : -1)).filter((i) => i >= 0);
  // BS の基準月が期首残高の基準月より前のときは、残高を出さない（期首残高から積み上げられないため。PL はそのまま出す）
  const workBalances = bsBeforeOpening ? [] : works.map((work) => {
    const w = perWork.get(work.id);
    const m = workMonthly.get(work.id);
    const committee = committeeByWork.get(work.id);
    const reasons = [...workOrigin(w).reasons];
    const row = {workId: work.id, code: work.code, title: work.title, kind: work.committee ? 'committee' : 'own', kindLabel: work.committee ? '委員会作品' : '自社作品'};
    const receiptsIn = sumBs(nums(w.receipts, '入金'));
    if (work.committee) {
      row.receivable = null;
      row.committeeDeposit = toSafe(BigInt(openingOf('committee_deposit', work.id)) + BigInt(receiptsIn), '委員会の預り金');
      row.royaltyPayable = null;
      row.royaltyRecouped = null;
      row.royaltyAdvanceYen = null;
      row.royaltyAdvanceUnrecouped = null;
      row.expensePayable = null;
      // 参考（BSの合計に入れない）: 委員会の口座で払う委員会作品の経費の未払と、委員会作品のロイヤリティの支払額
      row.committeeUnpaidExpense = sumBs(nums(w.committeeUnpaidExpense, '委員会の経費の未払'));
      row.committeeRoyaltyPaid = sumBs(nums(committeeRoyaltyPaid.get(work.id), '委員会作品のロイヤリティの支払'));
      row.wip = null;
      const acquired = selfPartnerId && committee && !committee.error ? sumBs(m.acq) : null;
      row.cumulativeAcquisition = selfPartnerId && committee && !committee.error ? sumIdx(m.acq, cumulativeToAsOf) : null;
      row.committeeReceivable = acquired === null ? null : toSafe(BigInt(openingOf('committee_receivable', work.id)) + BigInt(acquired) - BigInt(sumBs(nums(w.committeeReceived, '委員会からの受取'))), '委員会からの未収');
      // 受取が取得額の累計を上回ると未収がマイナスになる（0円で埋めず、そのまま残して理由を出す）
      if (row.committeeReceivable !== null && row.committeeReceivable < 0) {
        reasons.push(`委員会からの受取（期間報告の自社への支払・販売期間が基準）が、自社の取得額の累計（月次収支・計上月が基準）を ${(-row.committeeReceivable).toLocaleString('ja-JP')}円上回っています。基準と控除の違う2つの計算の差なので、期間報告と月次収支を照らして確かめてください`);
      }
      row.investmentCommitted = committee?.committedYen ?? null;
      row.investmentPaid = toSafe(BigInt(openingOf('committee_investment', work.id)) + BigInt(sumBs(nums(w.investmentPaid, '出資の払込'))), '出資金');
      row.investmentUnpaid = row.investmentCommitted === null ? null : row.investmentCommitted - row.investmentPaid;
      row.recoveryRate = row.cumulativeAcquisition !== null && row.investmentCommitted > 0 ? row.cumulativeAcquisition / row.investmentCommitted : null;
      row.selfShareBps = committee?.selfShareBps ?? null;
    } else {
      row.receivable = toSafe(BigInt(openingOf('receivable', work.id)) + BigInt(sumBs(m.salesInc)) - BigInt(receiptsIn), '売掛金');
      row.committeeDeposit = null;
      const recouped = sumBs(nums(w.royaltyRecouped, '前払金の充当'));
      row.royaltyRecouped = recouped;
      row.royaltyPayable = toSafe(BigInt(openingOf('royalty_payable', work.id)) + BigInt(sumBs(m.royalty)) - BigInt(recouped) - BigInt(sumBs(nums(w.royaltyPaid, 'ロイヤリティの支払'))), '未払ロイヤリティ');
      row.royaltyAdvanceYen = null;
      row.royaltyAdvanceUnrecouped = null;
      // 前払金の支払は記録していない。充当で未払ロイヤリティを減らした分は、現預金が減らないので会社BSの説明のつかない差額に出る
      if (w.royaltyAdvanceYen > 0) {
        row.royaltyAdvanceYen = w.royaltyAdvanceYen;
        row.royaltyAdvanceUnrecouped = toSafe(BigInt(w.royaltyAdvanceYen) - BigInt(sumIdx(nums(w.royaltyRecouped, '前払金の充当'), cumulativeToAsOf)), '前払金の未充当残');
        reasons.push(`ロイヤリティの前払金（${w.royaltyAdvanceYen.toLocaleString('ja-JP')}円）の支払の記録が無いため、前払金の充当 ${recouped.toLocaleString('ja-JP')}円を未払ロイヤリティから引いた分は、会社BSの説明のつかない差額に出ます`);
      }
      row.expensePayable = toSafe(BigInt(openingOf('expense_payable', work.id)) + BigInt(sumBs(nums(w.expenseInc, '経費'))) - BigInt(sumBs(nums(w.expensePaid, '経費の出金'))), '未払の経費');
      const settlement=input.expenseSettlement?.work?.[work.id];row.expenseUnreadyPayable=settlement?.unready_payable??0;
      if(row.expenseUnreadyPayable)reasons.push('締め日未整備の経費は参考の未払残高に分けています');
      row.expensePayable+=settlement?.payable??0;
      row.expensePrepaid=settlement?.prepaid??0;row.expenseRefundReceivable=settlement?.refund_receivable??0;
      row.committeeUnpaidExpense = null;
      row.committeeRoyaltyPaid = null;
      row.wip = asOfIdx === undefined ? 0 : toSafe(w.wip[asOfIdx], '制作中の作品');
      row.cumulativeAcquisition = null;
      row.committeeReceivable = null;
      row.investmentCommitted = null;
      row.investmentPaid = null;
      row.investmentUnpaid = null;
      row.recoveryRate = null;
    }
    const mg = (input.mg || []).filter((item) => Number(item.workId) === work.id);
    row.mgIncomingUnconsumed = mg.some((item) => item.direction === 'incoming') ? sumOf(mg.filter((item) => item.direction === 'incoming').map((item) => item.guaranteedYen - item.appliedYen)) : null;
    row.mgOutgoingUnrecouped = mg.some((item) => item.direction === 'outgoing') ? sumOf(mg.filter((item) => item.direction === 'outgoing').map((item) => item.guaranteedYen - item.appliedYen)) : null;
    const assets = sumOf([row.receivable, row.wip, row.investmentPaid, row.committeeReceivable,row.expensePrepaid,row.expenseRefundReceivable]);
    const liabilities = sumOf([row.royaltyPayable, row.expensePayable, row.expenseUnreadyPayable, row.committeeDeposit]);
    row.assets = assets;
    row.liabilities = liabilities;
    row.net = assets - liabilities;
    if (row.mgIncomingUnconsumed !== null || row.mgOutgoingUnrecouped !== null) reasons.push('MG は受取・支払の記録が無いため、残高の合計に入れていません（参考）');
    row.reasons = reasons;
    row.origin = reasons.length ? 'unverified' : 'system';
    row.originLabel = ORIGIN_LABELS[row.origin];
    return row;
  });

  // ---------- 会社の簡易BS（asOf 月末） ----------
  const openSysOf = (key) => sumOf([...openingBy.entries()].filter(([k]) => k.startsWith(`${key}:`)).map(([, value]) => value));
  const companyBs = bsBeforeOpening ? null : buildCompanyBs();
  function buildCompanyBs() {
  const allPerWork = [...perWork.values()];
  const sumWorks = (pickFn) => sumOf(allPerWork.map(pickFn));
  const own = allPerWork.filter((w) => !w.work.committee);
  const com = allPerWork.filter((w) => w.work.committee);
  const openSys = (key) => sumOf([...openingBy.entries()].filter(([k]) => k.startsWith(`${key}:`)).map(([, value]) => value));
  const cashFlows = {
    billingReceipts: toSafe(BigInt(sumWorks((w) => sumBs(nums(w.receipts, '入金')))) + BigInt(sumBs(nums(company.unallocatedReceipts, '入金'))), '請求の入金'),
    committeeReceipts: sumWorks((w) => sumBs(nums(w.committeeReceived, '委員会からの受取'))),
    expensePayments: toSafe(BigInt(sumWorks((w) => sumBs(nums(w.expensePaid, '出金')))) + BigInt(sumBs(nums(company.unallocatedExpensePaid, '出金'))), '経費の出金'),
    royaltyPayments: toSafe(BigInt(sumWorks((w) => sumBs(nums(w.royaltyPaid, '支払')))) + BigInt(sumBs(nums(company.unallocatedRoyaltyPaid, '支払'))), 'ロイヤリティの支払'),
    investmentPayments: sumWorks((w) => sumBs(nums(w.investmentPaid, '払込'))),
    manualIncomeCash: 0, manualCostCash: 0, manualIncomeTax: 0, manualCostTax: 0, manualBalanceCash: 0,
  };
  // 手入力の PL の額（現預金を動かす科目だけ）と、現預金を動かさない分（差額の手がかり）
  let nonCashPl = 0n;
  let manualPlUnverified = false;
  // 手入力の費用・収益は、税抜の額に消費税額を足した税込で現預金が動き、税額は未払消費税等（仮払・仮受）に入る
  for (const {account, values, taxValues, unverified} of manualAccountSeries.values()) {
    const amount = BigInt(sumBs(values));
    const tax = BigInt(sumBs(taxValues));
    const income = INCOME_SECTIONS.has(account.section);
    if (unverified) manualPlUnverified = true;
    if (account.cashEffect) {
      if (income) {
        cashFlows.manualIncomeCash = toSafe(BigInt(cashFlows.manualIncomeCash) + amount + tax);
        cashFlows.manualIncomeTax = toSafe(BigInt(cashFlows.manualIncomeTax) + tax);
      } else {
        cashFlows.manualCostCash = toSafe(BigInt(cashFlows.manualCostCash) + amount + tax);
        cashFlows.manualCostTax = toSafe(BigInt(cashFlows.manualCostTax) + tax);
      }
    } else nonCashPl += income ? -amount : amount;
  }
  // 手入力の BS の科目（月末残高）
  const manualBsRows = [];
  let nonCashBalance = 0n;
  for (const account of accounts.rows.filter((row) => row.source === 'manual' && BS_SECTIONS.includes(row.section))) {
    const current = manualLevel(account.id, asOf);
    const opening = openingMonth ? manualLevel(account.id, openingMonth) : {amount: 0, unverified: false};
    const delta = BigInt(current.amount) - BigInt(opening.amount);
    const sign = account.section === 'asset' ? -1n : 1n;
    if (account.cashEffect) cashFlows.manualBalanceCash = toSafe(BigInt(cashFlows.manualBalanceCash) + sign * delta, '手入力の残高の増減');
    else nonCashBalance += account.section === 'asset' ? delta : -delta;
    if (!manualBalances.has(account.id)) continue;
    manualBsRows.push({key: `manual:${account.id}`, section: account.section, label: account.name, accountCode: account.code, opening: opening.amount, value: current.amount,
      origin: current.unverified || opening.unverified ? 'unverified' : 'manual', asOfMonth: current.month, cashEffect: account.cashEffect});
  }
  const settlement=input.expenseSettlement??{};
  const openingCash = openSys('cash');
  const cash = toSafe(BigInt(settlement.cash??0) + BigInt(openingCash) + BigInt(cashFlows.billingReceipts) + BigInt(cashFlows.committeeReceipts) - BigInt(cashFlows.expensePayments)
    - BigInt(cashFlows.royaltyPayments) - BigInt(cashFlows.investmentPayments) + BigInt(cashFlows.manualIncomeCash) - BigInt(cashFlows.manualCostCash) + BigInt(cashFlows.manualBalanceCash), '現預金');
  const receivable = toSafe(BigInt(openSys('receivable')) + BigInt(sumOf(own.map((w) => sumBs(workMonthly.get(w.work.id).salesInc)))) - BigInt(sumOf(own.map((w) => sumBs(nums(w.receipts, '入金'))))) - BigInt(sumBs(nums(company.unallocatedReceipts, '入金'))), '売掛金');
  const committeeDeposit = toSafe(BigInt(openSys('committee_deposit')) + BigInt(sumOf(com.map((w) => sumBs(nums(w.receipts, '入金'))))), '委員会の預り金');
  const committeeRows = workBalances.filter((row) => row.kind === 'committee');
  const committeeReceivable = toSafe(BigInt(openSys('committee_receivable')) - BigInt(sumOf(committeeRows.map((row) => openingOf('committee_receivable', row.workId)))) + BigInt(sumOf(committeeRows.map((row) => row.committeeReceivable ?? 0))), '委員会からの未収');
  const investment = toSafe(BigInt(openSys('committee_investment')) - BigInt(sumOf(committeeRows.map((row) => openingOf('committee_investment', row.workId)))) + BigInt(sumOf(committeeRows.map((row) => row.investmentPaid ?? 0))), '出資金');
  const wip = toSafe(BigInt(openSys('work_in_progress')) - BigInt(sumOf(own.map((w) => openingOf('work_in_progress', w.work.id)))) + BigInt(sumOf(workBalances.filter((row) => row.kind === 'own').map((row) => row.wip))), '制作中の作品');
  const expensePayable = toSafe(BigInt(settlement.payable??0) + BigInt(openSys('expense_payable')) + BigInt(sumOf(own.map((w) => sumBs(nums(w.expenseInc, '経費'))))) - BigInt(sumOf(own.map((w) => sumBs(nums(w.expensePaid, '出金')))))
    + BigInt(sumBs(nums(company.unallocatedExpenseInc, '経費'))) - BigInt(sumBs(nums(company.unallocatedExpensePaid, '出金'))), '未払金');
  const royaltyRecoupedTotal = sumOf(own.map((w) => sumBs(nums(w.royaltyRecouped, '前払金の充当'))));
  const royaltyPayable = toSafe(BigInt(openSys('royalty_payable')) + BigInt(sumOf(own.map((w) => sumBs(workMonthly.get(w.work.id).royalty)))) - BigInt(royaltyRecoupedTotal) - BigInt(sumOf(own.map((w) => sumBs(nums(w.royaltyPaid, '支払'))))) - BigInt(sumBs(nums(company.unallocatedRoyaltyPaid, '支払'))), '未払ロイヤリティ');
  const consumptionTax = toSafe(BigInt(openSys('consumption_tax')) + BigInt(sumOf(own.map((w) => sumBs(workMonthly.get(w.work.id).salesTax)))) - BigInt(sumOf(own.map((w) => sumBs(nums(w.expenseTax, '税額'))))) - BigInt(sumBs(nums(company.unallocatedExpenseTax, '税額')))
    + BigInt(cashFlows.manualIncomeTax) - BigInt(cashFlows.manualCostTax), '未払消費税等');
  const advanceRows = workBalances.filter((row) => row.kind === 'own' && row.royaltyAdvanceYen);
  const overReceived = sumOf(workBalances.filter((row) => row.kind === 'committee' && row.committeeReceivable !== null && row.committeeReceivable < 0).map((row) => -row.committeeReceivable));
  const netIncomeBs = sumBs(netIncome);
  const retainedOpening = openSys('retained_earnings');
  const retained = toSafe(BigInt(retainedOpening) + BigInt(netIncomeBs), '繰越利益剰余金');

  const bsRows = [];
  const pushBs = (row) => bsRows.push({level: 1, emphasis: false, ...row, originLabel: ORIGIN_LABELS[row.origin]});
  const systemOpening = (key) => openSys(key);
  const sysOrigin = (unverified) => (unverified ? 'unverified' : openingUnverified ? 'unverified' : 'system');
  const bsSystem = [
    ['asset', 'cash', cash, sysOrigin(manualPlUnverified || advanceRows.length > 0), '期首残高＋請求の入金＋委員会からの受取−経費の出金−ロイヤリティの支払−出資の払込＋手入力の収益−手入力の費用（どちらも税込。現預金を動かす科目）＋手入力の残高の増減。ロイヤリティの前払金の支払は記録していない'],
    ['asset', 'receivable', receivable, sysOrigin(false), '自社作品の売上（税込・計上月）−請求の入金。請求していない売上も残る'],
    ['asset', 'committee_receivable', committeeReceivable, sysOrigin(committeeUnverified || !selfPartnerId || overReceived > 0), '委員会の自社の取得額の累計−委員会からの受取（委員会の期間報告の自社への支払）。受取が取得額を上回る作品はマイナスのまま足す（未確定）'],
    ['asset', 'work_in_progress', wip, sysOrigin(workPl.some((row) => row.reasons.some((r) => r.includes('公開月')))), '公開前の自社作品の制作費（公開月に費用にする）'],
    ['asset', 'committee_investment', investment, sysOrigin(false), '委員会への出資の払込の累計（PLに入れない）'],
    ['liability', 'expense_payable', expensePayable, sysOrigin(false), '自社作品の経費と、作品を付けない経費（作品の決まっていない案件・作品が1本も無い案件）の税込額（計上月）−出金'],
    ['liability', 'royalty_payable', royaltyPayable, sysOrigin(advanceRows.length > 0 || workPl.some((row) => row.kind === 'own' && row.reasons.some((r) => r.startsWith('ロイヤリティ')))), '自社作品のロイヤリティの発生額−前払金の充当−支払（支払は報告書の明細の作品ごとの、充当を引いた額の比で分ける）'],
    ['liability', 'consumption_tax', consumptionTax, sysOrigin(false), '自社作品の売上の税額−経費の税額＋手入力の収益の税額−手入力の費用の税額（納付は記録していない）'],
    ['liability', 'committee_deposit', committeeDeposit, sysOrigin(false), '自社が請求して受け取った委員会作品の売上（委員会へ渡すまでの預り）'],
    ['equity', 'retained_earnings', retained, sysOrigin(worksUnverified.length > 0 || manualPlUnverified), `期首残高＋期首の翌月から基準月までの当期純利益（${sumBs(netIncome).toLocaleString('ja-JP')}円）`],
  ];
  const extraLabels={expense_unready_payable:'締め日未整備分（参考の未払残高）',expense_pending_offset_assets:'相殺の反映待ち（債権の減少）',expense_prepaid:'前払金',expense_refund_receivable:'未収入金',expense_card_payable:'未払金（カード）',expense_withholding:'預り金（源泉）'};
  for(const [field,key,section] of [['unready_payable','expense_unready_payable','liability'],['pending_offset_assets','expense_pending_offset_assets','asset'],['prepaid','expense_prepaid','asset'],['refund_receivable','expense_refund_receivable','asset'],['card_payable','expense_card_payable','liability'],['withholding','expense_withholding','liability']]){
    if(input.expenseSettlement||openSys(key))bsSystem.push([section,key,openSys(key)+(settlement[field]??0),field==='unready_payable'?'unverified':sysOrigin(false),'基準月末までの事実。取消は取消日から反映']);
  }
  const totals = {asset: 0n, liability: 0n, equity: 0n};
  const openingTotals = {asset: 0n, liability: 0n, equity: 0n};
  for (const section of BS_SECTIONS) {
    for (const [s, key, value, origin, note] of bsSystem.filter((row) => row[0] === section)) {
      const account = accounts.bySystemKey.get(key)??{name:extraLabels[key],code:null};
      pushBs({key, section: s, label: account.name, accountCode: account.code, opening: systemOpening(key), value, origin, note});
      totals[s] += BigInt(value);
      openingTotals[s] += BigInt(systemOpening(key));
    }
    for (const row of manualBsRows.filter((item) => item.section === section)) {
      pushBs({...row, note: row.cashEffect ? '手入力の月末残高。前の月からの増減は現預金の増減として扱う' : '手入力の月末残高。増減は現預金を動かさない'});
      totals[section] += BigInt(row.value);
      openingTotals[section] += BigInt(row.opening);
    }
    const origin = bsRows.filter((row) => row.section === section).some((row) => row.origin === 'unverified') ? 'unverified' : 'system';
    pushBs({key: `total:${section}`, section, label: `${SECTION_LABELS[section]}の部（計）`, opening: toSafe(openingTotals[section]), value: toSafe(totals[section]), origin, emphasis: true, level: 0, subtotal: true});
  }
  const difference = toSafe(totals.asset - totals.liability - totals.equity, '説明のつかない差額');
  const openingGap = toSafe(openingTotals.asset - openingTotals.liability - openingTotals.equity, '期首の貸借差');
  const hints = [
    {key: 'openingGap', label: '期首残高の貸借差（資産−負債−純資産の期首残高）', value: openingGap},
    {key: 'nonCashPl', label: '現預金を動かさない手入力の費用−収益（減価償却費など）', value: toSafe(nonCashPl)},
    {key: 'nonCashBalance', label: '現預金を動かさない手入力の残高の増減（固定資産など）', value: toSafe(nonCashBalance)},
  ];
  const explained = sumOf(hints.map((hint) => hint.value));
  hints.push({key: 'unexplained', label: '手がかりで説明できない残り', value: difference - explained});
  pushBs({key: 'difference', section: 'difference', label: '説明のつかない差額（資産−負債−純資産）', opening: openingGap, value: difference, origin: difference === 0 ? 'system' : 'unverified', emphasis: true, level: 0,
    note: '複式の仕訳を持たない試算のため、一致を保証しません。0でないときは下の手がかりを確かめてください'});
  const reference = [
    {key:'expense_input_tax',label:'仮払消費税（経費・参考）',value:sumOf((input.expenses??[]).filter(e=>(!e.workId||!workById.get(e.workId)?.committee)&&e.month<=asOf).map(e=>e.tax)),origin:'system',note:'消費税の純額（仮受−仮払）に含めています。資産に重ねて加算しません'},
    {key: 'mg_incoming', label: '受取MGの未消化（前受金の見込み・未確定）', value: sumOf(workBalances.map((row) => row.mgIncomingUnconsumed ?? 0)), origin: 'unverified', note: 'MGの受取の記録が無いため、BSの合計に入れていません'},
    {key: 'mg_outgoing', label: '支払MGの未回収（前払金の見込み・未確定）', value: sumOf(workBalances.map((row) => row.mgOutgoingUnrecouped ?? 0)), origin: 'unverified', note: 'MGの支払の記録が無いため、BSの合計に入れていません'},
    {key: 'investment_unpaid', label: '委員会への出資の未払込（約定額−払込額）', value: sumOf(committeeRows.map((row) => row.investmentUnpaid ?? 0)), origin: 'system', note: '約定のうちまだ払っていない額。BSの合計に入れていません'},
    {key: 'committee_unpaid_expense', label: '委員会作品の経費で未払のもの', value: sumOf(committeeRows.map((row) => row.committeeUnpaidExpense ?? 0)), origin: 'system', note: '委員会の口座で払う額。自社のBSの合計に入れていません'},
    {key: 'committee_royalty_paid', label: '委員会作品のロイヤリティの支払額（委員会の口座から）', value: sumOf(committeeRows.map((row) => row.committeeRoyaltyPaid ?? 0)), origin: 'system', note: '委員会の権利処理費の支払。自社の現預金に入れていません'},
    ...(overReceived > 0 ? [{key: 'committee_over_received', label: '委員会からの受取超過（参考・未確定）', value: overReceived, origin: 'unverified', note: '受取が自社の取得額の累計を上回る作品の超過分の合計（委員会からの未収では他の作品と相殺して見えなくなる分）。BSの合計に入れていません'}] : []),
    ...(advanceRows.length ? [{key: 'royalty_advance_unrecouped', label: 'ロイヤリティの前払金の未充当残（参考・未確定）', value: sumOf(advanceRows.map((row) => row.royaltyAdvanceUnrecouped ?? 0)), origin: 'unverified', note: '前払金−充当の累計。前払金の支払の記録が無いため、BSの合計に入れていません'}] : []),
  ].map((row) => ({...row, originLabel: ORIGIN_LABELS[row.origin]}));
    if (cash < 0) companyNotes.push(`${monthLabel(asOf)}末の現預金がマイナス（${cash.toLocaleString('ja-JP')}円）です。支払（制作費・出資・経費など）に見合う入金・借入・増資・委員会からの受取が記録されていないか、期首残高が足りません。`);
    if (overReceived > 0) notes.push(`委員会からの受取が自社の取得額の累計を上回る作品があります（計 ${overReceived.toLocaleString('ja-JP')}円。作品別の残高の未確定の理由を確かめてください）。`);
    return {asOf, openingMonth, rows: bsRows, reference, hints, difference, cashFlows, receivable,
      totals: {asset: toSafe(totals.asset), liability: toSafe(totals.liability), equity: toSafe(totals.equity)}, netIncomeSinceOpening: netIncomeBs};
  }

  // ---------- 経費の費目の区分（自社作品の経費。期間に計上したもの） ----------
  // 「制作費」で始まる費目だけが公開月に一括。入力の字の違い（製作費など）で扱いが変わるので、どの費目をどの区分に数えたかを返す
  const classified = new Map();
  for (const row of input.expenses || []) {
    const w = row.workId == null ? null : perWork.get(Number(row.workId));
    if (w?.work.committee || !(row.month >= from && row.month <= to)) continue;
    const category = String(row.category ?? '').trim() || '（費目なし）';
    const kind = row.systemKey || (row.accountId?`account:${row.accountId}`:'unclassified');
    const key = `${kind}|${category}`;
    const entry = classified.get(key) || {category, kind, label: row.accountName??'費用区分未整備', origin:row.classificationOrigin, count: 0, exTax: 0n};
    entry.count += 1;
    entry.exTax += asBig(row.exTax, '経費');
    classified.set(key, entry);
  }
  const expenseClassification = [...classified.values()]
    .sort((a, b) => Object.keys(EXPENSE_CLASS_LABELS).indexOf(a.kind) - Object.keys(EXPENSE_CLASS_LABELS).indexOf(b.kind) || a.category.localeCompare(b.category, 'ja'))
    .map((entry) => ({...entry, exTax: toSafe(entry.exTax, '経費')}));

  // ---------- 照合 ----------
  // scope: company は会社PL・会社BSの照合（会社全体を見られる人だけに返す）、work は作品ごとの照合
  const checks = [];
  const check = (item, value, detail, scope = 'company') => checks.push({item, value, ok: value === 0, scope, detail: detail || (value === 0 ? '一致' : `差 ${value.toLocaleString('ja-JP')}円`)});
  const workMonthDiffs = workPl.map((row) => sumOf(row.monthly.map((m) => m.profit)) - row.period.profit);
  check('作品別PLの月別の利益の和 ＝ 期間計（作品ごと）', workMonthDiffs.find((value) => value !== 0) ?? 0, workMonthDiffs.every((value) => value === 0) ? `全${workPl.length}作品で一致` : undefined, 'work');
  const companyNetByMonth = periodMonths.map((month) => netIncome[idx(month)]);
  const worksNetByMonth = periodMonths.map((month) => sumOf([...workMonthly.values()].map((m) => m.profit[idx(month)])));
  const otherByMonth = periodMonths.map((month) => {
    const i = idx(month);
    return toSafe(-BigInt(company.unallocatedDirect.values[i]) - BigInt(company.unallocatedPromotion.values[i]) - BigInt(company.unallocatedOther.values[i]) - BigInt(companyProductionExpensed.values[i])
      + [...company.manualBy.values()].reduce((total, {account, series}) => total + (INCOME_SECTIONS.has(account.section) ? series.values[i] : -series.values[i]), 0n)
      - [...company.expenseBy?.values()??[]].reduce((total,e)=>total+e.series.values[i],0n));
  });
  const monthDiffs = companyNetByMonth.map((value, k) => value - worksNetByMonth[k] - otherByMonth[k]);
  check('会社PLの当期純利益 ＝ 作品別PLの利益の和 ＋ 作品に付かない経費・手入力（月ごと）', monthDiffs.find((value) => value !== 0) ?? 0,
    monthDiffs.every((value) => value === 0) ? `全${periodMonths.length}か月で一致` : undefined);
  check('月別の当期純利益の和 ＝ 期間計', sumOf(companyNetByMonth) - plRows.find((row) => row.key === 'netIncome').values.period);
  if (companyBs) {
    // 作品に分けられない入金と、作品を付けずに入れた期首の売掛金は会社の分
    const own = works.filter((work) => !work.committee);
    const receivableCompanyOnly = openSysOf('receivable') - sumOf(own.map((work) => openingOf('receivable', work.id))) - sumBs(nums(company.unallocatedReceipts, '入金'));
    check('作品別の売掛金の和 ＋ 会社だけの分 ＝ 会社BSの売掛金', sumOf(workBalances.map((row) => row.receivable ?? 0)) + receivableCompanyOnly - companyBs.receivable);
  }
  check('委員会作品の自社の取得額（作品別PL）＝ 会社PLの委員会作品の自社の取得額', sumOf(workPl.filter((row) => row.kind === 'committee').map((row) => row.period.acq)) - plRows.find((row) => row.key === 'committee_share').values.period);
  if (companyBs) check('手がかりで説明できない残り（差0）', companyBs.hints.at(-1).value);

  const headingNotes = [
    '計上月・税抜のPL、月末の残高のBS。複式の仕訳は持たない管理会計の試算です。税務・会計上の決算書ではありません。',
    '委員会作品は自社の取り分（委員会の月次収支の自社の取得額）だけを売上にし、委員会の経費・権利処理費は自社の費用として引きません。出資金はPLに入れずBSの資産に置きます。',
    '費用区分で公開月一括を指定した自社作品の経費は公開月に一括で費用にし、公開前は制作中の作品（資産）に置きます。',
    '手入力の費用・収益は、その月に現預金で払った・受け取ったものとして扱います（減価償却費など現預金を動かさない科目を除く）。手入力の残高（借入金・資本金など）の増減は現預金の増減として扱います。',
    '委員会の資金は委員会の口座で扱う前提です。委員会作品の経費・ロイヤリティの支払は自社の現預金に入れず（参考に示します）、自社が請求して受け取った委員会作品の売上は委員会の預り金に置きます。自社が立て替える運用のときは、立替金を手入力の残高（その他の資産）で補ってください。',
  ];
  if (!fiscal.confirmed) notes.push('年度の解釈（決算月）が未確定です。帳票センターの「年度の設定」で確かめてください。');
  if (!openingMonth) companyNotes.push('期首残高の基準月が未設定のため、期首残高を0として、最初の月からの動きだけでBSを出しています（会社の設定で基準月を入れてください）。');
  if (!selfPartnerId) notes.push('自社を表す取引先が未設定のため、委員会作品の自社の取り分を計算していません（会社の設定で選んでください）。');
  const bsUnavailableReason = bsBeforeOpening
    ? `BSの基準月（${monthLabel(asOf)}末）が期首残高の基準月（${monthLabel(openingMonth)}末）より前のため、作品別の残高と会社BSは出していません。BSの基準月を${monthLabel(openingMonth)}以後にしてください。`
    : null;
  if (bsUnavailableReason) notes.push(bsUnavailableReason);

  return {
    calculationVersion: PL_BS_VERSION, heading: PL_BS_HEADING, headingNotes, notes,
    conditions: {from, to, asOf, openingMonth, fiscalStartMonth: fiscal.fiscalStartMonth, fiscalConfirmed: fiscal.confirmed, selfPartnerId},
    months: periodMonths, firstMonth: months[0],
    workPl, workDetail: Object.fromEntries(works.map((work) => [work.id, workDetail(work.id)])),
    companyPl: {columns: plCols.map(({indices, ...col}) => col), rows: plRows, netIncome: {period: plRows.find((row) => row.key === 'netIncome').values.period,cumulative:sumIdx(netIncome,cumulativeIdx)}},
    workBalances, bsUnavailable: bsUnavailableReason,
    companyBs: companyBs
      ? (({receivable, ...rest}) => rest)(companyBs)
      : {asOf, openingMonth, unavailable: true, reason: bsUnavailableReason, rows: [], hints: [], reference: [], difference: null, totals: null, cashFlows: null, netIncomeSinceOpening: null},
    companyNotes, checks, expenseClassification,
  };
}

export function checksOk(checks = []) {
  return checks.every((row) => row.value === 0);
}
