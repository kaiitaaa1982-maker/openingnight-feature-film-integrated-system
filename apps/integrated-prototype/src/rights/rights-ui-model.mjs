// 権利・分配、権利の調達、製作委員会の画面で共通に使う純関数（表示の言葉・入力の変換・既定値）。
// ブラウザ・Node・Worker で同じ結果を返す。コード値は画面に出さず、ここで日本語に直す。
import {labelOf, optionsOf} from '../ui/labels.mjs';
import {parseYen, isBlankInput, formatNumberInput} from '../ui/parse-input.mjs';
import {UNKNOWN_TEXT} from '../ui/format.mjs';
import {ApiError, isApiError, describeError} from '../ui/api-client.mjs';
import {apiDbError} from '../data-platform/db-errors.mjs';

// ---- 画面の見出し（英語の見出しを出さない。試験で英字が混ざらないことを確かめる） ----

export const SCREEN_TEXT = Object.freeze({
  settlement: Object.freeze({
    eyebrow: '権利・分配',
    title: '権利契約と分配の試算',
    lead: '登録した権利契約の条件版で、紐付けた売上報告から権利元への配分と自社の受取を試算します。売上や収支は書き換えません。実際の支払・入金には使いません。',
    preview: '分配の試算',
    basis: '計算根拠（売上明細ごと）',
    links: '売上報告と契約条件の紐付け',
    linked: '紐付け済みの売上報告',
    contracts: '権利契約と条件版',
    register: '＋権利契約を登録',
    newVersion: '新しい条件版を作る',
  }),
  intake: Object.freeze({
    eyebrow: '企画 → 権利の調達 → 分配条件',
    title: '権利の調達',
    lead: '作品ごとに、権利の受け方・契約書の参照・権利範囲・参加者を版として残します。不足を補うときは前の版を残して改訂します。製作委員会の案件は「製作委員会」画面で条件と期間報告へ進めます。',
    list: '調達案件',
    register: '＋調達案件を登録',
    revise: 'この内容から改訂版を作る',
  }),
  committee: Object.freeze({
    eyebrow: '製作委員会',
    title: '窓口・幹事・出資者への分配を契約条件から試算',
    lead: '作品へ配賦した売上だけを使い、分配の締めと会計の計上月を分けて、根拠つきの報告を版として保存します。',
    saved: '保存済みの期間報告',
    builder: '期間報告を作成',
    terms: '委員会の契約条件',
    register: '＋委員会の契約条件を登録',
    joint: '共同製作・入金基準',
    legacy: '窓口別の計算',
  }),
  reports: Object.freeze({
    committeeTab: '権利先への収支報告',
    mgTab: 'MG作品別の現況',
  }),
});

// 分配の流れ（製作委員会の画面の冒頭に番号つきで示す）
export const COMMITTEE_FLOW = Object.freeze([
  '作品へ配賦した売上（税抜）',
  '窓口・幹事の手数料と経費を控除',
  '権利処理費・製作費の回収を控除',
  '出資比率で出資者へ分配',
]);

// ---- 選択肢（コード値 → 日本語） ----

const freezeOptions = (list) => Object.freeze(list.map((item) => Object.freeze(item)));

export const REPORT_BASIS_OPTIONS = freezeOptions([
  {value: 'gross', label: '控除前の額（配信事業者などの手数料を引く前）'},
  {value: 'net', label: '控除後の額（手数料を引いた後）'},
]);
export const RECOUP_BASIS_OPTIONS = freezeOptions([
  {value: 'platform_net', label: 'PF控除後の受取'},
  {value: 'after_fee', label: '代理店手数料を引いた後の受取'},
]);
export const CONTRACT_TYPE_OPTIONS = freezeOptions(optionsOf('contractType'));
export const INTAKE_TYPE_OPTIONS = freezeOptions(optionsOf('intakeType'));
export const EXCLUSIVITY_OPTIONS = freezeOptions([
  {value: 'unknown', label: '未確認'},
  {value: 'exclusive', label: '独占'},
  {value: 'nonexclusive', label: '非独占'},
]);
export const PERIOD_DATE_BASIS_OPTIONS = freezeOptions([
  {value: 'sales_period', label: '販売期間が締め期間の中にある売上'},
  {value: 'report_received', label: '報告を受け取った日が締め期間の中にある売上'},
]);
export const WINDOW_KIND_OPTIONS = freezeOptions(optionsOf('committeeWindowKind'));
export const ROUTE_OPTIONS = freezeOptions([
  {value: 'direct', label: '窓口から出資者へ直接'},
  {value: 'via_manager', label: '窓口から幹事を経由'},
]);
export const FEE_ORDER_OPTIONS = freezeOptions([
  {value: 'window_first', label: '窓口手数料を先に控除'},
  {value: 'manager_first', label: '幹事手数料を先に控除'},
]);
export const REFERENCE_TYPE_OPTIONS = freezeOptions([
  {value: 'release', label: '公開日'},
  {value: 'first_sales', label: '初回の販売日'},
  {value: 'first_report', label: '初回の報告日'},
  {value: 'contract_specific', label: '契約で定めた日'},
]);
export const DEDUCTION_CATEGORY_OPTIONS = freezeOptions(optionsOf('deductionCategory'));

const RECOUP_TEXT = Object.freeze({platform_net: 'PF控除後', after_fee: '代理店手数料控除後'});
const ROUTE_TEXT = Object.freeze({direct: '窓口から出資者へ直接', via_manager: '窓口から幹事を経由'});
const FEE_BASIS_TEXT = Object.freeze({platform_net: 'PF控除後', after_window: '窓口手数料控除後', after_manager: '幹事手数料控除後'});

export const reportBasisText = (code) => (code === 'mixed' ? '控除前と控除後が混在' : labelOf('reportBasis', code));
export const recoupBasisText = (code) => (code ? RECOUP_TEXT[code] || `未登録の値（${code}）` : UNKNOWN_TEXT);
export const routeText = (code) => (code ? ROUTE_TEXT[code] || `未登録の値（${code}）` : UNKNOWN_TEXT);
export const feeBasisText = (code) => (code ? FEE_BASIS_TEXT[code] || `未登録の値（${code}）` : UNKNOWN_TEXT);
export const feeOrderText = (code) => labelOf('feeOrder', code);
export const windowKindText = (code) => labelOf('committeeWindowKind', code);
export const reportKindText = (code) => labelOf('reportKind', code);
export const contractTypeText = (code) => labelOf('contractType', code);
export const intakeTypeText = (code) => labelOf('intakeType', code);
export const exclusivityText = (code) => labelOf('exclusivity', code || 'unknown');
export const periodDateBasisText = (code) => labelOf('periodDateBasis', code);
export const referenceTypeText = (code) => REFERENCE_TYPE_OPTIONS.find((item) => item.value === code)?.label || labelOf('referenceType', code);
export const deductionCategoryText = (code) => labelOf('deductionCategory', code);
export const milestoneStageText = (code) => labelOf('milestoneStage', code);
// 保存した報告・調達案件は状態 draft しか持たない（DB の CHECK 制約）。画面では「下書き」と書く。
export const snapshotStatusText = (code) => labelOf('snapshotStatus', code || 'draft');

// ---- 率（%）と金額 ----

const squash = (text) => String(text ?? '').normalize('NFKC').replace(/[\s​]+/g, '');

// 「12.5」「１２．５」「12.5%」「12.5％」→ 1250（bp）。小数は2桁まで。空欄は null。
export function parsePercent(input, {min = 0, max = 100} = {}) {
  if (typeof input === 'number') return Number.isFinite(input) ? checkPercent(input, min, max) : {ok: false, error: '率は数字で入力してください（例: 12.5）'};
  if (isBlankInput(input)) return {ok: true, value: null};
  const text = squash(input).replace(/[%％]$/, '').replace(/。/g, '.').replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(text)) return {ok: false, error: '率は数字で入力してください（例: 12.5）'};
  const [, fraction = ''] = text.split('.');
  if (fraction.length > 2) return {ok: false, error: '率は小数第2位まで入力できます（例: 12.25）'};
  return checkPercent(Number(text), min, max);
}

function checkPercent(n, min, max) {
  if (n < min || n > max) return {ok: false, error: `率は${min}〜${max}%で入力してください`};
  return {ok: true, value: Math.round(n * 100)};
}

// bp → 入力欄の文字（1250 → "12.5"）。null は空欄。
export function percentInput(bps) {
  if (bps === null || bps === undefined || bps === '') return '';
  const n = Number(bps);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n) / 100);
}

// bp → 表示（1250 → "12.5%"、1234 → "12.34%"）。null は「未確認」。
export function percentText(bps) {
  if (bps === null || bps === undefined || bps === '') return UNKNOWN_TEXT;
  const n = Number(bps);
  if (!Number.isFinite(n)) return UNKNOWN_TEXT;
  return `${(Math.round(n) / 100).toLocaleString('ja-JP', {maximumFractionDigits: 2})}%`;
}

// 金額の入力（全角・カンマ・¥・円を吸収）。0以上。空欄は null。
export function parseMoney(input, {allowNegative = false} = {}) {
  return parseYen(input, {allowNegative});
}

// 金額 → 入力欄の文字（12000 → "12,000"）
export const moneyInput = (value) => (value === null || value === undefined || value === '' ? '' : formatNumberInput(value));

// ---- 日（締め日・報告日・支払日）と日程 ----

// 「月末」「末」「末日」→ 'eom'、「25」「２５日」→ 25。
export function parseDayOfMonth(input) {
  if (typeof input === 'number') return Number.isInteger(input) && input >= 1 && input <= 31 ? {ok: true, value: input} : {ok: false, error: '日は「月末」か1〜31で入力してください'};
  const text = squash(input).toLowerCase();
  if (!text) return {ok: false, error: '日は「月末」か1〜31で入力してください'};
  if (['eom', '月末', '末', '末日', '月末日'].includes(text)) return {ok: true, value: 'eom'};
  const match = text.match(/^(\d{1,2})日?$/);
  if (!match) return {ok: false, error: '日は「月末」か1〜31で入力してください'};
  const day = Number(match[1]);
  if (day < 1 || day > 31) return {ok: false, error: '日は「月末」か1〜31で入力してください'};
  return {ok: true, value: day};
}

// 保存値 → 入力欄の文字（'eom' → '月末'、15 → '15'）
export function dayInput(value) {
  if (value === null || value === undefined || value === '') return '';
  return String(value) === 'eom' ? '月末' : String(value);
}

export function dayText(value) {
  if (value === null || value === undefined || value === '') return UNKNOWN_TEXT;
  return String(value) === 'eom' ? '月末' : `${Number(value)}日`;
}

// 締め日から何か月後の何日か（0 → 当月、1 → 翌月）
export function offsetText(months, day) {
  const n = Number(months);
  if (!Number.isInteger(n) || n < 0) return UNKNOWN_TEXT;
  const when = n === 0 ? '締めと同じ月' : n === 1 ? '翌月' : `${n}か月後`;
  return `${when}の${dayText(day)}`;
}

export function intervalText(months) {
  const n = Number(months);
  if (!Number.isInteger(n) || n < 1) return UNKNOWN_TEXT;
  return n === 1 ? '毎月' : `${n}か月ごと`;
}

// ---- コード（利用者が読む識別子）の初期値 ----

const pad2 = (n) => String(n).padStart(2, '0');

// 使われていない最初の番号のコード。prefix="W001-分配" → "W001-分配-01"
export function nextCode(prefix, existing = []) {
  const used = new Set((existing || []).map((code) => String(code ?? '').trim()));
  for (let n = 1; n < 1000; n += 1) {
    const code = `${prefix}-${pad2(n)}`;
    if (!used.has(code)) return code;
  }
  return `${prefix}-${used.size + 1}`;
}

export function workPrefix(work) {
  const code = String(work?.code ?? '').trim();
  return code || (work?.id ? `作品${work.id}` : '作品');
}

// ---- 版 ----

export function latestVersion(versions = [], key = 'version_no') {
  let latest = null;
  for (const version of versions || []) {
    if (!latest || Number(version?.[key]) > Number(latest?.[key])) latest = version;
  }
  return latest;
}

// ---- 権利・分配（Settlement） ----

// 分配の条件版1つを短く書く（「版2・PF 30%・手数料 20%・回収 PF控除後」）
export function settlementVersionText(version) {
  if (!version) return UNKNOWN_TEXT;
  const parts = [`版${version.version_no}`, `PF ${percentText(version.platform_rate_bps)}`];
  if (version.agency_fee_bps !== null && version.agency_fee_bps !== undefined) parts.push(`手数料 ${percentText(version.agency_fee_bps)}`);
  if (version.recoup_basis) parts.push(`回収の基礎 ${recoupBasisText(version.recoup_basis)}`);
  return parts.join('・');
}

function byRecent(a, b) {
  return String(b.accounting_month || '').localeCompare(String(a.accounting_month || ''))
    || String(b.link?.created_at || '').localeCompare(String(a.link?.created_at || ''))
    || Number(b.id) - Number(a.id);
}

// 未紐付けの売上報告に出す既定の契約・条件版・報告額の基準。
// - 同じ取引先・同じ流通の前回の紐付け（なければ同じ流通、なければ直近）の契約を選び、その契約の最新の条件版を既定にする。
// - 報告額の基準は前回の紐付けの基準。前回が無いときは推測せず空欄（選んでもらう）。
// - 前回が無く契約が1件だけならその契約と最新の条件版。
export function linkDefaults(report, contracts = [], reports = []) {
  const linked = (reports || []).filter((row) => row?.link && row.id !== report?.id).sort(byRecent);
  const alive = (row) => (contracts || []).some((contract) => contract.id === row.link.contract_id);
  const previous = linked.find((row) => alive(row) && row.partner_id === report?.partner_id && row.kind === report?.kind)
    || linked.find((row) => alive(row) && row.kind === report?.kind)
    || linked.find(alive)
    || null;
  if (previous) {
    const contract = contracts.find((item) => item.id === previous.link.contract_id);
    const version = latestVersion(contract?.versions);
    return {contractId: String(contract.id), versionId: version ? String(version.id) : '', reportBasis: previous.link.report_basis || '', source: 'previous'};
  }
  if ((contracts || []).length === 1) {
    const version = latestVersion(contracts[0].versions);
    return {contractId: String(contracts[0].id), versionId: version ? String(version.id) : '', reportBasis: '', source: 'single'};
  }
  return {contractId: '', versionId: '', reportBasis: '', source: 'none'};
}

// 権利契約の登録フォームの既定値。前回（この作品で最後に登録した契約の最新版）の料率を引き継ぐ。
export function contractFormDefaults(contracts = [], work = null) {
  const list = contracts || [];
  const last = list.length ? list.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a)) : null;
  const version = latestVersion(last?.versions);
  const lastMg = [...list].reverse().find((contract) => contract.contract_type === 'mg');
  const mgVersion = latestVersion(lastMg?.versions);
  return {
    contractCode: nextCode(`${workPrefix(work)}-分配`, list.map((contract) => contract.contract_code)),
    title: '',
    contractType: last?.contract_type || 'commission',
    holderPartnerId: last?.holder_partner_id ? String(last.holder_partner_id) : '',
    intakeCaseId: '',
    mgContractYen: '',
    mgPaidYen: '',
    platformRate: version ? percentInput(version.platform_rate_bps) : '',
    feeRate: version && version.agency_fee_bps !== null && version.agency_fee_bps !== undefined ? percentInput(version.agency_fee_bps) : '',
    recoupBasis: mgVersion?.recoup_basis || '',
  };
}

// 権利契約の登録フォームの値（RecordForm の変換後）→ API の入力
export function settlementContractPayload(values, workId) {
  const platform = parsePercent(values.platformRate);
  if (!platform.ok || platform.value === null) throw new Error(platform.ok ? 'PF料率を入力してください' : platform.error);
  const payload = {workId: Number(workId), contractCode: values.contractCode, title: values.title, contractType: values.contractType, terms: {platformRateBps: platform.value}};
  if (values.intakeCaseId) payload.intakeCaseId = Number(values.intakeCaseId);
  if (values.contractType !== 'self_owned') {
    const fee = parsePercent(values.feeRate);
    if (!fee.ok || fee.value === null) throw new Error(fee.ok ? '代理店手数料率を入力してください' : fee.error);
    payload.holderPartnerId = Number(values.holderPartnerId);
    payload.terms.agencyFeeBps = fee.value;
  }
  if (values.contractType === 'mg') {
    payload.mgContractYen = values.mgContractYen === null || values.mgContractYen === undefined ? null : Number(values.mgContractYen);
    payload.mgPaidYen = values.mgPaidYen === null || values.mgPaidYen === undefined || values.mgPaidYen === '' ? null : Number(values.mgPaidYen);
    payload.terms.recoupBasis = values.recoupBasis;
  }
  return payload;
}

// 新しい条件版の既定値（最新の条件版を写す）
export function versionFormDefaults(contract) {
  const version = latestVersion(contract?.versions);
  return {
    platformRate: percentInput(version?.platform_rate_bps ?? null),
    feeRate: percentInput(version?.agency_fee_bps ?? null),
    recoupBasis: version?.recoup_basis || 'platform_net',
    note: '',
  };
}

export function versionPayload(form, contractType) {
  const platform = parsePercent(form.platformRate);
  if (!platform.ok || platform.value === null) throw new Error(platform.ok ? 'PF料率を入力してください' : platform.error);
  const payload = {platformRateBps: platform.value, note: String(form.note || '').trim() || null};
  if (contractType !== 'self_owned') {
    const fee = parsePercent(form.feeRate);
    if (!fee.ok || fee.value === null) throw new Error(fee.ok ? '代理店手数料率を入力してください' : fee.error);
    payload.agencyFeeBps = fee.value;
  }
  if (contractType === 'mg') payload.recoupBasis = form.recoupBasis;
  return payload;
}

// 率の入力欄の検査（RecordForm の validate 用）
export function percentFieldError(value, {required = true} = {}) {
  const parsed = parsePercent(value);
  if (!parsed.ok) return parsed.error;
  if (required && parsed.value === null) return '率を入力してください';
  return null;
}

// ---- 権利の調達（RightsIntake） ----

// 権利範囲の「媒体」にしない流通区分（会計上の区分）
const NON_MEDIA = new Set(['相殺', '調整', '製作委員会収入']);
export const ALL_MEDIA = '全媒体';
const FALLBACK_MEDIA = ['劇場', '配信', 'ビデオグラム', '放送', '海外', '商品化'];

// 媒体の選択肢。流通区分マスタ（/api/distribution-types）の流通名から重複を除いて並べる。
// マスタが読めないときは基本の媒体だけを出す。current が選択肢に無い保存済みの値ならそのまま残す。
export function mediaOptions(types = [], current = '') {
  const names = [];
  for (const type of types || []) {
    if (!type || type.legacy || !type.distribution_name) continue;
    const name = String(type.distribution_name).replace(/_/g, '・');
    if (NON_MEDIA.has(name) || names.includes(name)) continue;
    names.push(name);
  }
  const list = [ALL_MEDIA, ...(names.length ? names : FALLBACK_MEDIA)];
  const options = list.map((name) => ({value: name, label: name}));
  const text = String(current ?? '').trim();
  if (text && !list.includes(text)) options.push({value: text, label: `${text}（以前の入力）`});
  return options;
}

export function intakeCodeDefault(work, cases = []) {
  return nextCode(`${workPrefix(work)}-調達`, (cases || []).map((row) => row.case_code));
}

// 改訂版のコード。元のコードの末尾の「-版n」を付け替える。
export function revisionCode(source, cases = []) {
  const base = String(source?.case_code || '').replace(/-版\d+$/, '');
  const next = Number(source?.snapshot_version || 1) + 1;
  const used = new Set((cases || []).map((row) => row.case_code));
  let n = next;
  while (used.has(`${base}-版${n}`) && n < next + 100) n += 1;
  return `${base}-版${n}`;
}

export const blankDocument = () => ({title: '', reference: '', versionLabel: '', contentHash: ''});
export const blankScope = () => ({channel: '', territory: '', territoryOther: '', rightsStart: '', rightsEnd: '', exclusivity: 'unknown'});
export const blankParticipant = (type) => ({
  partyKind: type === 'sole_owned' ? 'current_org' : 'partner',
  partnerId: '',
  role: type === 'sole_owned' ? '権利保有主体' : '',
  investmentYen: '',
  explicitShare: '',
});

export function newIntakeForm(work, cases = [], type = 'committee') {
  return {caseCode: intakeCodeDefault(work, cases), title: '', intakeType: type, sourceCaseId: null, documents: [blankDocument()], scopes: [blankScope()], participants: [blankParticipant(type)]};
}

// 保存済みの案件から改訂版の入力を作る。territory は「選択肢＋その他の文字」に分ける（splitTerritory を渡す）。
export function intakeFormFromCase(source, cases = [], splitTerritory = (value) => ({select: value || '', other: ''})) {
  const documents = (source?.documents || []).map((row) => ({title: row.title || '', reference: row.reference || '', versionLabel: row.version_label || '', contentHash: row.content_hash || ''}));
  const scopes = (source?.scopes || []).map((row) => {
    const territory = splitTerritory(row.territory || '');
    return {channel: row.channel || '', territory: territory.select, territoryOther: territory.other, rightsStart: row.rights_start || '', rightsEnd: row.rights_end || '', exclusivity: row.exclusivity || 'unknown'};
  });
  const participants = (source?.participants || []).map((row) => ({
    partyKind: row.party_kind,
    partnerId: row.partner_id === null || row.partner_id === undefined ? '' : String(row.partner_id),
    role: row.role || '',
    investmentYen: moneyInput(row.investment_yen),
    explicitShare: percentInput(row.explicit_share_bps),
  }));
  return {
    caseCode: revisionCode(source, cases),
    title: source?.title || '',
    intakeType: source?.intake_type || 'committee',
    sourceCaseId: source?.id ?? null,
    documents: documents.length ? documents : [blankDocument()],
    scopes: scopes.length ? scopes : [blankScope()],
    participants: participants.length ? participants : [blankParticipant(source?.intake_type)],
  };
}

// 調達案件の入力 → API の入力。金額・率の書式の揺れを吸収し、直せない値は {ok:false, errors:[...]} で返す。
// territoryOf(scope) は地域の選択と「その他」の文字から保存する文字を返す。
export function intakePayload(form, workId, territoryOf = (scope) => scope.territory) {
  const errors = [];
  const participants = (form.participants || []).map((row, index) => {
    const money = parseMoney(row.investmentYen);
    if (!money.ok) errors.push(`参加者${index + 1}の出資額: ${money.error}`);
    const share = parsePercent(row.explicitShare);
    if (!share.ok) errors.push(`参加者${index + 1}の持分: ${share.error}`);
    return {
      partyKind: row.partyKind,
      partnerId: row.partyKind === 'partner' && row.partnerId !== '' ? Number(row.partnerId) : null,
      role: String(row.role || '').trim(),
      investmentYen: money.ok ? money.value : null,
      explicitShareBps: share.ok ? share.value : null,
    };
  });
  const documents = (form.documents || []).map((row, index) => {
    const hash = String(row.contentHash || '').trim().toLowerCase();
    if (hash && !/^[a-f0-9]{64}$/.test(hash)) errors.push(`契約書${index + 1}の照合値は64桁の英数字（0〜9とa〜f）で入力してください`);
    return {title: String(row.title || '').trim(), reference: String(row.reference || '').trim(), versionLabel: String(row.versionLabel || '').trim(), contentHash: hash};
  });
  const scopes = (form.scopes || []).map((row, index) => {
    if (row.rightsStart && row.rightsEnd && row.rightsEnd < row.rightsStart) errors.push(`権利範囲${index + 1}の終了日が開始日より前です`);
    return {channel: String(row.channel || '').trim(), territory: String(territoryOf(row) || '').trim(), rightsStart: row.rightsStart || '', rightsEnd: row.rightsEnd || '', exclusivity: row.exclusivity || 'unknown'};
  });
  if (!String(form.caseCode || '').trim()) errors.push('案件コードを入力してください');
  if (!String(form.title || '').trim()) errors.push('名称を入力してください');
  if (errors.length) return {ok: false, errors};
  const payload = {workId: Number(workId), caseCode: String(form.caseCode).trim(), title: String(form.title).trim(), intakeType: form.intakeType, documents, scopes, participants};
  if (form.sourceCaseId !== null && form.sourceCaseId !== undefined) payload.sourceCaseId = form.sourceCaseId;
  return {ok: true, payload};
}

// 調達案件の一覧（DataGrid の行）
export function intakeRows(cases = []) {
  const codes = new Map((cases || []).map((row) => [row.id, row.case_code]));
  return (cases || []).map((row) => ({
    ...row,
    typeText: intakeTypeText(row.intake_type),
    readiness: row.inputComplete ? '入力は充足' : `不足・未確認 ${row.missingFields?.length || 0}件`,
    readinessOk: Boolean(row.inputComplete),
    sourceText: row.source_case_id ? `${codes.get(row.source_case_id) || '前の版'}から改訂` : '初版',
    linksText: (row.settlementLinks || []).map((link) => `${link.contract_code}｜${link.contract_title}`).join('、') || '未関連',
    statusText: snapshotStatusText(row.status),
  }));
}

// ---- サーバーの文言の日本語化 ----

const TOKEN_TEXT = [
  [/platformRateBps/g, 'PF料率'], [/windowFeeBps/g, '窓口手数料率'], [/managerFeeBps/g, '幹事手数料率'], [/agencyFeeBps/g, '代理店手数料率'],
  [/reportOffsetMonths/g, '報告までの月数'], [/paymentOffsetMonths/g, '支払までの月数'], [/reportDay/g, '報告予定日'], [/paymentDay/g, '支払予定日'],
  [/intervalMonths/g, '締めの間隔'], [/closeDay/g, '締め日'],
  [/after_window/g, '窓口手数料控除後'], [/after_manager/g, '幹事手数料控除後'], [/after_fee/g, '代理店手数料控除後'], [/platform_net/g, 'PF控除後'],
  [/committee、sole_owned、entrusted/g, '製作委員会・単独保有・権利受託'],
  [/grossまたはnet/g, '控除前または控除後'], [/gross ?\/ ?net/g, '控除前・控除後'], [/\bgross\b/g, '控除前'], [/\bnet\b/g, '控除後'],
  [/allowStubを明示してください/g, '「端数期間を採用する」に印を付けてください'],
  [/eomまたは1〜31/g, '月末または1〜31日'], [/\beom\b/g, '月末'],
  [/(\d+)〜(\d+)bp/g, (_, a, b) => `${Number(a) / 100}〜${Number(b) / 100}%`],
  [/\bdraft\b/g, '下書き'], [/\bunverified\b/g, '未確認'],
  [/JPY税抜/g, '円・税抜'], [/JPY/g, '円'],
];
const WHOLE_TEXT = [
  [/invalid commission terms/i, '手数料型の条件が正しくありません。代理店手数料率を入れ、MGの項目は空にしてください'],
  [/invalid mg terms/i, 'MG調達型の条件が正しくありません。代理店手数料率と回収の基礎を選んでください'],
  [/invalid self owned terms/i, '自社権利型の条件が正しくありません。代理店手数料率とMGの項目は空にしてください'],
  [/settlement contract scope mismatch/i, '契約と条件版の組み合わせが正しくありません'],
  [/契約書ハッシュは64桁のSHA-256形式です/, '照合値は64桁の英数字（0〜9とa〜f）で入力してください'],
];
// 一意の違反は、API が応答に載せた共通のエラーの種類（src/data-platform/db-errors.mjs の dbErrorBody）で見分ける（DB の文で分岐しない。FR-CORE-DATA-016）
const CODE_COLUMN = /^(?:contract_|case_)?code$/;
function uniqueText(error) {
  const found = apiDbError(error);
  if (found?.kind !== 'unique') return null;
  return (found.columns || []).some((column) => CODE_COLUMN.test(column)) ? '同じコードが既に登録されています。別のコードにしてください' : '同じ内容が既に登録されています';
}
const KIND_WORDS = /販路(theatrical|digital|package|broadcast|other)/g;

export function japaneseMessage(text) {
  if (text === null || text === undefined) return '';
  let out = String(text);
  for (const [pattern, replacement] of WHOLE_TEXT) if (pattern.test(out)) return replacement;
  out = out.replace(KIND_WORDS, (_, kind) => `販路「${windowKindText(kind)}」`);
  for (const [pattern, replacement] of TOKEN_TEXT) out = out.replace(pattern, replacement);
  return out;
}

// API の失敗の知らせ（ProblemNotice）の主の文。一意の違反は応答の dbError から言い換え、それ以外は describeError の文を日本語にする
// （言い換えた文には「再読込して確認してください」を足さない。DB の文の照合で言い換えていたときと同じ文）
export function problemText(error) {
  return uniqueText(error) ?? japaneseMessage(describeError(error));
}

// 例外の文を日本語に直した例外（種類・状態・詳細はそのまま。サーバーの生の文は技術情報に残る）
export function translateError(error) {
  if (!error || typeof error !== 'object') return error;
  const message = uniqueText(error) ?? japaneseMessage(error.message);
  if (message === error.message) return error;
  if (isApiError(error)) return new ApiError(message, {status: error.status, kind: error.kind, details: error.details, body: error.body});
  return new Error(message);
}
