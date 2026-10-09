// 流通別の販売条件（営業作品一覧）と営業資料の表示・入力の純関数。ブラウザ・Node・Worker で同じ結果を返す。
// - 地域: 選択肢と名寄せ。「日本」「国内」「Japan」を同じ地域として扱い、新しく入力された値と表示を正規化する。
//   保存済みの値は書き換えない（版の系列は保存済みの文字列のまま続ける）。
// - 状態: 語彙は labels.mjs の availabilityStatus の1つだけを使う。
// - 流通: 流通区分マスタを分類見出しつきで選ばせる。旧分類は登録済みの版を開いたときだけ出す。
// - 営業資料: 作品マスタ（あらすじ・キャッチ・クレジット・尺）から作品概要の下書きを作る。
import {labelOf, optionsOf} from '../ui/labels.mjs';

// ---- 地域 ----

// 地域の選択肢。value は保存する文字列（表示名そのもの）。aliases は名寄せに使う別表記。
export const TERRITORIES = Object.freeze([
  {key: 'JP', label: '日本', aliases: ['日本', '国内', '日本国内', '日本国', '日本全国', '日本全域', '全国', '本邦', 'にほん', 'にっぽん', 'ジャパン', 'japan', 'jp', 'jpn']},
  {key: 'WW', label: '全世界', aliases: ['全世界', '世界', '世界全域', '全世界(日本を含む)', '全地域', 'ワールドワイド', 'グローバル', 'worldwide', 'world', 'world-wide', 'ww', 'global']},
  {key: 'WW_EX_JP', label: '全世界（日本を除く）', aliases: ['全世界(日本を除く)', '全世界(日本除く)', '日本を除く全世界', '日本以外', '海外', '海外全域', 'ex-japan', 'exjapan', 'worldexjapan', 'worldwideexcludingjapan', 'overseas']},
  {key: 'ASIA', label: 'アジア', aliases: ['アジア', 'アジア全域', 'asia']},
  {key: 'NA', label: '北米', aliases: ['北米', '北アメリカ', '米国・カナダ', '米加', 'northamerica', 'na']},
  {key: 'US', label: '米国', aliases: ['米国', 'アメリカ', 'アメリカ合衆国', 'usa', 'us', 'u.s.', 'u.s.a.', 'unitedstates']},
  {key: 'EU', label: '欧州', aliases: ['欧州', 'ヨーロッパ', 'europe', 'eu']},
  {key: 'CN', label: '中国', aliases: ['中国', '中国本土', '中華人民共和国', 'china', 'cn', 'prc']},
  {key: 'KR', label: '韓国', aliases: ['韓国', '大韓民国', 'korea', 'southkorea', 'kr']},
  {key: 'TW', label: '台湾', aliases: ['台湾', 'taiwan', 'tw']},
  {key: 'HK', label: '香港', aliases: ['香港', 'hongkong', 'hk']},
]);

export const OTHER_TERRITORY = '__other__';

// 表記の比較用: 全角半角をそろえ（NFKC）、小文字にし、空白を除く。
export function compactTerritory(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

const ALIAS_INDEX = new Map(TERRITORIES.flatMap((territory) => [territory.label, ...territory.aliases].map((alias) => [compactTerritory(alias), territory])));

export function knownTerritory(value) {
  return ALIAS_INDEX.get(compactTerritory(value)) || null;
}

// 名寄せのキー。既知の地域はそのキー、未知の値は表記をそろえた文字列、空は ''。
export function territoryKey(value) {
  const compact = compactTerritory(value);
  if (!compact) return '';
  return knownTerritory(value)?.key || `raw:${compact}`;
}

// 表示名。既知の地域は正規の名前、未知の値は前後の空白を除いた文字（全角英数は半角に）。空は「未確認」。
export function territoryLabel(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text) return '未確認';
  return knownTerritory(text)?.label || text;
}

export function territoryOptions({withOther = true} = {}) {
  const options = TERRITORIES.map((territory) => ({value: territory.label, label: territory.label}));
  return withOther ? [...options, {value: OTHER_TERRITORY, label: 'その他（入力する）'}] : options;
}

// 保存済みの地域を入力欄（選択＋その他の文字）へ戻す。既知の地域は選択肢、未知の値は「その他」に入れる。
export function territoryInput(value) {
  const text = String(value ?? '').trim();
  if (!text) return {select: '', other: ''};
  const known = knownTerritory(text);
  return known ? {select: known.label, other: ''} : {select: OTHER_TERRITORY, other: text};
}

// 入力欄（選択＋その他の文字）から地域の文字を取り出す（未入力は ''）。保存前の名寄せは resolveTerritory で行う。
export function territoryFromInput(select, other) {
  if (select === OTHER_TERRITORY) return String(other ?? '').trim();
  return String(select ?? '').trim();
}

// 入力欄の値（選択肢 or 自由入力）から、保存前の地域を決める。
// existing: 同じ作品・流通に保存済みの版の系列 [{territory, version_no}]。
// 返り値: {territory: 保存する文字列, label, key, match: 'exact'|'alias'|'new', aliasOf?} または {error}
export function resolveTerritory(input, existing = []) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return {error: '地域を選んでください'};
  if (trimmed.length > 100) return {error: '地域は100文字以内で入力してください'};
  const key = territoryKey(trimmed);
  const exact = existing.find((row) => row.territory === trimmed);
  if (exact) return {territory: exact.territory, label: territoryLabel(exact.territory), key, match: 'exact'};
  const same = existing.filter((row) => territoryKey(row.territory) === key)
    .sort((a, b) => (Number(b.version_no) || 0) - (Number(a.version_no) || 0) || String(a.territory).localeCompare(String(b.territory)));
  if (same.length) return {territory: same[0].territory, label: territoryLabel(same[0].territory), key, match: 'alias', aliasOf: trimmed};
  const label = territoryLabel(trimmed);
  return {territory: label, label, key, match: 'new'};
}

// 同じ作品・流通で、名寄せすると同じ地域なのに別の文字で保存された系列（表記ゆれで版が分かれたもの）。
// rows: [{work_id, distribution_code, territory}] → Map(行の系列キー → 同じ地域の保存済み表記の一覧（2つ以上のときだけ）)
export function territoryVariants(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const group = `${row.work_id}|${row.distribution_code}|${territoryKey(row.territory)}`;
    if (!groups.has(group)) groups.set(group, new Set());
    groups.get(group).add(row.territory);
  }
  const out = new Map();
  for (const row of rows) {
    const set = groups.get(`${row.work_id}|${row.distribution_code}|${territoryKey(row.territory)}`);
    if (set && set.size > 1) out.set(seriesKey(row), [...set].sort());
  }
  return out;
}

export const seriesKey = (row) => `${row.work_id}|${row.distribution_code}|${row.territory}`;

// ---- 状態 ----

// 保存された状態（draft/confirmed/withdrawn）の表示名。語彙は labels.mjs の1つだけ。
export function availabilityStatusLabel(code) {
  return labelOf('availabilityStatus', code);
}

export function availabilityStatusOptions() {
  return optionsOf('availabilityStatus');
}

// 確認日時点の販売期間の状況。保存された状態とは別の列で見せる。
export function periodState(row, asOf) {
  if (row?.status === 'withdrawn') return {code: 'withdrawn', label: '対象外（取り下げ）', tone: 'info'};
  if (!row?.release_on || !row?.sales_end_on) return {code: 'unknown', label: '期間未確認', tone: 'warn'};
  if (asOf < row.release_on) return {code: 'before', label: '解禁前', tone: 'info'};
  if (asOf > row.sales_end_on) return {code: 'ended', label: '販売終了', tone: 'info'};
  return {code: 'active', label: '販売期間中', tone: 'ok'};
}

// ---- 流通 ----

const groupName = (type) => String(type.distribution_name || '').replace(/_/g, '・');

// 流通名の中での区別（販売種別から流通名の重複を除き、取引方法を足す）。例: 配給×RS×劇場_RS →「劇場・RS」。
function kindText(type) {
  const name = String(type.distribution_name || '');
  let kind = String(type.sales_type || '');
  if (kind === name) kind = '';
  else if (kind.startsWith(`${name}_`)) kind = kind.slice(name.length + 1);
  kind = kind.replace(/_/g, '・');
  const method = String(type.transaction_method || '');
  if (!kind) return method;
  return !method || kind.includes(method) ? kind : `${kind}・${method}`;
}

// 流通区分の表示名（流通IDは出さない）。マスタにある区分は「流通名・区別」、旧分類は旧ラベル。
export function distributionDisplay(type) {
  if (!type) return '未登録の流通';
  if (type.distribution_name) {
    const kind = kindText(type);
    return kind ? `${groupName(type)}・${kind}` : groupName(type);
  }
  return type.label || '未登録の流通';
}

// 選択肢を分類見出し（流通名）ごとにまとめる。旧分類は currentCode が旧分類のときだけ末尾に出す。
export function distributionGroups(types = [], currentCode = '') {
  const groups = [];
  const byName = new Map();
  for (const type of types) {
    if (type.legacy || !type.distribution_name) continue;
    const name = groupName(type);
    if (!byName.has(name)) {
      const group = {label: name, options: []};
      byName.set(name, group);
      groups.push(group);
    }
    byName.get(name).options.push({value: type.code, label: `${kindText(type) || name}（${type.code}）`});
  }
  const current = types.find((type) => type.code === currentCode);
  if (current && (current.legacy || !current.distribution_name)) {
    groups.push({label: '旧分類（登録済みの版だけ）', options: [{value: current.code, label: current.label || current.code}]});
  }
  return groups;
}

// ---- 一覧の行 ----

// GET /api/sales-catalog の結果を表の行にする。流通条件の無い作品は「流通条件未登録」の行として含める（出力にも残す）。
export function catalogGridRows(result, asOf) {
  if (!result) return [];
  const types = result.types || [];
  const variants = territoryVariants(result.rows || []);
  const intakes = new Map((result.intakes || []).map((row) => [row.id, row]));
  const rows = (result.rows || []).map((row) => {
    const type = types.find((item) => item.code === row.distribution_code);
    const period = periodState(row, asOf);
    return {
      key: `v:${row.id}`,
      kind: 'condition',
      row,
      work_id: row.work_id,
      work_title: row.work_title,
      distribution_code: row.distribution_code,
      distribution: distributionDisplay(type || {label: row.distribution_label}),
      territory: territoryLabel(row.territory),
      territory_raw: row.territory,
      territory_variants: variants.get(seriesKey(row)) || null,
      release_on: row.release_on || null,
      sales_end_on: row.sales_end_on || null,
      status: row.status,
      status_label: availabilityStatusLabel(row.status),
      period: period.label,
      period_code: period.code,
      period_tone: period.tone,
      overlaps: (row.overlaps || []).map((item) => item.contract_code).join('、') || null,
      exclusivity: labelOf('exclusivity', row.exclusivity),
      terms_text: row.terms_text || null,
      source_reference: row.source_reference || null,
      intake: row.intake_case_id ? (intakes.get(row.intake_case_id)?.case_code || '登録済み') : null,
      version_no: row.version_no,
    };
  });
  const missing = (result.missing || []).map((row) => ({
    key: `m:${row.work_id}`,
    kind: 'missing',
    work_id: row.work_id,
    work_title: row.work_title,
    distribution: null,
    territory: null,
    status_label: '流通条件未登録',
    period: null,
    version_no: null,
  }));
  return [...rows, ...missing];
}

// ---- 営業資料 ----

const CREDIT_ROLES = [['director', '監督'], ['writer', '脚本'], ['cast', '出演']];

// 作品マスタ（/api/work-catalog の作品と profile）から、営業資料のタイトルと作品概要の下書きを作る。
// 返り値: {title, synopsis, filled: 作品マスタから入れた項目名の一覧, missing: 未登録の項目名の一覧}
export function materialDraft({work, profile, partnerName} = {}) {
  const title = work?.title ? `${work.title}のご提案${partnerName ? `（${partnerName}向け）` : ''}` : '';
  const filled = [];
  const missing = [];
  const blocks = [];
  const catchCopy = profile?.catch_short || profile?.catch_long;
  if (catchCopy) { blocks.push(String(catchCopy).trim()); filled.push('キャッチコピー'); } else missing.push('キャッチコピー');
  const synopsis = profile?.synopsis_long || profile?.synopsis_short;
  if (synopsis) { blocks.push(String(synopsis).trim()); filled.push('あらすじ'); } else missing.push('あらすじ');
  const credits = [];
  for (const [role, label] of CREDIT_ROLES) {
    const names = (profile?.credits || []).filter((credit) => credit.role === role).map((credit) => credit.name).filter(Boolean);
    if (names.length) credits.push(`${label}: ${names.join('、')}`);
  }
  if (credits.length) { blocks.push(credits.join('\n')); filled.push('クレジット'); } else missing.push('クレジット');
  const facts = [];
  const runtime = (profile?.editions || []).map((edition) => Number(edition.runtime_seconds)).find((seconds) => Number.isFinite(seconds) && seconds > 0);
  if (runtime) facts.push(`本編 ${Math.round(runtime / 60)}分`);
  if (profile?.production_year) facts.push(`${profile.production_year}年製作`);
  if (facts.length) { blocks.push(facts.join('／')); filled.push(runtime ? '尺' : '製作年'); }
  return {title, synopsis: blocks.join('\n\n'), filled, missing, hasProfile: Boolean(profile)};
}

// 保存済みの版から、次の版の入力値を作る（同じ営業案件・商品・本文）。
export function materialFromVersion(row) {
  return {
    opportunityId: row?.opportunity_id ? String(row.opportunity_id) : '',
    productId: row?.product_id ? String(row.product_id) : '',
    title: row?.title || '',
    synopsis: row?.synopsis || '',
    pitch: row?.pitch || '',
    terms: row?.terms_text || '',
  };
}
