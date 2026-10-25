// 企画の試算の写し（trials_snapshot.json の形の JSON）を、案件×月の予測の版にする純関数（フェーズ1の仕様書 #13。FR-REV-YOJITSU-026）。
// 写しは、代表の手元で extract_trials.ps1 が各企画の売上試算 xlsx の「回収スケジュール」の値を書き出したもの（xlsx と Excel の COM は
// 統合システムに持ち込まない。実データの写しを作るのは U-3 のあと）。読み方は会社ルート ORG/事業計画/_build/build_yojitsu.py の
// trial_books・trial_rows と同じにする。試験は架空の写し（test/fixtures/yojitsu/trials-snapshot*.json）と、それを build_yojitsu.py の
// trial_rows に流した期待値（trials-expected.json。生成は同じフォルダの trials.py）で照らす。
//
// 写しの形: [{path: 元のファイルの会社ルートからの道筋, sha256: 元のファイルの SHA-256（16進64桁）, rows: 表のセルの値の2次元の並び}]。
//  - 1列目が「入金サイト（月）」の行: 2列目が入金サイト（売上の月から入金の月までの月数）
//  - 1列目が「シナリオ」の行: 見出し。Excel の日付の通し番号（40000〜60000 の数）が最初に出る列から右が月（月初の日）
//  - 見出しより下で1列目がシナリオ（even・good・MAX）の行: 2列目が項目。「入金」は入金の合計、「出資」は出資、3列目の単位に「本」を含む行は窓口の売上
// 窓口の売上は月に入金サイトを足して入金の月にし、項目（窓口）×入金の月で足して区分「流通売上」の行（相手も項目と同じ）に、出資は月ごとに
// 足して区分「出資」の行にする。値が数でないセルと、絶対値が 0.5 以下のセルは読まない。
// 窓口の売上を入金の月で足した額と「入金」の行の差の、見出しの最後の月までの合計を円に丸めて1円を超えたら、その写しは取り込まない
// （build_yojitsu.py と同じ許容。FR-REV-YOJITSU-026）。額は Excel の計算の小数なので、10進の値のまま足してから円に丸め、ちょうど半分は偶数へ寄せる
// （build_yojitsu.py の Python の round と同じ。端数の処理は要件の要確認17）。DB・時刻・環境変数を読まない（docs/rules/architecture.md）
import {addMonths} from './yojitsu-model.mjs';

export const TRIAL_IMPORT_PREFIX = '試算の写し'; // 版の名前の頭。後ろに取り込んだ日を付ける（例: 試算の写し 2026-10-20）
export const TRIAL_SOURCE_NOTE = '（回収スケジュール。売上の月に入金サイトを足して入金の月にした）';
export const TRIAL_INVESTMENT_ITEM = '製作費（出資）';
export const TRIAL_CHECK_TOLERANCE_YEN = 1;
// 表のシナリオの語（even・good・MAX）→ 予測の行のシナリオ。並びは build_yojitsu.py の SCENARIOS と同じ（行の順もこの順）
const GRID_SCENARIOS = Object.freeze([['even', 'even'], ['good', 'good'], ['MAX', 'max']]);
const SITE_LABEL = '入金サイト（月）';
const HEADER_LABEL = 'シナリオ';
const PAID_IN_LABEL = '入金';
const INVESTMENT_LABEL = '出資';
const CHANNEL_UNIT_MARK = '本';
const SERIAL_MIN = 40000;
const SERIAL_MAX = 60000;
const MAX_YEN = BigInt(Number.MAX_SAFE_INTEGER);

// ---------- 10進の値（Excel の計算の小数）を、10の18乗倍の整数で持つ ----------
// 0.5 より大きい値は有効数字17桁以下なので小数は17桁以下で、18桁の整数倍で欠けない。0.5 以下の値は読まないので、18桁を超える分の切り捨ては結果に効かない
const SCALE_DIGITS = 18;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const HALF = SCALE / 2n;

function scaledOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  if (!m) return null;
  const fraction = m[3] ?? '';
  const digits = BigInt(m[2] + fraction);
  const exponent = Number(m[4] ?? 0) - fraction.length + SCALE_DIGITS;
  const abs = exponent >= 0 ? digits * 10n ** BigInt(exponent) : digits / 10n ** BigInt(-exponent);
  return m[1] ? -abs : abs;
}

const absOf = (scaled) => (scaled < 0n ? -scaled : scaled);

// 円に丸める。ちょうど半分は偶数へ（Python の round と同じ。符号に対して対称）
function roundHalfEvenYen(scaled) {
  const abs = absOf(scaled);
  let yen = abs / SCALE;
  const rest = abs % SCALE;
  if (rest > HALF || (rest === HALF && yen % 2n === 1n)) yen += 1n;
  if (yen > MAX_YEN) throw new Error('試算の額が安全な整数を超えます');
  return Number(scaled < 0n ? -yen : yen);
}

// 試算のセルの1つの値（数）を円に丸めた値。数でなければ null（端数の処理を試験で確かめる入口）
export function trialValueToYen(value) {
  const scaled = scaledOf(value);
  return scaled === null ? null : roundHalfEvenYen(scaled);
}

// ---------- 写しの読み取り ----------

export const trialBookName = (path) => String(path).split(/[\\/]/).at(-1);

// Excel の日付の通し番号（1899-12-30 からの日数）→ YYYY-MM-DD
function serialDate(serial) {
  return new Date(Date.UTC(1899, 11, 30 + serial)).toISOString().slice(0, 10);
}

// 試算の写しの冊ごとに、案件コードを決め、同じ案件に2冊あればファイル名の日付（_YYYYMMDD.xlsx）が新しい方を使う（build_yojitsu.py の trial_books）。
// projectByPrefix は「試算のファイル名の頭 → 案件コード」（build_yojitsu.py の 試算の案件 と同じ形）で、前から順に見て最初に合う頭を使う。
// 返り値: {chosen:[{projectCode, book, name}]（案件コードが最初に出た順）, ignored:[{name, projectCode}], errors}
export function chooseTrialBooks(snapshot, projectByPrefix) {
  const errors = [];
  if (!Array.isArray(snapshot)) return {chosen: [], ignored: [], errors: [{field: 'snapshot', message: '試算の写しは冊の並び（trials_snapshot.json の形）で渡してください'}]};
  const prefixes = Object.entries(projectByPrefix && typeof projectByPrefix === 'object' ? projectByPrefix : {});
  const byCode = new Map();
  snapshot.forEach((book, i) => {
    const at = `snapshot.${i}`;
    if (!book || typeof book !== 'object' || typeof book.path !== 'string' || !book.path.trim()) { errors.push({field: `${at}.path`, message: '試算のファイルの道筋がありません'}); return; }
    if (typeof book.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(book.sha256)) { errors.push({field: `${at}.sha256`, message: '試算のファイルの SHA-256（16進64桁）がありません'}); return; }
    if (!Array.isArray(book.rows) || !book.rows.every(Array.isArray)) { errors.push({field: `${at}.rows`, message: '試算の表の値が2次元の並びではありません'}); return; }
    const name = trialBookName(book.path);
    const hit = prefixes.find(([prefix, code]) => typeof prefix === 'string' && prefix && typeof code === 'string' && name.startsWith(prefix));
    if (!hit) { errors.push({field: `${at}.path`, message: `案件コードが決まっていない試算です: ${name}`}); return; }
    if (!byCode.has(hit[1])) byCode.set(hit[1], []);
    byCode.get(hit[1]).push({book, name});
  });
  const dateKey = ({book}) => [/_(\d{8})\.xlsx$/.exec(book.path)?.[1] ?? '', book.path];
  const chosen = [];
  const ignored = [];
  for (const [projectCode, books] of byCode) {
    const sorted = [...books].sort((a, b) => {
      const [ka, kb] = [dateKey(a), dateKey(b)];
      return ka[0] < kb[0] ? -1 : ka[0] > kb[0] ? 1 : ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
    });
    for (const old of sorted.slice(0, -1)) ignored.push({name: old.name, projectCode});
    chosen.push({projectCode, ...sorted.at(-1)});
  }
  return {chosen, ignored, errors};
}

// 1冊の試算を、予測の行と照合の結果にする。categories は {channel: 区分「流通売上」の id, investment: 区分「出資」の id}、
// status は行の状態、excluded は予測に使わない窓口の項目の集合（版の中の印。build_yojitsu.py の EXCLUDED_ITEMS に当たる）。
// 返り値: {lines:[{scenario, month, categoryId, item, counterparty, amountYen, status, useForForecast}], checks:[{scenario, diffYen}], errors}
export function readTrialBook(book, {categories, status, excluded = new Set()}) {
  const errors = [];
  const fail = (message) => ({lines: [], checks: [], errors: [...errors, {field: 'rows', message: `${trialBookName(book.path)}: ${message}`}]});
  const grid = book.rows;
  const siteRow = grid.find((r) => r[0] === SITE_LABEL);
  if (!siteRow) return fail(`「${SITE_LABEL}」の行がありません`);
  const site = siteRow[1];
  if (!Number.isSafeInteger(site) || site < 0 || site > 120) return fail('入金サイト（月）は0〜120の整数です');
  const headerIndex = grid.findIndex((r) => r[0] === HEADER_LABEL);
  if (headerIndex < 0) return fail(`見出し（1列目が「${HEADER_LABEL}」）の行がありません`);
  const header = grid[headerIndex];
  const first = header.findIndex((v) => typeof v === 'number' && v > SERIAL_MIN && v < SERIAL_MAX);
  if (first < 0) return fail('見出しに月（Excel の日付の通し番号）がありません');
  const months = [];
  for (const v of header.slice(first)) {
    if (!Number.isSafeInteger(v) || v <= SERIAL_MIN || v >= SERIAL_MAX) return fail('見出しの月の列に、日付でない値があります');
    const date = serialDate(v);
    if (!date.endsWith('-01')) return fail(`見出しの月が月初の日ではありません: ${date}`);
    months.push(date);
  }
  const last = months.at(-1);
  const lines = [];
  const checks = [];
  for (const [gridName, scenario] of GRID_SCENARIOS) {
    const channel = new Map(); // `入金の月\u0000項目` → {month, item, sum}
    const paidIn = new Map();
    const investment = new Map();
    const add = (map, key, value) => map.set(key, (map.get(key) ?? 0n) + value);
    for (const r of grid.slice(headerIndex + 1)) {
      if (r[0] !== gridName) continue;
      const label = r[1];
      const values = r.slice(first);
      for (let i = 0; i < Math.min(months.length, values.length); i += 1) {
        const v = values[i];
        if (typeof v === 'boolean') return fail(`${gridName} の ${label} の ${months[i]} に真偽の値があります`);
        const scaled = scaledOf(v);
        if (scaled === null || absOf(scaled) <= HALF) continue; // 数でないセルと、絶対値 0.5 以下のセルは読まない
        if (label === PAID_IN_LABEL) add(paidIn, months[i], scaled);
        else if (label === INVESTMENT_LABEL) add(investment, months[i], absOf(scaled));
        else if (typeof r[2] === 'string' && r[2].includes(CHANNEL_UNIT_MARK)) {
          if (typeof label !== 'string' || !label.trim()) return fail(`${gridName} の窓口の行に項目の名前がありません`);
          const month = addMonths(months[i], site);
          const key = `${month}\u0000${label}`;
          const entry = channel.get(key) ?? {month, item: label, sum: 0n};
          entry.sum += scaled;
          channel.set(key, entry);
        }
      }
    }
    // 照合: 窓口の売上を入金の月で足した額と「入金」の行の差（見出しの最後の月まで）
    const byMonth = new Map();
    for (const e of channel.values()) add(byMonth, e.month, e.sum);
    let diff = 0n;
    for (const month of new Set([...byMonth.keys(), ...paidIn.keys()])) {
      if (month <= last) diff += absOf((byMonth.get(month) ?? 0n) - (paidIn.get(month) ?? 0n));
    }
    checks.push({scenario, diffYen: roundHalfEvenYen(diff)});
    const sorted = [...channel.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
    for (const e of sorted) {
      const amountYen = roundHalfEvenYen(e.sum);
      if (amountYen < 1) return fail(`${gridName} の ${e.item} の ${e.month} の額が正ではありません（予測の行の額は正の整数）`);
      lines.push({scenario, month: e.month, categoryId: categories.channel, item: e.item, counterparty: e.item, amountYen, status, useForForecast: !excluded.has(e.item)});
    }
    for (const month of [...investment.keys()].sort()) {
      lines.push({scenario, month, categoryId: categories.investment, item: TRIAL_INVESTMENT_ITEM, counterparty: null,
        amountYen: roundHalfEvenYen(investment.get(month)), status, useForForecast: true});
    }
  }
  return {lines, checks, errors};
}

// 試算の写しの取り込みの計画（書く前に全部を決める）。existing は 案件コード → {latestVersionNo, sha256s: 小文字の SHA-256 の集合}
// （案件の予測の版の全部。前に同じ写しを取り込んだ案件は、写し済みとして足さない。build_yojitsu.py と同じく、改めた写しのあとで古い写しに
// 戻しても足さない）。足す版は、その案件の予測の新しい版（前の版は残り「予測に使う＝いいえ」と読む）。
// 照合の差が1円を超えた冊が1つでもあれば、どの冊も足さない（errors に入れる）。
// 返り値: {versions:[{projectCode, name, previousVersionNo, label, sourceKind, source, sourceSha256, createdOn, lines}], skipped:[{name, projectCode, reason}],
//   checks:[{name, projectCode, scenario, diffYen}], errors}
export function planTrialImport(snapshot, {projectByPrefix, existing = new Map(), createdOn, status, excludedItems = [], categories}) {
  const {chosen, ignored, errors} = chooseTrialBooks(snapshot, projectByPrefix);
  const skipped = ignored.map((x) => ({...x, reason: 'older_book'}));
  const versions = [];
  const checks = [];
  const excluded = new Set(excludedItems);
  for (const {projectCode, book, name} of chosen) {
    const sha256 = book.sha256.toLowerCase();
    const before = existing.get(projectCode) ?? {latestVersionNo: 0, sha256s: new Set()};
    if (before.sha256s.has(sha256)) { skipped.push({name, projectCode, reason: 'already_imported'}); continue; }
    const read = readTrialBook(book, {categories, status, excluded});
    errors.push(...read.errors);
    if (read.errors.length) continue;
    for (const c of read.checks) {
      checks.push({name, projectCode, ...c});
      if (c.diffYen > TRIAL_CHECK_TOLERANCE_YEN) {
        errors.push({field: 'snapshot', message: `${name} の ${c.scenario} の窓口の売上と入金の行が合いません（差 ${c.diffYen} 円。許容は ${TRIAL_CHECK_TOLERANCE_YEN} 円）`});
      }
    }
    if (!read.lines.length) { skipped.push({name, projectCode, reason: 'no_lines'}); continue; }
    versions.push({projectCode, name, previousVersionNo: before.latestVersionNo, label: `${TRIAL_IMPORT_PREFIX} ${createdOn}`, sourceKind: 'trial_import',
      source: `${book.path}${TRIAL_SOURCE_NOTE}SHA-256 ${book.sha256.slice(0, 16).toUpperCase()}`, sourceSha256: sha256, createdOn, lines: read.lines});
  }
  return {versions: errors.length ? [] : versions, skipped, checks, errors};
}
