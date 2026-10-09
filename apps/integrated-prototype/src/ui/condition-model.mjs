// 帳票の共通条件（ConditionBar が使う純関数）。年度・期間・基準・税・作品・取引先・流通・軸・MGの向き・基準月。
// 値は URL の検索パラメータに保存する（CONDITION_KEYS）。年度の開始月は組織の設定値（既定5月＝決算4月）を
// 呼び出し側が渡す。年度の呼び名は「開始月がある暦年」: 開始5月なら 2026年度 = 2026年5月〜2027年4月。
// 月は 'YYYY-MM' の文字列で扱う。

export const DEFAULT_FISCAL_START_MONTH = 5;

// 条件名 → URL のキー。作品・取引先は外枠の work（作品選択）と混ざらないよう workId・partnerId にする。
// キー名は帳票 API の問い合わせ名と同じにしてあり、conditionsToQuery でそのまま渡せる。
export const CONDITION_KEYS = Object.freeze({
  fiscalYear: 'fy',
  period: 'period',
  from: 'from',
  to: 'to',
  basis: 'basis',
  tax: 'tax',
  work: 'workId',
  partner: 'partnerId',
  distribution: 'distribution',
  axis: 'axis',
  direction: 'direction',
  month: 'month',
});

export const CONDITION_NAMES = Object.freeze(['fiscalYear', 'period', 'basis', 'tax', 'work', 'partner', 'distribution', 'axis', 'direction', 'month']);

export const PERIOD_PRESETS = Object.freeze([
  {id: 'fy', label: '年度'},
  {id: 'h1', label: '上期'},
  {id: 'h2', label: '下期'},
  {id: 'q1', label: '第1四半期'},
  {id: 'q2', label: '第2四半期'},
  {id: 'q3', label: '第3四半期'},
  {id: 'q4', label: '第4四半期'},
  {id: 'custom', label: '任意の期間'},
]);

export const BASIS_OPTIONS = Object.freeze([
  {value: 'accounting', label: '計上月'},
  {value: 'sales', label: '販売月'},
]);

export const TAX_OPTIONS = Object.freeze([
  {value: 'ex', label: '税抜'},
  {value: 'inc', label: '税込'},
]);

export const DIRECTION_OPTIONS = Object.freeze([
  {value: 'incoming', label: '受取MG（販売先）'},
  {value: 'outgoing', label: '支払MG（仕入先）'},
]);

export const AXIS_OPTIONS = Object.freeze([
  {value: 'total', label: '合計'},
  {value: 'work', label: '作品別'},
  {value: 'partner', label: '取引先別'},
  {value: 'distribution', label: '流通別'},
  {value: 'product', label: '商品別'},
  {value: 'partner-distribution', label: '取引先×流通'},
]);

export const CONDITION_LABELS = Object.freeze({
  fiscalYear: '年度', period: '期間', basis: '集計の基準', tax: '税', work: '作品', partner: '取引先',
  distribution: '流通', axis: '集計の軸', direction: 'MGの向き', month: '基準月',
});

const pad2 = (n) => String(n).padStart(2, '0');

export function normalizeStartMonth(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : DEFAULT_FISCAL_START_MONTH;
}

// 'YYYY-MM' を検査して {year, month} にする。不正なら null。
export function parseYm(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return {year, month};
}

export function isYm(value) {
  return parseYm(value) !== null;
}

export function ym(year, month) {
  return `${year}-${pad2(month)}`;
}

export function addMonths(value, n) {
  const parsed = parseYm(value);
  if (!parsed) return null;
  const index = parsed.year * 12 + (parsed.month - 1) + n;
  return ym(Math.floor(index / 12), (index % 12) + 1);
}

export function compareYm(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// from〜to（両端を含む）の月の配列。from が to より後なら空。
export function monthsBetween(from, to) {
  if (!isYm(from) || !isYm(to) || from > to) return [];
  const out = [];
  for (let current = from; current <= to; current = addMonths(current, 1)) out.push(current);
  return out;
}

// 日本時間の今月（'YYYY-MM'）。
export function currentYm(today = new Date()) {
  const jst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
  return ym(jst.getUTCFullYear(), jst.getUTCMonth() + 1);
}

// その月が属する年度（開始月がある暦年）。
export function fiscalYearOf(month, startMonth = DEFAULT_FISCAL_START_MONTH) {
  const parsed = parseYm(month);
  if (!parsed) return null;
  const start = normalizeStartMonth(startMonth);
  return parsed.month >= start ? parsed.year : parsed.year - 1;
}

export function fiscalYearRange(fiscalYear, startMonth = DEFAULT_FISCAL_START_MONTH) {
  const from = ym(Number(fiscalYear), normalizeStartMonth(startMonth));
  return {from, to: addMonths(from, 11)};
}

// 四半期（1〜4）。年度の最初の3か月が第1四半期。
export function quarterRange(fiscalYear, quarter, startMonth = DEFAULT_FISCAL_START_MONTH) {
  const {from} = fiscalYearRange(fiscalYear, startMonth);
  const start = addMonths(from, (Number(quarter) - 1) * 3);
  return {from: start, to: addMonths(start, 2)};
}

// 半期（1=上期、2=下期）。
export function halfRange(fiscalYear, half, startMonth = DEFAULT_FISCAL_START_MONTH) {
  const {from} = fiscalYearRange(fiscalYear, startMonth);
  const start = addMonths(from, (Number(half) - 1) * 6);
  return {from: start, to: addMonths(start, 5)};
}

// 期間の呼び名（プリセット）→ 月の範囲。custom は from/to をそのまま使う。
export function presetRange(period, fiscalYear, startMonth = DEFAULT_FISCAL_START_MONTH) {
  if (period === 'fy') return fiscalYearRange(fiscalYear, startMonth);
  if (/^q[1-4]$/.test(period)) return quarterRange(fiscalYear, Number(period.slice(1)), startMonth);
  if (/^h[12]$/.test(period)) return halfRange(fiscalYear, Number(period.slice(1)), startMonth);
  return null;
}

export function monthText(value) {
  const parsed = parseYm(value);
  return parsed ? `${parsed.year}年${parsed.month}月` : String(value ?? '');
}

export function rangeText(from, to) {
  if (!from || !to) return '';
  const count = monthsBetween(from, to).length;
  return from === to ? `${monthText(from)}（1か月）` : `${monthText(from)}〜${monthText(to)}（${count}か月）`;
}

// 「2026年度（2026年5月〜2027年4月）」
export function fiscalYearLabel(fiscalYear, startMonth = DEFAULT_FISCAL_START_MONTH) {
  const {from, to} = fiscalYearRange(fiscalYear, startMonth);
  return `${fiscalYear}年度（${monthText(from)}〜${monthText(to)}）`;
}

// 「年度: 5月〜翌4月（決算4月・解釈は未確認）」
export function fiscalRuleText(startMonth = DEFAULT_FISCAL_START_MONTH, {confirmed = false} = {}) {
  const start = normalizeStartMonth(startMonth);
  const end = start === 1 ? 12 : start - 1;
  const span = start === 1 ? '1月〜12月' : `${start}月〜翌${end}月`;
  return `年度: ${span}（決算${end}月${confirmed ? '' : '・解釈は未確認'}）`;
}

// 年度の選択肢。当年度の翌年度から count 年度さかのぼる（新しい順）。extra（URL の値など）も必ず含める。
export function fiscalYearOptions(currentFiscalYear, {count = 10, extra = []} = {}) {
  const years = new Set();
  for (let n = 0; n < count; n += 1) years.add(currentFiscalYear + 1 - n);
  for (const year of extra) if (Number.isInteger(Number(year)) && String(year) !== '') years.add(Number(year));
  return [...years].sort((a, b) => b - a).map((year) => ({value: String(year), label: `${year}年度`}));
}

// 組織の年度設定（GET /api/settings/fiscal の本体）から開始月と確認状態を取り出す。形が違えば既定。
export function fiscalSettingFrom(body) {
  const source = body?.setting ?? body?.fiscal ?? body ?? {};
  const raw = source.fiscalStartMonth ?? source.fiscal_start_month ?? source.startMonth ?? source.start_month;
  const valid = Number.isInteger(Number(raw)) && Number(raw) >= 1 && Number(raw) <= 12;
  const confirmedRaw = source.confirmed ?? source.isConfirmed;
  return {
    fiscalStartMonth: valid ? Number(raw) : DEFAULT_FISCAL_START_MONTH,
    confirmed: valid && (confirmedRaw === true || confirmedRaw === 1 || confirmedRaw === '1'),
    fromServer: valid,
  };
}

function optionValue(options, value, fallback) {
  const list = (options || []).map((option) => String(option.value ?? option.code ?? option.id));
  if (value !== null && value !== undefined && list.includes(String(value))) return String(value);
  return fallback;
}

const blank = (value) => value === null || value === undefined || value === '';

function idValue(value) {
  if (blank(value)) return null;
  const text = String(value).trim();
  return /^\d+$/.test(text) ? text : null;
}

// URL の値（getParam）から、使う条件の正規化済みの値を作る。不正な値は既定に戻し、理由を errors に入れる。
// options: fiscalStartMonth, today, defaults（条件名→既定値）, axisOptions, monthOptions, distributionOptions
export function readConditions(getParam, conditions = [], options = {}) {
  const read = typeof getParam === 'function' ? (key) => getParam(key, null) : (key) => getParam?.[key] ?? null;
  const want = new Set(conditions);
  const startMonth = normalizeStartMonth(options.fiscalStartMonth);
  const defaults = options.defaults || {};
  const nowMonth = currentYm(options.today);
  const errors = [];
  const values = {fiscalStartMonth: startMonth};

  if (want.has('fiscalYear') || want.has('period')) {
    const currentFy = fiscalYearOf(nowMonth, startMonth);
    const rawFy = read(CONDITION_KEYS.fiscalYear);
    const fy = /^\d{4}$/.test(String(rawFy ?? '')) ? Number(rawFy) : Number(defaults.fiscalYear ?? currentFy);
    if (!blank(rawFy) && !/^\d{4}$/.test(String(rawFy))) errors.push('年度の指定を読み取れないため、当年度を表示しています');
    values.fiscalYear = fy;
    values.currentFiscalYear = currentFy;
    let period = want.has('period') ? read(CONDITION_KEYS.period) : 'fy';
    if (!PERIOD_PRESETS.some((preset) => preset.id === period)) {
      if (!blank(period)) errors.push('期間の指定を読み取れないため、年度全体を表示しています');
      period = want.has('period') && defaults.period ? defaults.period : 'fy';
    }
    values.period = period;
    if (period === 'custom') {
      const fyRange = fiscalYearRange(fy, startMonth);
      const rawFrom = read(CONDITION_KEYS.from);
      const rawTo = read(CONDITION_KEYS.to);
      const from = isYm(rawFrom) ? rawFrom : fyRange.from;
      const to = isYm(rawTo) ? rawTo : fyRange.to;
      if ((!blank(rawFrom) && !isYm(rawFrom)) || (!blank(rawTo) && !isYm(rawTo))) errors.push('期間の月を読み取れません。「2026-09」の形で指定してください');
      values.from = from;
      values.to = to;
      if (from > to) errors.push('期間の開始月が終了月より後になっています');
    } else {
      Object.assign(values, presetRange(period, fy, startMonth));
    }
    values.months = monthsBetween(values.from, values.to);
    values.periodLabel = period === 'fy' ? fiscalYearLabel(fy, startMonth) : period === 'custom'
      ? rangeText(values.from, values.to)
      : `${fy}年度 ${PERIOD_PRESETS.find((preset) => preset.id === period).label}（${monthText(values.from)}〜${monthText(values.to)}）`;
  }
  if (want.has('basis')) values.basis = optionValue(BASIS_OPTIONS, read(CONDITION_KEYS.basis), defaults.basis ?? 'accounting');
  if (want.has('tax')) values.tax = optionValue(TAX_OPTIONS, read(CONDITION_KEYS.tax), defaults.tax ?? 'ex');
  if (want.has('direction')) values.direction = optionValue(DIRECTION_OPTIONS, read(CONDITION_KEYS.direction), defaults.direction ?? 'incoming');
  if (want.has('axis')) {
    const axisOptions = options.axisOptions || AXIS_OPTIONS;
    values.axis = optionValue(axisOptions, read(CONDITION_KEYS.axis), defaults.axis ?? String(axisOptions[0]?.value ?? 'total'));
  }
  if (want.has('work')) values.workId = idValue(read(CONDITION_KEYS.work)) ?? idValue(defaults.work);
  if (want.has('partner')) values.partnerId = idValue(read(CONDITION_KEYS.partner)) ?? idValue(defaults.partner);
  if (want.has('distribution')) {
    const raw = read(CONDITION_KEYS.distribution);
    const list = options.distributionOptions;
    values.distribution = blank(raw) ? (defaults.distribution ?? null)
      : Array.isArray(list) && list.length ? optionValue(list, raw, defaults.distribution ?? null) : String(raw);
  }
  if (want.has('month')) {
    const raw = read(CONDITION_KEYS.month);
    const list = options.monthOptions;
    const fallback = defaults.month ?? (Array.isArray(list) && list.length ? String(list[0].value) : nowMonth);
    if (!blank(raw) && !isYm(raw)) errors.push('基準月を読み取れないため、既定の月を表示しています');
    values.month = isYm(raw) ? raw : fallback;
  }
  values.errors = errors;
  values.valid = !errors.some((message) => /開始月が終了月より後/.test(message));
  return values;
}

// 条件の変更 → URL に書く [key, value] の組（null は削除）。
export function paramUpdates(name, value, current = {}, {fiscalStartMonth} = {}) {
  const K = CONDITION_KEYS;
  switch (name) {
    case 'fiscalYear': return [[K.fiscalYear, blank(value) ? null : String(value)]];
    case 'period': {
      if (value === 'custom') {
        // 任意の期間へ切り替えたときは、いま見ている範囲を初期値にする
        const range = current.from && current.to ? {from: current.from, to: current.to} : fiscalYearRange(current.fiscalYear, fiscalStartMonth);
        return [[K.period, 'custom'], [K.from, range.from], [K.to, range.to]];
      }
      return [[K.period, blank(value) || value === 'fy' ? null : value], [K.from, null], [K.to, null]];
    }
    case 'from': return [[K.from, blank(value) ? null : value]];
    case 'to': return [[K.to, blank(value) ? null : value]];
    case 'work': return [[K.work, blank(value) ? null : String(value)]];
    case 'partner': return [[K.partner, blank(value) ? null : String(value)]];
    default: {
      const key = K[name];
      return key ? [[key, blank(value) ? null : String(value)]] : [];
    }
  }
}

// 帳票 API へ渡す問い合わせ文字列（先頭の ? なし）。条件に無い値・空の値は含めない。
export function conditionsToQuery(values, conditions = CONDITION_NAMES) {
  const params = new URLSearchParams();
  const want = new Set(conditions);
  if ((want.has('fiscalYear') || want.has('period')) && values.from && values.to) {
    params.set('from', values.from);
    params.set('to', values.to);
  }
  const pairs = [['basis', 'basis', values.basis], ['tax', 'tax', values.tax], ['axis', 'axis', values.axis],
    ['direction', 'direction', values.direction], ['month', 'month', values.month], ['work', 'workId', values.workId],
    ['partner', 'partnerId', values.partnerId], ['distribution', 'distribution', values.distribution]];
  for (const [name, key, value] of pairs) if (want.has(name) && !blank(value)) params.set(key, String(value));
  return params.toString();
}

// Excel の「条件」行などに使う [[見出し, 値]]。names: {work: id→表示名, partner: id→表示名, distribution: code→表示名}
export function describeConditions(values, conditions = CONDITION_NAMES, {names = {}, axisOptions = AXIS_OPTIONS} = {}) {
  const want = new Set(conditions);
  const rows = [];
  const labelFrom = (options, value) => options.find((option) => String(option.value) === String(value))?.label ?? String(value ?? '');
  // names の各項目は「ID→表示名」の関数でも、{ID: 表示名} のオブジェクトでもよい
  const nameOf = (source, id) => (typeof source === 'function' ? source(id) : source?.[String(id)]);
  if (want.has('fiscalYear') || want.has('period')) rows.push(['期間', values.periodLabel || rangeText(values.from, values.to)]);
  if (want.has('basis')) rows.push([CONDITION_LABELS.basis, labelFrom(BASIS_OPTIONS, values.basis)]);
  if (want.has('tax')) rows.push([CONDITION_LABELS.tax, labelFrom(TAX_OPTIONS, values.tax)]);
  if (want.has('axis')) rows.push([CONDITION_LABELS.axis, labelFrom(axisOptions, values.axis)]);
  if (want.has('direction')) rows.push([CONDITION_LABELS.direction, labelFrom(DIRECTION_OPTIONS, values.direction)]);
  if (want.has('month')) rows.push([CONDITION_LABELS.month, monthText(values.month)]);
  if (want.has('work')) rows.push([CONDITION_LABELS.work, values.workId ? (nameOf(names.work, values.workId) ?? values.workId) : 'すべての作品（閲覧権限内）']);
  if (want.has('partner')) rows.push([CONDITION_LABELS.partner, values.partnerId ? (nameOf(names.partner, values.partnerId) ?? values.partnerId) : 'すべての取引先']);
  if (want.has('distribution')) rows.push([CONDITION_LABELS.distribution, values.distribution ? (nameOf(names.distribution, values.distribution) ?? values.distribution) : 'すべての流通']);
  return rows;
}
