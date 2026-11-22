// 制作部の業務のひな型（移行 0057）。純関数。画面と受け口の両方で使う。
// ひな型の中身は「部品の並び」（blocks）と「差し込みの穴の定義」（variables）。部品の種類を増やしても DB の移行は要らない（形はここで確かめる）。
// 穴は本文の {{キー}} で書く。条件（when）を持つ部品・行は、穴の入り方で出る・出ないが決まる。

export const BLOCK_KINDS = Object.freeze(['heading', 'text', 'checklist', 'fields', 'table']);
export const VARIABLE_KINDS = Object.freeze(['text', 'longtext', 'number', 'date', 'time', 'url', 'choice']);
export const WHEN_OPS = Object.freeze(['filled', 'empty', 'equals', 'not_equals']);
// 出どころの種類。分からないときは unverified（推測で埋めない）
export const SOURCE_KINDS = Object.freeze(['document', 'message', 'sheet', 'verbal', 'other', 'unverified']);

export const OFFICE_TYPES = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});
// 保管庫（src/preprod/vault-routes.mjs）と同じ。inline で持てる上限（共通の原本 source_documents の MAX_INLINE_BYTES）
export const MAX_FILE_BYTES = 12 * 1024 * 1024;

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]{0,39})\}\}/g;
const LIMITS = Object.freeze({blocks: 200, items: 200, columns: 12, variables: 60, options: 30, text: 5000, line: 300, json: {blocks: 60000, variables: 20000, source: 4000}});

const fail = (message) => { throw new Error(message); };
const str = (value, label, max, {required = false} = {}) => {
  if (value != null && typeof value !== 'string') fail(`${label}を確かめてください`);
  const text = (value ?? '').trim();
  if (!text) { if (required) fail(`${label}を入れてください`); return null; }
  if (text.length > max) fail(`${label}は${max}字までにしてください`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) fail(`${label}に制御文字は使えません`);
  return text;
};

export function normalizeFolderInput(input) {
  return {name: str(input?.name, 'フォルダの名前', 80, {required: true}), description: str(input?.description, '説明', 300)};
}

// フォルダの直し（名前・説明・やめた印）。理由は任意（500字まで）。名前の重なりは DB が断る
export function normalizeFolderRevisionInput(input) {
  if (input?.retired != null && typeof input.retired !== 'boolean') fail('やめた印は 真・偽 で入れてください');
  return {...normalizeFolderInput(input), retired: input?.retired === true, reason: str(input?.reason, '理由', 500)};
}

// 移動の理由（任意・500字まで）
export const normalizeMoveReason = (reason) => str(reason, '理由', 500);

// Google ドライブのファイル ID かリンク（任意）。同期や取得はしない。出どころの印だけ
export function normalizeDriveRef(value) {
  const text = str(value, 'Google ドライブの出どころ', 500);
  if (!text) return null;
  const isLink = /^https:\/\/(drive|docs)\.google\.com\/\S+$/.test(text);
  const isId = /^[A-Za-z0-9_-]{10,200}$/.test(text);
  if (!isLink && !isId) fail('Google ドライブの出どころは、ファイル ID か drive.google.com・docs.google.com のリンクで入れてください');
  return text;
}

export function placeholdersOf(text) {
  return [...String(text ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]);
}

function normalizeWhen(when, keys, where) {
  if (when == null) return null;
  if (typeof when !== 'object' || Array.isArray(when)) fail(`${where}の条件を確かめてください`);
  if (!keys.has(when.key)) fail(`${where}の条件が、定義していない穴「${when.key}」を指しています`);
  if (!WHEN_OPS.includes(when.op)) fail(`${where}の条件の種類を確かめてください`);
  const out = {key: when.key, op: when.op};
  if (when.op === 'equals' || when.op === 'not_equals') out.value = str(when.value, `${where}の条件の値`, 200, {required: true});
  return out;
}

function checkText(text, keys, where) {
  for (const key of placeholdersOf(text)) if (!keys.has(key)) fail(`${where}に、定義していない穴「{{${key}}}」があります`);
}

export function normalizeVariables(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) fail('穴の定義を確かめてください');
  if (list.length > LIMITS.variables) fail(`穴は${LIMITS.variables}個までです`);
  const seen = new Set();
  const out = list.map((raw, index) => {
    const where = `穴${index + 1}`;
    if (!raw || typeof raw !== 'object') fail(`${where}を確かめてください`);
    if (typeof raw.key !== 'string' || !KEY.test(raw.key)) fail(`${where}のキーは、英小文字で始まる英小文字・数字・_ の40字までです`);
    if (seen.has(raw.key)) fail(`穴のキー「${raw.key}」が重なっています`);
    seen.add(raw.key);
    const kind = raw.kind ?? 'text';
    if (!VARIABLE_KINDS.includes(kind)) fail(`${where}の種類を確かめてください`);
    const variable = {key: raw.key, label: str(raw.label, `${where}の名前`, 60, {required: true}), kind, required: raw.required === true};
    if (kind === 'choice') {
      const options = Array.isArray(raw.options) ? raw.options.map((o) => str(o, `${where}の選択肢`, 80, {required: true})) : [];
      if (options.length < 1 || options.length > LIMITS.options) fail(`${where}の選択肢は1〜${LIMITS.options}個です`);
      if (new Set(options).size !== options.length) fail(`${where}の選択肢が重なっています`);
      variable.options = options;
    }
    const hint = str(raw.hint, `${where}の入れ方`, 200);
    if (hint) variable.hint = hint;
    const example = str(raw.example, `${where}の例`, 200);
    if (example) variable.example = example;
    return variable;
  });
  if (JSON.stringify(out).length > LIMITS.json.variables) fail('穴の定義が大きすぎます');
  return out;
}

export function normalizeBlocks(list, variables) {
  if (list == null) return [];
  if (!Array.isArray(list)) fail('部品の並びを確かめてください');
  if (list.length > LIMITS.blocks) fail(`部品は${LIMITS.blocks}個までです`);
  const keys = new Set(variables.map((v) => v.key));
  const line = (value, where, {required = false} = {}) => { const text = str(value, where, LIMITS.line, {required}); if (text) checkText(text, keys, where); return text; };
  const out = list.map((raw, index) => {
    const where = `部品${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${where}を確かめてください`);
    if (!BLOCK_KINDS.includes(raw.kind)) fail(`${where}の種類を確かめてください（${BLOCK_KINDS.join('・')}）`);
    const block = {kind: raw.kind};
    const when = normalizeWhen(raw.when, keys, where);
    if (when) block.when = when;
    if (raw.kind === 'heading') {
      block.text = line(raw.text, `${where}の見出し`, {required: true});
    } else if (raw.kind === 'text') {
      const text = str(raw.text, `${where}の本文`, LIMITS.text, {required: true}); checkText(text, keys, `${where}の本文`); block.text = text;
    } else {
      const title = line(raw.title, `${where}の題`); if (title) block.title = title;
      if (raw.kind === 'checklist') {
        if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > LIMITS.items) fail(`${where}の項目は1〜${LIMITS.items}個です`);
        block.items = raw.items.map((item, k) => {
          const w = `${where}の項目${k + 1}`; const entry = {text: line(item?.text, w, {required: true})};
          const cond = normalizeWhen(item?.when, keys, w); if (cond) entry.when = cond; return entry;
        });
      } else if (raw.kind === 'fields') {
        if (!Array.isArray(raw.rows) || raw.rows.length < 1 || raw.rows.length > LIMITS.items) fail(`${where}の行は1〜${LIMITS.items}行です`);
        block.rows = raw.rows.map((row, k) => {
          const w = `${where}の行${k + 1}`; const entry = {label: str(row?.label, `${w}の名前`, 80, {required: true}), value: line(row?.value ?? '', `${w}の値`) ?? ''};
          const cond = normalizeWhen(row?.when, keys, w); if (cond) entry.when = cond; return entry;
        });
      } else {
        if (!Array.isArray(raw.columns) || raw.columns.length < 1 || raw.columns.length > LIMITS.columns) fail(`${where}の列は1〜${LIMITS.columns}列です`);
        block.columns = raw.columns.map((c, k) => str(c, `${where}の列${k + 1}`, 60, {required: true}));
        if (!Array.isArray(raw.rows) || raw.rows.length < 1 || raw.rows.length > LIMITS.items) fail(`${where}の行は1〜${LIMITS.items}行です`);
        block.rows = raw.rows.map((row, k) => {
          const w = `${where}の行${k + 1}`;
          if (!Array.isArray(row?.cells) || row.cells.length !== block.columns.length) fail(`${w}のセルの数が列の数と合いません`);
          const entry = {cells: row.cells.map((cell, j) => line(cell ?? '', `${w}の列${j + 1}`) ?? '')};
          const cond = normalizeWhen(row.when, keys, w); if (cond) entry.when = cond; return entry;
        });
      }
    }
    return block;
  });
  if (JSON.stringify(out).length > LIMITS.json.blocks) fail('ひな型の中身が大きすぎます');
  return out;
}

export function normalizeSource(raw) {
  if (raw == null) return {kind: 'unverified'};
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('出どころを確かめてください');
  const kind = raw.kind ?? 'unverified';
  if (!SOURCE_KINDS.includes(kind)) fail('出どころの種類を確かめてください');
  const out = {kind};
  const note = str(raw.note, '出どころのメモ', 1000); if (note) out.note = note;
  const origin = str(raw.origin, '出どころの名前', 200); if (origin) out.origin = origin;
  if (JSON.stringify(out).length > LIMITS.json.source) fail('出どころが大きすぎます');
  return out;
}

// 新しい版（1版目も同じ）の入力。2版目からは理由が要る。やめる（retired）ときも理由が要る
export function normalizeVersionInput(input, {first}) {
  const variables = normalizeVariables(input?.variables);
  const out = {
    name: str(input?.name, 'ひな型の名前', 120, {required: true}),
    purpose: str(input?.purpose, '何のためか', 500),
    scene: str(input?.scene, '使う場面', 500),
    blocks: normalizeBlocks(input?.blocks, variables),
    variables,
    source: normalizeSource(input?.source),
    driveRef: normalizeDriveRef(input?.driveRef),
    retired: input?.retired === true,
    reason: str(input?.reason, '直した理由', 500, {required: !first}),
  };
  if (first && out.retired) fail('作ったばかりのひな型はやめられません');
  return out;
}

// ---- 穴を埋める ----
const filled = (values, key) => String(values?.[key] ?? '').trim() !== '';
export function whenHolds(when, values) {
  if (!when) return true;
  const value = String(values?.[when.key] ?? '').trim();
  if (when.op === 'filled') return value !== '';
  if (when.op === 'empty') return value === '';
  if (when.op === 'equals') return value === when.value;
  return value !== when.value;
}

export function fillText(text, values, variables = []) {
  const labels = new Map(variables.map((v) => [v.key, v.label]));
  return String(text ?? '').replace(PLACEHOLDER, (_, key) => (filled(values, key) ? String(values[key]).trim() : `【${labels.get(key) || key}】`));
}

// 条件に合う部品・行だけを残し、穴を値で埋める（値が無い穴は【名前】のまま残す）
export function resolveBlocks(blocks, values, variables = []) {
  const fill = (text) => fillText(text, values, variables);
  return (blocks || []).filter((b) => whenHolds(b.when, values)).map((b) => {
    if (b.kind === 'heading' || b.kind === 'text') return {...b, text: fill(b.text)};
    const title = b.title ? fill(b.title) : undefined;
    if (b.kind === 'checklist') return {...b, title, items: b.items.filter((i) => whenHolds(i.when, values)).map((i) => ({...i, text: fill(i.text)}))};
    if (b.kind === 'fields') return {...b, title, rows: b.rows.filter((r) => whenHolds(r.when, values)).map((r) => ({...r, value: fill(r.value)}))};
    return {...b, title, rows: b.rows.filter((r) => whenHolds(r.when, values)).map((r) => ({...r, cells: r.cells.map(fill)}))};
  });
}

// 貼り付け・メッセージ用の文字にする
export function blocksToText(resolved) {
  const parts = [];
  for (const b of resolved) {
    const lines = [];
    if (b.kind === 'heading') lines.push(`■ ${b.text}`);
    else if (b.kind === 'text') lines.push(b.text);
    else {
      if (b.title) lines.push(`■ ${b.title}`);
      if (b.kind === 'checklist') b.items.forEach((i) => lines.push(`□ ${i.text}`));
      else if (b.kind === 'fields') b.rows.forEach((r) => lines.push(`${r.label}: ${r.value}`));
      else { lines.push(b.columns.join(' | ')); b.rows.forEach((r) => lines.push(r.cells.join(' | '))); }
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

// 必須の穴で、値がまだ入っていないもの
export const missingRequired = (variables, values) => (variables || []).filter((v) => v.required && !filled(values, v.key));

// ---- Office の原本 ----
export function officeFileInfo(fileName) {
  const name = typeof fileName === 'string' ? fileName.trim() : '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!OFFICE_TYPES[ext]) fail('置けるのは Word（.docx）・Excel（.xlsx）・PowerPoint（.pptx）のファイルです');
  return {ext, mediaType: OFFICE_TYPES[ext]};
}
// docx・xlsx・pptx は ZIP。先頭の印だけ確かめる（拡張子だけ変えた別のファイルを断る）
export const looksLikeZip = (bytes) => bytes instanceof Uint8Array && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
