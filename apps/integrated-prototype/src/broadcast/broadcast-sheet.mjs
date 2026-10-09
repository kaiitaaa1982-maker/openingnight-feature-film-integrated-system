// 放送枠・販売条件の Excel/CSV 往復（純関数。ブラウザ・node・Worker 共通。node:* を使わない）。
// - 出力は日本語の見出し。名称などの確かめ用の列は「参考_」で始め、取込では読まない。
// - 取込は日本語の見出しと従来の英語キー（slot_id, work_id …）の両方を受け付ける。
// - 行の検査は全行を最後まで行い、行ごとの理由（列・内容）を返す。1行でもエラーがあればどの行も登録しない。
import {labelOf, optionsOf} from '../ui/labels.mjs';
import {parseCsv} from '../csv.mjs';

export const REFERENCE_PREFIX = '参考_';
export const IMPORT_ROW_LIMIT = 200;

const nfkc = (value) => (value === null || value === undefined ? '' : String(value).normalize('NFKC').trim());
const headerKey = (value) => nfkc(value).replace(/[\s_　]+/g, '').toLowerCase();
export const isReferenceHeader = (header) => nfkc(header).startsWith(REFERENCE_PREFIX);
const trim = (value) => (value === null || value === undefined ? '' : String(value).trim());
const blank = (value) => trim(value) === '';

// ---- 列の定義 -------------------------------------------------------------------------------
// key: 取込で使う意味。headers: 受け付ける見出し（先頭が出力の日本語見出し。英語キーも含める）。
// type: 出力の書式。ref: 出力だけの参考列（「参考_」で始まる）。
export const SLOT_SHEET = Object.freeze({
  name: '放送枠',
  label: '放送枠',
  columns: Object.freeze([
    {key: 'slot_id', headers: ['放送枠ID', 'slot_id'], type: 'id', hint: '出力した放送枠のID。空欄の行は新しい放送枠として追加します'},
    {key: 'revision', headers: ['版', '放送枠の版', 'revision'], type: 'int', hint: '出力したときの版。放送枠IDがある行で必要です（出力後に他の人が直していないかの照合に使います）'},
    {key: 'work_code', headers: ['作品コード', 'work_code'], type: 'code', hint: '画面で選んでいる作品のコード（別の作品のファイルを取り違えないための照合）'},
    {key: 'broadcast_month', headers: ['放送月', 'broadcast_month'], type: 'month', required: true, hint: '「2026-11」の形。「2026/11」「2026年11月」も読めます'},
    {key: 'station_name', headers: ['放送局', '放送局名', 'station_name'], type: 'text', required: true, hint: '取引先に「放送局」の区分で登録した名称。一覧にない局名も入れられます（確認の表で「未登録の局」と出ます）'},
    {ref: 'station_status', header: '参考_放送局の登録'},
    {key: 'customer_code', headers: ['取引先コード', '取引先', 'customer_code'], type: 'code', hint: '取引先のコード（名称でも読めます）。空欄は未紐付け'},
    {key: 'customer_partner_id', headers: ['customer_partner_id'], type: 'id', legacy: true},
    {ref: 'customer_name', header: '参考_取引先名'},
    {key: 'agency_code', headers: ['代理店コード', '代理店', 'agency_code'], type: 'code', hint: '代理店の取引先コード（名称でも読めます）。空欄は代理店なし'},
    {key: 'agency_partner_id', headers: ['agency_partner_id'], type: 'id', legacy: true},
    {ref: 'agency_name', header: '参考_代理店名'},
    {key: 'agreement_code', headers: ['販売契約コード', '販売契約', '契約コード', 'agreement_code'], type: 'code', hint: 'この作品の放送の販売契約のコード。空欄は未紐付け'},
    {key: 'agreement_id', headers: ['agreement_id'], type: 'id', legacy: true},
    {ref: 'agreement_title', header: '参考_販売契約名'},
    {key: 'period_from', headers: ['期間開始', '放送期間開始', 'period_from'], type: 'date', required: true, hint: '放送月の中の日付（2026-11-01）'},
    {key: 'period_to', headers: ['期間終了', '放送期間終了', 'period_to'], type: 'date', required: true, hint: '放送月の中の日付で、期間開始以降'},
    {key: 'planned_on', headers: ['放送予定日', '予定日', 'planned_on'], type: 'date', hint: '期間の中の日付。未定なら空欄'},
    {key: 'planned_runs', headers: ['予定回数', '回数', 'planned_runs'], type: 'int', hint: '1〜9999。空欄は1回'},
    {key: 'source_reference', headers: ['根拠', '根拠資料', 'source_reference'], type: 'text', hint: '編成表・メールなど、この枠の根拠'},
    {ref: 'status', header: '参考_状態'},
    {ref: 'work_title', header: '参考_作品名'},
    {key: 'work_id', headers: ['work_id'], type: 'id', legacy: true},
  ]),
});

export const AVAIL_SHEET = Object.freeze({
  name: '販売条件',
  label: '販売条件',
  columns: Object.freeze([
    {key: 'work_code', headers: ['作品コード', 'work_code'], type: 'code', hint: '作品コード（作品・商品マスタのコード）'},
    {ref: 'work_title', header: '参考_作品名'},
    {ref: 'distribution_group', header: '参考_分類'},
    {key: 'distribution_code', headers: ['流通コード', 'distribution_code'], type: 'code', required: true, hint: '流通区分マスタのコード（例: B001）。旧区分のコードは新しく登録できません'},
    {ref: 'distribution_label', header: '参考_流通名'},
    {key: 'territory', headers: ['地域', 'territory'], type: 'text', required: true, hint: '「日本」「国内」「Japan」のように同じ地域の書き方は、登録済みの系列に寄せます（元の版はその系列の版）'},
    {key: 'base_version', headers: ['元の版', 'base_version'], type: 'int', hint: '出力したときの版。新しい流通・地域の行は空欄か0'},
    {key: 'release_on', headers: ['解禁日', 'release_on'], type: 'date', hint: '2026-10-01 の形。未定なら空欄'},
    {key: 'sales_end_on', headers: ['販売終了日', 'sales_end_on'], type: 'date', hint: '解禁日以降。未定なら空欄'},
    {key: 'exclusivity', headers: ['独占', 'exclusivity'], type: 'select', domain: 'exclusivity', hint: '独占・非独占・未確認。空欄は未確認'},
    {key: 'status', headers: ['状態', 'status'], type: 'select', domain: 'availabilityStatus', hint: '条件未確定・条件確認済み・取り下げ。空欄は条件未確定。条件確認済みには解禁日・販売終了日・販売条件が必要'},
    {key: 'terms_text', headers: ['販売条件', '条件', 'terms_text'], type: 'text', wrap: true, hint: '条件の要約（5000文字まで）'},
    {key: 'source_reference', headers: ['根拠', 'source_reference'], type: 'text', required: true, hint: '契約書・メールなど、この条件の根拠'},
    {ref: 'intake_link', header: '参考_調達の根拠'},
    {key: 'work_id', headers: ['work_id'], type: 'id', legacy: true},
    {key: 'work_title', headers: ['work_title'], type: 'text', legacy: true},
    {key: 'distribution_name', headers: ['distribution_name'], type: 'text', legacy: true},
    {key: 'transaction_method', headers: ['transaction_method'], type: 'text', legacy: true},
  ]),
});

// 英語キー（従来のCSV）の見出しの並び。出力の既定（API互換）に使う。
export const SLOT_EN_HEADERS = ['slot_id', 'revision', 'work_id', 'broadcast_month', 'station_name', 'customer_partner_id', 'agency_partner_id', 'agreement_id', 'period_from', 'period_to', 'planned_on', 'planned_runs', 'source_reference'];
export const AVAIL_EN_HEADERS = ['work_id', 'work_code', 'work_title', 'distribution_code', 'distribution_name', 'transaction_method', 'territory', 'base_version', 'release_on', 'sales_end_on', 'exclusivity', 'status', 'terms_text', 'source_reference'];

// 日本語の出力に並べる列（英語だけの互換列は出さない）。
export const exportColumns = (sheet) => sheet.columns.filter((column) => column.ref || !column.legacy);
export const jaHeader = (column) => column.ref ? column.header : column.headers[0];

// 見出し → 列の意味。{mode: 'ja'|'en', keys: [key|null], unknown: [見出し], references: [見出し], headerOf: {key: 見出し}}
export function mapHeaders(headers, sheet) {
  const lookup = new Map();
  for (const column of sheet.columns) if (column.key) for (const header of column.headers) lookup.set(headerKey(header), column.key);
  const keys = [];
  const unknown = [];
  const references = [];
  const headerOf = {};
  const duplicated = [];
  let ja = 0;
  let en = 0;
  headers.forEach((raw) => {
    const header = trim(raw);
    if (!header) { keys.push(null); return; }
    if (isReferenceHeader(header)) { references.push(header); keys.push(null); return; }
    const key = lookup.get(headerKey(header));
    if (!key) { unknown.push(header); keys.push(null); return; }
    if (Object.hasOwn(headerOf, key)) { duplicated.push(header); keys.push(null); return; }
    headerOf[key] = header;
    keys.push(key);
    if (/^[a-z_]+$/.test(nfkc(header))) en += 1; else ja += 1;
  });
  return {mode: ja >= en && ja > 0 ? 'ja' : 'en', keys, unknown, references, duplicated, headerOf};
}

// 取込の表を読む。入力は {table: {headers, rows: [[値…]] | [{rowNo, cells}]}} か {csv: 文字列}。
// → {headers, rows: [{rowNo, cells, values: {key: 文字}}], mapping}。見出しの不足・行数超過はここで止める（ファイル全体の問題）。
export function readImportTable(input, sheet, {limit = IMPORT_ROW_LIMIT} = {}) {
  let headers;
  let raw;
  if (input?.table && Array.isArray(input.table.headers)) {
    headers = input.table.headers.map((value) => trim(value));
    raw = (Array.isArray(input.table.rows) ? input.table.rows : []).map((row, index) => (Array.isArray(row)
      ? {rowNo: index + 2, cells: row}
      : {rowNo: Number(row?.rowNo) || index + 2, cells: Array.isArray(row?.cells) ? row.cells : []}));
    raw = raw.filter((row) => row.cells.some((cell) => !blank(cell)));
    if (!raw.length) throw new Error('見出しの下にデータの行がありません');
  } else {
    const parsed = parseCsv(String(input?.csv || ''));
    headers = Object.keys(parsed[0]?.values || {}).map((value) => trim(value));
    raw = parsed.map((row) => ({rowNo: row.rowNo, cells: Object.values(row.values)}));
  }
  const named = headers.filter(Boolean);
  if (new Set(named.map(headerKey)).size !== named.length) throw new Error('見出しに同じ名前の列があります。1つにしてから読み込んでください');
  if (raw.length > limit) throw new Error(`一度に取り込めるのは${limit}行までです（このファイルは${raw.length}行）。ファイルを分けてください`);
  const mapping = mapHeaders(headers, sheet);
  const has = (key) => Object.hasOwn(mapping.headerOf, key);
  const missing = sheet.columns.filter((column) => column.key && column.required && !has(column.key)).map((column) => column.headers[0]);
  if (!has('work_code') && !has('work_id') && sheet.columns.some((column) => column.key === 'work_code')) missing.unshift('作品コード');
  if (missing.length) throw new Error(`見出しが足りません: ${missing.join('、')}。出力したファイルの1行目（見出し）を消さずに使ってください`);
  const rows = raw.map(({rowNo, cells}) => {
    const values = {};
    mapping.keys.forEach((key, index) => { if (key) values[key] = trim(cells[index]); });
    return {rowNo, cells: headers.map((_, index) => (cells[index] === null || cells[index] === undefined ? '' : cells[index])), values};
  });
  return {headers, rows, mapping};
}

// ---- 値の読み替え（書式の揺れを吸収する） ------------------------------------------------------
function validDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
const pad = (n) => String(n).padStart(2, '0');

export function parseDateCell(value) {
  const text = nfkc(value);
  if (!text) return {ok: true, value: null};
  const match = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!match) return {ok: false, error: `日付は「2026-11-01」の形で入れてください（${text}）`};
  const [y, m, d] = match.slice(1).map(Number);
  if (!validDate(y, m, d)) return {ok: false, error: `存在しない日付です（${text}）`};
  return {ok: true, value: `${y}-${pad(m)}-${pad(d)}`};
}

export function parseMonthCell(value) {
  const text = nfkc(value);
  if (!text) return {ok: true, value: null};
  const match = text.match(/^(\d{4})[-/.年](\d{1,2})月?(?:[-/.](\d{1,2})日?)?$/);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return {ok: false, error: `「2026-11」の形で入れてください（${text}）`};
  // Excel が「2026-11」を日付（2026-11-01）に変えたものも読む
  if (match[3] && !validDate(Number(match[1]), Number(match[2]), Number(match[3]))) return {ok: false, error: `存在しない日付です（${text}）`};
  return {ok: true, value: `${match[1]}-${pad(Number(match[2]))}`};
}

export function parseIntCell(value, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  const text = nfkc(value).replace(/[,，\s]/g, '').replace(/(回|版)$/, '');
  if (!text) return {ok: true, value: null};
  if (!/^\d+$/.test(text)) return {ok: false, error: `整数で入れてください（${nfkc(value)}）`};
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) return {ok: false, error: `${min}〜${max}の整数で入れてください（${nfkc(value)}）`};
  return {ok: true, value: number};
}

// 選択肢の値: コード（draft 等）と日本語名（条件未確定 等）の両方を受け付ける。
const CHOICE_ALIASES = Object.freeze({
  availabilityStatus: {'下書き': 'draft', '未確定': 'draft', '取下げ': 'withdrawn', '確認済み': 'confirmed'},
  exclusivity: {},
});
export function parseChoiceCell(domain, value, fallback) {
  const text = nfkc(value);
  if (!text) return {ok: true, value: fallback};
  const options = optionsOf(domain);
  const hit = options.find((option) => option.value === text || option.label === text) || null;
  if (hit) return {ok: true, value: hit.value};
  const alias = CHOICE_ALIASES[domain]?.[text];
  if (alias) return {ok: true, value: alias};
  return {ok: false, error: `「${options.map((option) => option.label).join('」「')}」のどれかにしてください（${text}）`};
}

// ---- 名寄せ ----------------------------------------------------------------------------------
export const matchKey = (value) => nfkc(value).replace(/[\s　]+/g, '').toLowerCase();

// 取引先を「コード」→「名称（1件だけ一致）」の順で探す。英語キーの列はIDで探す。
export function findPartner(partners, value, {byId = false} = {}) {
  const text = nfkc(value);
  if (!text) return {ok: true, value: null};
  if (byId) {
    const hit = /^\d+$/.test(text) ? partners.find((partner) => String(partner.id) === text) : null;
    return hit ? {ok: true, value: hit} : {ok: false, error: `登録されていない取引先IDです（${text}）`};
  }
  const key = matchKey(text);
  const byCode = partners.filter((partner) => matchKey(partner.code) === key);
  if (byCode.length === 1) return {ok: true, value: byCode[0]};
  const byName = partners.filter((partner) => matchKey(partner.name) === key);
  if (byName.length === 1) return {ok: true, value: byName[0]};
  if (byName.length > 1) return {ok: false, error: `同じ名称の取引先が${byName.length}件あります。取引先コードで入れてください（${text}）`};
  return {ok: false, error: `取引先に登録されていません（${text}）。取引先の画面で登録するか、コードを確かめてください`};
}

// 地域の表記ゆれ（同じ意味の書き方）。推測で置き換えず、警告で知らせるだけに使う。
const TERRITORY_ALIASES = [['日本', '国内', '日本国内', 'japan', 'jp', 'jpn']];
export function territoryKey(value) {
  const key = matchKey(value);
  const group = TERRITORY_ALIASES.find((list) => list.some((item) => matchKey(item) === key));
  return group ? matchKey(group[0]) : key;
}
// 既存の地域のうち、表記だけ違って同じ意味のもの。
export function territoryVariant(value, existing = []) {
  const text = nfkc(value);
  if (!text) return null;
  const key = territoryKey(text);
  return existing.find((item) => item !== text && territoryKey(item) === key) || null;
}

// 放送局として登録された取引先か（名称かコードの一致）。
export function stationPartner(stationName, stations = []) {
  const key = matchKey(stationName);
  if (!key) return null;
  return stations.find((partner) => matchKey(partner.name) === key || matchKey(partner.code) === key) || null;
}

// ---- 行の検査 --------------------------------------------------------------------------------
function collector(mapping) {
  const errors = [];
  const column = (key) => mapping.headerOf[key] || null;
  return {
    errors,
    fail: (key, message) => errors.push({column: column(key), message}),
    take: (key, result) => {
      if (!result.ok) { errors.push({column: column(key), message: result.error}); return undefined; }
      return result.value;
    },
  };
}

const SLOT_COMPARE = ['broadcast_month', 'station_name', 'customer_partner_id', 'agency_partner_id', 'agreement_id', 'period_from', 'period_to', 'planned_on', 'planned_runs', 'source_reference'];
export const SLOT_VALUE_LABELS = Object.freeze({
  broadcast_month: '放送月', station_name: '放送局', customer_partner_id: '取引先', agency_partner_id: '代理店', agreement_id: '販売契約',
  period_from: '期間開始', period_to: '期間終了', planned_on: '放送予定日', planned_runs: '予定回数', source_reference: '根拠',
});

// 放送枠の1行。ctx = {work, partners, stations, agreements, slots: Map(slotId → 現在の版), seen: Map(slotId → rowNo)}。
// → {rowNo, errors:[{column, message}], warnings:[文], action, slotId, baseRevision, diff:[列], value}
export function validateSlotRow(row, mapping, ctx) {
  const v = row.values;
  const {errors, fail, take} = collector(mapping);
  const warnings = [];
  const has = (key) => Object.hasOwn(v, key) && v[key] !== '';
  // 作品の照合（別の作品のファイルの取り違えを止める）
  if (has('work_code') && matchKey(v.work_code) !== matchKey(ctx.work.code)) fail('work_code', `画面で選んでいる作品（${ctx.work.code}）と違う作品コードです（${v.work_code}）`);
  if (has('work_id') && String(v.work_id) !== String(ctx.work.id)) fail('work_id', `登録済み作品IDと一致しません（${v.work_id}）`);
  if (!has('work_code') && !has('work_id')) fail(mapping.headerOf.work_code ? 'work_code' : 'work_id', '作品コードを入れてください');

  const month = take('broadcast_month', parseMonthCell(v.broadcast_month));
  if (month === null) fail('broadcast_month', '放送月を入れてください');
  const station = trim(v.station_name);
  if (!station) fail('station_name', '放送局を入れてください');
  else if (station.length > 200) fail('station_name', '放送局は200文字以内にしてください');
  const from = take('period_from', parseDateCell(v.period_from));
  const to = take('period_to', parseDateCell(v.period_to));
  if (from === null) fail('period_from', '期間開始を入れてください');
  if (to === null) fail('period_to', '期間終了を入れてください');
  const planned = take('planned_on', parseDateCell(v.planned_on));
  const runsRaw = take('planned_runs', parseIntCell(v.planned_runs, {min: 1, max: 9999}));
  const runs = runsRaw === null ? 1 : runsRaw;
  if (month && from && from.slice(0, 7) !== month) fail('period_from', `期間開始は放送月（${month}）の中の日付にしてください`);
  if (month && to && to.slice(0, 7) !== month) fail('period_to', `期間終了は放送月（${month}）の中の日付にしてください`);
  if (from && to && to < from) fail('period_to', '期間終了は期間開始以降の日付にしてください');
  if (planned && from && to && (planned < from || planned > to)) fail('planned_on', '放送予定日は期間の中の日付にしてください');
  const source = trim(v.source_reference);
  if (source.length > 1000) fail('source_reference', '根拠は1000文字以内にしてください');

  const partnerOf = (codeKey, idKey) => {
    if (has(codeKey)) { const found = take(codeKey, findPartner(ctx.partners, v[codeKey])); return found === undefined ? undefined : found?.id ?? null; }
    if (has(idKey)) { const found = take(idKey, findPartner(ctx.partners, v[idKey], {byId: true})); return found === undefined ? undefined : found?.id ?? null; }
    return null;
  };
  const customer = partnerOf('customer_code', 'customer_partner_id');
  const agency = partnerOf('agency_code', 'agency_partner_id');
  let agreement = null;
  const agreementText = has('agreement_code') ? v.agreement_code : has('agreement_id') ? v.agreement_id : '';
  if (agreementText) {
    const key = has('agreement_code') ? 'agreement_code' : 'agreement_id';
    const hit = key === 'agreement_id'
      ? ctx.agreements.find((a) => String(a.id) === String(agreementText))
      : ctx.agreements.find((a) => matchKey(a.contract_code) === matchKey(agreementText)) || ctx.agreements.find((a) => matchKey(a.title) === matchKey(agreementText));
    if (!hit) fail(key, `この作品の販売契約にありません（${agreementText}）`);
    else if (hit.channel && hit.channel !== 'broadcast') fail(key, `放送の販売契約を選んでください（${hit.contract_code || agreementText}は放送以外の契約です）`);
    else agreement = hit.id;
  }
  if (station && !stationPartner(station, ctx.stations)) warnings.push(`「${station}」は取引先に放送局として登録されていません（未登録の局）`);

  let action = 'append';
  let slotId = null;
  let baseRevision = null;
  let diff = [];
  const value = {
    broadcast_month: month || null, station_name: station || null, customer_partner_id: customer ?? null, agency_partner_id: agency ?? null,
    agreement_id: agreement, period_from: from || null, period_to: to || null, planned_on: planned ?? null, planned_runs: runs ?? 1,
    source_reference: source || null, reason: null, status: 'draft',
  };
  if (has('slot_id')) {
    const parsedId = take('slot_id', parseIntCell(v.slot_id, {min: 1}));
    if (parsedId) {
      slotId = parsedId;
      const earlier = ctx.seen?.get(slotId);
      if (earlier) fail('slot_id', `同じ放送枠IDが${earlier}行目にもあります`);
      else ctx.seen?.set(slotId, row.rowNo);
      const old = ctx.slots.get(slotId);
      if (!old) fail('slot_id', `この作品の放送枠にありません（放送枠ID ${slotId}）`);
      else {
        const rev = take('revision', parseIntCell(v.revision, {min: 1}));
        if (rev === null) fail('revision', '放送枠IDがある行は版も入れてください（出力したときの値）');
        else if (rev !== undefined && rev !== old.revision) fail('revision', `出力した後に放送枠が更新されています（いまは第${old.revision}版）。もう一度出力してから直してください`);
        baseRevision = rev ?? null;
        diff = SLOT_COMPARE.filter((key) => String(value[key] ?? '') !== String(old[key] ?? ''));
        action = diff.length ? 'revise' : 'unchanged';
        if (action === 'revise' && !['draft', 'rejected'].includes(old.status)) {
          fail('slot_id', `${labelOf('broadcastStatus', old.status)}の放送枠は取込で修正できません。差し戻してから修正してください`);
        }
      }
    }
  }
  // 同じ放送月・同じ局（全角・半角の違いは同じ局）の二重登録は、全行を当てた後の状態で API がエラーにする（slot-duplicates.mjs の importDuplicateErrors）
  return {rowNo: row.rowNo, errors, warnings, action, slotId, baseRevision, diff, value};
}

const AVAIL_COMPARE = ['release_on', 'sales_end_on', 'exclusivity', 'status', 'terms_text', 'source_reference'];
export const AVAIL_VALUE_LABELS = Object.freeze({release_on: '解禁日', sales_end_on: '販売終了日', exclusivity: '独占', status: '状態', terms_text: '販売条件', source_reference: '根拠', work_id: '作品', distribution_code: '流通', territory: '地域'});

// 販売条件の1行。ctx = {works: [編集できる作品], types: Map(code → 流通), current: Map('作品|流通|地域' → 最新版),
//   series: Map('作品|流通' → [{territory, version_no}]), resolveTerritory?: (入力, series) → {territory, match}|{error}, seen: Map}
export function validateAvailRow(row, mapping, ctx) {
  const v = row.values;
  const {errors, fail, take} = collector(mapping);
  const warnings = [];
  const has = (key) => Object.hasOwn(v, key) && v[key] !== '';
  let work = null;
  if (has('work_id')) {
    work = /^\d+$/.test(v.work_id) ? ctx.works.find((item) => String(item.id) === v.work_id) || null : null;
    if (!work) fail('work_id', `編集できる登録済みの作品IDではありません（${v.work_id}）`);
    else if (has('work_code') && matchKey(v.work_code) !== matchKey(work.code)) { fail('work_code', `作品IDと作品コードが一致しません（${v.work_code}）`); work = null; }
  } else if (has('work_code')) {
    work = ctx.works.find((item) => matchKey(item.code) === matchKey(v.work_code)) || null;
    if (!work) fail('work_code', `編集できる登録済みの作品コードではありません（${v.work_code}）`);
  } else fail(mapping.headerOf.work_code ? 'work_code' : 'work_id', '作品コードを入れてください');
  if (work && has('work_title') && nfkc(v.work_title) !== nfkc(work.title)) { fail('work_title', `作品名が作品IDと一致しません（${v.work_title}）`); work = null; }

  const code = nfkc(v.distribution_code);
  const type = code ? ctx.types.get(code) : null;
  if (!code) fail('distribution_code', '流通コードを入れてください');
  else if (!type) fail('distribution_code', `登録済みの流通コードではありません（${code}）`);
  else {
    if (has('distribution_name') && nfkc(v.distribution_name) !== nfkc(type.distribution_name)) fail('distribution_name', `流通コードと流通名が一致しません（${v.distribution_name}）`);
    if (has('transaction_method') && nfkc(v.transaction_method) !== nfkc(type.transaction_method)) fail('transaction_method', `流通コードと取引方法が一致しません（${v.transaction_method}）`);
  }
  const territory = trim(v.territory);
  if (!territory) fail('territory', '地域を入れてください');
  else if (territory.length > 100) fail('territory', '地域は100文字以内にしてください');

  const release = take('release_on', parseDateCell(v.release_on));
  const end = take('sales_end_on', parseDateCell(v.sales_end_on));
  const exclusivity = take('exclusivity', parseChoiceCell('exclusivity', v.exclusivity, 'unknown'));
  const status = take('status', parseChoiceCell('availabilityStatus', v.status, 'draft'));
  const terms = trim(v.terms_text);
  const source = trim(v.source_reference);
  if (terms.length > 5000) fail('terms_text', '販売条件は5000文字以内にしてください');
  if (!source) fail('source_reference', '根拠を入れてください（契約書・メールなど）');
  else if (source.length > 1000) fail('source_reference', '根拠は1000文字以内にしてください');
  if (release && end && end < release) fail('sales_end_on', '販売終了日は解禁日以降の日付にしてください');
  if (status === 'confirmed' && (!release || !end || !terms)) fail('status', '条件確認済みにするには、解禁日・販売終了日・販売条件が必要です');
  const base = take('base_version', parseIntCell(v.base_version, {min: 0})) ?? 0;

  let action = 'append';
  let diff = [];
  let old = null;
  let seriesTerritory = territory;
  if (work && type && territory && territory.length <= 100) {
    // 地域の名寄せ: ctx.resolveTerritory（流通別の販売条件の画面と同じ規則）があれば、同じ地域の既存の系列に寄せる。
    // series: 同じ作品・流通の保存済みの系列 [{territory, version_no}]
    const series = ctx.series?.get([work.id, code].join('|')) || [];
    let alias = null;
    if (typeof ctx.resolveTerritory === 'function') {
      const resolved = ctx.resolveTerritory(territory, series);
      if (resolved?.error) fail('territory', resolved.error);
      else if (resolved) {
        seriesTerritory = resolved.territory;
        if (resolved.match === 'alias') alias = resolved.territory;
        else if (resolved.territory !== territory) warnings.push(`地域「${territory}」は「${resolved.territory}」として登録します`);
      }
    } else {
      const variant = territoryVariant(territory, series.map((item) => item.territory));
      if (variant) warnings.push(`地域「${territory}」は既存の「${variant}」と表記が違うため、別の系列として追加します。同じ地域なら「${variant}」と書いてください`);
    }
    const key = [work.id, code, seriesTerritory].join('|');
    const earlier = ctx.seen?.get(key);
    if (earlier) fail('territory', `同じ作品・流通・地域の行が${earlier}行目にもあります`);
    else ctx.seen?.set(key, row.rowNo);
    old = ctx.current.get(key) || null;
    if (alias && old) warnings.push(`地域「${territory}」は登録済みの「${alias}」と同じ地域として、その系列の新しい版にします`);
    if (alias && old && base === 0) {
      fail('territory', `地域「${territory}」は登録済みの「${alias}」（第${old.version_no}版）と同じ地域です。「${alias}」の行を直すか、元の版に${old.version_no}を入れてください`);
    } else if (base !== (old?.version_no || 0)) {
      fail('base_version', old ? `出力した後に販売条件が更新されています（いまは第${old.version_no}版）。もう一度出力してから直してください` : 'この作品・流通・地域の販売条件はまだありません。元の版は空欄か0にしてください');
    }
    if (!old && type.legacy) fail('distribution_code', `旧区分の流通コード（${code}）は新しく登録できません。流通区分マスタのコードを使ってください`);
  }
  const value = {
    work_id: work?.id ?? null, distribution_code: code || null, territory: seriesTerritory || null, release_on: release ?? null, sales_end_on: end ?? null,
    exclusivity: exclusivity || 'unknown', status: status || 'draft', terms_text: terms, source_reference: source || null,
    // 調達の根拠（調達ケース・文書）は前の版から引き継ぐ（取込で黙って外さない）
    intake_case_id: old?.intake_case_id ?? null, document_id: old?.document_id ?? null,
  };
  if (old) {
    diff = AVAIL_COMPARE.filter((key) => String(value[key] ?? '') !== String(old[key] ?? ''));
    action = diff.length ? 'revise' : 'unchanged';
  }
  return {rowNo: row.rowNo, errors, warnings, action, baseVersion: base, diff, value, workTitle: work?.title ?? null, workCode: work?.code ?? null, distributionName: type?.distribution_name ?? null, distributionLabel: type ? distributionLabel(type) : null};
}

// 読み込んだブック（decodeXlsx の結果）から取込の表を選ぶ。名前の合うシート、無ければ説明用以外の最初のシート。
// 1行目が見出し。行番号は Excel の行番号（見出しが1行目なのでデータは2行目から）。
const NOT_DATA_SHEETS = new Set(['記入ガイド', '記入例', '_meta']);
export function tableFromSheets(sheets, preferred) {
  const list = Array.isArray(sheets) ? sheets : [];
  const sheet = list.find((item) => item.name === preferred) || list.find((item) => !NOT_DATA_SHEETS.has(item.name) && !/^選択肢/.test(item.name) && !item.error);
  if (sheet?.error) throw new Error(`「${sheet.name}」シートに数式のセルがあります。Excelで数式を値に変換（コピーして値として貼り付け）してから保存してください`);
  if (!sheet || !sheet.rows?.length) throw new Error(`「${preferred}」のシートが見つかりません。出力したExcelを使ってください`);
  const [headers = [], ...rows] = sheet.rows;
  return {sheetName: sheet.name, table: {headers: headers.map((value) => (value === null || value === undefined ? '' : value)), rows: rows.map((cells, index) => ({rowNo: index + 2, cells: cells || []}))}};
}

// 行の検査結果をまとめる。エラーがあれば {ok:false, …} の応答本体、なければ counts。
export function summarizeRows(results, table) {
  const failed = results.filter((row) => row.errors.length);
  const counts = {
    append: results.filter((row) => row.action === 'append').length,
    revise: results.filter((row) => row.action === 'revise').length,
    unchanged: results.filter((row) => row.action === 'unchanged').length,
    warnings: results.filter((row) => row.warnings.length).length,
    errors: failed.length,
    total: results.length,
  };
  if (!failed.length) return {ok: true, counts};
  const cellsOf = new Map(table.rows.map((row) => [row.rowNo, row.cells]));
  return {
    ok: false,
    counts,
    error: `${failed.length}行にエラーがあります（全${results.length}行）。1行でもエラーがあると、どの行も登録しません。表の理由を見て直し、もう一度読み込んでください`,
    details: failed.flatMap((row) => row.errors.map((error) => ({row: row.rowNo, column: error.column, message: error.message}))),
    headers: table.headers,
    failedRows: failed.map((row) => ({rowNo: row.rowNo, cells: cellsOf.get(row.rowNo) || [], errors: row.errors.map((error) => (error.column ? `${error.column}: ${error.message}` : error.message))})),
  };
}

// ---- 出力 ------------------------------------------------------------------------------------
// 流通区分マスタの流通の表示名（同じ分類・取引方法でも区別できるように、販売種別を先に出す）。
export function distributionLabel(type) {
  if (!type) return '';
  const salesType = nfkc(type.sales_type);
  const method = nfkc(type.transaction_method);
  const base = salesType || nfkc(type.distribution_name) || nfkc(type.label) || nfkc(type.code);
  return method && !base.includes(method) ? `${base}（${method}）` : base;
}

const COLUMN_TYPE = {id: 'id', int: 'int', code: 'code', month: 'month', date: 'date', text: 'text', select: 'text'};

function sheetColumns(sheet) {
  return exportColumns(sheet).map((column) => (column.ref
    ? {key: column.ref, label: column.header, type: 'text'}
    : {key: column.key, label: column.headers[0], type: COLUMN_TYPE[column.type] || 'text', wrap: Boolean(column.wrap), width: column.wrap ? 40 : undefined}));
}

function headerKinds(sheet) {
  return Object.fromEntries(exportColumns(sheet).map((column) => [column.ref || column.key, column.ref ? 'reference' : column.required ? 'required' : 'optional']));
}

function guideSheet(sheet, notes) {
  return {
    name: '記入ガイド',
    title: `${sheet.label}の Excel 記入ガイド`,
    conditions: [['読み込むシート', `「${sheet.name}」`], ['参考の列', '「参考_」で始まる列は確かめ用で、読み込みません']],
    columns: [{key: 'header', label: '列', type: 'text'}, {key: 'required', label: '必須', type: 'text'}, {key: 'hint', label: '説明', type: 'text', wrap: true, width: 70}],
    rows: exportColumns(sheet).map((column) => ({
      header: column.ref ? column.header : column.headers[0],
      required: column.ref ? '読み込まない' : column.required ? '必須' : '任意',
      hint: column.ref ? '確かめ用の参考情報です。書き換えても登録されません' : column.hint || '',
    })),
    notes,
    freezeCols: 1,
  };
}

// 放送枠の出力（日本語見出し）。rows は現在の版に参考情報（名称など）を付けたもの。
export function slotExportRows(slots, {work, partners = [], stations = [], agreements = []}) {
  const partnerById = new Map(partners.map((partner) => [partner.id, partner]));
  const agreementById = new Map(agreements.map((agreement) => [agreement.id, agreement]));
  return slots.map((slot) => ({
    slot_id: slot.slot_id, revision: slot.revision, work_code: work.code, broadcast_month: slot.broadcast_month, station_name: slot.station_name,
    station_status: stationPartner(slot.station_name, stations) ? '登録済みの放送局' : '未登録の局',
    customer_code: partnerById.get(slot.customer_partner_id)?.code ?? '', customer_name: partnerById.get(slot.customer_partner_id)?.name ?? '',
    agency_code: partnerById.get(slot.agency_partner_id)?.code ?? '', agency_name: partnerById.get(slot.agency_partner_id)?.name ?? '',
    agreement_code: agreementById.get(slot.agreement_id)?.contract_code ?? '', agreement_title: agreementById.get(slot.agreement_id)?.title ?? '',
    period_from: slot.period_from, period_to: slot.period_to, planned_on: slot.planned_on ?? '', planned_runs: slot.planned_runs,
    source_reference: slot.source_reference ?? '', status: labelOf('broadcastStatus', slot.status), work_title: work.title,
  }));
}

export function slotExportSheets(rows) {
  return [
    {name: SLOT_SHEET.name, titleBand: false, freezeCols: 1, columns: sheetColumns(SLOT_SHEET), rows, headerKinds: headerKinds(SLOT_SHEET)},
    guideSheet(SLOT_SHEET, [
      '放送枠IDが空欄の行は、新しい放送枠（下書き）として追加します。',
      '放送枠IDがある行は、変わった項目があれば新しい版（下書き）として保存します。申請中・確定の放送枠は取込では直せません（差し戻してから）。',
      `1回に${IMPORT_ROW_LIMIT}行まで。1行でもエラーがあれば、どの行も登録しません。画面にすべての行の理由を出し、エラーの行をExcelで受け取れます。`,
      '承認・差し戻しは取込ではなく、画面の「承認待ち」で行います。',
    ]),
  ];
}

export function availExportRows(rows, {types = new Map()} = {}) {
  return rows.map((row) => {
    const type = types.get(row.distribution_code);
    return {
      work_code: row.work_code, work_title: row.work_title, distribution_group: type?.distribution_name || (type?.legacy ? '旧区分' : ''),
      distribution_code: row.distribution_code, distribution_label: type ? distributionLabel(type) : '', territory: row.territory, base_version: row.version_no,
      release_on: row.release_on ?? '', sales_end_on: row.sales_end_on ?? '', exclusivity: labelOf('exclusivity', row.exclusivity || 'unknown'),
      status: labelOf('availabilityStatus', row.status || 'draft'), terms_text: row.terms_text ?? '', source_reference: row.source_reference ?? '',
      intake_link: row.intake_case_code ? `調達ケース ${row.intake_case_code}${row.document_title ? `・文書 ${row.document_title}` : ''}` : row.intake_case_id || row.document_id ? '調達の根拠あり' : '',
    };
  });
}

export function availExportSheets(rows) {
  return [
    {
      name: AVAIL_SHEET.name, titleBand: false, freezeCols: 1, columns: sheetColumns(AVAIL_SHEET), rows, headerKinds: headerKinds(AVAIL_SHEET),
      validations: [{key: 'exclusivity', list: optionsOf('exclusivity').map((option) => option.label)}, {key: 'status', list: optionsOf('availabilityStatus').map((option) => option.label)}],
    },
    guideSheet(AVAIL_SHEET, [
      '作品・流通・地域の組み合わせごとに版で残します。変わった項目がある行だけ新しい版を作ります。',
      '調達ケース・文書の紐付け（参考_調達の根拠）は、新しい版にもそのまま引き継ぎます。',
      '流通コードは流通区分マスタのものを使ってください。旧区分のコードは既存の行の修正だけ受け付けます。',
      `1回に${IMPORT_ROW_LIMIT}行まで。1行でもエラーがあれば、どの行も登録しません。画面にすべての行の理由を出し、エラーの行をExcelで受け取れます。`,
    ]),
  ];
}

// 英語キーの行（従来のCSVと互換）。
export function slotEnglishRows(slots, workId) {
  return [SLOT_EN_HEADERS, ...slots.map((slot) => SLOT_EN_HEADERS.map((header) => (header === 'work_id' ? workId : slot[header] ?? '')))];
}
export function availEnglishRows(rows) {
  return [AVAIL_EN_HEADERS, ...rows.map((row) => AVAIL_EN_HEADERS.map((header) => (header === 'base_version' ? row.version_no : row[header] ?? '')))];
}
// 日本語見出しの行（CSV用）。
export function japaneseRows(sheet, rows) {
  const columns = exportColumns(sheet);
  return [columns.map(jaHeader), ...rows.map((row) => columns.map((column) => row[column.ref || column.key] ?? ''))];
}

// 失敗行の Excel（元の見出しと値のまま、先頭に元の行番号、末尾にエラー理由。どちらも「参考_」なので、直して読み直せる）。
export function failedRowSheets(sheet, {fileName = '', headers = [], failedRows = []} = {}) {
  const columns = [
    {key: '__row', label: `${REFERENCE_PREFIX}元の行番号`, type: 'int'},
    ...headers.map((header, index) => ({key: `c${index}`, label: header || `列${index + 1}`, type: 'text'})),
    {key: '__error', label: `${REFERENCE_PREFIX}エラー理由`, type: 'text', wrap: true, width: 60},
  ];
  const rows = failedRows.map((row) => ({
    __row: row.rowNo, __error: (row.errors || []).join(' ／ '),
    ...Object.fromEntries(headers.map((_, index) => [`c${index}`, row.cells?.[index] ?? ''])),
  }));
  return [
    {name: '失敗行', titleBand: false, freezeCols: 1, columns, rows},
    {
      name: '記入ガイド', title: `${fileName || sheet.label} の登録できなかった行`,
      conditions: [['件数', `${rows.length}行`]],
      columns: [{key: 'text', label: '直し方', type: 'text', wrap: true, width: 90}],
      rows: [
        {text: '「参考_エラー理由」を見て、元のファイルの同じ行（参考_元の行番号）を直してください。'},
        {text: '1行でもエラーがあると、どの行も登録していません。直したら元のファイル全体をもう一度読み込んでください。'},
        {text: '「参考_」で始まる列は読み込まないので、このシートを直して読み込むこともできます（このシートにある行だけが対象になります）。'},
      ],
      freezeCols: 0,
    },
  ];
}
