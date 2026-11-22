// 予算書の読み取りの定義（データ）を検査し、読み取りが使う形に整える純関数（要件 FR-PLAN-BUDGET-035〜041。
// 会社ルートの plans/2026-11-12-ingest-definitions.md の手順4）。
// 定義が持つのは語の一覧と、コードが持つ決まった名前（読み方・行き先）の選択だけ。正規表現は持たない（決定1）。
// 語はただの文字として当てる。当て方は4つの名前から選ぶ:
//   equals   正規化した文字と同じ
//   prefix   正規化した文字の先頭
//   contains 正規化した文字のどこか（部分一致）
//   words    日本語などの語は部分一致、英字だけの語は語の境（前後が a〜z でない）で当てる（"dit" は "additional" に当てない）
// 知らない読み方・知らないキー・決まった集合に無い行き先・空の語は、定義の検査で断る。定義がどう書かれていても破れない検査
// （金額は整数円・小計と総合計の照合・区分は A〜K）は、読み取りと budget-model.mjs の検査がコードで持つ。
import {CATEGORY_CODES, normalizeLabel} from './budget-model.mjs';

export const MATCH_KINDS = Object.freeze(['equals', 'prefix', 'contains', 'words']);
// 区分の行き先: A〜K と、制作管理費・予備費
export const CATEGORY_TARGETS = Object.freeze([...CATEGORY_CODES, 'managementFee', 'contingency']);
export const TOTAL_TARGETS = Object.freeze(['direct', 'managementFee', 'contingency', 'total', 'subtotalWithFee']);
export const SUMMARY_TARGETS = Object.freeze(['estimate', 'tax', 'totalIncTax']);
export const HEADER_FIELD_TARGETS = Object.freeze(['createdOn']);
export const IGNORE_TARGETS = Object.freeze(['cast_table']);
const BREAKDOWN_KEYS = Object.freeze(['amountHeader', 'label', 'qty', 'unitPrice']);
const COMMON_KEYS = Object.freeze(['kind', 'name', 'read', 'header', 'summary', 'headerFields', 'notes', 'confirmedFills']);

// 読み方。定義はこの中から選ぶだけで、読み方を作れない。新しい読み方はコードの PR で足す
export const READ_LAYOUTS = Object.freeze({
  // 「科目」の右に単価・数量・金額が並ぶ区画（左右に2つまで）。区分は「A 企画費 … 小計」の行で閉じる
  category_blocks: Object.freeze({
    subtotal: Object.freeze(['marker_row']), category: Object.freeze(['letter_prefix_then_order']),
    roles: Object.freeze(['name', 'unitPrice', 'qty', 'unit', 'amount', 'amountIncTax', 'actual']), requiredRoles: Object.freeze(['name', 'amount']),
    keys: Object.freeze([...COMMON_KEYS, 'subtotalMarkers', 'totals', 'ignore', 'breakdown']), required: Object.freeze(['subtotalMarkers', 'totals']),
    // 原本の合計を照らすために、合計の行の語の行き先として必ず持つもの（総合計・制作管理費。FR-PLAN-BUDGET-041）
    requiredTotals: Object.freeze(['total', 'managementFee']),
  }),
  // Code・Detail・Description の1区画。区分の小計は合計の列の範囲の SUM。区分は小計の名前の語、決まらなければ範囲の明細の語の多数
  code_detail: Object.freeze({
    subtotal: Object.freeze(['sum_range_of_amount_column']), category: Object.freeze(['words_then_line_majority']),
    roles: Object.freeze(['code', 'name', 'description', 'qty', 'unitPrice', 'unit', 'amount']), requiredRoles: Object.freeze(['name', 'description', 'amount']),
    keys: Object.freeze([...COMMON_KEYS, 'grandTotal', 'categories']), required: Object.freeze(['categories', 'grandTotal']),
    requiredTotals: Object.freeze([]),
  }),
});

const LIMITS = Object.freeze({words: 100, wordLength: 60, rules: 100, fills: 10, nameLength: 100, jsonLength: 32768});

// 見出し・合計の名前などは normalizeLabel（全角・空白・括弧・「・」のゆれを消す）、区分の語は NFKC と小文字だけ（空白を残す）
const NORMALIZERS = Object.freeze({
  label: normalizeLabel,
  text: (value) => String(value ?? '').normalize('NFKC').toLowerCase(),
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// 誤りの文に値を出す（文字でない値も止めずに出す）
const show = (value) => (typeof value === 'string' ? value : JSON.stringify(value) ?? String(value));
// 決まった名前の表から引く。継承したプロパティ（constructor・toString・__proto__ など）は引かない
const ownValue = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);
const isAscii = (word) => [...word].every((ch) => ch.charCodeAt(0) < 128);
const isLatinLetter = (ch) => ch !== undefined && ch >= 'a' && ch <= 'z';

// 英字の語を語の境で探す（前後の1字が a〜z でなければ当たり）。正規表現を組み立てない
function includesAtWordBoundary(text, word) {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    if (!isLatinLetter(text[at - 1]) && !isLatinLetter(text[at + word.length])) return true;
  }
  return false;
}

const TESTS = Object.freeze({
  equals: (text, word) => text === word,
  prefix: (text, word) => text.startsWith(word),
  contains: (text, word) => text.includes(word),
  words: (text, word) => (isAscii(word) ? includesAtWordBoundary(text, word) : text.includes(word)),
});

// 当て方（{equals|prefix|contains|words: [語…]} のどれか1つ）を検査し、語を正規化した当て方を返す。誤りは errors に足す
function compileMatcher(value, path, errors, normalize, {allowed = MATCH_KINDS, extraKeys = []} = {}) {
  if (!isPlainObject(value)) { errors.push(`${path} は当て方（${allowed.join('・')} のどれか）を持つ形にしてください`); return null; }
  const keys = Object.keys(value).filter((key) => !extraKeys.includes(key));
  const kinds = keys.filter((key) => MATCH_KINDS.includes(key));
  for (const key of keys) if (!MATCH_KINDS.includes(key)) errors.push(`${path} に知らないキー「${key}」があります`);
  if (kinds.length !== 1) { errors.push(`${path} は当て方を1つだけ持ってください（${allowed.join('・')}）`); return null; }
  const kind = kinds[0];
  if (!allowed.includes(kind)) { errors.push(`${path} の当て方「${kind}」はここでは使えません（${allowed.join('・')}）`); return null; }
  const words = compileWords(value[kind], `${path}.${kind}`, errors, normalize);
  if (!words) return null;
  const test = TESTS[kind];
  return Object.freeze({kind, words, test: (raw) => { const text = normalize(raw); return text !== '' && words.some((word) => test(text, word)); }});
}

function compileWords(list, path, errors, normalize) {
  if (!Array.isArray(list) || !list.length) { errors.push(`${path} は1つ以上の語の一覧にしてください`); return null; }
  if (list.length > LIMITS.words) { errors.push(`${path} の語は${LIMITS.words}個までです`); return null; }
  const words = [];
  list.forEach((word, i) => {
    if (typeof word !== 'string') { errors.push(`${path}[${i}] は文字にしてください`); return; }
    if (word.length > LIMITS.wordLength) { errors.push(`${path}[${i}] は${LIMITS.wordLength}字までです`); return; }
    const normalized = normalize(word);
    if (!normalized.trim()) { errors.push(`${path}[${i}] が空です（空白・括弧だけの語は当てられません）`); return; }
    // 記号だけの語（"-" など）と ASCII の1字の語（"a"）は、ほとんどの文字に当たってしまうので断る。日本語などは1字でも通す（見出しの「数」）
    if (![...normalized].some((ch) => /[\p{L}\p{N}]/u.test(ch))) { errors.push(`${path}[${i}]「${word}」は記号だけの語です（文字か数字を含めてください）`); return; }
    if (isAscii(normalized.trim()) && normalized.trim().length === 1) { errors.push(`${path}[${i}]「${word}」は英数字1字の語です（2字以上にしてください）`); return; }
    words.push(normalized);
  });
  return words.length === list.length ? Object.freeze(words) : null;
}

// 行き先つきの当て方の一覧（[{to, equals|…}]）
function compileRules(list, path, errors, normalize, targets, {allowed = MATCH_KINDS} = {}) {
  if (!Array.isArray(list)) { errors.push(`${path} は一覧にしてください`); return null; }
  if (list.length > LIMITS.rules) { errors.push(`${path} は${LIMITS.rules}行までです`); return null; }
  const rules = [];
  list.forEach((rule, i) => {
    const at = `${path}[${i}]`;
    if (!isPlainObject(rule)) { errors.push(`${at} は {to, 当て方} の形にしてください`); return; }
    if (!targets.includes(rule.to)) { errors.push(`${at}.to「${show(rule.to)}」は決まった行き先（${targets.join('・')}）のどれでもありません`); return; }
    const matcher = compileMatcher(rule, at, errors, normalize, {allowed, extraKeys: ['to']});
    if (matcher) rules.push(Object.freeze({to: rule.to, ...matcher}));
  });
  return rules.length === list.length ? Object.freeze(rules) : null;
}

const unknownKeys = (value, allowed, path, errors) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${path}に知らないキー「${key}」があります`);
};

// 定義を検査する。通れば読み取りが使う形（compiled）を返す。誤りは「どこが・なぜ」を1行ずつ返す
export function checkBudgetReadDefinition(definition) {
  const errors = [];
  if (!isPlainObject(definition)) return {ok: false, errors: ['定義は JSON のオブジェクトにしてください']};
  let text;
  try { text = JSON.stringify(definition); } catch { return {ok: false, errors: ['定義を JSON にできません']}; }
  if (text.length > LIMITS.jsonLength) return {ok: false, errors: [`定義は JSON で${LIMITS.jsonLength}字までです`]};
  if (definition.kind !== 'budget') errors.push('kind は "budget" にしてください');
  if (typeof definition.name !== 'string' || !definition.name.trim() || definition.name.length > LIMITS.nameLength) errors.push(`name は1〜${LIMITS.nameLength}字の文字にしてください`);
  const read = definition.read;
  const layout = isPlainObject(read) ? ownValue(READ_LAYOUTS, read.layout) : undefined;
  if (!isPlainObject(read)) errors.push('read（読み方）を {layout, subtotal, category} の形で書いてください');
  else if (!layout) errors.push(`read.layout「${show(read.layout)}」は決まった読み方（${Object.keys(READ_LAYOUTS).join('・')}）のどれでもありません`);
  if (!layout) return {ok: false, errors};
  unknownKeys(read, ['layout', 'subtotal', 'category'], 'read ', errors);
  if (!layout.subtotal.includes(read.subtotal)) errors.push(`read.subtotal「${show(read.subtotal)}」は ${read.layout} の読み方（${layout.subtotal.join('・')}）にありません`);
  if (!layout.category.includes(read.category)) errors.push(`read.category「${show(read.category)}」は ${read.layout} の読み方（${layout.category.join('・')}）にありません`);
  unknownKeys(definition, layout.keys, '定義', errors);
  for (const key of ['header', ...layout.required]) if (definition[key] === undefined) errors.push(`${key} がありません（${read.layout} では必ず書きます）`);

  // 見出しの役: 役ごとに見出しの語（正規化した文字と同じものを当てる）。同じ語を2つの役に書かない
  const roles = new Map();
  const header = definition.header;
  if (header !== undefined) {
    if (!isPlainObject(header) || !isPlainObject(header.roles)) errors.push('header は {roles: {役: [語…]}} の形にしてください');
    else {
      unknownKeys(header, ['roles'], 'header ', errors);
      for (const [role, list] of Object.entries(header.roles)) {
        if (!layout.roles.includes(role)) { errors.push(`header.roles の役「${role}」は ${read.layout} の役（${layout.roles.join('・')}）にありません`); continue; }
        const words = compileWords(list, `header.roles.${role}`, errors, NORMALIZERS.label);
        for (const word of words ?? []) {
          if (roles.has(word) && roles.get(word) !== role) errors.push(`見出しの語「${word}」が ${roles.get(word)} と ${role} の両方にあります`);
          else roles.set(word, role);
        }
      }
      for (const role of layout.requiredRoles) if (!Object.hasOwn(header.roles, role)) errors.push(`header.roles に ${role} の語がありません（${read.layout} では必ず書きます）`);
    }
  }
  const optionalRules = (key, targets, normalize, options) => (definition[key] === undefined ? Object.freeze([]) : compileRules(definition[key], key, errors, normalize, targets, options));
  const optionalMatcher = (value, path, normalize) => (value === undefined ? null : compileMatcher(value, path, errors, normalize));
  const summary = optionalRules('summary', SUMMARY_TARGETS, NORMALIZERS.label);
  const headerFields = optionalRules('headerFields', HEADER_FIELD_TARGETS, NORMALIZERS.label);
  const notes = optionalMatcher(definition.notes, 'notes', NORMALIZERS.label);
  let confirmedFills = Object.freeze([]);
  if (definition.confirmedFills !== undefined) {
    const fills = definition.confirmedFills;
    if (!Array.isArray(fills) || fills.length > LIMITS.fills || fills.some((fill) => typeof fill !== 'string' || !/^[0-9A-Fa-f]{6}$/.test(fill))) {
      errors.push(`confirmedFills は16進6桁の色（例 "FFFF00"）の一覧（${LIMITS.fills}個まで）にしてください`);
    } else confirmedFills = Object.freeze(fills.map((fill) => fill.toUpperCase()));
  }
  const compiled = {kind: 'budget', name: definition.name, layout: read.layout, subtotal: read.subtotal, category: read.category,
    roles, summary, headerFields, notes, confirmedFills};

  if (read.layout === 'category_blocks') {
    compiled.subtotalMarkers = definition.subtotalMarkers === undefined ? null : compileWords(definition.subtotalMarkers, 'subtotalMarkers', errors, NORMALIZERS.label);
    compiled.totals = optionalRules('totals', TOTAL_TARGETS, NORMALIZERS.label);
    if (definition.totals !== undefined && compiled.totals) {
      for (const target of layout.requiredTotals) if (!compiled.totals.some((rule) => rule.to === target)) errors.push(`totals に ${target} の行き先がありません（原本の合計を照らすので ${read.layout} では必ず書きます）`);
    }
    compiled.ignore = optionalRules('ignore', IGNORE_TARGETS, NORMALIZERS.label);
    const breakdown = definition.breakdown;
    compiled.breakdown = {};
    if (breakdown !== undefined) {
      if (!isPlainObject(breakdown)) errors.push('breakdown は {amountHeader, label, qty, unitPrice} の当て方の形にしてください');
      else {
        unknownKeys(breakdown, BREAKDOWN_KEYS, 'breakdown ', errors);
        for (const key of BREAKDOWN_KEYS) compiled.breakdown[key] = optionalMatcher(breakdown[key], `breakdown.${key}`, NORMALIZERS.label);
      }
    }
  } else {
    compiled.grandTotal = optionalMatcher(definition.grandTotal, 'grandTotal', NORMALIZERS.label);
    compiled.categories = definition.categories === undefined ? null : compileRules(definition.categories, 'categories', errors, NORMALIZERS.text, CATEGORY_TARGETS, {allowed: ['words']});
    if (compiled.categories && !compiled.categories.length) errors.push('categories は1行以上にしてください');
  }
  if (errors.length) return {ok: false, errors};
  return {ok: true, definition: Object.freeze(compiled)};
}

// 検査を通した定義（compiled）か、通らなければ止める（読み取りの入口が使う）
export function compileBudgetReadDefinition(definition) {
  const checked = checkBudgetReadDefinition(definition);
  if (!checked.ok) throw new Error(`読み取りの定義が正しくありません: ${checked.errors.join('／')}`);
  return checked.definition;
}

// 行き先つきの当て方の一覧を上から順に当て、最初に当たった行き先を返す。当たらなければ null
export function firstTarget(rules, text) {
  return rules?.find((rule) => rule.test(text))?.to ?? null;
}

// 定義の版の行（読み取りの表から読んだもの）から、定義ごとに「使用中」の版を選ぶ。
// 使用中は、最後の判定が承認（approve）の版のうち番号の最も大きいもの。案の版（判定なし）と差し戻した版は使わない（FR-PLAN-BUDGET-037）。
// rows は {profileId, profileName, versionId, versionNo, definitionJson, definitionHash, latestAction}。定義の作られた順（profileId）に並べる
export function inUseReadVersions(rows = []) {
  const best = new Map();
  for (const row of rows) {
    if (row.latestAction !== 'approve') continue;
    const current = best.get(row.profileId);
    if (!current || row.versionNo > current.versionNo) best.set(row.profileId, row);
  }
  return [...best.values()].sort((a, b) => a.profileId - b.profileId).map((row) => ({readVersionId: row.versionId, profileId: row.profileId,
    name: row.profileName, versionNo: row.versionNo, definitionHash: row.definitionHash, definition: JSON.parse(row.definitionJson)}));
}

// 定義を表に入れる文字（JSON）。指紋はこの文字の SHA-256
export const budgetReadDefinitionText = (definition) => JSON.stringify(definition);
