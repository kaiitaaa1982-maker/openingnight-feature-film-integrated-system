// 制作費の版（成功報酬の線にする制作費。フェーズ1の仕様書 #5）の入力の読み取り・出資の記録の選び方・登録できる人・状態を決める純関数。
// 要件は docs/requirements/expenses/production-cost.md の FR-EXP-PCOST-001〜005・008・015・019〜023・039。表は移行 0016（production_cost_versions）。
// DB・時刻・環境変数を読まない（docs/rules/architecture.md）。金額は税抜の整数の円（docs/rules/money.md）で、計算は足し算と比べるだけ
// （税込の契約を税抜に戻す計算は持たない。戻した額と戻し方を入れてもらう。FR-EXP-PCOST-023。端数の処理は決まっていない）

// 金額の上限（1兆円。移行 0016 の CHECK と、work_finance_versions の出資額と同じ）
export const MAX_PRODUCTION_COST_YEN = 1_000_000_000_000;
// 版の根拠の種類（移行 0016 の source_kind）。追加の版（additional_contract）を足す受け口はまだ無い。
// 税の区分が確定した「不明」の版を置き換える種類は、委員会の条件版に区分の列を足す移行で足す（要件のテストの穴の FR-EXP-PCOST-022）
export const SOURCE_KINDS = Object.freeze(['investment', 'contract', 'additional_contract']);
// 作品の制作費の状態（3値）。版が無い作品は「制作費の版なし」で、額を 0円で埋めない（FR-EXP-PCOST-003）。
// 税の区分が「不明」の版（委員会の条件版から作った版）は、成功報酬の判定が保留になる（FR-EXP-PCOST-015・017、FR-SETL-ACCR-020）
export const PRODUCTION_COST_STATUSES = Object.freeze(['registered', 'tax_unknown', 'unregistered']);
// 出資額から作る版の根拠に残す仮置き（production-cost.md の「前提とやらないこと」の確かめるまでの仮置き。会計の専門家の確認の前）
export const TAX_REVIEW_NOTES = Object.freeze({
  own_investment: '会計の専門家確認前（自社の出資額をそのまま税抜の制作費と読む仮置き）',
  committee: '会計の専門家確認前（委員会の条件版は税の区分を持たないので、税の区分は不明）',
});
// 作品ごとの役目のうち、制作費の版を登録できる役目（作品ごとの役目の表の語彙。docs/requirements/production/schedule-commit.md の FR-PROD-SCHED-063）
export const REGISTRAR_WORK_ROLE = 'producer';

const NOTE_MAX = 400; // 利用者のメモ（出資額から作る版は仮置きの文のあとにつなぐので、表の上限 1000 文字に収まる長さ）
const isYen = (value, min = 1) => Number.isSafeInteger(value) && value >= min && value <= MAX_PRODUCTION_COST_YEN;

// 暦にある日付（YYYY-MM-DD）だけを受ける
export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function text(errors, field, value, {max, label, required = false}) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    if (required) errors.push({field, message: `${label}を入れてください`});
    return null;
  }
  if (typeof value !== 'string') { errors.push({field, message: `${label}は文字で入れてください`}); return null; }
  const trimmed = value.trim();
  if (trimmed.length > max) errors.push({field, message: `${label}は${max}文字までです`});
  return trimmed;
}

// 内訳（制作費・P&A。FR-EXP-PCOST-019）。出資が P&A を含む作品だけが持ち、2つの和が版の額。無ければ null
function breakdownOf(errors, raw, amountYen) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) { errors.push({field: 'breakdown', message: '内訳は制作費と P&A の2つの額で入れてください'}); return null; }
  const productionYen = raw.productionYen ?? null;
  const paYen = raw.paYen ?? null;
  if (!isYen(productionYen, 0)) errors.push({field: 'breakdown.productionYen', message: '内訳の制作費は0円〜1兆円の整数の円（税抜）で入れてください'});
  if (!isYen(paYen, 0)) errors.push({field: 'breakdown.paYen', message: '内訳の P&A は0円〜1兆円の整数の円（税抜）で入れてください'});
  if (isYen(productionYen, 0) && isYen(paYen, 0) && Number.isSafeInteger(amountYen) && productionYen + paYen !== amountYen) {
    errors.push({field: 'breakdown', message: `内訳の和（${productionYen + paYen}円）を版の額（${amountYen}円）にそろえてください`});
  }
  return {productionYen, paYen};
}

// 作品の出資の記録から、最初の版を作る元を選ぶ（FR-EXP-PCOST-002・003）。
// finance は作品の費用の最新の版（work_finance_versions の行。無ければ null）、committees は作品の委員会の契約ごとの最新の条件版
// （{contractId, termVersionId, fundingYen, investmentTotalYen, investmentCount}。条件版の無い契約は termVersionId が null）。
// 出資の記録＝自社の出資額のある最新の版か、委員会の契約。記録が無ければ hasRecord が偽で、契約書から手で入れられる（FR-EXP-PCOST-039）。
// 返り値: {ok: true, hasRecord: true, kind, amountYen, taxBasis, workFinanceRevision|committeeTermVersionId} か {ok: false, reason, hasRecord}
export function investmentSource({finance = null, committees = []} = {}) {
  const own = finance && finance.own_investment_yen !== null && finance.own_investment_yen !== undefined ? finance : null;
  const list = Array.isArray(committees) ? committees : [];
  if (!own && !list.length) return {ok: false, reason: 'no_record', hasRecord: false};
  // 自社の出資と委員会の両方、または委員会の契約が2つ以上あると、どれを制作費にするか決められない（推測で選ばない）
  if ((own && list.length) || list.length > 1) return {ok: false, reason: 'ambiguous', hasRecord: true};
  if (own) {
    if (own.own_investment_status !== 'confirmed') return {ok: false, reason: 'not_confirmed', hasRecord: true};
    const amountYen = Number(own.own_investment_yen);
    if (!isYen(amountYen)) return {ok: false, reason: 'zero_investment', hasRecord: true};
    return {ok: true, hasRecord: true, kind: 'own_investment', amountYen, taxBasis: own.own_investment_tax_basis, workFinanceRevision: Number(own.revision)};
  }
  const committee = list[0];
  if (committee.termVersionId === null || committee.termVersionId === undefined || committee.fundingYen === null || committee.fundingYen === undefined
    || !Number(committee.investmentCount)) return {ok: false, reason: 'committee_unfunded', hasRecord: true};
  const fundingYen = Number(committee.fundingYen);
  if (Number(committee.investmentTotalYen) !== fundingYen) return {ok: false, reason: 'committee_mismatch', hasRecord: true};
  if (!isYen(fundingYen)) return {ok: false, reason: 'zero_investment', hasRecord: true};
  return {ok: true, hasRecord: true, kind: 'committee', amountYen: fundingYen, taxBasis: 'unknown', committeeTermVersionId: Number(committee.termVersionId)};
}

// investmentSource の理由を、受け口が返す文にする
export const INVESTMENT_SOURCE_MESSAGES = Object.freeze({
  no_record: '出資の記録がありません（作品の費用の版の自社の出資額か、委員会の条件版の出資額を先に入れてください。出資の記録が無い作品は契約書から入れます）',
  ambiguous: '出資の記録が2つ以上あります（自社の出資と委員会、または委員会の契約が2つ）。どれを制作費にするかを確かめてください',
  not_confirmed: '自社の出資額が確定していません（見込み・未確認の額からは制作費の版を作りません）',
  zero_investment: '出資額が0円です（0円の制作費の版は作りません）',
  committee_unfunded: '委員会の最新の条件版に、製作費総額と出資額がありません',
  committee_mismatch: '委員会の最新の条件版の出資額の合計が、製作費総額と合っていません',
});

// 出資額から作る最初の版の入力。source は investmentSource の ok の結果。額は出資の記録から読み、本文の額は受けない（手で写させない）
export function normalizeInvestmentVersionInput(raw, source) {
  const errors = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (!source?.ok) throw new Error('出資の記録の選び方が決まっていません');
  if (src.amountYen !== undefined) errors.push({field: 'amountYen', message: '出資額から作る版の額は出資の記録から読みます（額は入れません）'});
  const note = text(errors, 'note', src.note, {max: NOTE_MAX, label: 'メモ'});
  const value = {
    versionNo: 1, sourceKind: 'investment', amountYen: source.amountYen, taxBasis: source.taxBasis,
    workFinanceRevision: source.kind === 'own_investment' ? source.workFinanceRevision : null,
    committeeTermVersionId: source.kind === 'committee' ? source.committeeTermVersionId : null,
    breakdown: breakdownOf(errors, src.breakdown, source.amountYen),
    contract: null, addition: null,
    note: [TAX_REVIEW_NOTES[source.kind], note].filter(Boolean).join('。'),
  };
  return {ok: errors.length === 0, value, errors};
}

// 契約書から手で入れる最初の版の入力（出資の記録が無い作品だけ。FR-EXP-PCOST-039）。契約書の参照・締結日・相手・額が要る。
// 税込の契約（contractTaxBasis: inc_tax）は、税抜に戻した額（exTaxAmountYen）と戻し方（taxConversion）も要る（FR-EXP-PCOST-023）
export function normalizeContractVersionInput(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const contractReference = text(errors, 'contractReference', src.contractReference, {max: 500, label: '契約書の参照', required: true});
  const signedOn = src.signedOn ?? null;
  if (!isCalendarDate(signedOn)) errors.push({field: 'signedOn', message: '契約の締結日を YYYY-MM-DD の日付で入れてください'});
  const counterpartyPartnerId = src.counterpartyPartnerId ?? null;
  if (!Number.isSafeInteger(counterpartyPartnerId) || counterpartyPartnerId <= 0) errors.push({field: 'counterpartyPartnerId', message: '契約の相手を取引先から選んでください'});
  const contractAmountYen = src.contractAmountYen ?? null;
  if (!isYen(contractAmountYen)) errors.push({field: 'contractAmountYen', message: '契約書の額は1円〜1兆円の整数の円で入れてください'});
  const contractTaxBasis = src.contractTaxBasis ?? null;
  if (!['ex_tax', 'inc_tax'].includes(contractTaxBasis)) errors.push({field: 'contractTaxBasis', message: '契約書の額が税抜か税込かを選んでください'});
  let amountYen = null;
  let taxConversion = null;
  if (contractTaxBasis === 'ex_tax') {
    amountYen = contractAmountYen;
    if (src.exTaxAmountYen !== undefined && src.exTaxAmountYen !== null && src.exTaxAmountYen !== contractAmountYen) errors.push({field: 'exTaxAmountYen', message: '税抜の契約は、契約書の額をそのまま版の額にします'});
    if (src.taxConversion !== undefined && src.taxConversion !== null && src.taxConversion !== '') errors.push({field: 'taxConversion', message: '税抜の契約に、税抜に戻す戻し方は要りません'});
  } else if (contractTaxBasis === 'inc_tax') {
    amountYen = src.exTaxAmountYen ?? null;
    if (!isYen(amountYen) || (isYen(contractAmountYen) && amountYen > contractAmountYen)) {
      errors.push({field: 'exTaxAmountYen', message: '税込の契約は、税抜に戻した額を1円〜契約書の額の整数の円で入れてください'});
    }
    taxConversion = text(errors, 'taxConversion', src.taxConversion, {max: 500, label: '税抜に戻した戻し方', required: true});
  }
  const value = {
    versionNo: 1, sourceKind: 'contract', amountYen, taxBasis: 'ex_tax', workFinanceRevision: null, committeeTermVersionId: null,
    breakdown: breakdownOf(errors, src.breakdown, amountYen),
    contract: {reference: contractReference, signedOn, counterpartyPartnerId, amountYen: contractAmountYen, taxBasis: contractTaxBasis, taxConversion},
    addition: null,
    note: text(errors, 'note', src.note, {max: NOTE_MAX, label: 'メモ'}),
  };
  return {ok: errors.length === 0, value, errors};
}

// 作品の制作費の状態（3値）。latest は作品の最新の版（無ければ null）
export function productionCostStatus(latest) {
  if (!latest) return 'unregistered';
  return latest.tax_basis === 'unknown' || latest.taxBasis === 'unknown' ? 'tax_unknown' : 'registered';
}

// 読める人と登録できる人（FR-EXP-PCOST-008・039）。読めるのは作品の財務の権限のある人（管理者と、作品の案件の編集の権限を持つ編集担当）。
// 登録できるのは管理者と、作品の財務の権限があり、その作品にプロデューサーの役目を持つ人（役割と役目の両方を確かめる）。
// 制作担当は役目があっても読めず、登録できない。workRoles はその人がその作品に持つ役目のコードの一覧
export function productionCostAccess({role, financeProject = false, workRoles = []} = {}) {
  if (role === 'admin') return {read: true, register: true};
  const finance = role === 'editor' && financeProject === true;
  return {read: finance, register: finance && Array.isArray(workRoles) && workRoles.includes(REGISTRAR_WORK_ROLE)};
}

const num = (value) => (value === null || value === undefined ? null : Number(value));

// 版の行（production_cost_versions）を受け口が返す形にする
export function productionCostVersionView(row) {
  const hasBreakdown = row.production_part_yen !== null && row.production_part_yen !== undefined;
  return {
    versionNo: Number(row.version_no), sourceKind: row.source_kind, amountYen: Number(row.amount_yen), taxBasis: row.tax_basis,
    breakdown: hasBreakdown ? {productionYen: Number(row.production_part_yen), paYen: Number(row.pa_part_yen)} : null,
    investment: row.source_kind === 'investment'
      ? {kind: row.work_finance_revision !== null && row.work_finance_revision !== undefined ? 'own_investment' : 'committee',
        workFinanceRevision: num(row.work_finance_revision), committeeTermVersionId: num(row.committee_term_version_id)}
      : null,
    contract: row.contract_reference !== null && row.contract_reference !== undefined
      ? {reference: row.contract_reference, signedOn: row.contract_signed_on, counterpartyPartnerId: num(row.counterparty_partner_id),
        amountYen: num(row.contract_amount_yen), taxBasis: row.contract_tax_basis, taxConversion: row.tax_conversion ?? null}
      : null,
    addition: row.source_kind === 'additional_contract' ? {addedYen: num(row.added_yen), burdenType: row.burden_type} : null,
    note: row.note ?? null, createdBy: Number(row.created_by), createdAt: row.created_at,
  };
}
