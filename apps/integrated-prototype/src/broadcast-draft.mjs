// 番販・放送の「流通別の販売条件」で、新しい版の下書きを作る純関数。
// 前の版にある調達ケース・調達文書のリンク（intake_case_id・document_id）を下書きへ引き継ぎ、
// 保存時に黙って外れないようにする。

// [下書きのキー, 版の列名, 表示名]
export const CONDITION_FIELDS = [
  ['releaseOn', 'release_on', '解禁日'],
  ['salesEndOn', 'sales_end_on', '販売終了日'],
  ['terms', 'terms_text', '販売条件'],
  ['sourceReference', 'source_reference', '根拠'],
  ['exclusivity', 'exclusivity', '独占'],
  ['status', 'status', '状態'],
  ['intakeCaseId', 'intake_case_id', '調達ケース'],
  ['documentId', 'document_id', '調達文書']
];

const idOrNull = value => (value === null || value === undefined || value === '' ? null : Number(value));

// 既存の版（sales_availability_versions の行）から次の版の下書きを作る。
export function conditionDraftFromRow(workId, row) {
  return {
    workId: Number(workId),
    distributionCode: row.distribution_code,
    territory: row.territory,
    baseVersion: Number(row.version_no) || 0,
    releaseOn: row.release_on || '',
    salesEndOn: row.sales_end_on || '',
    terms: row.terms_text || '',
    sourceReference: row.source_reference || '',
    exclusivity: row.exclusivity || 'unknown',
    status: row.status || 'draft',
    intakeCaseId: idOrNull(row.intake_case_id),
    documentId: idOrNull(row.document_id),
    original: row
  };
}

// まだ版のない流通の第1版の下書き。
export function newConditionDraft(workId, distributionCode, territory = '日本') {
  return {
    workId: Number(workId), distributionCode, territory, baseVersion: 0,
    releaseOn: '', salesEndOn: '', terms: '', sourceReference: '', exclusivity: 'unknown', status: 'draft',
    intakeCaseId: null, documentId: null, original: null
  };
}

// 前の版から変わった項目の表示名。第1版は空配列。
export function conditionChanges(draft) {
  if (!draft?.original) return [];
  return CONDITION_FIELDS
    .filter(([key, column]) => String(draft[key] ?? '') !== String(draft.original[column] ?? ''))
    .map(([, , label]) => label);
}

// POST /api/sales-catalog に送る本文。元の行（original）は送らない。
export function conditionPayload(draft) {
  return {
    workId: draft.workId,
    distributionCode: draft.distributionCode,
    territory: draft.territory,
    baseVersion: draft.baseVersion,
    releaseOn: draft.releaseOn,
    salesEndOn: draft.salesEndOn,
    terms: draft.terms,
    sourceReference: draft.sourceReference,
    exclusivity: draft.exclusivity,
    status: draft.status,
    intakeCaseId: idOrNull(draft.intakeCaseId),
    documentId: idOrNull(draft.documentId)
  };
}

// 下書きに付いている調達の根拠の表示（「調達ケース X・文書 Y」）。
export function conditionLinkText(draft, { intakes = [], documents = [] } = {}) {
  if (draft?.intakeCaseId == null && draft?.documentId == null) return '調達ケース・文書は未紐付け';
  const intake = intakes.find(row => Number(row.id) === Number(draft.intakeCaseId));
  const document = documents.find(row => Number(row.id) === Number(draft.documentId));
  const parts = [];
  if (draft.intakeCaseId != null) parts.push(`調達ケース ${intake?.case_code || '（参照できないケース）'}`);
  if (draft.documentId != null) parts.push(`文書 ${document?.title || document?.reference || '（参照できない文書）'}`);
  return parts.join('・');
}

// ---- 差分の表示（保存後に画面へ出す） -----------------------------------------------------------
const EXCLUSIVITY_TEXT = {unknown: '未確認', exclusive: '独占', nonexclusive: '非独占'};
const AVAILABILITY_TEXT = {draft: '条件未確定', confirmed: '条件確認済み', withdrawn: '取り下げ'};
const shown = (value) => (value === null || value === undefined || String(value).trim() === '' ? '未入力' : String(value));

// 販売条件の前の版からの変更を {key, label, before, after} で返す（第1版は空配列）。
export function conditionChangeDetails(draft, {intakes = [], documents = []} = {}) {
  if (!draft?.original) return [];
  const display = (key, value) => {
    if (key === 'exclusivity') return EXCLUSIVITY_TEXT[value] || shown(value);
    if (key === 'status') return AVAILABILITY_TEXT[value] || shown(value);
    if (key === 'intakeCaseId') return value == null || value === '' ? '未紐付け' : intakes.find((row) => Number(row.id) === Number(value))?.case_code || '（参照できないケース）';
    if (key === 'documentId') return value == null || value === '' ? '未紐付け' : documents.find((row) => Number(row.id) === Number(value))?.title || '（参照できない文書）';
    return shown(value);
  };
  return CONDITION_FIELDS
    .filter(([key, column]) => String(draft[key] ?? '') !== String(draft.original[column] ?? ''))
    .map(([key, column, label]) => ({key, label, before: display(key, draft.original[column]), after: display(key, draft[key])}));
}

// Notice の details（列＝項目名、内容＝「前 → 後」）。
export const changeNoticeDetails = (changes = []) => changes.map((change) => ({column: change.label, message: `${change.before} → ${change.after}`}));

// ---- 放送枠の入力 ------------------------------------------------------------------------------
// [フォームのキー, 版の列名, 表示名]
export const SLOT_FIELDS = [
  ['broadcastMonth', 'broadcast_month', '放送月'],
  ['stationName', 'station_name', '放送局'],
  ['customerPartnerId', 'customer_partner_id', '取引先'],
  ['agencyPartnerId', 'agency_partner_id', '代理店'],
  ['agreementId', 'agreement_id', '販売契約'],
  ['periodFrom', 'period_from', '期間開始'],
  ['periodTo', 'period_to', '期間終了'],
  ['plannedOn', 'planned_on', '放送予定日'],
  ['plannedRuns', 'planned_runs', '予定回数'],
  ['sourceReference', 'source_reference', '根拠'],
];

// 今日（日本時間）の年月。
export function currentMonthJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 7);
}

export function blankSlotForm(workId, month = currentMonthJst()) {
  return {workId: Number(workId), baseRevision: 0, broadcastMonth: month, stationName: '', customerPartnerId: '', agencyPartnerId: '', agreementId: '', periodFrom: '', periodTo: '', plannedOn: '', plannedRuns: '1', sourceReference: '', reason: ''};
}

export function slotFormFromRow(row) {
  return {
    workId: row.work_id, baseRevision: row.revision, broadcastMonth: row.broadcast_month, stationName: row.station_name ?? '',
    customerPartnerId: row.customer_partner_id ?? '', agencyPartnerId: row.agency_partner_id ?? '', agreementId: row.agreement_id ?? '',
    periodFrom: row.period_from ?? '', periodTo: row.period_to ?? '', plannedOn: row.planned_on ?? '', plannedRuns: String(row.planned_runs ?? 1),
    sourceReference: row.source_reference ?? '', reason: '',
  };
}

const toHalfDigits = (value) => String(value ?? '').normalize('NFKC').replace(/[,\s]/g, '').replace(/回$/, '');
const idOrBlank = (value) => (value === null || value === undefined || value === '' ? '' : Number(value));

// POST /api/broadcast/slots・PATCH /api/broadcast/slots/:id に送る本文。
export function slotPayload(form) {
  return {
    workId: Number(form.workId), baseRevision: Number(form.baseRevision) || 0, broadcastMonth: form.broadcastMonth, stationName: String(form.stationName ?? '').trim(),
    customerPartnerId: idOrBlank(form.customerPartnerId), agencyPartnerId: idOrBlank(form.agencyPartnerId), agreementId: idOrBlank(form.agreementId),
    periodFrom: form.periodFrom, periodTo: form.periodTo, plannedOn: form.plannedOn || '', plannedRuns: toHalfDigits(form.plannedRuns) || '1',
    sourceReference: String(form.sourceReference ?? '').trim(), reason: form.reason || '',
  };
}

// 保存前の入力の検査（項目の直下に出す理由）。サーバーでも同じ検査をする。
export function slotFormErrors(form) {
  const errors = {};
  const month = String(form.broadcastMonth || '');
  const monthOk = /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  if (!monthOk) errors.broadcastMonth = '放送月を選んでください';
  if (!String(form.stationName ?? '').trim()) errors.stationName = '放送局を選ぶか、一覧にない局名を入れてください';
  else if (String(form.stationName).trim().length > 200) errors.stationName = '放送局は200文字以内にしてください';
  if (!form.periodFrom) errors.periodFrom = '期間開始を入れてください';
  else if (monthOk && form.periodFrom.slice(0, 7) !== month) errors.periodFrom = `放送月（${month}）の中の日付にしてください`;
  if (!form.periodTo) errors.periodTo = '期間終了を入れてください';
  else if (monthOk && form.periodTo.slice(0, 7) !== month) errors.periodTo = `放送月（${month}）の中の日付にしてください`;
  else if (form.periodFrom && form.periodTo < form.periodFrom) errors.periodTo = '期間開始以降の日付にしてください';
  if (form.plannedOn && form.periodFrom && form.periodTo && (form.plannedOn < form.periodFrom || form.plannedOn > form.periodTo)) errors.plannedOn = '期間の中の日付にしてください';
  const runs = toHalfDigits(form.plannedRuns);
  if (runs && (!/^\d+$/.test(runs) || Number(runs) < 1 || Number(runs) > 9999)) errors.plannedRuns = '1〜9999の整数で入れてください';
  if (String(form.sourceReference ?? '').length > 1000) errors.sourceReference = '根拠は1000文字以内にしてください';
  return errors;
}

// 放送枠の前の版からの変更。lookups: {partners, agreements}（ID を名称で見せる）。
export function slotChangeDetails(form, original, {partners = [], agreements = []} = {}) {
  if (!original) return [];
  const after = slotPayload(form);
  const display = (key, value) => {
    if (value === null || value === undefined || value === '') return key === 'agencyPartnerId' ? '代理店なし' : key.endsWith('Id') ? '未紐付け' : '未入力';
    if (key === 'customerPartnerId' || key === 'agencyPartnerId') return partners.find((row) => Number(row.id) === Number(value))?.name || '（参照できない取引先）';
    if (key === 'agreementId') {
      const hit = agreements.find((row) => Number(row.id) === Number(value));
      return hit ? [hit.contract_code, hit.title].filter(Boolean).join('・') : '（参照できない契約）';
    }
    if (key === 'plannedRuns') return `${Number(value)}回`;
    return String(value);
  };
  return SLOT_FIELDS
    .filter(([key, column]) => String(after[key] ?? '') !== String(original[column] ?? ''))
    .map(([key, column, label]) => ({key, label, before: display(key, original[column]), after: display(key, after[key])}));
}
