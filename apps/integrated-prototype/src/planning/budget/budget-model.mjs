// 予算書の純関数（要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET。会社ルートの計画 plans/2026-10-22-folder-budget.md）。
// 合計は保存せず、明細の行から毎回導く（FR-PLAN-BUDGET-004）。原本に書かれた合計は検査の片側にだけ使う（FR-PLAN-BUDGET-010〜013）。
// 金額は税抜の整数円。消費税は総合計に1回だけ掛け、truncate で円にする（docs/rules/money.md。版が率と端数の扱いを持つ）。

import {changeInBps, taxFromBps, unitPriceTimesQty} from './money-budget.mjs';

// 費目の大分類（A〜K の11区分）。実費の行（FR-EXP-PCOST-033）と同じコードを使う（FR-PLAN-BUDGET-002）。コードは変えない
export const BUDGET_CATEGORIES = Object.freeze([
  {code: 'A', name: '企画費'},
  {code: 'B', name: '俳優費'},
  {code: 'C', name: 'プロデューサー費'},
  {code: 'D', name: 'スタッフ費'},
  {code: 'E', name: '製作準備費'},
  {code: 'F', name: '機材費'},
  {code: 'G', name: '美術・衣装費'},
  {code: 'H', name: 'ロケーション費'},
  {code: 'I', name: '音楽・効果費'},
  {code: 'J', name: '編集・MA費'},
  {code: 'K', name: 'プリント・制作諸費'},
].map(Object.freeze));
export const CATEGORY_CODES = Object.freeze(BUDGET_CATEGORIES.map((category) => category.code));
const CATEGORY_BY_CODE = new Map(BUDGET_CATEGORIES.map((category) => [category.code, category]));

export const DEFAULT_TAX_RATE_BPS = 1000;
// 「前の版から区分が大きく動いた」の目安（知らせるだけ。FR-PLAN-BUDGET-015）。仮置き
export const LARGE_CHANGE_BPS = 2000;

// 見出しや区分の名前を照らすための正規化（全角の英数字・空白・括弧のゆれを消す）
export function normalizeLabel(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\s　・･]/g, '').replace(/[()（）]/g, '').toLowerCase();
}

// 区分の小計の行の名前（例「A 企画費」「F　機材費」「J 編集・MA費　」）から区分コードを導く。A〜K に当たらなければ null
export function categoryFromLabel(label) {
  const text = String(label ?? '').normalize('NFKC').trim();
  const match = text.match(/^([A-Za-z])[\s　.．:：]*(.*)$/u);
  if (!match) return null;
  const code = match[1].toUpperCase();
  const category = CATEGORY_BY_CODE.get(code);
  if (!category) return null;
  // 名前が書いてあれば、区分の名前と食い違わないこと（「A」だけの行は名前を見ない）
  const name = normalizeLabel(match[2]);
  if (name && !normalizeLabel(category.name).startsWith(name.slice(0, 2))) return null;
  return code;
}

const isYen = (value) => Number.isSafeInteger(value) && value >= 0;

// 版の合計を明細から導く（FR-PLAN-BUDGET-004・005）。lines は {categoryCode, amountExTaxYen, departmentId?}
export function budgetTotals({lines = [], managementFeeYen = 0, contingencyYen = 0, taxRateBps = DEFAULT_TAX_RATE_BPS} = {}) {
  for (const value of [managementFeeYen ?? 0, contingencyYen ?? 0]) if (!isYen(value)) throw new Error('制作管理費・予備費は0以上の整数円です');
  if (!Number.isSafeInteger(taxRateBps) || taxRateBps < 0 || taxRateBps >= 10000) throw new Error('税率は0〜9999 bps です');
  const sums = new Map(CATEGORY_CODES.map((code) => [code, {subtotalYen: 0, lineCount: 0}]));
  for (const line of lines) {
    const entry = sums.get(line.categoryCode);
    if (!entry) throw new Error(`区分 ${line.categoryCode} は A〜K のどれでもありません`);
    if (!isYen(line.amountExTaxYen)) throw new Error('行の税抜額は0以上の整数円です');
    entry.subtotalYen += line.amountExTaxYen;
    entry.lineCount += 1;
  }
  const byCategory = BUDGET_CATEGORIES.map((category) => ({code: category.code, name: category.name, ...sums.get(category.code)}));
  const directYen = byCategory.reduce((sum, row) => sum + row.subtotalYen, 0);
  const totalExTaxYen = directYen + (managementFeeYen ?? 0) + (contingencyYen ?? 0);
  const taxYen = taxFromBps(totalExTaxYen, taxRateBps);
  return {byCategory, directYen, managementFeeYen: managementFeeYen ?? 0, contingencyYen: contingencyYen ?? 0, totalExTaxYen, taxRateBps, taxYen,
    totalIncTaxYen: totalExTaxYen + taxYen};
}

// 部署ごとの小計（FR-PLAN-BUDGET-006）。部署の無い行は null の部署にまとめる
export function departmentTotals(lines = []) {
  const sums = new Map();
  for (const line of lines) {
    const key = line.departmentId ?? null;
    const entry = sums.get(key) ?? {departmentId: key, subtotalYen: 0, lineCount: 0};
    entry.subtotalYen += line.amountExTaxYen;
    entry.lineCount += 1;
    sums.set(key, entry);
  }
  return [...sums.values()].sort((a, b) => (a.departmentId == null) - (b.departmentId == null) || (a.departmentId ?? 0) - (b.departmentId ?? 0));
}

// 2つの版を比べる（FR-PLAN-BUDGET-016）。区分ごとの差と、区分の中の行の足し・消し・変更。行は区分と費目名で照らす
export function compareBudgetVersions(before, after) {
  const totalsOf = (version) => budgetTotals(version);
  const a = totalsOf(before);
  const b = totalsOf(after);
  const key = (line) => `${line.categoryCode}\u0000${normalizeLabel(line.name)}`;
  const index = (lines) => { const map = new Map(); for (const line of lines ?? []) map.set(key(line), (map.get(key(line)) ?? 0) + line.amountExTaxYen); return map; };
  const beforeLines = index(before.lines);
  const afterLines = index(after.lines);
  const names = new Map([...(before.lines ?? []), ...(after.lines ?? [])].map((line) => [key(line), line.name]));
  const categories = a.byCategory.map((row, i) => {
    const next = b.byCategory[i];
    const lines = [];
    for (const [lineKey, name] of names) {
      if (!lineKey.startsWith(`${row.code}\u0000`)) continue;
      const from = beforeLines.get(lineKey) ?? null;
      const to = afterLines.get(lineKey) ?? null;
      if (from === to) continue;
      lines.push({name, beforeYen: from, afterYen: to, kind: from == null ? 'added' : to == null ? 'removed' : 'changed', diffYen: (to ?? 0) - (from ?? 0)});
    }
    const diffYen = next.subtotalYen - row.subtotalYen;
    const changeBps = changeInBps(diffYen, row.subtotalYen);
    return {code: row.code, name: row.name, beforeYen: row.subtotalYen, afterYen: next.subtotalYen, diffYen, changeBps,
      large: row.subtotalYen > 0 ? Math.abs(diffYen) * 10000 >= row.subtotalYen * LARGE_CHANGE_BPS : next.subtotalYen > 0, lines};
  });
  return {categories, before: a, after: b, totalDiffYen: b.totalExTaxYen - a.totalExTaxYen};
}

// 原本に書かれた合計と、明細から導いた合計を照らす（FR-PLAN-BUDGET-010〜014）。parsed は readBudgetSheet の結果。
// 返すのは検査ごとの {key, ok, label, statedYen, derivedYen, cell}。原本に合計が無いものは ok: null（飛ばした）
export function checkParsedBudget(parsed, {taxRateBps = DEFAULT_TAX_RATE_BPS} = {}) {
  const totals = budgetTotals({lines: parsed.lines, managementFeeYen: parsed.stated.managementFeeYen ?? 0, contingencyYen: parsed.stated.contingencyYen ?? 0, taxRateBps});
  const checks = [];
  const compare = (key, label, stated, derivedYen) => {
    if (stated == null || stated.yen == null) { checks.push({key, ok: null, label, statedYen: null, derivedYen, cell: stated?.cell ?? null}); return; }
    checks.push({key, ok: stated.yen === derivedYen, label, statedYen: stated.yen, derivedYen, cell: stated.cell});
  };
  for (const row of totals.byCategory) {
    const stated = parsed.categories[row.code];
    if (!stated) continue;
    compare(`subtotal:${row.code}`, `${row.code} ${row.name}の小計`, stated.subtotal, row.subtotalYen);
  }
  compare('direct', '直接制作費の合計', parsed.stated.direct, totals.directYen);
  compare('subtotal_with_fee', '直接制作費＋制作管理費', parsed.stated.subtotalWithFee, totals.directYen + totals.managementFeeYen);
  compare('total', '総合計（税抜）', parsed.stated.total, totals.totalExTaxYen);
  compare('estimate', '制作費見積り（税抜）', parsed.stated.estimate, totals.totalExTaxYen);
  compare('tax', '消費税', parsed.stated.tax, totals.taxYen);
  compare('total_inc_tax', '合計金額（税込）', parsed.stated.totalIncTax, totals.totalIncTaxYen);
  // 区分の小計の行に当たらない明細（FR-PLAN-BUDGET-011）
  checks.push({key: 'uncategorized', ok: parsed.uncategorized.length === 0, label: '区分の無い行', count: parsed.uncategorized.length,
    cells: parsed.uncategorized.map((line) => line.cell)});
  checks.push({key: 'unknown_category', ok: parsed.unknownSubtotals.length === 0, label: 'A〜K に当たらない区分', count: parsed.unknownSubtotals.length,
    cells: parsed.unknownSubtotals.map((row) => row.cell)});
  // 数式だけで保存された値の無い金額のセル（Excel で開いて保存していないブック）。値が読めないので照らせない
  checks.push({key: 'without_value', ok: (parsed.withoutValue ?? []).length === 0, label: '値の保存されていない数式', count: (parsed.withoutValue ?? []).length,
    cells: parsed.withoutValue ?? []});
  // 内訳を別のシートから足す行: 原本に保存された行の額（SUMIF・SUM の結果）＝内訳の和（FR-PLAN-BUDGET-030）。範囲の外の内訳の行は SUMIF の範囲漏れ
  for (const check of parsed.breakdownChecks ?? []) {
    checks.push({key: `breakdown:${check.cell}`, ok: check.ok, label: `${check.name ?? ''}の内訳（${check.sheet ?? 'シートなし'}）`, statedYen: check.statedYen, derivedYen: check.derivedYen,
      cell: check.cell, reason: check.reason, cells: check.outside});
  }
  // 小計の行の並びから当てた区分（名前で分からなかった行）。確定は止めないが、人が確かめる（ok は判定なし）
  if ((parsed.inferredCategories ?? []).length) checks.push({key: 'inferred_category', ok: null, label: '並びから当てた区分', count: parsed.inferredCategories.length,
    cells: parsed.inferredCategories.map((c) => `${c.cell}→${c.code}`)});
  // 整数でない円の値（端数を出す式）。丸めて読まない
  checks.push({key: 'fractional_yen', ok: (parsed.fractional ?? []).length === 0, label: '円未満の端数のある額', count: (parsed.fractional ?? []).length,
    cells: parsed.fractional ?? []});
  return {checks, totals};
}

// 知らせるだけの検査（確定を止めない。FR-PLAN-BUDGET-015）: 単価×数量と金額の食い違い・セルの色から起こした確定の印
export function noticesForLines(lines = []) {
  const notices = [];
  for (const line of lines) {
    const productYen = line.unitPriceYen != null && line.qtyMilli != null ? unitPriceTimesQty(line.unitPriceYen, line.qtyMilli) : null;
    if (productYen != null && line.amountExTaxYen !== productYen) {
      notices.push({kind: 'unit_price_qty', cell: line.cell, name: line.name, amountExTaxYen: line.amountExTaxYen, productYen});
    }
    for (const mark of line.marks ?? []) notices.push({kind: mark, cell: line.cell, name: line.name});
  }
  return notices;
}

// 判定の1行（FR-PLAN-BUDGET-017）。落ちた検査が1つでもあれば「例外あり」で確定できない
export function budgetVerdict(checks = []) {
  const judged = checks.filter((check) => check.ok !== null);
  const failed = judged.filter((check) => check.ok === false);
  return {kind: failed.length ? 'exceptions' : 'draft_ok', failed: failed.length, passed: judged.length - failed.length, total: judged.length,
    failedKeys: failed.map((check) => check.key)};
}

// 比べる相手との差（知らせるだけ。FR-PLAN-BUDGET-015）。相手は企画の試算の製作費・制作費の版・受託の総製作費・作品の費用の版
export function referenceDiffs(totalExTaxYen, references = {}) {
  const labels = {estimate: '企画の試算', productionCost: '制作費の版（線）', contractProduction: '受託の総製作費', workFinance: '作品の費用の版'};
  return Object.entries(labels).filter(([key]) => isYen(references[key])).map(([key, label]) => ({
    key, label, referenceYen: references[key], diffYen: totalExTaxYen - references[key],
    over: key === 'productionCost' ? totalExTaxYen !== references[key] : totalExTaxYen > references[key]}));
}

// 作品画面の進み具合（全業務共通の folderStatusForWork。予算書は作品から案件をたどって返す。会社ルートの計画の約束10）
export function budgetFolderState({versions = [], fixes = [], latestVerdict = null} = {}) {
  const fixed = currentFixedVersionNo(fixes);
  const latestNo = versions.reduce((max, version) => Math.max(max, version.versionNo), 0);
  if (!latestNo) return {state: 'not_started', done: 0, total: 1, reason: '版なし'};
  if (fixed != null) return {state: 'done', done: 1, total: 1, reason: latestNo > fixed ? `確定 rev${fixed}・下書き rev${latestNo}` : `確定 rev${fixed}`};
  if (latestVerdict?.kind === 'exceptions') return {state: 'needs_review', done: 0, total: 1, reason: `例外 ${latestVerdict.failed}`};
  return {state: 'in_progress', done: 0, total: 1, reason: `下書き rev${latestNo}`};
}

// 確定の記録（追加だけ）から、いまの確定版の番号を導く。取り消しの行は action 'void' で、その時点の確定を外す（FR-PLAN-BUDGET-019）
export function currentFixedVersionNo(fixes = []) {
  const ordered = [...fixes].sort((a, b) => a.seq - b.seq);
  let current = null;
  for (const fix of ordered) current = fix.action === 'void' ? null : fix.versionNo;
  return current;
}

// 画面から足す版の本文を整える（FR-PLAN-BUDGET-001・003）。行は {categoryCode, name, amountExTaxYen, unitPriceYen?, qtyMilli?, unit?, workId?, departmentId?,
// paymentMonth?, confirmed?, note?}。区分の中の行番号は並び順で振り直す。誤りは欄ごとの文で返す
export function normalizeBudgetVersionInput(input = {}, {workIds = []} = {}) {
  const errors = [];
  const int = (value, label, {min = 0, max = 1000000000000, optional = false} = {}) => {
    if (value == null || value === '') { if (!optional) errors.push(`${label}を入れてください`); return null; }
    const n = typeof value === 'string' ? Number(value.replace(/[,，]/g, '')) : value;
    if (!Number.isSafeInteger(n) || n < min || n > max) { errors.push(`${label}は${min}〜${max}の整数です`); return null; }
    return n;
  };
  const text = (value, label, max, {optional = true} = {}) => {
    const s = value == null ? '' : String(value).trim();
    if (!s) { if (!optional) errors.push(`${label}を入れてください`); return null; }
    if (s.length > max) { errors.push(`${label}は${max}字までです`); return null; }
    return s;
  };
  const reason = text(input.reason, '理由', 1000, {optional: false});
  const title = text(input.title, '題', 200);
  const managementFeeYen = int(input.managementFeeYen ?? 0, '制作管理費');
  const contingencyYen = int(input.contingencyYen ?? 0, '予備費（計画）');
  const taxRateBps = int(input.taxRateBps ?? DEFAULT_TAX_RATE_BPS, '税率', {max: 9999});
  const rows = Array.isArray(input.lines) ? input.lines : [];
  if (rows.length > 1000) errors.push('行は1000行までです');
  const counters = new Map();
  const works = new Set(workIds.map(Number));
  const lines = [];
  rows.forEach((row, i) => {
    const at = `${i + 1}行目の`;
    const categoryCode = String(row?.categoryCode ?? '').trim().toUpperCase();
    if (!CATEGORY_CODES.includes(categoryCode)) { errors.push(`${at}区分は A〜K のどれかです`); return; }
    const name = text(row.name, `${at}費目名`, 200, {optional: false});
    const amountExTaxYen = int(row.amountExTaxYen, `${at}税抜額`);
    const unitPriceYen = int(row.unitPriceYen, `${at}単価`, {optional: true});
    const qtyMilli = int(row.qtyMilli, `${at}数量`, {max: 1000000000, optional: true});
    const workId = row.workId == null || row.workId === '' ? null : Number(row.workId);
    if (workId != null && !works.has(workId)) errors.push(`${at}作品はこの案件の作品ではありません`);
    const departmentId = int(row.departmentId, `${at}部署`, {min: 1, max: Number.MAX_SAFE_INTEGER, optional: true});
    const paymentMonth = row.paymentMonth == null || row.paymentMonth === '' ? null : String(row.paymentMonth);
    if (paymentMonth != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(paymentMonth)) errors.push(`${at}支払予定月は YYYY-MM です`);
    // 内訳（キャストリストなど）。行の金額は内訳の和（FR-PLAN-BUDGET-029）。和と違う金額が来たら断る
    let breakdown = null;
    if (row.breakdown && Array.isArray(row.breakdown.items)) {
      const sheetLabel = text(row.breakdown.sheet, `${at}内訳のシート名`, 31) ?? '内訳';
      const items = [];
      row.breakdown.items.forEach((item, j) => {
        const label = text(item?.label, `${at}内訳${j + 1}の名目`, 200, {optional: false});
        const itemAmount = int(item?.amountExTaxYen, `${at}内訳${j + 1}の金額`);
        items.push({itemNo: j + 1, label, amountExTaxYen: itemAmount, qtyMilli: int(item?.qtyMilli, `${at}内訳${j + 1}の数量`, {max: 1000000000, optional: true}),
          unitPriceYen: int(item?.unitPriceYen, `${at}内訳${j + 1}の単価`, {optional: true}), castingRef: text(item?.castingRef, `${at}内訳${j + 1}のキャスト`, 80),
          sourceCell: text(item?.sourceCell, `${at}内訳${j + 1}のセル`, 40)});
      });
      if (items.length > 500) errors.push(`${at}内訳は500行までです`);
      const sum = items.reduce((total, item) => total + (item.amountExTaxYen ?? 0), 0);
      if (amountExTaxYen != null && amountExTaxYen !== sum) errors.push(`${at}税抜額は内訳の和（${sum}）と同じにしてください`);
      breakdown = {sheet: sheetLabel, items};
    }
    const lineNo = (counters.get(categoryCode) ?? 0) + 1;
    counters.set(categoryCode, lineNo);
    lines.push({categoryCode, lineNo, name, amountExTaxYen, unitPriceYen, qtyMilli, unit: text(row.unit, `${at}単位`, 20), workId, departmentId, paymentMonth,
      confirmedSource: row.confirmedSource === 'fill' ? 'fill' : row.confirmed ? 'manual' : 'none', sourceCell: text(row.sourceCell, `${at}セル`, 12),
      note: text(row.note, `${at}メモ`, 500), ...(breakdown ? {breakdown} : {})});
  });
  if (errors.length) return {ok: false, errors};
  return {ok: true, value: {reason, title, managementFeeYen, contingencyYen, taxRateBps, lines}};
}

// 読んだ予算書から版の本文を作る（行の番号は区分の中の並び順。確定の印はセルの色なら fill）
export function versionInputFromParsed(parsed, {reason, title} = {}) {
  return {reason, title, managementFeeYen: parsed.stated.managementFeeYen ?? 0, contingencyYen: parsed.stated.contingencyYen ?? 0,
    taxRateBps: DEFAULT_TAX_RATE_BPS,
    lines: parsed.lines.map((line) => ({categoryCode: line.categoryCode, name: line.name, amountExTaxYen: line.amountExTaxYen, unitPriceYen: line.unitPriceYen,
      qtyMilli: line.qtyMilli, unit: line.unit, confirmedSource: line.confirmed ? 'fill' : 'none', sourceCell: line.cell,
      ...(line.breakdown ? {breakdown: {sheet: line.breakdown.sheet, items: line.breakdown.items.map((item) => ({label: item.label, qtyMilli: item.qtyMilli,
        unitPriceYen: item.unitPriceYen, amountExTaxYen: item.amountExTaxYen, sourceCell: item.cell}))}} : {})}))};
}

// 画面で作った版の検査（原本の合計が無いので、合計の照合は未判定。区分の無い行などは整える段で止める）
export function checkScreenVersion(value) {
  return checkParsedBudget({lines: value.lines, categories: {}, uncategorized: [], unknownSubtotals: [], withoutValue: [],
    stated: {managementFeeYen: value.managementFeeYen, contingencyYen: value.contingencyYen}}, {taxRateBps: value.taxRateBps});
}

// 検査の結果を表に残す形（判定・合否の数・検査ごとの結果）
export function checkRunRecord(checks) {
  const verdict = budgetVerdict(checks);
  return {verdict: verdict.kind, passed: verdict.passed, failed: verdict.failed, checks};
}

// 型の費目を整える（FR-PLAN-BUDGET-032）。行は {categoryCode, name, unit?, unitPriceYen?, qtyMilli?, breakdownSheet?, note?}。区分の中の行番号は並び順で振り直す。
// 同じ区分に同じ名前の費目を2つ置かない（型を足していくときに重ならないように）
export function normalizeTemplateItems(rows = []) {
  const errors = [];
  if (!Array.isArray(rows) || rows.length > 1000) return {ok: false, errors: ['費目は1000行までです']};
  const counters = new Map();
  const seen = new Set();
  const items = [];
  rows.forEach((row, i) => {
    const at = `${i + 1}行目の`;
    const categoryCode = String(row?.categoryCode ?? '').trim().toUpperCase();
    if (!CATEGORY_CODES.includes(categoryCode)) { errors.push(`${at}区分は A〜K のどれかです`); return; }
    const name = String(row?.name ?? '').trim();
    if (!name || name.length > 200) { errors.push(`${at}費目名を200字までで入れてください`); return; }
    const key = `${categoryCode}\u0000${normalizeLabel(name)}`;
    if (seen.has(key)) { errors.push(`${at}費目「${name}」は ${categoryCode} にもうあります`); return; }
    seen.add(key);
    const optionalInt = (value, label, max) => {
      if (value == null || value === '') return null;
      if (!Number.isSafeInteger(value) || value < 0 || value > max) { errors.push(`${at}${label}は0〜${max}の整数です`); return null; }
      return value;
    };
    const lineNo = (counters.get(categoryCode) ?? 0) + 1;
    counters.set(categoryCode, lineNo);
    const sheet = row?.breakdownSheet == null || row.breakdownSheet === '' ? null : String(row.breakdownSheet).trim().slice(0, 31);
    items.push({categoryCode, lineNo, name, unit: row?.unit ? String(row.unit).trim().slice(0, 20) : null, unitPriceYen: optionalInt(row?.unitPriceYen, '単価', 1000000000000),
      qtyMilli: optionalInt(row?.qtyMilli, '数量', 1000000000), breakdownSheet: sheet, note: row?.note ? String(row.note).trim().slice(0, 500) : null});
  });
  if (errors.length) return {ok: false, errors};
  return {ok: true, items};
}

// 予算書の行（版・読んだ予算書）から型の費目を作る。額は持たず、単価・数量・単位・内訳のシートの名前だけを写す
export function templateItemsFromLines(lines = []) {
  return lines.map((line) => ({categoryCode: line.categoryCode, name: line.name, unit: line.unit ?? null, unitPriceYen: line.unitPriceYen ?? null,
    qtyMilli: line.qtyMilli ?? null, breakdownSheet: line.breakdown?.sheet ?? null}));
}

// 型に費目を足す（「型にも足す」）。今の版の費目のあとに、区分ごとに足す。同じ名前は足さない
export function addItemsToTemplate(current = [], additions = []) {
  const ordered = [];
  for (const code of CATEGORY_CODES) {
    ordered.push(...current.filter((item) => item.categoryCode === code));
    ordered.push(...additions.filter((item) => String(item.categoryCode ?? '').toUpperCase() === code));
  }
  return normalizeTemplateItems(ordered);
}
