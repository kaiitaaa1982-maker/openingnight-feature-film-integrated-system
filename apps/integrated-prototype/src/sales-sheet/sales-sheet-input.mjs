// 売上集計シートの入力の読み取り（純関数）: 拡張属性の値・外貨・ロイヤリティ計上の基準・列の定義・シート定義・一覧の条件。
// 返り値は {value} か {error}（利用者に見せる日本語の文）。
import {COLUMN_KEY, SOURCE_REFS, VALUE_TYPES, AGGREGATIONS, GROUPS, formulaProblem, formulaColumns, COLUMN_SETS, ALL_SET, ADDITIONAL_COLUMN_SETS, ADDITIONAL_SHEET_COLUMNS} from './column-registry.mjs';
import {DIMENSIONS, MONTH_BASES, TAX_BASES, GRAINS, MAX_DIMENSIONS} from './sales-sheet-model.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const validDate = (text) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
};
const half = (value) => String(value ?? '').normalize('NFKC').trim();
const numberText = (value) => half(value).replace(/[,，¥￥\s]/g, '').replace(/[−－]/g, '-');

// 拡張属性の値（画面・取込の文字）→ {value: {t, n}} 。空欄は {value: {t:null, n:null}}（値を消す）
export function parseAttributeValue(column, raw) {
  const text = typeof raw === 'boolean' ? (raw ? '1' : '0') : raw === null || raw === undefined ? '' : String(raw);
  if (!half(text)) return {value: {t: null, n: null}};
  const label = column.label;
  switch (column.value_type) {
    case 'yen': case 'integer': {
      const t = numberText(text);
      if (!/^-?\d+$/.test(t) || !Number.isSafeInteger(Number(t))) return {error: `${label}は整数で入れてください（値: ${text}）`};
      return {value: {t: null, n: Number(t)}};
    }
    case 'decimal': case 'rate_pct': {
      const t = numberText(text).replace(/%$/, '');
      if (!/^-?\d+(\.\d{1,6})?$/.test(t)) return {error: `${label}は数（小数6桁まで）で入れてください（値: ${text}）`};
      const n = Number(t);
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) return {error: `${label}の値が大きすぎます`};
      return {value: {t: null, n}};
    }
    case 'bool': {
      const t = half(text).toLowerCase();
      if (['1', 'true', 'はい', 'yes', 'y', '○', '◯', 'あり'].includes(t)) return {value: {t: null, n: 1}};
      if (['0', 'false', 'いいえ', 'no', 'n', '×', 'なし'].includes(t)) return {value: {t: null, n: 0}};
      return {error: `${label}は「はい」か「いいえ」で入れてください（値: ${text}）`};
    }
    case 'date': {
      const t = half(text).replaceAll('/', '-').replace(/^(\d{4})-(\d)-/, '$1-0$2-').replace(/-(\d)$/, '-0$1');
      if (!validDate(t)) return {error: `${label}は日付（2026-09-25）で入れてください（値: ${text}）`};
      return {value: {t, n: null}};
    }
    case 'month': {
      const t = half(text).replaceAll('/', '-').replace(/^(\d{4})-(\d)$/, '$1-0$2');
      if (!MONTH.test(t)) return {error: `${label}は年月（2026-09）で入れてください（値: ${text}）`};
      return {value: {t, n: null}};
    }
    default: {
      const t = String(text).trim();
      if (t.length > 500) return {error: `${label}は500文字までです`};
      return {value: {t, n: null}};
    }
  }
}
export const sameAttribute = (a, b) => (a?.t ?? null) === (b?.t ?? null) && (a?.n === null || a?.n === undefined ? null : Number(a.n)) === (b?.n === null || b?.n === undefined ? null : Number(b.n));

// 小数の文字 → 整数の倍（×10^digits）。桁が多い・形が違うときは null
export function scaledInteger(value, digits) {
  const t = numberText(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t);
  if (!match || (match[3] || '').length > digits) return null;
  const n = Number(`${match[1]}${match[2]}${(match[3] || '').padEnd(digits, '0')}`);
  return Number.isSafeInteger(n) ? n : null;
}

// 外貨の入力
export function normalizeCurrencyInput(input, sale) {
  const code = half(input?.currencyCode).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return {error: '通貨は3文字の通貨コード（USD・EUR・JPY など）で入れてください'};
  const rateDate = half(input?.rateDate).replaceAll('/', '-');
  if (!validDate(rateDate)) return {error: 'レートの適用日を日付（2026-09-25）で入れてください'};
  const basis = half(input?.basis);
  if (!basis || basis.length > 500) return {error: 'レートの根拠（出典）を500文字まで入れてください'};
  if (code === 'JPY') return {value: {currency_code: 'JPY', original_amount_x100: null, original_royalty_x100: null, exchange_rate_x10000: 10000, rate_date: rateDate, basis}};
  const amount = scaledInteger(input?.originalAmount, 2);
  if (amount === null) return {error: '外貨の計上額（税抜）を小数2桁までの数で入れてください'};
  const royaltyText = half(input?.originalRoyaltyAmount);
  const royalty = royaltyText ? scaledInteger(royaltyText, 2) : null;
  if (royaltyText && royalty === null) return {error: '外貨のロイヤリティ計上額を小数2桁までの数で入れてください'};
  const rate = scaledInteger(input?.exchangeRate, 4);
  if (rate === null || rate <= 0) return {error: '為替レート（1外貨あたりの円）を小数4桁までの正の数で入れてください'};
  if (sale) {
    const yen = Math.round(Math.abs(amount) * rate / 1_000_000) * Math.sign(amount);
    if (Math.abs(yen - sale.amount_ex_tax) > 1 + Math.abs(sale.amount_ex_tax) / 1e9) {
      return {error: `外貨の計上額×為替レート（${yen.toLocaleString('ja-JP')}円）が、計上額（税抜）${Number(sale.amount_ex_tax).toLocaleString('ja-JP')}円と合いません`};
    }
  }
  return {value: {currency_code: code, original_amount_x100: amount, original_royalty_x100: royalty, exchange_rate_x10000: rate, rate_date: rateDate, basis}};
}

// ロイヤリティ計上の基準の入力
export function normalizeRoyaltyInput(input) {
  const month = half(input?.royaltyMonth).replaceAll('/', '-');
  if (!MONTH.test(month)) return {error: 'ロイヤリティ計上月を年月（2026-09）で入れてください'};
  const ints = {};
  for (const [key, label] of [['amountExTax', 'ロイヤリティ計上額（税抜）'], ['taxAmount', '消費税額']]) {
    const t = numberText(input?.[key]);
    if (!/^-?\d+$/.test(t) || !Number.isSafeInteger(Number(t))) return {error: `${label}を整数で入れてください`};
    ints[key] = Number(t);
  }
  const inc = ints.amountExTax + ints.taxAmount;
  if (half(input?.amountIncTax) && Number(numberText(input.amountIncTax)) !== inc) return {error: 'ロイヤリティ計上額（税込）は 税抜＋消費税額 にしてください'};
  return {value: {royalty_month: month, royalty_amount_ex_tax: ints.amountExTax, royalty_tax_amount: ints.taxAmount, royalty_amount_inc_tax: inc}};
}

// 集計の決まりと型の組み合わせ（表の CHECK と同じ）
export function aggregationProblem(valueType, aggregation) {
  if (!Object.hasOwn(AGGREGATIONS, aggregation)) return '集計の決まりを選んでください';
  if (aggregation === 'ratio' && !['decimal', 'rate_pct', 'yen', 'integer'].includes(valueType)) return '比率の再計算は数の列だけです';
  if (['sum', 'period_end'].includes(aggregation) && !['yen', 'integer', 'decimal'].includes(valueType)) return '合計・期末の値は 金額・整数・小数 の列だけです';
  if (aggregation === 'min_max' && !['date', 'month', 'text', 'integer'].includes(valueType)) return '最小〜最大は 日付・年月・文字・整数 の列だけです';
  return null;
}

// 列の定義（新しい列、または版）。index: 今のカタログ。current があれば版（型・取り方は変えない）
export function normalizeColumnDefinition(input, index, current = null) {
  const key = current ? current.column_key : half(input?.columnKey);
  if (!COLUMN_KEY.test(key)) return {error: '列キーは英小文字で始まる 英小文字・数字・_ の48文字までです'};
  if (!current && index.has(key)) return {error: `列キー ${key} は使われています`};
  const label = half(input?.label ?? current?.label);
  if (!label || label.length > 60) return {error: '見出しを60文字まで入れてください'};
  const activeFlag = input?.active === undefined ? (current ? Boolean(current.active) : true) : Boolean(input.active);
  if (activeFlag) {
    const clash = [...index.values()].find((column) => column.active && column.column_key !== key && column.label === label);
    if (clash) return {error: `見出し「${label}」はほかの列（${clash.column_key}）で使っています。Excel の見出しが重なるので別の名前にしてください`};
  }
  const groupKey = half(input?.groupKey ?? current?.group_key) || 'custom';
  if (!Object.hasOwn(GROUPS, groupKey)) return {error: '列のまとまりを選んでください'};
  const valueType = current ? current.value_type : half(input?.valueType);
  if (!Object.hasOwn(VALUE_TYPES, valueType)) return {error: '値の型を選んでください'};
  const sourceKind = current ? current.source_kind : half(input?.sourceKind) || 'attribute';
  if (!current && !['attribute', 'derived'].includes(sourceKind)) return {error: '足せる列は 拡張属性 か 計算・結合 の列です（登録済みの表の列は初期の83列だけ）'};
  const aggregation = half(input?.aggregation ?? current?.aggregation);
  const aggProblem = aggregationProblem(valueType, aggregation);
  if (aggProblem) return {error: aggProblem};
  let sourceRef = current ? current.source_ref : null;
  let formula = current?.formula ?? null;
  if (sourceKind === 'derived') {
    if (!current) {
      sourceRef = half(input?.sourceRef) || null;
      formula = input?.formula ? (typeof input.formula === 'string' ? safeJson(input.formula) : input.formula) : null;
      if ((sourceRef === null) === (formula === null)) return {error: '計算・結合の列は 許可リストのキー か 式 のどちらか一方を指定します'};
    } else if (Object.hasOwn(input || {}, 'formula') && current.formula) {
      formula = typeof input.formula === 'string' ? safeJson(input.formula) : input.formula;
    }
    if (sourceRef !== null && !Object.hasOwn(SOURCE_REFS, sourceRef)) return {error: `許可リストに無い取り方です: ${sourceRef}`};
    if (formula !== null) {
      const known = new Set([...index.keys()].filter((k) => k !== key));
      const problem = formulaProblem(formula, known);
      if (problem) return {error: problem};
      if (formulaColumns(formula).has(key)) return {error: '式が自分の列を参照しています'};
      if (!['decimal', 'yen', 'integer', 'rate_pct'].includes(valueType)) return {error: '式の列は数の型にしてください'};
    }
  }
  const additional = ADDITIONAL_SHEET_COLUMNS.find((c) => c.source_ref === sourceRef);
  if (additional && aggregation !== additional.aggregation) return {error: '追加の列は合算できません。日付は範囲、それ以外は種類を表示します'};
  let numeratorKey = null, denominatorKey = null, ratioScale = null;
  if (aggregation === 'ratio') {
    numeratorKey = half(input?.numeratorKey ?? current?.numerator_key);
    denominatorKey = half(input?.denominatorKey ?? current?.denominator_key);
    ratioScale = Number(input?.ratioScale ?? current?.ratio_scale ?? (valueType === 'rate_pct' ? 100 : 1));
    for (const [k, name] of [[numeratorKey, '分子'], [denominatorKey, '分母']]) {
      if (!k || !index.has(k) || k === key) return {error: `比率の${name}の列を選んでください（ほかの数の列）`};
      if (!['yen', 'integer', 'decimal', 'rate_pct'].includes(index.get(k).value_type)) return {error: `比率の${name}は数の列にしてください`};
    }
    if (![1, 100].includes(ratioScale)) return {error: '比率の倍率は 1 か 100（%）です'};
  }
  const digitsRaw = input?.digits ?? current?.digits;
  const digits = digitsRaw === null || digitsRaw === undefined || digitsRaw === '' ? null : Number(digitsRaw);
  if (digits !== null && (!Number.isInteger(digits) || digits < 0 || digits > 6)) return {error: '表示の小数の桁は0〜6です'};
  const description = half(input?.description ?? current?.description) || null;
  if (description && description.length > 500) return {error: '説明は500文字までです'};
  const sortOrder = Number(input?.sortOrder ?? current?.sort_order ?? 10000);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) return {error: '並び順は0〜100000の整数です'};
  return {value: {
    column_key: key, label, legacy_position: current?.legacy_position ?? null, group_key: groupKey, value_type: valueType, aggregation,
    numerator_key: numeratorKey, denominator_key: denominatorKey, ratio_scale: ratioScale, digits, source_kind: sourceKind,
    source_ref: sourceKind === 'attribute' ? null : sourceRef, formula_json: sourceKind === 'derived' && formula ? JSON.stringify(formula) : null,
    description, sort_order: sortOrder, active: activeFlag ? 1 : 0,
  }};
}
function safeJson(text) { try { return JSON.parse(text); } catch { return {invalid: true}; } }

// 一覧・出力の条件（URL の問い合わせ）。index があれば列も確かめる
export const BILLING_FILTERS = Object.freeze({unbilled: '未請求のみ', billed: '請求済のみ'});
// 取引区分（流通分類の精算方式。記録が無い売上は未確認）。ui/labels.mjs の dealType と同じ
export const DEAL_TYPES = Object.freeze({unverified: '未確認', royalty: 'ロイヤリティ', MG: 'MG', FLAT: 'FLAT（定額）', other: 'その他'});

export function normalizeSheetQuery(query, index = null) {
  const q = (key) => half(query?.[key]);
  const out = {};
  for (const key of ['from', 'to']) {
    const v = q(key);
    if (v && !MONTH.test(v)) return {error: '期間は「2026-05」の形で指定してください'};
    out[key] = v || null;
  }
  out.monthBasis = q('month') || 'accounting';
  if (!Object.hasOwn(MONTH_BASES, out.monthBasis)) return {error: '月の基準は 計上月・販売月・ロイヤリティ計上月 のどれかです'};
  out.taxBasis = q('tax') || 'ex';
  if (!Object.hasOwn(TAX_BASES, out.taxBasis)) return {error: '税抜か税込を選んでください'};
  out.grain = q('grain') || 'detail';
  if (!Object.hasOwn(GRAINS, out.grain)) return {error: '明細か集計を選んでください'};
  for (const key of ['workId', 'partnerId']) {
    const v = q(key);
    if (v && !/^\d+$/.test(v)) return {error: '作品・取引先の指定が正しくありません'};
    out[key] = v ? Number(v) : null;
  }
  out.kind = q('kind') || null;
  if (out.kind && !['theatrical', 'digital', 'package', 'broadcast', 'other'].includes(out.kind)) return {error: '報告の種類が正しくありません'};
  out.distribution = q('distribution') || null;
  if (out.distribution && !/^[A-Za-z0-9_]{1,40}$/.test(out.distribution)) return {error: '流通IDの指定が正しくありません'};
  out.q = q('q').slice(0, 100) || null;
  // 売上明細の条件（請求・商品・取引区分）。売上明細の列セットで見るときも同じように絞る
  out.billing = q('billing') || null;
  if (out.billing && !Object.hasOwn(BILLING_FILTERS, out.billing)) return {error: '請求の絞り込みは 未請求のみ・請求済のみ のどちらかです'};
  out.productId = q('productId') || null;
  if (out.productId && out.productId !== 'none' && !/^\d+$/.test(out.productId)) return {error: '商品の指定が正しくありません'};
  out.deal = q('deal') || null;
  if (out.deal && !Object.hasOwn(DEAL_TYPES, out.deal)) return {error: `取引区分は ${Object.values(DEAL_TYPES).join('・')} のどれかです`};
  out.set = q('set') || 'basic';
  if (out.set !== ALL_SET && out.set !== 'custom' && ![...COLUMN_SETS, ...ADDITIONAL_COLUMN_SETS].some((set) => set.key === out.set)) return {error: '列セットが正しくありません'};
  out.columns = q('columns') ? q('columns').split(',').map((key) => key.trim()).filter(Boolean) : [];
  if (out.columns.length > 200) return {error: '列は200列までです'};
  if (index) {
    const unknown = out.columns.filter((key) => !index.has(key));
    if (unknown.length) return {error: `知らない列です: ${unknown.slice(0, 5).join('、')}`};
  }
  out.dimensions = q('dims') ? q('dims').split(',').map((key) => key.trim()).filter(Boolean) : [];
  if (out.dimensions.length > MAX_DIMENSIONS || out.dimensions.some((dim) => !Object.hasOwn(DIMENSIONS, dim)) || new Set(out.dimensions).size !== out.dimensions.length) {
    return {error: `集計の切り口は ${Object.values(DIMENSIONS).map((d) => d.label).join('・')} から${MAX_DIMENSIONS}つまでです`};
  }
  if (out.grain === 'detail') out.dimensions = [];
  out.pivot = out.grain === 'aggregate' && ['1', 'true'].includes(q('pivot'));
  out.hideEmpty = !['0', 'false'].includes(q('hideEmpty'));
  const page = q('page') ? Number(q('page')) : 1;
  const pageSize = q('pageSize') ? Number(q('pageSize')) : 100;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 10 || pageSize > 500) return {error: 'ページの指定が正しくありません（1ページ10〜500行）'};
  out.page = page;
  out.pageSize = pageSize;
  if (out.from && out.to && out.from > out.to) return {error: '期間の始まりが終わりより後です'};
  return {value: out};
}

// シート定義（保存する形）
export function normalizeViewDefinition(input, index) {
  const columns = Array.isArray(input?.columns) ? input.columns.map((key) => half(key)).filter(Boolean) : [];
  if (!columns.length || columns.length > 200) return {error: '保存する列を1〜200列選んでください'};
  const unknown = columns.filter((key) => !index.has(key));
  if (unknown.length) return {error: `知らない列です: ${unknown.slice(0, 5).join('、')}`};
  if (new Set(columns).size !== columns.length) return {error: '同じ列が2回入っています'};
  const grain = half(input?.grain) || 'detail';
  if (!Object.hasOwn(GRAINS, grain)) return {error: '明細か集計を選んでください'};
  const dimensions = grain === 'aggregate' && Array.isArray(input?.dimensions) ? input.dimensions.map((d) => half(d)).filter(Boolean) : [];
  if (dimensions.length > MAX_DIMENSIONS || dimensions.some((d) => !Object.hasOwn(DIMENSIONS, d)) || new Set(dimensions).size !== dimensions.length) return {error: `集計の切り口は${MAX_DIMENSIONS}つまでです`};
  const monthBasis = half(input?.monthBasis) || 'accounting';
  if (!Object.hasOwn(MONTH_BASES, monthBasis)) return {error: '月の基準を選んでください'};
  const taxBasis = half(input?.taxBasis) || 'ex';
  if (!Object.hasOwn(TAX_BASES, taxBasis)) return {error: '税抜か税込を選んでください'};
  const filters = {};
  const f = input?.filters && typeof input.filters === 'object' ? input.filters : {};
  for (const key of ['from', 'to']) if (f[key]) { if (!MONTH.test(half(f[key]))) return {error: '保存する期間は「2026-05」の形です'}; filters[key] = half(f[key]); }
  for (const key of ['workId', 'partnerId']) if (f[key]) { if (!/^\d+$/.test(half(f[key]))) return {error: '作品・取引先の指定が正しくありません'}; filters[key] = Number(f[key]); }
  if (f.kind) { if (!['theatrical', 'digital', 'package', 'broadcast', 'other'].includes(half(f.kind))) return {error: '報告の種類が正しくありません'}; filters.kind = half(f.kind); }
  if (f.distribution) { if (!/^[A-Za-z0-9_]{1,40}$/.test(half(f.distribution))) return {error: '流通IDが正しくありません'}; filters.distribution = half(f.distribution); }
  if (f.q) filters.q = half(f.q).slice(0, 100);
  return {value: {columns, grain, dimensions, monthBasis, taxBasis, pivot: grain === 'aggregate' && Boolean(input?.pivot), hideEmpty: input?.hideEmpty !== false, filters}};
}
