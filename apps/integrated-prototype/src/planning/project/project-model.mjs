// 案件の登録（型・稼ぎ方・段階・基準額・売上率）の入力の読み取りと、使う売上率・ステップの畳み方・区分の符号を決める純関数。
// フェーズ1の仕様書 #10。要件は docs/requirements/revenue/project-cashflow-forecast-actual.md（FR-REV-YOJITSU-015・018〜020・024）と
// contract-work.md（FR-REV-CWORK-014〜016）。稼ぎ方・段階・ステップのコードは参照表の行（移行 0012）が正本で、ここでは引数で受け取る。
// DB・時刻・環境変数を読まない（docs/rules/architecture.md）。金額は整数の円、率は整数の bp（docs/rules/money.md）
import {contractVersionComplete} from '../contract-production/contract-production-model.mjs';

// 案件の型（ontology の6つ。移行 0012 の projects.project_type の CHECK と同じ並び）。現場受託・製作・買付・受託配給・受託開発・受託制作
export const PROJECT_TYPES = Object.freeze(['field_contract', 'production', 'acquisition', 'agency', 'sw_contract', 'contract_production']);
export const PROJECT_TYPE_LABELS = Object.freeze({
  field_contract: '現場受託', production: '製作', acquisition: '買付', agency: '受託配給', sw_contract: '受託開発', contract_production: '受託制作',
});
// 前提の数字の状態（K-9。確認済み・監督申告・報道値・仮置き）。移行 0012 の earning_type_rate_versions.status の CHECK と同じ並び
export const ASSUMPTION_STATUSES = Object.freeze(['confirmed', 'director_reported', 'press_reported', 'provisional']);

const MAX_YEN = Number.MAX_SAFE_INTEGER;
const isInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

// 前後の空白を除いた文字。空なら null。文字でないものは undefined（誤り）
function text(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// 暦の日付（YYYY-MM-DD・半角の数字）だけを日付とみなす。2月30日・4月31日・うるう年でない2月29日は断る
export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

function readText(errors, field, value, {max, required = false, label}) {
  const out = text(value);
  if (out === undefined) errors.push({field, message: `${label}は文字で入れてください`});
  else if (out === null && required) errors.push({field, message: `${label}を入れてください`});
  else if (out !== null && out.length > max) errors.push({field, message: `${label}は${max}文字までです`});
  return out ?? null;
}

// 段階（登録と同時の最初の段階・段階の変更で同じ決まり）。理由の要る段階（見送り）は理由が要る。fields は誤りに付ける項目の名前
const STAGE_FIELDS = Object.freeze({code: 'stage.code', enteredOn: 'stage.enteredOn', evidence: 'stage.evidence', reason: 'stage.reason'});
const CHANGE_FIELDS = Object.freeze({code: 'stageCode', enteredOn: 'enteredOn', evidence: 'evidence', reason: 'reason'});
function readStage(errors, fields, {code, enteredOn, evidence, reason}, stages) {
  const stage = stages.find((s) => s.code === code);
  if (!stage) errors.push({field: fields.code, message: '段階は段階の一覧から選んでください'});
  if (!isCalendarDate(enteredOn)) errors.push({field: fields.enteredOn, message: '段階に入った日は YYYY-MM-DD の日付で入れてください'});
  const evidenceText = readText(errors, fields.evidence, evidence, {max: 1000, label: '言質'});
  const reasonText = readText(errors, fields.reason, reason, {max: 1000, label: '理由'});
  if (stage && Number(stage.requires_reason) === 1 && reasonText === null) errors.push({field: fields.reason, message: `「${stage.label}」にするときは理由を入れてください`});
  return {evidence: evidenceText, reason: reasonText};
}

// 案件の登録の入力（画面・施策の受け口が渡す JSON）を、store に渡す形にそろえる。
// earningTypes は稼ぎ方の参照表の行（code・project_type・rate_source）、stages は段階の参照表の行（code・label・requires_reason）。
// 返り値: {ok, value, errors:[{field, message}]}。ok が false のときは value を使わない
export function normalizeProjectInput(raw, {earningTypes, stages}) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const code = readText(errors, 'code', src.code, {max: 40, required: true, label: '案件コード'});
  const title = readText(errors, 'title', src.title, {max: 200, required: true, label: '案件名'});
  const projectType = src.projectType;
  if (!PROJECT_TYPES.includes(projectType)) errors.push({field: 'projectType', message: `案件の型は ${PROJECT_TYPES.map((t) => PROJECT_TYPE_LABELS[t]).join('・')} のどれかです`});
  // 稼ぎ方は型と対応表の組だけ。稼ぎ方のある型では稼ぎ方が要り、稼ぎ方の無い型（現場受託・受託開発）では持たない
  const allowed = earningTypes.filter((e) => e.project_type === projectType);
  const earningType = src.earningType ?? null;
  const earning = earningTypes.find((e) => e.code === earningType) ?? null;
  if (PROJECT_TYPES.includes(projectType)) {
    if (allowed.length && !allowed.some((e) => e.code === earningType)) errors.push({field: 'earningType', message: `この型の稼ぎ方は ${allowed.map((e) => e.label).join('・')} のどれかです`});
    if (!allowed.length && earningType !== null) errors.push({field: 'earningType', message: `${PROJECT_TYPE_LABELS[projectType]}の案件は稼ぎ方を持ちません`});
  }
  const baseAmountYen = src.baseAmountYen ?? null;
  if (baseAmountYen !== null && !isInt(baseAmountYen, 0, MAX_YEN)) errors.push({field: 'baseAmountYen', message: '基準額は0以上の整数の円で入れてください'});
  const revenueRateBps = src.revenueRateBps ?? null;
  if (revenueRateBps !== null) {
    if (!isInt(revenueRateBps, 0, 10000)) errors.push({field: 'revenueRateBps', message: '売上率は 0〜10000 の整数の bp で入れてください'});
    else if (!earning) errors.push({field: 'revenueRateBps', message: '稼ぎ方の無い案件は売上率を持ちません'});
    else if (earning.rate_source !== 'project') errors.push({field: 'revenueRateBps', message: `${earning.label}は受託の契約の版の受託費率を使うので、案件の売上率を入れません`});
  }
  const startedOn = src.startedOn ?? null;
  if (startedOn !== null && !isCalendarDate(startedOn)) errors.push({field: 'startedOn', message: '始めた日は YYYY-MM-DD の日付で入れてください'});
  const value = {
    code, title, projectType, earningType, baseAmountYen, revenueRateBps,
    counterpartyName: readText(errors, 'counterpartyName', src.counterpartyName, {max: 200, label: '相手'}),
    keyPerson: readText(errors, 'keyPerson', src.keyPerson, {max: 200, label: 'キーパーソン'}),
    startedOn,
    planningFolder: readText(errors, 'planningFolder', src.planningFolder, {max: 500, label: '企画フォルダ'}),
    note: readText(errors, 'note', src.note, {max: 2000, label: 'メモ'}),
    stage: null,
  };
  if (src.stage !== null && src.stage !== undefined) {
    const s = src.stage;
    const {evidence, reason} = readStage(errors, STAGE_FIELDS, {code: s.code, enteredOn: s.enteredOn, evidence: s.evidence, reason: s.reason}, stages);
    value.stage = {code: s.code, enteredOn: s.enteredOn, evidence, reason};
  }
  return {ok: errors.length === 0, value, errors};
}

// 段階の変更（段階の履歴に1行足す）の入力をそろえる。previousStageCode は画面が見ていた段階（最初の段階なら null）で、
// DB が最新の行の段階と照らして古い画面からの書き込みを断る（移行 0012 の project_stage_events_stale）
export function normalizeStageChange(raw, {stages}) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const previousStageCode = src.previousStageCode ?? null;
  if (previousStageCode !== null && !stages.some((s) => s.code === previousStageCode)) errors.push({field: 'previousStageCode', message: '前の段階を読めません'});
  const {evidence, reason} = readStage(errors, CHANGE_FIELDS, {code: src.stageCode, enteredOn: src.enteredOn, evidence: src.evidence, reason: src.reason}, stages);
  if (src.stageCode !== undefined && src.stageCode === previousStageCode) errors.push({field: 'stageCode', message: '同じ段階へは変えません'});
  return {ok: errors.length === 0, errors, value: {stageCode: src.stageCode, previousStageCode, enteredOn: src.enteredOn, evidence, reason}};
}

// 案件に使う売上率（FR-REV-YOJITSU-020）。project は案件の行（revenue_rate_bps）、earningType は稼ぎ方の参照表の行、
// defaultRate はその組織・稼ぎ方の既定の売上率の最新の版（無ければ null）。
// 制作受託（rate_source=contract）は、受託の契約の版（移行 0013。フェーズ1 #10b）の最新の版の受託費率を使い（FR-REV-YOJITSU-044）、
// 案件の売上率と既定は使わない。contractVersion は store の readLatestContractVersions の行（無ければ null）で、
// 版が無ければ理由 contract_version_unregistered、節目が揃っていない版なら contract_version_incomplete（契約前の手入力は要確認1）。
// ほかの稼ぎ方の順は 案件の値 → 買い切りの買付は 10000 → 稼ぎ方の既定。買い切りの売上は権利売上そのもの（要件の対応表の「売上の数え方」。
// acquisitionTerms は revenue-class-model の acquisitionTermsOf の値で、契約の分からない買付は既定の率＝窓口手数料率のまま）。
// 決まらないときは 0 にせず null と理由（reason）を返す
export function effectiveRevenueRate({project, earningType, defaultRate, contractVersion = null, acquisitionTerms = null}) {
  const result = (bps, source, {status = null, versionNo = null, reason = null} = {}) => ({bps, source, status, versionNo, reason});
  if (!earningType) return result(null, null, {reason: 'earning_type_unregistered'});
  if (earningType.rate_source === 'contract') {
    if (!contractVersion) return result(null, 'contract', {reason: 'contract_version_unregistered'});
    const versionNo = Number(contractVersion.version_no);
    if (!contractVersionComplete(contractVersion)) return result(null, 'contract', {versionNo, reason: 'contract_version_incomplete'});
    return result(Number(contractVersion.markup_bps), 'contract', {versionNo});
  }
  const own = project?.revenue_rate_bps;
  if (own !== null && own !== undefined) return result(Number(own), 'project');
  if (earningType.code === 'acquisition' && acquisitionTerms === 'buyout') return result(10000, 'buyout');
  if (!defaultRate) return result(null, 'default', {reason: 'default_unregistered'});
  return result(Number(defaultRate.revenue_rate_bps), 'default', {status: defaultRate.status, versionNo: Number(defaultRate.version_no)});
}

// 行動のステップを集計の3つ（親の無い行）へ畳む（FR-REV-YOJITSU-015・017）。steps は参照表の行（code・parent_code）。
// 参照表に無いコード・空のステップは null（数えない）
export function rollUpStep(steps, code) {
  if (code === null || code === undefined) return null;
  const step = steps.find((s) => s.code === code);
  if (!step) return null;
  return step.parent_code ?? step.code;
}

// 区分の金額は正の整数の円で持ち、符号は区分の入出金で決める（FR-REV-YOJITSU-024）。入金は正、出金は負
export function signedCashflowYen(category, amountYen) {
  if (!isInt(amountYen, 1, MAX_YEN)) throw new Error(`区分の金額は正の整数の円で持ちます: ${amountYen}`);
  if (category?.direction === 'in') return amountYen;
  if (category?.direction === 'out') return -amountYen;
  throw new Error(`区分の入出金を読めません: ${category?.direction}`);
}
