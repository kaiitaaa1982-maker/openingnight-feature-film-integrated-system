// 案件収支の予実（YOJITSU）の、案件×月の予測の版の純関数（フェーズ1の仕様書 #13、移行 0015）: 版の入力の読み取り、有効な版の選び方、
// 読む人に返す形、予測に使う行の区分×月の収支（入金は正・出金は負）。要件は docs/requirements/revenue/project-cashflow-forecast-actual.md の
// FR-REV-YOJITSU-023・026。4段の着地・確度加重（#14）と月別の収支の見込み（#14）は、ここの forecastCashflowByMonth と同じ「予測に使う行」を読む。
// DB・時刻・環境変数を読まない（docs/rules/architecture.md）。金額は整数の円（docs/rules/money.md）
import {ASSUMPTION_STATUSES, isCalendarDate, signedCashflowYen} from '../../planning/project/project-model.mjs';
import {isMonthStart} from './yojitsu-model.mjs';

// シナリオ（試算のケース。移行 0015 の yojitsu_forecast_lines.scenario の CHECK と同じ並び）。表の語は小文字で、画面の語は Excel と同じ
export const FORECAST_SCENARIOS = Object.freeze(['even', 'good', 'max', 'single']);
export const FORECAST_SCENARIO_LABELS = Object.freeze({even: 'even', good: 'good', max: 'MAX', single: '単一'});
// 「単一」の行は、採用するシナリオに関わらず予測に使う（試算のケースが1つしか無い予測。Excel の「採用するシナリオか単一」）
export const SINGLE_SCENARIO = 'single';
// 出所の種類（試算の写し・手入力・施策の既定の予測行）。試算の写しだけが元のファイルの SHA-256 を持つ
export const FORECAST_SOURCE_KINDS = Object.freeze(['trial_import', 'manual', 'initiative']);
// 1つの版の行の上限。版の文（ヘッダ1・8行ずつの行の文・audit_log 1）が D1 の1回の batch（480文）に収まる数: (480 - 2) × 8。
// 移行 0015 の yojitsu_forecast_versions.line_count の CHECK と同じ（src/revenue/revenue-store.mjs の FORECAST_BATCH_STATEMENTS）
export const MAX_FORECAST_LINES = 3824;

const MAX_YEN = Number.MAX_SAFE_INTEGER;
const isInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const SHA256 = /^[0-9a-fA-F]{64}$/;

// 前後の空白を除いた文字（空・文字でないものは null。長すぎるものは誤り）
function readText(errors, field, value, {max, required, label}) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    if (required) errors.push({field, message: `${label}を入れてください`});
    return null;
  }
  if (typeof value !== 'string') { errors.push({field, message: `${label}は文字で入れてください`}); return null; }
  const out = value.trim();
  if (out.length > max) errors.push({field, message: `${label}は${max}文字までです`});
  return out;
}

// 予測の版の入力（受け口・試算の取り込み・種が渡す形）を、store に渡す値にそろえる。categories は組織の区分マスタの行（id）。
// 移行 0015 の CHECK と同じ決まりを先に見て、項目ごとの誤りを返す。返り値: {ok, value, errors:[{field, message}]}。
// 行の useForForecast を省くと「予測に使う」。版の番号は画面が見ていた版の次（previousVersionNo + 1。古い画面からの書き込みは DB が断る）
export function normalizeForecastVersionInput(raw, {categories}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const err = (field, message) => errors.push({field, message});
  if (!isInt(src.projectId, 1, MAX_YEN)) err('projectId', '案件を選んでください');
  const previousVersionNo = src.previousVersionNo ?? 0;
  if (!isInt(previousVersionNo, 0, MAX_YEN)) err('previousVersionNo', '前の版の番号は0以上の整数です');
  const label = readText(errors, 'label', src.label, {max: 100, required: true, label: '版の名前'});
  if (!FORECAST_SOURCE_KINDS.includes(src.sourceKind)) err('sourceKind', '出所の種類は 試算の写し・手入力・施策の既定の予測 のどれかです');
  const source = readText(errors, 'source', src.source, {max: 1000, required: true, label: '出所'});
  let sourceSha256 = src.sourceSha256 ?? null;
  if (src.sourceKind === 'trial_import') {
    if (typeof sourceSha256 !== 'string' || !SHA256.test(sourceSha256)) err('sourceSha256', '試算の写しは元のファイルの SHA-256（16進64桁）を持ちます');
    else sourceSha256 = sourceSha256.toLowerCase();
  } else if (sourceSha256 !== null) err('sourceSha256', 'SHA-256 は試算の写しだけが持ちます');
  if (!isCalendarDate(src.createdOn)) err('createdOn', '作った日は YYYY-MM-DD の日付で入れてください');
  const categoryIds = new Set((categories ?? []).map((c) => Number(c.id)));
  const lines = Array.isArray(src.lines) ? src.lines : [];
  if (!lines.length) err('lines', '予測の行を1行以上入れてください');
  if (lines.length > MAX_FORECAST_LINES) err('lines', `予測の行は1つの版に${MAX_FORECAST_LINES}行までです`);
  const value = lines.map((line, i) => {
    const l = line && typeof line === 'object' ? line : {};
    const at = (name) => `lines.${i}.${name}`;
    if (!FORECAST_SCENARIOS.includes(l.scenario)) err(at('scenario'), 'シナリオは even・good・MAX・単一 のどれかです');
    if (!isMonthStart(l.month)) err(at('month'), '月は月初の日（YYYY-MM-01）で入れてください');
    if (!categoryIds.has(l.categoryId)) err(at('categoryId'), '区分は組織の区分マスタから選んでください');
    const item = readText(errors, at('item'), l.item, {max: 200, required: true, label: '項目'});
    const counterparty = readText(errors, at('counterparty'), l.counterparty, {max: 200, required: false, label: '相手'});
    if (!isInt(l.amountYen, 1, MAX_YEN)) err(at('amountYen'), '金額は1以上の整数の円（税別）で入れてください。入金か出金かは区分で決まります');
    if (!ASSUMPTION_STATUSES.includes(l.status)) err(at('status'), '状態は 確認済み・監督申告・報道値・仮置き のどれかです');
    const useForForecast = l.useForForecast ?? true;
    if (typeof useForForecast !== 'boolean') err(at('useForForecast'), '予測に使うかは はい・いいえ で入れてください');
    return {lineNo: i + 1, scenario: l.scenario, month: l.month, categoryId: l.categoryId, item, counterparty, amountYen: l.amountYen, status: l.status, useForForecast};
  });
  return {ok: errors.length === 0, errors, value: {projectId: src.projectId, previousVersionNo, label, sourceKind: src.sourceKind, source, sourceSha256,
    createdOn: src.createdOn, lines: value}};
}

// 予測の版のヘッダの行から、案件ごとの最新の version_no の版の id（有効な予測。FR-REV-YOJITSU-023・026）。
// stored_line_count（DB にある行の数）が line_count に満たない版は有効にしない（版と行は store の1回の batch で書くので、アプリを通さない
// 書き込みでだけ起きる）。案件の最新の版が欠けていれば、その案件に有効な予測は無い（前の版には戻さない）
export function latestForecastVersionIds(versions) {
  const best = new Map();
  for (const row of versions) {
    const current = best.get(Number(row.project_id));
    if (!current || Number(row.version_no) > Number(current.version_no)) best.set(Number(row.project_id), row);
  }
  return new Set([...best.values()].filter((row) => Number(row.stored_line_count) === Number(row.line_count)).map((row) => Number(row.id)));
}

// 予測の版のヘッダと行を、読む人に返す形にする。予測に使う（used）は、版が有効で、行の印が 1 のとき。
// 前の版の行は、印に関わらず使わない（Excel の「予測に使う＝いいえ」）。lines は行の番号の順
export function forecastVersionView(version, lines, {effective}) {
  return {id: Number(version.id), projectId: Number(version.project_id), versionNo: Number(version.version_no), label: version.label,
    sourceKind: version.source_kind, source: version.source, sourceSha256: version.source_sha256 ?? null, createdOn: version.created_on,
    lineCount: Number(version.line_count), effective: Boolean(effective),
    lines: lines.map((l) => ({lineNo: Number(l.line_no), scenario: l.scenario, month: l.forecast_month, categoryId: Number(l.category_id), item: l.item,
      counterparty: l.counterparty ?? null, amountYen: Number(l.amount_yen), status: l.status, useForForecast: Number(l.use_for_forecast) === 1,
      used: Boolean(effective) && Number(l.use_for_forecast) === 1}))};
}

// 予測に使う行の、区分×月の収支（入金は正・出金は負の整数の円）。versions は forecastVersionView の形。
// 採用するシナリオ（scenario）の行と「単一」の行だけを足す（Excel の「採用するシナリオか単一」）。採用するシナリオが「単一」なら単一の行だけ
// （設定の選択肢は even・good・MAX・単一。FR-REV-YOJITSU-045・要確認15）。includeProject（案件の id → 真偽）で入れる案件を絞る（月別の表に
// 入れる案件の範囲〈企画中も含む・着地・契約済み〉は予実のビュー #14 が決めて渡す）。返り値: 区分の id → (月初の日 → 円)。値の無い月は Map に無い（0円で埋めない）
export function forecastCashflowByMonth(versions, {categories, scenario, includeProject = () => true}) {
  if (!FORECAST_SCENARIOS.includes(scenario)) throw new Error('採用するシナリオは even・good・MAX・単一 のどれかです');
  const byId = new Map(categories.map((c) => [Number(c.id), c]));
  const out = new Map();
  for (const version of versions) {
    if (!includeProject(version.projectId)) continue;
    for (const line of version.lines) {
      if (!line.used || (line.scenario !== scenario && line.scenario !== SINGLE_SCENARIO)) continue;
      const category = byId.get(line.categoryId);
      if (!category) throw new Error(`区分を読めません: ${line.categoryId}`);
      if (!out.has(line.categoryId)) out.set(line.categoryId, new Map());
      const months = out.get(line.categoryId);
      const total = (months.get(line.month) ?? 0) + signedCashflowYen(category, line.amountYen);
      if (!Number.isSafeInteger(total)) throw new Error('合計が安全な整数を超えます');
      months.set(line.month, total);
    }
  }
  return out;
}
