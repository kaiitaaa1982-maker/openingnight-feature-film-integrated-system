// 売上報告の取込ウィザードの論理（純関数）。画面（SalesImportWizard.jsx）とサーバー（sales-import-routes.mjs）で共用する。
// 列対応の版（report_mapping_versions）の形は既存APIに合わせる: {ignoredColumns, mappings:[{target, mode, source|value|operands}]}。
import {parseCsv} from '../csv.mjs';
import {targetLabel, suggestMappings, knownHeaderTargets, suggestAttributeMappings, ATTRIBUTE_SALES_TARGETS} from './column-synonyms.mjs';
import {isAttributeTarget} from '../sales-sheet/column-registry.mjs';
import {RESOLVED_PRODUCT_COLUMN} from './source-partition.mjs';

// ---------- 値の読み方 ----------
const normalizeIntegerText = (value) => String(value ?? '').replace(/[￥¥,，\s]/g, '').replace(/[－−]/g, '-').replace(/[０-９]/g, (c) => String('０１２３４５６７８９'.indexOf(c)));

// 円・件数の整数として読めれば数、読めなければ null（既存の取込と同じ規則: 全角・カンマ・¥ を吸収）。
export function integerOrNull(value) {
  const text = normalizeIntegerText(value);
  if (!/^-?\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(value) {
  const text = String(value ?? '');
  if (!DATE_ISO.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
export const isIsoMonth = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value ?? ''));

// 「2026/08」「2026年8月」「202608」「2026-08-01」→「2026-08」。読めなければ null。
export function normalizeMonth(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  const match = text.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*(?:月)?(?:\s*[-/.]\s*\d{1,2}\s*日?)?$/) || text.match(/^(\d{4})(\d{2})$/);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}`;
}

export function monthRange(ym) {
  if (!isIsoMonth(ym)) return null;
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}`};
}

// 元の報告の「対象月」「集計年月」などの列が1つの月にそろっていれば、その月を対象期間の候補にする。
export function guessPeriod(headers, rows) {
  const list = headers || [];
  for (let index = 0; index < list.length; index += 1) {
    const targets = knownHeaderTargets(list[index]);
    if (!targets.includes('sales_month') && !targets.includes('accounting_month')) continue;
    const months = new Set();
    let unreadable = false;
    for (const row of rows || []) {
      const raw = Array.isArray(row) ? row[index] : row?.[list[index]];
      if (raw === null || raw === undefined || String(raw).trim() === '') continue;
      const month = normalizeMonth(raw);
      if (!month) { unreadable = true; break; }
      months.add(month);
    }
    if (!unreadable && months.size === 1) {
      const month = [...months][0];
      return {month, column: list[index], ...monthRange(month)};
    }
  }
  return null;
}

// ---------- 列対応（画面の入力 → 版の定義） ----------
// 計上基準ID → 計上基準に必要な日付の列（既存の計上基準マスタ recognition_bases と同じ）
export const BASIS_FIELDS = Object.freeze({1: 'sales_month', 2: 'report_received_on', 3: 'contract_start_on', 4: 'license_start_on', 5: 'broadcast_on'});

export const MODE_LABELS = Object.freeze({
  auto: '自動で付ける', literal: '固定値', none: '使わない', zero: '0円（税額の列がない）', same_ex: '税抜と同じ（税額が0円のとき）',
  resolved: '行ごとに商品コードで照合する（手順4で作品に割り当て）',
  add: '計算: 列を足す', subtract: '計算: 列を引く', multiply: '計算: 列を掛ける', source: '元の列',
});

// 画面に出す共通列の並びと、選べる取り方。input は固定値の入力の種類。
export const FIELD_SPECS = Object.freeze([
  {key: 'report_key', label: '報告番号', required: true, modes: ['auto', 'source', 'literal'], input: 'text'},
  {key: 'product_id', label: '商品', modes: ['literal', 'none', 'resolved'], input: 'product', columns: false},
  {key: 'period_from', label: '対象期間の初日', required: true, modes: ['literal', 'source'], input: 'date'},
  {key: 'period_to', label: '対象期間の末日', required: true, modes: ['literal', 'source'], input: 'date'},
  {key: 'recognition_basis_id', label: '計上基準', modes: ['literal', 'none'], input: 'basis', columns: false},
  {key: 'basis_date', label: '計上基準の日付', modes: ['literal', 'source'], input: 'basis-date', basisOnly: true},
  {key: 'basis_reason', label: '計上の根拠', modes: ['literal'], input: 'text', basisOnly: true, columns: false},
  {key: 'accounting_month', label: '計上月', modes: ['literal', 'source'], input: 'month', noBasisOnly: true},
  {key: 'description', label: '明細名', modes: ['source', 'literal', 'none'], input: 'text'},
  {key: 'quantity', label: '数量', modes: ['source', 'none']},
  {key: 'amount_ex_tax', label: '税抜', required: true, modes: ['source', 'add', 'subtract', 'multiply']},
  {key: 'tax_amount', label: '税額', required: true, modes: ['source', 'zero', 'add', 'subtract', 'multiply']},
  {key: 'amount_inc_tax', label: '税込', required: true, modes: ['source', 'same_ex', 'add', 'subtract', 'multiply']},
]);

const ARITHMETIC = new Set(['add', 'subtract', 'multiply']);
export const blankField = (mode = '') => ({mode, source: '', value: '', operands: ['', '']});

export function basisDateTarget(fields) {
  return BASIS_FIELDS[Number(fields?.recognition_basis_id?.value)] || null;
}

// 報告番号を自動で付けるときの値。取引先コード・対象月・原本のハッシュ先頭で、同じ原本以外とは重ならない。
export function autoReportKey({partnerCode, partnerId, periodFrom, rawHash}) {
  const code = String(partnerCode || '').normalize('NFKC').replace(/[^A-Za-z0-9_-]/g, '') || `P${partnerId || 0}`;
  const month = isIsoDate(periodFrom) ? periodFrom.slice(0, 7).replace('-', '') : '000000';
  const hash = String(rawHash || '').replace(/[^0-9a-f]/gi, '').slice(0, 8) || 'manual';
  return `${code}-${month}-${hash}`.slice(0, 200);
}

function sourceRule(target, field, headers, errors, label) {
  if (field.mode === 'source') {
    if (!field.source) { errors.push({target, message: `${label}の元の列を選んでください`}); return null; }
    if (!headers.includes(field.source)) { errors.push({target, message: `${label}の元の列「${field.source}」が見出しにありません`}); return null; }
    return {target, mode: 'source', source: field.source};
  }
  if (ARITHMETIC.has(field.mode)) {
    const operands = (field.operands || []).map((value) => String(value || '').trim()).filter(Boolean);
    const need = field.mode === 'subtract' ? 'exactly2' : 'atLeast2';
    if ((need === 'exactly2' && operands.length !== 2) || (need === 'atLeast2' && (operands.length < 2 || operands.length > 8))) {
      errors.push({target, message: field.mode === 'subtract' ? `${label}の計算に使う2つの列を選んでください` : `${label}の計算に使う列を2つ以上選んでください`});
      return null;
    }
    const missing = operands.find((column) => !headers.includes(column));
    if (missing) { errors.push({target, message: `${label}の計算に使う列「${missing}」が見出しにありません`}); return null; }
    return {target, mode: field.mode, operands};
  }
  return undefined;
}

// 画面の入力（fields）から版の定義を組み立てる。返り値 {definition, errors:[{target, message}]}。
// ctx: {headers, partnerId, autoKey, correction:{id, reportKey}|null, resolvedProduct:boolean}
// resolvedProduct: 原本を商品コードの列で作品ごとに分けるとき。分けた表の右端に「商品ID（照合）」が付くので、商品はその列から取る。
export function buildDefinition(fields, ctx) {
  const resolvedProduct = Boolean(ctx?.resolvedProduct);
  const headers = [...(ctx?.headers || []).map(String), ...(resolvedProduct && !(ctx?.headers || []).includes(RESOLVED_PRODUCT_COLUMN) ? [RESOLVED_PRODUCT_COLUMN] : [])];
  const errors = [];
  const mappings = [];
  const f = (key) => fields?.[key] || blankField();
  const push = (rule) => { if (rule) mappings.push(rule); };

  // 報告番号
  if (ctx?.correction) push({target: 'report_key', mode: 'literal', valueType: 'string', value: String(ctx.correction.reportKey)});
  else {
    const field = f('report_key');
    if (field.mode === 'auto') push({target: 'report_key', mode: 'literal', valueType: 'string', value: String(ctx?.autoKey || '')});
    else if (field.mode === 'literal') {
      const value = String(field.value || '').trim();
      if (!value || value.length > 200) errors.push({target: 'report_key', message: '報告番号は1〜200文字で入力してください'});
      else push({target: 'report_key', mode: 'literal', valueType: 'string', value});
    } else {
      const rule = sourceRule('report_key', field, headers, errors, '報告番号');
      if (rule === undefined) errors.push({target: 'report_key', message: '報告番号の付け方を選んでください'});
      else push(rule);
    }
  }
  // 取引先（手順1で選んだもの）
  if (!Number.isSafeInteger(Number(ctx?.partnerId)) || Number(ctx?.partnerId) <= 0) errors.push({target: 'partner_id', message: '取引先を選んでください'});
  else push({target: 'partner_id', mode: 'literal', valueType: 'integer', value: String(Number(ctx.partnerId))});
  // 商品
  const product = f('product_id');
  if (product.mode === 'literal') {
    if (!Number(product.value)) errors.push({target: 'product_id', message: '商品を選んでください（作品に直接計上するときは「使わない」）'});
    else push({target: 'product_id', mode: 'literal', valueType: 'integer', value: String(Number(product.value))});
  } else if (product.mode === 'resolved') {
    if (!resolvedProduct) errors.push({target: 'product_id', message: '商品を行ごとに照合するのは、原本を商品コードの列で作品ごとに分けるときだけです'});
    else push({target: 'product_id', mode: 'source', source: RESOLVED_PRODUCT_COLUMN});
  } else if (product.mode !== 'none') errors.push({target: 'product_id', message: '商品を選ぶか「使わない」にしてください'});
  // 対象期間
  for (const [key, label] of [['period_from', '対象期間の初日'], ['period_to', '対象期間の末日']]) {
    const field = f(key);
    if (field.mode === 'literal') {
      if (!isIsoDate(field.value)) errors.push({target: key, message: `${label}を日付で入力してください`});
      else push({target: key, mode: 'literal', valueType: 'string', value: field.value});
    } else {
      const rule = sourceRule(key, field, headers, errors, label);
      if (rule === undefined) errors.push({target: key, message: `${label}の取り方を選んでください`});
      else push(rule);
    }
  }
  if (f('period_from').mode === 'literal' && f('period_to').mode === 'literal' && isIsoDate(f('period_from').value) && isIsoDate(f('period_to').value) && f('period_to').value < f('period_from').value) {
    errors.push({target: 'period_to', message: '対象期間の末日が初日より前です'});
  }
  // 計上基準・計上月
  const basis = f('recognition_basis_id');
  const dateTarget = basisDateTarget(fields);
  if (basis.mode === 'literal') {
    if (!dateTarget) errors.push({target: 'recognition_basis_id', message: '計上基準を選んでください'});
    else {
      push({target: 'recognition_basis_id', mode: 'literal', valueType: 'integer', value: String(Number(basis.value))});
      const field = f('basis_date');
      const label = targetLabel(dateTarget);
      if (field.mode === 'literal') {
        const ok = dateTarget === 'sales_month' ? isIsoMonth(field.value) : isIsoDate(field.value);
        if (!ok) errors.push({target: 'basis_date', message: `${label}を${dateTarget === 'sales_month' ? '年月' : '日付'}で入力してください`});
        else push({target: dateTarget, mode: 'literal', valueType: 'string', value: field.value});
      } else {
        const rule = sourceRule(dateTarget, field, headers, errors, label);
        if (rule === undefined) errors.push({target: 'basis_date', message: `${label}の取り方を選んでください`});
        else if (rule) push(rule);
      }
      const reason = String(f('basis_reason').value || '').trim();
      if (!reason || reason.length > 1000) errors.push({target: 'basis_reason', message: '計上の根拠を1〜1000文字で書いてください'});
      else push({target: 'basis_reason', mode: 'literal', valueType: 'string', value: reason});
    }
  } else if (basis.mode === 'none') {
    const field = f('accounting_month');
    if (field.mode === 'literal') {
      if (!isIsoMonth(field.value)) errors.push({target: 'accounting_month', message: '計上月を年月で入力してください（計上基準を使わないとき）'});
      else push({target: 'accounting_month', mode: 'literal', valueType: 'string', value: field.value});
    } else {
      const rule = sourceRule('accounting_month', field, headers, errors, '計上月');
      if (rule === undefined) errors.push({target: 'accounting_month', message: '計上月の取り方を選んでください'});
      else push(rule);
    }
  } else errors.push({target: 'recognition_basis_id', message: '計上基準を選ぶか「使わない」にして計上月を入れてください'});
  // 明細名・数量
  const description = f('description');
  if (description.mode === 'literal') {
    const value = String(description.value || '').trim();
    if (value) push({target: 'description', mode: 'literal', valueType: 'string', value});
  } else if (description.mode === 'source') push(sourceRule('description', description, headers, errors, '明細名'));
  const quantity = f('quantity');
  if (quantity.mode === 'source') push(sourceRule('quantity', quantity, headers, errors, '数量'));
  // 金額
  const ex = f('amount_ex_tax');
  const exRule = sourceRule('amount_ex_tax', ex, headers, errors, '税抜');
  if (exRule === undefined) errors.push({target: 'amount_ex_tax', message: '税抜の取り方を選んでください'});
  else push(exRule);
  const tax = f('tax_amount');
  if (tax.mode === 'zero') push({target: 'tax_amount', mode: 'literal', valueType: 'integer', value: '0'});
  else {
    const rule = sourceRule('tax_amount', tax, headers, errors, '税額');
    if (rule === undefined) errors.push({target: 'tax_amount', message: '税額の取り方を選んでください（列がなければ「0円」）'});
    else push(rule);
  }
  const inc = f('amount_inc_tax');
  if (inc.mode === 'same_ex') {
    if (tax.mode !== 'zero') errors.push({target: 'amount_inc_tax', message: '「税抜と同じ」は税額が0円のときだけ選べます'});
    else if (exRule) push(exRule.mode === 'source' ? {target: 'amount_inc_tax', mode: 'source', source: exRule.source} : {target: 'amount_inc_tax', mode: exRule.mode, operands: exRule.operands});
  } else {
    const rule = sourceRule('amount_inc_tax', inc, headers, errors, '税込');
    if (rule === undefined) errors.push({target: 'amount_inc_tax', message: '税込の取り方を選んでください'});
    else push(rule);
  }
  // 売上集計シートの拡張属性の列（任意）。fields.attributes = {attr_<列キー>: 元の列}。元の列をそのまま使う
  for (const [target, source] of Object.entries(fields?.attributes || {})) {
    if (!source) continue;
    if (!isAttributeTarget(target)) { errors.push({target, message: `売上集計シートの列ではありません: ${target}`}); continue; }
    const label = ATTRIBUTE_SALES_TARGETS.find((item) => item.key === target)?.label || target;
    if (!headers.includes(source)) { errors.push({target, message: `${label}の元の列「${source}」が見出しにありません`}); continue; }
    push({target, mode: 'source', source});
  }
  // 訂正元
  if (ctx?.correction) push({target: 'supersedes_id', mode: 'literal', valueType: 'integer', value: String(Number(ctx.correction.id))});
  const used = new Set(mappings.flatMap((rule) => (rule.mode === 'source' ? [rule.source] : rule.operands || [])));
  const ignoredColumns = headers.filter((header) => !used.has(header));
  return {definition: {ignoredColumns, mappings}, errors};
}

// 前回の版から、今回の見出しで使える取り方だけを画面の入力に戻す（期間・日付・報告番号の固定値は毎回変わるので戻さない）。
export function fieldsFromDefinition(definition, headers) {
  const list = (headers || []).map(String);
  const fields = {};
  const rules = Array.isArray(definition?.mappings) ? definition.mappings : [];
  const has = (rule) => (rule.mode === 'source' ? list.includes(rule.source) || rule.source === RESOLVED_PRODUCT_COLUMN : ARITHMETIC.has(rule.mode) ? (rule.operands || []).every((column) => list.includes(column)) : true);
  const toField = (rule) => (rule.mode === 'source' ? {...blankField('source'), source: rule.source} : {...blankField(rule.mode), operands: [...rule.operands]});
  const byTarget = Object.fromEntries(rules.map((rule) => [rule.target, rule]));
  for (const rule of rules) {
    if (!has(rule)) continue;
    const {target} = rule;
    if (target === 'report_key') { if (rule.mode === 'source') fields.report_key = toField(rule); continue; }
    if (['partner_id', 'supersedes_id'].includes(target)) continue;
    if (target === 'product_id') {
      if (rule.mode === 'literal') fields.product_id = {...blankField('literal'), value: String(rule.value)};
      else if (rule.mode === 'source' && rule.source === RESOLVED_PRODUCT_COLUMN) fields.product_id = blankField('resolved');
      continue;
    }
    if (target === 'recognition_basis_id') { fields.recognition_basis_id = {...blankField('literal'), value: String(rule.value)}; continue; }
    if (target === 'basis_reason') { fields.basis_reason = {...blankField('literal'), value: String(rule.value)}; continue; }
    if (Object.values(BASIS_FIELDS).includes(target) && target === BASIS_FIELDS[Number(byTarget.recognition_basis_id?.value)]) {
      if (rule.mode === 'source') fields.basis_date = toField(rule);
      continue;
    }
    if (['period_from', 'period_to', 'accounting_month'].includes(target)) { if (rule.mode === 'source') fields[target] = toField(rule); continue; }
    if (target === 'tax_amount' && rule.mode === 'literal' && String(rule.value) === '0') { fields.tax_amount = blankField('zero'); continue; }
    if (target === 'description' && rule.mode === 'literal') { fields.description = {...blankField('literal'), value: String(rule.value)}; continue; }
    if (['description', 'quantity', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax'].includes(target) && rule.mode !== 'literal') fields[target] = toField(rule);
    if (isAttributeTarget(target) && rule.mode === 'source') fields.attributes = {...(fields.attributes || {}), [target]: rule.source};
  }
  const ex = byTarget.amount_ex_tax;
  const inc = byTarget.amount_inc_tax;
  if (ex && inc && fields.tax_amount?.mode === 'zero' && stableStringify({...ex, target: ''}) === stableStringify({...inc, target: ''})) fields.amount_inc_tax = blankField('same_ex');
  if (!byTarget.product_id && rules.length) fields.product_id = blankField('none');
  if (!byTarget.recognition_basis_id && byTarget.accounting_month) fields.recognition_basis_id = blankField('none');
  return fields;
}

// 画面の初期値。前回の版 → 見出しの同義語 → 空欄 の順で埋め、埋めた理由を notes に残す。
// ctx: {headers, sampleRows, previous:{definition, versionNo}|null, productIds:[id], period:{from,to,month,column}|null,
//       assignMode:'single_work'|'by_product'|'by_work_column'（resolvedProduct:true は by_product と同じ。前の呼び方）,
//       attributeTargets:[attr_<列キー>]（組織が採用して使っている拡張属性の列。無ければ拡張属性の列は選ばない）}
export function defaultFields(ctx) {
  const headers = (ctx?.headers || []).map(String);
  // 商品の取り方は作品の決め方（assignMode）で変える。
  // - 商品コードの列で分ける: 商品は必ず行ごとに照合する（前回の固定の商品は使わない）
  // - 作品コードの列で分ける: 前回が行ごとの照合ならそのまま残す（商品コードの列は手順4で選ぶ。作品コードだけで分けるなら「使わない」にする）
  // - 1つの作品: 照合の列が無いので前回の照合は使わない
  const assignMode = ctx?.assignMode || (ctx?.resolvedProduct ? 'by_product' : 'single_work');
  const splitMode = assignMode !== 'single_work';
  const fields = {};
  const notes = {};
  for (const spec of FIELD_SPECS) fields[spec.key] = blankField('');
  fields.report_key = blankField('auto');
  fields.basis_reason = blankField('literal');
  const products = ctx?.productIds || [];
  fields.product_id = products.length === 1 ? {...blankField('literal'), value: String(products[0])} : blankField(products.length ? 'literal' : 'none');
  if (products.length === 1) notes.product_id = 'この作品・報告の種類の商品が1つだけのため選びました';
  if (assignMode === 'by_product') {
    fields.product_id = blankField('resolved');
    notes.product_id = '商品コードの列で作品ごとに分けるため、商品は行ごとに照合します';
  }
  fields.period_from = blankField('literal');
  fields.period_to = blankField('literal');
  fields.accounting_month = blankField('literal');
  fields.basis_date = blankField('literal');
  if (ctx?.period) {
    fields.period_from.value = ctx.period.from;
    fields.period_to.value = ctx.period.to;
    notes.period_from = `列「${ctx.period.column}」がすべて${Number(ctx.period.month.slice(5))}月のため、その月を入れました`;
    notes.period_to = notes.period_from;
  }
  const previous = ctx?.previous?.definition ? fieldsFromDefinition(ctx.previous.definition, headers) : {};
  for (const [key, field] of Object.entries(previous)) {
    if (key === 'attributes') continue;
    fields[key] = field;
    notes[key] = `前回の列対応（版${ctx.previous.versionNo ?? '—'}）から`;
  }
  if (assignMode === 'by_product' && previous.product_id) {
    fields.product_id = blankField('resolved');
    notes.product_id = '商品コードの列で作品ごとに分けるため、商品は行ごとに照合します';
  } else if (assignMode === 'by_work_column' && previous.product_id?.mode === 'resolved') {
    fields.product_id = blankField('resolved');
    notes.product_id = '前回の列対応（行ごとに照合）のままにしました。手順4で商品コードの列を選びます。作品コードの列だけで分けるときは「使わない」にしてください';
  } else if (!splitMode && previous.product_id?.mode === 'resolved') {
    fields.product_id = products.length === 1 ? {...blankField('literal'), value: String(products[0])} : blankField(products.length ? 'literal' : 'none');
    notes.product_id = '前回は商品を行ごとに照合しました。今回は1つの作品の原本なので、商品を選び直してください';
  }
  // 前回の商品が、今回の作品・報告の種類に結び付いていなければ使わない（作品ごとに分ける原本では、1つに固定した商品は使わない）
  if (assignMode !== 'by_product' && previous.product_id?.mode === 'literal' && !products.map(String).includes(String(previous.product_id.value))) {
    fields.product_id = products.length === 1 ? {...blankField('literal'), value: String(products[0])} : blankField(products.length ? 'literal' : 'none');
    notes.product_id = splitMode
      ? '作品コードの列で作品ごとに分けるため、前回の1つに固定した商品は使いません。商品も照合するときは「行ごとに照合する」を選んでください'
      : '前回の商品はこの作品・報告の種類に結び付いていないため、選び直してください';
  }
  const suggested = suggestMappings(headers, ctx?.sampleRows || []);
  const used = new Set(Object.values(fields).flatMap((field) => (field.mode === 'source' ? [field.source] : ARITHMETIC.has(field.mode) ? field.operands : [])).filter(Boolean));
  for (const [target, item] of Object.entries(suggested)) {
    const key = ['sales_month', 'report_received_on'].includes(target) ? null : target;
    if (!key || !fields[key] || previous[key]) continue;
    if (!item.formatOk) { if (!notes[key]) notes[key] = item.reason; continue; }
    if (used.has(item.source)) continue;
    if (['period_from', 'period_to', 'accounting_month'].includes(key) && fields[key].value) continue;
    fields[key] = {...blankField('source'), source: item.source};
    notes[key] = item.reason;
    used.add(item.source);
  }
  // 売上集計シートの拡張属性の列: 組織が採用して使っている列（ctx.attributeTargets）だけを扱う。
  // 前回の対応 → 見出しが一致するもの（使っていない元の列だけ）を選ぶ。部分一致は候補の表示だけで選ばない。何も無ければ持たない
  const adopted = new Set(ctx?.attributeTargets || []);
  const attributes = {};
  for (const [target, source] of Object.entries(previous.attributes || {})) {
    if (adopted.has(target)) attributes[target] = source;
    else notes[target] = '前回の列対応にありましたが、今は売上集計シートで使っていない列のため選びません';
  }
  for (const [target, item] of Object.entries(suggestAttributeMappings(headers, ATTRIBUTE_SALES_TARGETS.filter((t) => adopted.has(t.key))))) {
    if (attributes[target]) continue;
    if (!item.exact || used.has(item.source) || Object.values(attributes).includes(item.source)) { if (!notes[target]) notes[target] = item.reason; continue; }
    attributes[target] = item.source;
    notes[target] = item.reason;
  }
  delete fields.attributes;
  if (Object.keys(attributes).length) fields.attributes = attributes;
  if (!fields.description.mode) fields.description = blankField('none');
  if (!fields.quantity.mode) fields.quantity = blankField('none');
  if (!fields.recognition_basis_id.mode) fields.recognition_basis_id = blankField('none');
  return {fields, notes};
}

// ---------- 版の比較 ----------
export function stableStringify(value) {
  return JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}
export function sameDefinition(a, b) {
  if (!a || !b) return false;
  const norm = (d) => ({ignoredColumns: [...(d.ignoredColumns || [])].sort(), mappings: d.mappings || []});
  return stableStringify(norm(a)) === stableStringify(norm(b));
}

// ---------- 行ごとの評価 ----------
// 既存の変換（元の列・固定値・足す・引く・掛ける）と同じ規則で1行を評価する。計算に使えない値は行のエラーにする。
export function evaluateRule(rule, values) {
  if (rule.mode === 'source') return {value: String(values?.[rule.source] ?? '').trim(), error: null};
  if (rule.mode === 'literal') return {value: String(rule.value ?? ''), error: null};
  const numbers = [];
  for (const column of rule.operands || []) {
    const n = integerOrNull(values?.[column]);
    if (n === null) return {value: null, error: `「${column}」が整数ではないため${targetLabel(rule.target)}を計算できません（値: ${String(values?.[column] ?? '').trim() || '空欄'}）`};
    numbers.push(BigInt(n));
  }
  let result;
  if (rule.mode === 'add') result = numbers.reduce((sum, n) => sum + n, 0n);
  else if (rule.mode === 'subtract') result = numbers[0] - numbers[1];
  else result = numbers.reduce((total, n) => total * n, 1n);
  const number = Number(result);
  if (!Number.isSafeInteger(number)) return {value: null, error: `${targetLabel(rule.target)}の計算結果が大きすぎます`};
  return {value: String(number), error: null};
}

export function evaluateMappings(mappings, values) {
  const out = {};
  const errors = [];
  for (const rule of mappings || []) {
    const {value, error} = evaluateRule(rule, values);
    out[rule.target] = value;
    if (error) errors.push({target: rule.target, message: error});
  }
  return {values: out, errors};
}

// 除外した行の金額（記録用）。計算できない金額は null（未確認）。
export function amountsOf(mappings, values) {
  const {values: out} = evaluateMappings(mappings, values);
  return {amountExTax: integerOrNull(out.amount_ex_tax), taxAmount: integerOrNull(out.tax_amount), amountIncTax: integerOrNull(out.amount_inc_tax)};
}

export function exclusionTotals(rows) {
  const sum = (key) => (rows || []).reduce((total, row) => total + (Number.isFinite(row?.[key]) ? row[key] : 0), 0);
  return {
    count: (rows || []).length,
    amountExTax: sum('amountExTax'), taxAmount: sum('taxAmount'), amountIncTax: sum('amountIncTax'),
    unknown: (rows || []).filter((row) => !Number.isFinite(row?.amountExTax)).length,
  };
}

// ---------- 検算（原本の列どうしの確かめ） ----------
export const CHECK_TYPES = Object.freeze({required: '空欄の確認', difference: '差し引きの確認（A − B = C）', product: '掛け算の確認（A × B = C）'});

export function describeCheck(check) {
  if (check?.type === 'required') return `「${check.column}」が空欄でない`;
  if (check?.type === 'difference') return `「${check.left}」−「${check.right}」＝「${check.result}」`;
  if (check?.type === 'product') return `「${check.left}」×「${check.right}」＝「${check.result}」`;
  return '未登録の確認';
}

export function validateChecks(checks, headers) {
  const list = (headers || []).map(String);
  const errors = [];
  if (!Array.isArray(checks)) return checks == null ? [] : ['検算の指定が不正です'];
  if (checks.length > 20) errors.push('検算は20件までです');
  checks.forEach((check, index) => {
    const no = index + 1;
    if (!check || !CHECK_TYPES[check.type]) { errors.push(`検算${no}: 種類を選んでください`); return; }
    const columns = check.type === 'required' ? [check.column] : [check.left, check.right, check.result];
    if (columns.some((column) => !column)) { errors.push(`検算${no}: 列をすべて選んでください`); return; }
    const missing = columns.find((column) => !list.includes(String(column)));
    if (missing) errors.push(`検算${no}: 列「${missing}」が見出しにありません`);
  });
  return errors;
}

const yenText = (n) => new Intl.NumberFormat('ja-JP').format(n);

// rows: [{sourceRow, values:{見出し: 値}}] → 検算に合わない行 [{sourceRow, message, columns}]
export function evaluateChecks(checks, rows) {
  const issues = [];
  for (const row of rows || []) {
    for (const check of checks || []) {
      const v = (column) => String(row.values?.[column] ?? '').trim();
      if (check.type === 'required') {
        if (!v(check.column)) issues.push({sourceRow: row.sourceRow, message: `「${check.column}」が空欄です`, columns: [check.column]});
        continue;
      }
      const columns = [check.left, check.right, check.result];
      const numbers = columns.map((column) => integerOrNull(v(column)));
      const bad = columns.find((_, index) => numbers[index] === null);
      if (bad) { issues.push({sourceRow: row.sourceRow, message: `検算できません: 「${bad}」が整数ではありません（値: ${v(bad) || '空欄'}）`, columns: [bad]}); continue; }
      const [left, right, result] = numbers;
      const expected = check.type === 'difference' ? left - right : left * right;
      if (expected !== result) {
        const op = check.type === 'difference' ? '−' : '×';
        issues.push({sourceRow: row.sourceRow, message: `検算が合いません: 「${check.left}」${op}「${check.right}」は ${yenText(expected)} ですが、「${check.result}」は ${yenText(result)} です`, columns: [check.result]});
      }
    }
  }
  return issues;
}

// 選んだ表（原本から抽出した見出し＋明細の CSV）を行に直す。sourceRowNumbers は原本の行番号。
export function selectionRows(canonicalCsv, sourceRowNumbers = []) {
  const parsed = parseCsv(canonicalCsv);
  return parsed.map((row, index) => ({rowNo: row.rowNo, sourceRow: sourceRowNumbers[index] ?? row.rowNo, values: row.values}));
}

// ---------- サーバーの検証結果を画面の言葉に ----------
const TARGET_PATTERNS = [
  [/税込/, 'amount_inc_tax'], [/取引先/, 'partner_id'], [/商品/, 'product_id'], [/販売期間/, 'sales_period_from'],
  [/報告書キー|報告番号/, 'report_key'], [/計上基準|計上月|計上根拠|販売月基準/, 'accounting_month'], [/期間/, 'period_from'],
];

// エラー文がどの列のことか。「整数ではありません: 値」のように値だけが書かれているときは、その値を持つ列を探す。
export function errorTarget(message, localValues = {}) {
  const text = String(message || '');
  const valueMatch = text.match(/(?:整数ではありません|有効な整数ではありません|日付はYYYY-MM-DD形式です|存在しない日付です|計上月はYYYY-MM形式です):\s*(.*)$/);
  if (valueMatch) {
    const value = valueMatch[1].trim();
    const found = Object.entries(localValues || {}).find(([, v]) => String(v ?? '').trim() === value);
    if (found) return found[0];
  }
  for (const [pattern, target] of TARGET_PATTERNS) if (pattern.test(text)) return target;
  return null;
}

export function friendlyMessage(message) {
  const text = String(message || '');
  let m;
  if ((m = text.match(/^有効な整数ではありません:\s*(.*)$/))) return `「${m[1]}」は使えません（0以上の整数が必要です）`;
  if ((m = text.match(/^整数ではありません:\s*(.*)$/))) return `「${m[1] || '空欄'}」は整数として読めません`;
  if ((m = text.match(/^日付はYYYY-MM-DD形式です:\s*(.*)$/))) return `「${m[1]}」は日付として読めません（2026-08-31 の形が必要です）`;
  if ((m = text.match(/^計上月はYYYY-MM形式です:\s*(.*)$/))) return `「${m[1]}」は年月として読めません（2026-08 の形が必要です）`;
  if ((m = text.match(/^存在しない日付です:\s*(.*)$/))) return `「${m[1]}」は存在しない日付です`;
  if (/税込額が税抜額＋税額と一致しません/.test(text)) return '税込が「税抜＋税額」と一致しません';
  if (/商品が選択作品・販路に結び付いていません/.test(text)) return '選んだ商品が、この作品・報告の種類に結び付いていません';
  if (/取引先IDが選択組織にありません/.test(text)) return '取引先が見つかりません';
  if (/同一報告は登録済みです/.test(text)) return '同じ内容の報告は登録済みです';
  if (/訂正版はsupersedes_id=/.test(text)) return '同じ報告番号の報告が登録済みです。訂正版として取り込むか、報告番号を変えてください';
  if (/訂正対象が現在の有効報告と一致しません/.test(text)) return '訂正する元の報告が、いま有効な報告ではありません。売上明細から選び直してください';
  if (/同じCSV内で報告書情報または算出した計上月が一致しません/.test(text)) return '行によって報告番号・対象期間・計上月が違います。1つの報告の中では同じにしてください（月ごとに分けて取り込みます）';
  if (/この報告種別には流通別売上項目を指定できません/.test(text)) return 'この報告の種類では使えない列が対応づけられています';
  if (/同じ元CSVは登録済みです/.test(text)) return '同じ内容の表はすでに登録済みです（このままでは二重の取込になります）。内容が変わっていなければ取り込み直す必要はありません。直すときは売上明細から「訂正版を取り込む」を使います';
  if (/原本は登録済みです/.test(text)) return 'この原本は登録済みです';
  if (/原本の選択版が更新されています|原本から抽出した表が選択版と一致しません/.test(text)) return '表の選択が新しくなっています。もう一度確かめてください';
  if (/マッピング版がありません/.test(text)) return '列対応の版が見つかりません。列の対応を保存し直してください';
  if ((m = text.match(/試作の一括取込は(\d+)行までです/))) return `1回に取り込めるのは${m[1]}行までです。ファイルを分けてください`;
  if (/報告書は200KB以内です/.test(text)) return '取り込む表が大きすぎます（約200KBまで）。ファイルを分けてください';
  return text;
}

// ---------- 表で確かめる（手順4） ----------
// selection: {canonicalCsv, sourceRowNumbers}、preview: 既存 /mapped-imports/preview の応答（無ければ null）。
// 返す行: {key, sourceRow, rowNo, status:'ok'|'error'|'warn', values, destination, issues:[{target, message, kind}]}
export function buildReviewRows({selection, mappings, preview = null, checks = [], totalRows = [], acceptedRows = []}) {
  const rows = selectionRows(selection.canonicalCsv, selection.sourceRowNumbers);
  const serverRows = new Map((preview?.rows || []).map((row) => [row.rowNo, row]));
  const serverErrors = new Map();
  for (const error of preview?.errors || []) {
    if (!error || typeof error !== 'object' || !error.rowNo) continue;
    const list = serverErrors.get(error.rowNo) || [];
    list.push(String(error.message || error.error || ''));
    serverErrors.set(error.rowNo, list);
  }
  const checkIssues = evaluateChecks(checks, rows);
  const totals = new Map((totalRows || []).map((item) => [Number(item.row), item.reason]));
  const accepted = new Set((acceptedRows || []).map(Number));
  return rows.map((row) => {
    const local = evaluateMappings(mappings, row.values);
    const server = serverRows.get(row.rowNo);
    const issues = [];
    for (const error of local.errors) issues.push({target: error.target, message: error.message, kind: 'error'});
    for (const message of serverErrors.get(row.rowNo) || []) issues.push({target: errorTarget(message, local.values), message: friendlyMessage(message), kind: 'error'});
    // 検算の列が共通の列にそのまま使われていれば、その列のセルにも理由を出す
    for (const issue of checkIssues.filter((item) => item.sourceRow === row.sourceRow)) {
      const target = (mappings || []).find((rule) => rule.mode === 'source' && rule.source === issue.columns[0])?.target ?? null;
      issues.push({target, column: issue.columns[0], message: issue.message, kind: 'check'});
    }
    if (totals.has(row.sourceRow) && !accepted.has(row.sourceRow)) issues.push({target: null, message: totals.get(row.sourceRow), kind: 'total'});
    const data = server?.data || {};
    const values = {
      partner_id: data.partner_id ?? integerOrNull(local.values.partner_id),
      product_id: server ? data.product_id ?? null : integerOrNull(local.values.product_id),
      description: server ? data.description : (local.values.description || null),
      quantity: server ? data.quantity : integerOrNull(local.values.quantity),
      amount_ex_tax: server ? data.amount_ex_tax : integerOrNull(local.values.amount_ex_tax),
      tax_amount: server ? data.tax_amount : integerOrNull(local.values.tax_amount),
      amount_inc_tax: server ? data.amount_inc_tax : integerOrNull(local.values.amount_inc_tax),
      accounting_month: server ? data.accounting_month : local.values.accounting_month || null,
      sales_period_from: server ? data.sales_period_from : local.values.sales_period_from || local.values.period_from || null,
      sales_period_to: server ? data.sales_period_to : local.values.sales_period_to || local.values.period_to || null,
    };
    const hasError = issues.some((issue) => issue.kind === 'error' || issue.kind === 'check');
    const status = hasError ? 'error' : issues.length ? 'warn' : 'ok';
    return {key: row.sourceRow, sourceRow: row.sourceRow, rowNo: row.rowNo, status, values, source: row.values, destination: server?.destination || null, issues};
  });
}

// 報告全体のエラー（行番号0）。
export function reportLevelErrors(preview) {
  return (preview?.errors || []).filter((error) => typeof error === 'string' || !error?.rowNo).map((error) => friendlyMessage(typeof error === 'string' ? error : error.message || error.error));
}

export function reviewTotals(rows) {
  const out = {rows: 0, count: 0, observations: 0, errors: 0, warnings: 0, amount_ex_tax: 0, tax_amount: 0, amount_inc_tax: 0};
  for (const row of rows || []) {
    out.rows += 1;
    if (row.status === 'error') { out.errors += 1; continue; }
    if (row.status === 'warn') out.warnings += 1;
    if (row.destination === 'package_report_observations') { out.observations += 1; continue; }
    out.count += 1;
    for (const key of ['amount_ex_tax', 'tax_amount', 'amount_inc_tax']) out[key] += Number.isFinite(row.values[key]) ? row.values[key] : 0;
  }
  return out;
}

// 取り込む行の、元の列の合計（整数だけの列）。原本の合計欄と照らし合わせる用。
export function sourceColumnTotals(headers, rows) {
  const out = [];
  for (const header of headers || []) {
    let total = 0;
    let seen = 0;
    let numeric = true;
    for (const row of rows || []) {
      const raw = String(row.source?.[header] ?? row.values?.[header] ?? '').trim();
      if (!raw) continue;
      const n = integerOrNull(raw);
      if (n === null) { numeric = false; break; }
      total += n;
      seen += 1;
    }
    if (numeric && seen) out.push({column: header, total, count: seen});
  }
  return out;
}

// 原本の統制値（件数・合計）との照合。入力が空の項目は比べない。
export function compareControls(controls, totals) {
  const items = [['rowCount', '件数', totals.count], ['amountExTax', '税抜の合計', totals.amount_ex_tax], ['taxAmount', '税額の合計', totals.tax_amount], ['amountIncTax', '税込の合計', totals.amount_inc_tax]];
  const out = [];
  for (const [key, label, actual] of items) {
    const raw = controls?.[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const expected = integerOrNull(raw);
    if (expected === null) { out.push({key, label, expected: null, actual, match: false, invalid: true}); continue; }
    out.push({key, label, expected, actual, match: expected === actual, difference: actual - expected});
  }
  return out;
}

// ---------- 重なる報告の扱い（画面とサーバーで同じ判定） ----------
const reasonOk = (reason) => {
  const text = String(reason ?? '').trim();
  return text.length >= 1 && text.length <= 500;
};

// overlaps: 重なる有効な報告 [{id}]、decision: {mode:'supersede'|'separate', reason}、supersedesId: 版の訂正元。問題なければ null。
export function overlapDecisionProblem(overlaps, decision, supersedesId) {
  const ids = (overlaps || []).map((row) => Number(row.id));
  if (!ids.length) return null;
  if (decision?.mode === 'supersede') {
    // 訂正版は元の報告（supersedesId）を置き換える。訂正で対象期間を直した場合、元の報告は重なりに入らないことがあるので、
    // 重なりに含まれることは求めない。元の報告以外に重なる報告があれば、別の報告として並べる理由を求める
    if (!supersedesId) return '訂正する元の報告を選んでください';
    const others = ids.filter((id) => id !== Number(supersedesId));
    if (others.length && !reasonOk(decision.reason)) return `ほかにも重なる報告が${others.length}件あります。別の報告として取り込む理由を書いてください`;
    return null;
  }
  if (decision?.mode === 'separate') return reasonOk(decision.reason) ? null : '別の報告として取り込む理由を書いてください（500文字まで）';
  return '同じ取引先・報告の種類で対象期間が重なる報告が登録済みです。訂正版として取り込むか、別の報告として取り込むかを選んでください';
}

// ---------- 失敗行Excel ----------
// 元の列そのまま＋右端に「原本の行」「エラーの理由」。直すのは元のファイル（このファイル自体は取込に使わない）。
export function failedRowsSheet(headers, reviewRows) {
  const bad = (reviewRows || []).filter((row) => row.status !== 'ok');
  return [
    [...headers, '原本の行', 'エラーの理由'],
    ...bad.map((row) => [...headers.map((header) => row.source?.[header] ?? ''), row.sourceRow, row.issues.map((issue) => issue.message).join(' ／ ')]),
  ];
}

// 既定の除外理由（画面で書き換えられる）。
export function defaultExclusionReason(row) {
  const issue = row?.issues?.[0];
  if (!issue) return '';
  if (issue.kind === 'total') return '合計の行のため';
  return `取り込まない: ${issue.message}`.slice(0, 200);
}

// ---------- 作品・商品への割り当て（手順4）と作品ごとの表（手順5） ----------
// 画面の下書き（作品の決め方）→ 割り当ての入力。足りない値があれば null（まだ試さない）。
// draft: {mode, workId, productColumn, workColumn, useProductColumn}
export function draftBinding(draft) {
  if (!draft?.mode) return null;
  if (draft.mode === 'single_work') return Number(draft.workId) > 0 ? {mode: 'single_work', workId: Number(draft.workId), productColumn: null, workColumn: null} : null;
  if (draft.mode === 'by_product') return draft.productColumn ? {mode: 'by_product', workId: null, productColumn: draft.productColumn, workColumn: null} : null;
  if (draft.mode !== 'by_work_column' || !draft.workColumn) return null;
  if (draft.useProductColumn && !draft.productColumn) return null;
  return {mode: 'by_work_column', workId: null, productColumn: draft.useProductColumn ? draft.productColumn : null, workColumn: draft.workColumn};
}

// 列対応の版と割り当てが合っているか。商品コードの列で照合するときは商品を「行ごとに照合」にし（配賦のある商品を集計で按分するため）、
// 照合しないときは「行ごとに照合」を使わない。合わなければ理由の文、合えば null。
// masters（任意）: {products, allocations, kind, works}。渡すと、1つの作品に割り当てるときに、列対応で固定した商品が
// その作品・報告の種類に結び付いているかも確かめる（手順4で作品を付け替えると、手順3で固定した商品が合わなくなるため）。
export function mappingFitsBinding(definition, binding, masters = null) {
  if (!definition || !binding) return null;
  const rule = (definition.mappings || []).find((item) => item.target === 'product_id');
  const resolved = rule?.mode === 'source' && rule.source === RESOLVED_PRODUCT_COLUMN;
  const hasColumn = binding.mode !== 'single_work' && Boolean(binding.productColumn);
  if (resolved && !hasColumn) return binding.mode === 'single_work'
    ? '列の対応で商品を「行ごとに照合する」にしています。1つの作品に割り当てるときは、手順3で商品を選び直してください'
    : '列の対応で商品を「行ごとに照合する」にしています。商品コードの列も選んでください';
  if (!resolved && hasColumn) return '商品コードの列で照合するときは、手順3で商品を「行ごとに照合する」にしてください（複数の作品に配賦された商品を集計で按分するため）';
  if (masters && binding.mode === 'single_work' && rule?.mode === 'literal') {
    const productId = Number(rule.value);
    const choices = productChoicesFor({...masters, workId: binding.workId});
    if (!choices.some((product) => Number(product.id) === productId)) {
      const product = (masters.products || []).find((item) => Number(item.id) === productId);
      const work = (masters.works || []).find((item) => Number(item.id) === Number(binding.workId));
      return `列の対応で固定した商品「${product?.name || product?.sku || `商品ID ${rule.value}`}」は、作品「${work?.title || '選んだ作品'}」に結び付いていません。手順3でこの作品の商品を選び直してください`;
    }
  }
  return null;
}

// 1つの作品に割り当てるときに選べる商品（その作品に配賦され、報告の種類と販路が同じ商品）
export function productChoicesFor({products = [], allocations = [], kind = null, workId = null} = {}) {
  if (!workId) return [];
  return products.filter((product) => (!kind || product.channel === kind)
    && allocations.some((row) => Number(row.product_id) === Number(product.id) && Number(row.work_id) === Number(workId)));
}

// 作品を付け替えたあとの手順3の商品の欄。固定した商品が新しい作品の選択肢に無ければ選び直させる（1つなら自動で選ぶ）。
// 返り値 {field, note}。変えなくてよいときは field が元のまま・note は null
export function refitProductField(field, choices = []) {
  if (field?.mode !== 'literal') return {field, note: null};
  if (choices.some((product) => String(product.id) === String(field.value))) return {field, note: null};
  const next = choices.length === 1 ? {...blankField('literal'), value: String(choices[0].id)} : blankField(choices.length ? 'literal' : 'none');
  const note = choices.length === 1
    ? '作品を付け替えたため、この作品の商品（1つだけ）を選びました'
    : choices.length ? '作品を付け替えたため、この作品の商品を選び直してください' : '作品を付け替えました。この作品に結び付いた商品が無いので、商品を使わずに作品へ直接計上します';
  return {field: next, note};
}

// 手順1で、見られない原本のファイルを選んだときの文（サーバーの restrictedReason ごと）
export function restrictedFileMessage(reason) {
  if (reason === 'unbound') return 'このファイルは、ほかの人が作品を決めないまま受け取った原本です（作品を決めるまでは、受け取った人と管理者だけが開けます）。受け取った人か管理者に、作品の割り当てを頼んでください';
  return 'このファイルは、権限のない作品の原本として受け取られています。管理者に確認してください';
}

// 手順1の「受け取ったまま登録し終えていない原本」の見出し。表示している件数と総数が違えば、新しい何件かを表示していると書く
export function pendingListTitle({shown = 0, total = 0} = {}) {
  const all = Math.max(Number(total) || 0, Number(shown) || 0);
  return all > shown ? `受け取ったまま登録し終えていない原本（全${all}件。新しい${shown}件を表示）` : `受け取ったまま登録し終えていない原本（${all}件）`;
}

// 作品ごとの表を、手順5の確認（buildReviewRows など）で使う選択の形にする
export function partitionSelection(partition) {
  return {canonicalCsv: partition?.csv || '', sourceRowNumbers: partition?.sourceRowNumbers || [], headers: partition?.headers || []};
}

// 手順4の表の「税抜合計」。計算できない行があれば0円と書かず、保留として示す
export function partitionAmountText(amounts, yenText = (n) => `${new Intl.NumberFormat('ja-JP').format(n)}円`) {
  if (!amounts) return '列の対応を保存すると出ます';
  if (amounts.unknownAmountRows) return `保留（計算できない行${amounts.unknownAmountRows}行。計算できた分は${yenText(amounts.amountExTax)}）`;
  return yenText(amounts.amountExTax);
}
