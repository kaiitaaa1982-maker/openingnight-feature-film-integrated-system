// フォルダからの受け取りの、必ず成り立つ検査（純関数）。
// 要件は docs/requirements/revenue/folder-entry.md の FR-REV-FOLDER-008。
// 入力は読み取った表・登録予定・1通の条件・届くはずの報告・型の版・有効な報告の配列。
// DB・時刻・環境変数は読まない。落ちた検査が1つでもあれば allPass は偽（その1通は確定しない）。
// 金額は整数の円のまま足す。読めない額は 0 にしない。
import {CHECK_TYPES, evaluateChecks, integerOrNull, isIsoDate, isIsoMonth, monthRange, validateChecks} from '../../import/wizard-model.mjs';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

const LABELS = Object.freeze({
  row_count: '行数',
  totals: '合計額',
  period: '対象期間',
  linkage: '全行の紐づけ',
  round_trip: '往復の照合',
  arithmetic: '検算',
  overlap: '重なり',
});

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function sumSafe(numbers) {
  let total = 0n;
  for (const n of numbers) {
    if (!Number.isSafeInteger(n)) return null;
    total += BigInt(n);
  }
  if (total > MAX || total < -MAX) return null;
  return Number(total);
}

function safeDiff(planned, source) {
  if (!Number.isSafeInteger(planned) || !Number.isSafeInteger(source)) return null;
  const diff = BigInt(planned) - BigInt(source);
  if (diff > MAX || diff < -MAX) return null;
  return Number(diff);
}

function identityHolds(ex, tax, inc) {
  if (!Number.isSafeInteger(ex) || !Number.isSafeInteger(tax) || !Number.isSafeInteger(inc)) return false;
  return BigInt(ex) + BigInt(tax) === BigInt(inc);
}

function reasonOk(reason) {
  if (typeof reason !== 'string') return false;
  const text = reason.trim();
  return text.length >= 1 && text.length <= 500;
}

// 行番号の並び。欠け・重複は bad。set は重複の無い番号だけを持つ。
function idSet(rows) {
  const set = new Set();
  let bad = false;
  for (const row of rows) {
    const id = row && Number.isSafeInteger(row.sourceRow) ? row.sourceRow : null;
    if (id == null || set.has(id)) bad = true;
    else set.add(id);
  }
  return {bad, set};
}

function cellInteger(row, header) {
  if (!row || !row.values || typeof row.values !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(row.values, header)) return null;
  return integerOrNull(row.values[header]);
}

function cellText(values, header) {
  if (!values || typeof values !== 'object' || !Object.prototype.hasOwnProperty.call(values, header)) return null;
  return String(values[header] ?? '').trim();
}

function checkOf(key, pass, items, extra = {}) {
  return {key, label: LABELS[key], pass, items, ...extra};
}

function rowCountCheck(sourceRows, planned, excluded) {
  const source = idSet(sourceRows);
  const plan = idSet(planned);
  const excl = idSet(excluded);
  const broken = [];
  if (!source.bad) {
    for (const id of source.set) {
      const inPlan = plan.set.has(id);
      const inExcluded = excl.set.has(id);
      if (!inPlan && !inExcluded) broken.push({sourceRow: id, code: 'missing'});
      if (inPlan && inExcluded) broken.push({sourceRow: id, code: 'both'});
    }
  }
  const extra = [];
  for (const id of plan.set) if (!source.bad && !source.set.has(id)) extra.push(id);
  for (const id of excl.set) if (!source.bad && !source.set.has(id)) extra.push(id);
  const reasonMissing = excluded.filter(row => !reasonOk(row?.reason)).map(row => row?.sourceRow ?? null);
  const pass = sourceRows.length >= 1 && !source.bad && !plan.bad && !excl.bad
    && broken.length === 0 && extra.length === 0 && reasonMissing.length === 0;
  return {
    check: checkOf('row_count', pass, [{pass, code: pass ? 'ok' : 'broken'}], {broken, extra, reasonMissing}),
    source, plan, excl,
  };
}

function totalsCheck(sourceRows, planned, terms, typeVersion, exclSet) {
  const columns = asObject(typeVersion.moneyColumns);
  const headers = [
    ['amountExTax', columns.amountExTax],
    ['taxAmount', columns.taxAmount],
    ['amountIncTax', columns.amountIncTax],
  ];
  const columnsOk = headers.every(([, header]) => typeof header === 'string' && header !== '');
  const imported = sourceRows.filter(row => !exclSet.has(row?.sourceRow));
  const sourceSums = {};
  const plannedSums = {};
  for (const [key, header] of headers) {
    sourceSums[key] = columnsOk ? sumSafe(imported.map(row => cellInteger(row, header))) : null;
    plannedSums[key] = sumSafe(planned.map(line => (Number.isSafeInteger(line?.[key]) ? line[key] : null)));
  }
  const items = headers.map(([key]) => {
    const source = sourceSums[key];
    const plannedSum = plannedSums[key];
    const pass = columnsOk && source != null && plannedSum != null && source === plannedSum;
    return {field: key, pass, source, planned: plannedSum, difference: safeDiff(plannedSum, source)};
  });
  const identity = columnsOk
    && identityHolds(sourceSums.amountExTax, sourceSums.taxAmount, sourceSums.amountIncTax)
    && identityHolds(plannedSums.amountExTax, plannedSums.taxAmount, plannedSums.amountIncTax);
  items.push({field: 'identity', pass: identity});
  let declared = 'unverified';
  const declaredInput = terms.declared;
  if (declaredInput != null && typeof declaredInput === 'object') {
    for (const [key] of headers) {
      const raw = declaredInput[key];
      if (raw === undefined || raw === null || raw === '') continue;
      declared = 'checked';
      const expected = integerOrNull(raw);
      const actual = sourceSums[key];
      items.push({field: `declared_${key}`, pass: expected != null && actual != null && expected === actual, expected, actual});
    }
  }
  return checkOf('totals', items.every(item => item.pass), items, {declared});
}

function periodItem(row, terms, expected) {
  const date = row?.date == null || row.date === '' ? null : String(row.date);
  const monthField = row?.month == null || row.month === '' ? null : String(row.month);
  if (date != null && !isIsoDate(date)) return {sourceRow: row?.sourceRow ?? null, pass: false, code: 'bad_date'};
  if (monthField != null && !isIsoMonth(monthField)) return {sourceRow: row?.sourceRow ?? null, pass: false, code: 'bad_month'};
  const month = monthField || (date ? date.slice(0, 7) : null);
  if (date == null && month == null) return {sourceRow: row?.sourceRow ?? null, pass: false, code: 'missing'};
  if (date && monthField && date.slice(0, 7) !== monthField) return {sourceRow: row?.sourceRow ?? null, pass: false, code: 'mismatch'};
  if (!isIsoDate(terms.periodFrom) || !isIsoDate(terms.periodTo) || terms.periodFrom > terms.periodTo) {
    return {sourceRow: row?.sourceRow ?? null, pass: false, code: 'bad_terms'};
  }
  if (date && (date < terms.periodFrom || date > terms.periodTo)) return {sourceRow: row?.sourceRow ?? null, pass: false, code: 'outside'};
  if (!date && month) {
    const range = monthRange(month);
    if (!range || range.to < terms.periodFrom || range.from > terms.periodTo) {
      return {sourceRow: row?.sourceRow ?? null, pass: false, code: 'outside'};
    }
  }
  if (!expected || !isIsoMonth(expected.targetMonth)) return {sourceRow: row?.sourceRow ?? null, pass: false, code: 'expected_missing'};
  if (month !== expected.targetMonth) return {sourceRow: row?.sourceRow ?? null, pass: false, code: 'target_month'};
  return {sourceRow: row?.sourceRow ?? null, pass: true, code: 'ok'};
}

function periodCheck(sourceRows, terms, expected) {
  const items = sourceRows.length
    ? sourceRows.map(row => periodItem(row, terms, expected))
    : [{sourceRow: null, pass: false, code: 'empty'}];
  return checkOf('period', items.every(item => item.pass), items);
}

function linkageCheck(sourceRows, planned, terms, typeVersion, sourceSet, planSet, exclSet) {
  const splitByProduct = typeVersion.splitByProduct === true;
  const items = [];
  for (const line of planned) {
    const problems = [];
    if (!Number.isSafeInteger(line?.workId) || line.workId < 1) problems.push('work');
    if (splitByProduct && (!Number.isSafeInteger(line?.productId) || line.productId < 1)) problems.push('product');
    if (!Number.isSafeInteger(terms.partnerId) || line?.partnerId !== terms.partnerId) problems.push('partner');
    if (!sourceSet.has(line?.sourceRow)) problems.push('source');
    items.push({sourceRow: line?.sourceRow ?? null, pass: problems.length === 0, problems});
  }
  for (const row of sourceRows) {
    if (exclSet.has(row?.sourceRow) || planSet.has(row?.sourceRow)) continue;
    items.push({sourceRow: row?.sourceRow ?? null, pass: false, problems: ['missing']});
  }
  if (!items.length) items.push({sourceRow: null, pass: false, code: 'empty'});
  return checkOf('linkage', items.every(item => item.pass), items);
}

function roundTripCheck(sourceRows, headers, roundTrip, sourceSet) {
  const rows = Array.isArray(roundTrip?.rows) ? roundTrip.rows : null;
  const sameHeaders = Array.isArray(headers) && Array.isArray(roundTrip?.headers)
    && headers.length === roundTrip.headers.length && headers.every((header, index) => header === roundTrip.headers[index]);
  if (!sameHeaders || !rows) return checkOf('round_trip', false, [{pass: false, code: 'headers'}]);
  const back = idSet(rows);
  const items = [];
  if (back.bad) items.push({pass: false, code: 'duplicate'});
  for (const row of sourceRows) {
    const restored = rows.find(item => item?.sourceRow === row?.sourceRow);
    if (!restored) {
      items.push({sourceRow: row?.sourceRow ?? null, pass: false, code: 'missing', fields: []});
      continue;
    }
    const fields = [];
    for (const header of headers) {
      const left = cellText(row?.values, header);
      const right = cellText(restored.values, header);
      if (left == null || right == null || left !== right) fields.push(header);
    }
    items.push({sourceRow: row.sourceRow, pass: fields.length === 0, fields});
  }
  for (const id of back.set) if (!sourceSet.has(id)) items.push({sourceRow: id, pass: false, code: 'extra'});
  if (!items.length) items.push({pass: false, code: 'empty'});
  return checkOf('round_trip', items.every(item => item.pass), items);
}

function arithmeticCheck(sourceRows, headers, typeVersion) {
  const rules = typeVersion.checks;
  if (!Array.isArray(rules)) return checkOf('arithmetic', false, [{pass: false, code: 'invalid'}], {issues: []});
  if (!rules.length) return checkOf('arithmetic', true, [], {issues: []});
  const unknown = rules.some(rule => !rule || !CHECK_TYPES[rule.type]);
  const headerErrors = unknown ? ['invalid'] : validateChecks(rules, headers);
  if (unknown || headerErrors.length) return checkOf('arithmetic', false, [{pass: false, code: 'invalid'}], {issues: []});
  const issues = evaluateChecks(rules, sourceRows.map(row => ({sourceRow: row?.sourceRow, values: row?.values || {}})));
  const items = [];
  for (const row of sourceRows) {
    for (const rule of rules) {
      const columns = rule.type === 'required' ? [rule.column] : [rule.left, rule.right, rule.result];
      const hit = issues.some(issue => issue.sourceRow === row?.sourceRow && (issue.columns || []).some(column => columns.includes(column)));
      items.push({sourceRow: row?.sourceRow ?? null, pass: !hit, type: rule.type});
    }
  }
  if (!items.length) items.push({pass: issues.length === 0, code: issues.length ? 'issue' : 'ok'});
  return checkOf('arithmetic', items.every(item => item.pass), items, {issues});
}

function rangesOverlap(fromA, toA, fromB, toB) {
  return fromA <= toB && fromB <= toA;
}

function overlapCheck(planned, terms, activeReports) {
  if (!Array.isArray(activeReports) || !isIsoDate(terms.periodFrom) || !isIsoDate(terms.periodTo) || typeof terms.kind !== 'string' || terms.kind === '') {
    return checkOf('overlap', false, [{pass: false, code: 'unverified'}], {hits: []});
  }
  const works = new Set(planned.map(line => line?.workId).filter(id => Number.isSafeInteger(id) && id >= 1));
  const hits = [];
  for (const report of activeReports) {
    if (!report || report.partnerId !== terms.partnerId || report.kind !== terms.kind) continue;
    if (!Number.isSafeInteger(report.workId) || !isIsoDate(report.periodFrom) || !isIsoDate(report.periodTo)) {
      hits.push({id: report.id ?? null, code: 'unverified'});
      continue;
    }
    if (!works.has(report.workId)) continue;
    if (rangesOverlap(terms.periodFrom, terms.periodTo, report.periodFrom, report.periodTo)) {
      hits.push({id: report.id ?? null, code: 'overlap'});
    }
  }
  const pass = hits.length === 0;
  return checkOf('overlap', pass, [{pass, code: pass ? 'ok' : 'overlap'}], {hits});
}

// 7つの検査を一度に返す。checks の並びは行数・合計額・対象期間・全行の紐づけ・往復の照合・検算・重なり。
// passed／total は判定の1行の分母に使う項目数（行数1、合計は列3＋税込の恒等式＋申告のある項目、期間と往復と紐づけは行ごと、検算は決まり×行、重なり1）。
export function evaluateFolderChecks(input) {
  const src = asObject(input);
  const sourceRows = Array.isArray(src.source?.rows) ? src.source.rows : [];
  const headers = Array.isArray(src.source?.headers) ? src.source.headers : [];
  const planned = Array.isArray(src.planned?.lines) ? src.planned.lines : [];
  const excluded = Array.isArray(src.planned?.excluded) ? src.planned.excluded : [];
  const terms = asObject(src.terms);
  const expected = src.expected && typeof src.expected === 'object' ? src.expected : null;
  const typeVersion = asObject(src.typeVersion);
  const counted = rowCountCheck(sourceRows, planned, excluded);
  const checks = [
    counted.check,
    totalsCheck(sourceRows, planned, terms, typeVersion, counted.excl.set),
    periodCheck(sourceRows, terms, expected),
    linkageCheck(sourceRows, planned, terms, typeVersion, counted.source.set, counted.plan.set, counted.excl.set),
    roundTripCheck(sourceRows, headers, src.roundTrip, counted.source.set),
    arithmeticCheck(sourceRows, headers, typeVersion),
    overlapCheck(planned, terms, src.activeReports),
  ];
  const items = checks.flatMap(check => check.items);
  return {
    allPass: checks.every(check => check.pass),
    passed: items.filter(item => item.pass).length,
    total: items.length,
    checks,
  };
}
