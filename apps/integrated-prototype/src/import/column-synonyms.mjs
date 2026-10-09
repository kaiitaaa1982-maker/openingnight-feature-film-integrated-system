// 共通売上の列と、取引先の報告でよく使われる見出しの対応候補。純関数。
// 入れるのは一般的な業務の語だけ（取引先固有の列名・様式は入れない）。候補は「提案」で、決めるのは人。
import {attributeImportTargets} from '../sales-sheet/column-registry.mjs';

// 共通売上の列（取込ウィザードで対応づける列）。format は元の列をそのまま使えるかの確認に使う。
export const CORE_SALES_TARGETS = Object.freeze([
  {key: 'report_key', label: '報告番号', required: true, format: 'text'},
  {key: 'product_id', label: '商品', format: 'id'},
  {key: 'period_from', label: '対象期間の初日', required: true, format: 'date'},
  {key: 'period_to', label: '対象期間の末日', required: true, format: 'date'},
  {key: 'sales_period_from', label: '販売期間の初日', format: 'date'},
  {key: 'sales_period_to', label: '販売期間の末日', format: 'date'},
  {key: 'accounting_month', label: '計上月', format: 'month'},
  {key: 'sales_month', label: '販売月', format: 'month'},
  {key: 'report_received_on', label: '報告受領日', format: 'date'},
  {key: 'contract_start_on', label: '契約開始日', format: 'date'},
  {key: 'license_start_on', label: '利用開始日', format: 'date'},
  {key: 'broadcast_on', label: '放送日', format: 'date'},
  {key: 'description', label: '明細名', format: 'text'},
  {key: 'quantity', label: '数量', format: 'integer'},
  {key: 'amount_ex_tax', label: '税抜', required: true, format: 'yen'},
  {key: 'tax_amount', label: '税額', required: true, format: 'yen'},
  {key: 'amount_inc_tax', label: '税込', required: true, format: 'yen'},
]);

// 売上集計シート（83列）の拡張属性の列。列カタログ（初期の列）から作る。変換先の名前は attr_<列キー>。
// 取込で値を入れると、売上明細と同じ登録で拡張属性の版1になる（src/sales-sheet/import-attributes.mjs）
const ATTRIBUTE_FORMATS = Object.freeze({yen: 'yen', integer: 'integer', decimal: 'decimal', rate_pct: 'decimal', date: 'date', month: 'month', text: 'text', bool: 'text'});
export const ATTRIBUTE_SALES_TARGETS = Object.freeze(attributeImportTargets().map((target) => Object.freeze({
  key: target.key, label: `${target.label}（売上集計シート）`, format: ATTRIBUTE_FORMATS[target.valueType] || 'text', attribute: true, columnKey: target.columnKey, group: target.group,
})));
export const SALES_TARGETS = Object.freeze([...CORE_SALES_TARGETS, ...ATTRIBUTE_SALES_TARGETS]);

export const TARGET_LABELS = Object.freeze(Object.fromEntries([
  ...SALES_TARGETS.map((target) => [target.key, target.label]),
  ['partner_id', '取引先'], ['recognition_basis_id', '計上基準'], ['basis_reason', '計上の根拠'], ['supersedes_id', '訂正元の報告'],
]));

export function targetLabel(key) {
  return TARGET_LABELS[key] || '未登録の列';
}

// 見出しの表記ゆれを吸収する（全角半角・大小・空白・括弧や記号）。
export function normalizeHeader(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s()（）\[\]［］【】「」『』<>＜＞・/／_\-－―:：.,，、。'"`]/g, '');
}

// exact: 正規化して完全一致、contains: 含む、exclude: 含むと除外、prefer: 含むと少し優先。
const RULES = Object.freeze({
  report_key: {exact: ['報告番号', '報告書番号', '報告no', '報告id', '報告書id', 'レポート番号', 'レポートid', '精算書番号', '明細書番号', 'reportid', 'reportno', 'reportkey', 'reportnumber'], contains: ['報告番号', '報告書番号', '精算書番号'], exclude: ['日', '月']},
  description: {exact: ['摘要', '内容', '明細', '明細名', '品名', '商品名', '作品名', 'タイトル', '題名', '項目', '商材', 'description', 'item', 'title'], contains: ['摘要', '明細名', '品名', '商材', 'タイトル', '区分'], exclude: ['コード', 'cd', 'id', '番号', '金額', '数']},
  quantity: {exact: ['数量', '件数', '枚数', '本数', '回数', '視聴数', '販売数', '販売件数', '契約数', 'qty', 'quantity', 'units'], contains: ['数量', '件数', '枚数', '本数', '視聴数', '契約数', '販売数', '回数'], exclude: ['単価', '金額', '額', '率', '返品', '率'], prefer: ['正味', '純', '実', 'net']},
  amount_ex_tax: {exact: ['税抜', '税抜金額', '税抜額', '税抜売上', '売上金額', '売上額', '売上', '金額', '正味売上', '正味額', '純売上', '純額', 'netsales', 'netamount', 'amountextax', 'amount'], contains: ['税抜', '売上', '金額', '正味額', '純額', '精算額', '支払額'], exclude: ['単価', '税込', '税額', '消費税', '手数料', '率', '数量', '件数', '総額', '予算', '前年', 'gross'], prefer: ['正味', '純', '税抜', 'net']},
  tax_amount: {exact: ['税額', '消費税', '消費税額', '消費税等', '税', 'tax', 'taxamount', 'vat'], contains: ['消費税', '税額'], exclude: ['税抜', '税込', '率', '単価']},
  amount_inc_tax: {exact: ['税込', '税込金額', '税込額', '税込売上', 'grosssales', 'amountinctax'], contains: ['税込'], exclude: ['単価', '率']},
  period_from: {exact: ['期間開始', '開始日', '対象開始日', '販売開始', '販売開始日', '期間自', 'startdate', 'periodfrom', 'from'], contains: ['開始日', '期間開始', '期間自'], exclude: ['契約', '利用', 'ライセンス']},
  period_to: {exact: ['期間終了', '終了日', '対象終了日', '販売終了', '販売終了日', '期間至', 'enddate', 'periodto', 'to'], contains: ['終了日', '期間終了', '期間至'], exclude: ['契約', '利用', 'ライセンス']},
  sales_month: {exact: ['対象月', '販売月', '集計月', '集計年月', '年月', '対象年月', '売上月', '利用月', '配信月', 'salesmonth', 'month'], contains: ['対象月', '販売月', '集計年月', '集計月', '対象年月'], exclude: ['計上']},
  accounting_month: {exact: ['計上月', '計上年月', 'accountingmonth'], contains: ['計上月', '計上年月'], exclude: []},
  report_received_on: {exact: ['受領日', '報告受領日', '報告日', 'receiveddate', 'receivedon'], contains: ['受領日'], exclude: []},
});

// 見出しとして一般的な語（取込先の列ではないが、見出し行の推定に使う）。
const GENERIC_WORDS = ['作品', '商品', 'コード', '品番', '区分', '備考', '単価', '手数料', '総額', '取引先', '媒体', '形態', '地域', '通貨', '率', 'メモ', '返品', '出荷', '配信', 'sku', 'code'];

function scoreFor(target, header) {
  const rule = RULES[target];
  if (!rule) return 0;
  const text = normalizeHeader(header);
  if (!text) return 0;
  if ((rule.exclude || []).some((word) => text.includes(word)) && !rule.exact.includes(text)) return 0;
  let score = 0;
  if (rule.exact.includes(text)) score = 3;
  else if ((rule.contains || []).some((word) => text.includes(word))) score = 2;
  if (!score) return 0;
  if ((rule.prefer || []).some((word) => text.includes(word))) score += 0.5;
  return score;
}

// その見出しが当てはまりそうな共通列（なければ空。一般的な見出しの語だけのときは ['generic']）。
export function knownHeaderTargets(header) {
  const targets = Object.keys(RULES).filter((target) => scoreFor(target, header) > 0);
  if (targets.length) return targets;
  const text = normalizeHeader(header);
  return text && GENERIC_WORDS.some((word) => text.includes(word)) ? ['generic'] : [];
}

const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_ISO = /^\d{4}-(0[1-9]|1[0-2])$/;
const INTEGER_TEXT = /^[-−－]?[¥￥]?[0-9０-９,，]+$/;
const DECIMAL_TEXT = /^[-−－]?[¥￥]?[0-9０-９,，]+(?:[.．][0-9０-９]+)?[%％]?$/;

// 元の列の値が、その共通列にそのまま使える形か（先頭の数行で確かめる）。
export function formatCheck(target, values) {
  const format = SALES_TARGETS.find((item) => item.key === target)?.format;
  const filled = (values || []).map((value) => String(value ?? '').trim()).filter(Boolean);
  if (!filled.length || !format || format === 'text' || format === 'id') return {ok: true};
  const test = format === 'date' ? DATE_ISO : format === 'month' ? MONTH_ISO : format === 'decimal' ? DECIMAL_TEXT : INTEGER_TEXT;
  const bad = filled.find((value) => !test.test(value));
  if (!bad) return {ok: true};
  const expected = format === 'date' ? '「2026-08-31」の形' : format === 'month' ? '「2026-08」の形' : format === 'decimal' ? '数' : '整数';
  return {ok: false, sample: bad, message: `値が「${bad}」の形のため、そのままでは使えません（${expected}が必要です）`};
}

// 見出しの並びから、共通列ごとの候補を1つずつ選ぶ（1つの元の列は1つの共通列にだけ使う）。
// sampleRows: 見出しの順に並んだ値の配列の配列。形が合わない候補は formatOk:false と理由を付けて返す。
export function suggestMappings(headers, sampleRows = []) {
  const list = (headers || []).map((header) => String(header ?? ''));
  const pairs = [];
  for (const target of Object.keys(RULES)) {
    list.forEach((header, index) => {
      const score = scoreFor(target, header);
      if (score > 0) pairs.push({target, header, index, score});
    });
  }
  pairs.sort((a, b) => b.score - a.score || a.index - b.index);
  const used = new Set();
  const taken = new Set();
  const out = {};
  for (const pair of pairs) {
    if (taken.has(pair.target) || used.has(pair.header)) continue;
    taken.add(pair.target);
    used.add(pair.header);
    const values = (sampleRows || []).slice(0, 20).map((row) => (Array.isArray(row) ? row[pair.index] : row?.[pair.header]));
    const check = formatCheck(pair.target, values);
    out[pair.target] = {
      source: pair.header,
      score: pair.score,
      formatOk: check.ok,
      reason: check.ok ? (pair.score >= 3 ? `見出し「${pair.header}」が一致` : `見出し「${pair.header}」に「${targetLabel(pair.target)}」らしい語がある`) : `見出し「${pair.header}」は${check.message}`,
    };
  }
  return out;
}

// 既存の原本選択API（suggestions_json）と同じ形 [{target, mode:'source', source, reason}] に直す。形が合わない候補は入れない。
export function suggestionList(headers, sampleRows = []) {
  return Object.entries(suggestMappings(headers, sampleRows))
    .filter(([, item]) => item.formatOk)
    .map(([target, item]) => ({target, mode: 'source', source: item.source, reason: item.reason}));
}

// 売上集計シートの拡張属性の列の候補（見出しの語から）。既存の共通列の候補（suggestMappings）とは別に出す
const ATTRIBUTE_RULES = Object.freeze({
  theatre_name: ['劇場名', '劇場', '館名', '上映館', 'theater', 'theatre'],
  ticket_category: ['券種区分', '券種の区分', '料金区分'],
  ticket_audience: ['対象層', 'ターゲット'],
  ticket_raw_label: ['券種表記', '券種原文'],
  ticket_unit_inc_tax: ['券種単価', '券種の税込単価', '税込単価'],
  theatre_unit_inc_tax: ['劇場別単価', '劇場単価'],
  overdue_count: ['延滞数', '延滞件数', '延滞本数'],
  overdue_amount: ['延滞額', '延滞金', '延滞料'],
  overdue_share: ['延滞分配', '延滞分配額'],
  rss_declared: ['申告額', '申告金額'],
  unique_viewers: ['視聴uu', 'uu', 'uu数', 'ユニーク', 'ユニーク視聴者', 'uniqueviewers'],
  rental_turnover: ['回転率'],
  update_reason: ['更新理由', '修正理由'],
});
// 返り値 {attr_<列キー>: {source, exact, reason}}。exact は見出しが語と一致（自動で選んでよい）、部分一致は exact:false（候補の表示だけ）
export function suggestAttributeMappings(headers, targets = ATTRIBUTE_SALES_TARGETS) {
  const list = (headers || []).map((header) => String(header ?? ''));
  const out = {};
  const used = new Set();
  for (const target of targets) {
    const words = [...(ATTRIBUTE_RULES[target.columnKey] || []), normalizeHeader(target.label.replace(/（売上集計シート）$/, ''))].map(normalizeHeader).filter(Boolean);
    const exact = list.find((header) => !used.has(header) && words.includes(normalizeHeader(header)));
    if (exact !== undefined) { used.add(exact); out[target.key] = {source: exact, exact: true, reason: `見出し「${exact}」が一致`}; continue; }
    const partial = list.find((header) => !used.has(header) && words.some((word) => word.length >= 2 && normalizeHeader(header).includes(word)));
    if (partial !== undefined) out[target.key] = {source: partial, exact: false, reason: `候補: 見出し「${partial}」に「${target.label.replace(/（売上集計シート）$/, '')}」らしい語があります（使うときは選んでください）`};
  }
  return out;
}
