// 稟議（自社出資の申請・承認・却下・払込の4状態の版）の入力の判定と、版の並びから稟議ごとのいまの状態を導く純関数（行動指標の計画 段B #4。K2-2・K2-17）。
// 計画: 会社ルートの plans/2026-10-09-sales-producer-kpi.md の香盤表 #4 と J-10 (a)。要件: docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-038。
// 表は移行 0019 の investment_approval_versions（追記だけ）。版の流れ・額・番号は DB のトリガーも断るが、ここで先に確かめて画面に分かる言葉で返す。
// - 版の流れ: 版1は申請。申請 → 申請し直し・承認・却下、却下 → 申請し直し、承認 → 払込、払込 → 払込（分けて払う。累計は承認の額まで）
// - 承認と却下の額は直前の申請の額のまま。申請は根拠の参照、却下は理由が要る。払込は払った日と額が要る
// - 申請と承認は同じ人でよい（J-10 (a)）。誰がしたかは各版の記録した人に残り、承認・却下の版には申請した人と同じかを出す。
//   人が増えたら APPROVAL_POLICY.sameApproverAllowed を false にして、申請した人の承認・却下を断る形に切り替える
// DB・時刻・環境変数を読まない（docs/rules/architecture.md）

export const APPROVAL_STATUS_LABELS = Object.freeze({applied: '申請', approved: '承認', rejected: '却下', paid: '払込'});
// 稟議のいまの状態（最新の版から導く）。承認のあとは、払込が承認の額に届くまで「払込の途中」
export const APPROVAL_STATE_LABELS = Object.freeze({
  applied: '申請中', approved: '承認済み（払込前）', paying: '払込の途中', paid_in_full: '払込済み', rejected: '却下',
});
export const APPROVAL_POLICY = Object.freeze({sameApproverAllowed: true, reason: 'J-10 (a)（2026-10-09）: いまは申請と承認が同じ人でよい。記録は残す'});
export const APPROVAL_ACTIONS = Object.freeze({apply: 'applied', approve: 'approved', reject: 'rejected', pay: 'paid'});
export const MAX_AMOUNT_YEN = 1_000_000_000_000;

// いまの状態ごとに足せる版（操作）
const NEXT_ACTIONS = Object.freeze({
  applied: ['apply', 'approve', 'reject'], rejected: ['apply'], approved: ['pay'], paying: ['pay'], paid_in_full: [],
});

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// 暦にある日付（YYYY-MM-DD）か。閏年も見る
export function isCalendarDate(value) {
  const m = DATE.exec(typeof value === 'string' ? value : '');
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

const num = (value) => (value === null || value === undefined ? null : Number(value));

// store の読み取りの行（investment_approval_versions の列）を、案件・稟議ごとに束ねていまの状態を導く。
// 返り値は稟議の番号の順の配列（versions は版の番号の順）。払込の累計は承認の額まで（DB が断る）なので remainingYen は0以上
export function summarizeApprovals(rows) {
  const byApproval = new Map();
  for (const row of [...rows].sort((a, b) => Number(a.approval_no) - Number(b.approval_no) || Number(a.version_no) - Number(b.version_no))) {
    const no = Number(row.approval_no);
    if (!byApproval.has(no)) byApproval.set(no, []);
    byApproval.get(no).push(row);
  }
  return [...byApproval].map(([approvalNo, list]) => {
    let applicantUserId = null;
    let applicationAmountYen = null;
    let approvedYen = null;
    let paidYen = 0;
    const versions = list.map((row) => {
      const status = row.status;
      const createdBy = num(row.created_by);
      const amountYen = Number(row.amount_yen);
      const decision = status === 'approved' || status === 'rejected';
      const version = {
        versionNo: Number(row.version_no), status, statusLabel: APPROVAL_STATUS_LABELS[status] ?? null, amountYen,
        basisReference: row.basis_reference ?? null, paidOn: row.paid_on ?? null, note: row.note ?? null, createdBy, createdAt: row.created_at ?? null,
        // 承認・却下の版だけ: 直前の申請をした人と同じか（J-10 (a) の記録）
        sameAsApplicant: decision ? createdBy === applicantUserId : null,
      };
      if (status === 'applied') { applicantUserId = createdBy; applicationAmountYen = amountYen; }
      if (status === 'approved') approvedYen = amountYen;
      if (status === 'paid') paidYen += amountYen;
      return version;
    });
    const latest = versions.at(-1);
    let state = latest.status;
    if (latest.status === 'paid' || latest.status === 'approved') state = approvedYen !== null && paidYen >= approvedYen ? 'paid_in_full' : paidYen > 0 ? 'paying' : 'approved';
    return {
      approvalNo, latestVersionNo: latest.versionNo, status: latest.status, state, stateLabel: APPROVAL_STATE_LABELS[state],
      applicantUserId, applicationAmountYen, approvedYen, paidYen,
      // 出資枠（承認の額−払込の累計）。承認していない稟議は null（0円で埋めない）
      remainingYen: approvedYen === null ? null : approvedYen - paidYen,
      nextActions: [...NEXT_ACTIONS[state]],
      versions,
    };
  });
}

// 案件の次の稟議の番号（最後の番号の次）
export function nextApprovalNo(rows) {
  return rows.reduce((max, row) => Math.max(max, Number(row.approval_no)), 0) + 1;
}

function readAmount(value, field, errors, {max = MAX_AMOUNT_YEN} = {}) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    errors.push({field, message: max === MAX_AMOUNT_YEN ? '額は1円以上・1兆円以下の整数の円で入れてください' : `額は1円以上・${max}円以下の整数の円で入れてください（承認の額のうち、まだ払っていない分まで）`});
    return null;
  }
  return value;
}

function readText(value, field, errors, {required, max, label}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) errors.push({field, message: `${label}を入れてください`});
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > max) {
    errors.push({field, message: `${label}は${max}文字までの文字で入れてください`});
    return null;
  }
  return value.trim();
}

// 新しい稟議（版1の申請）の入力。nextNo は案件の次の稟議の番号（nextApprovalNo）
export function normalizeNewApproval(input, {nextNo}) {
  const errors = [];
  const body = input && typeof input === 'object' ? input : {};
  const amountYen = readAmount(body.amountYen, 'amountYen', errors);
  const basisReference = readText(body.basisReference, 'basisReference', errors, {required: true, max: 500, label: '根拠の参照（企画書・試算など）'});
  const note = readText(body.note, 'note', errors, {required: false, max: 1000, label: 'メモ'});
  if (errors.length) return {ok: false, status: 400, errors};
  return {ok: true, value: {approvalNo: nextNo, versionNo: 1, status: 'applied', amountYen, basisReference, paidOn: null, note}};
}

// 既存の稟議に版を1つ足す入力（申請し直し・承認・却下・払込）。approval は summarizeApprovals の1件、actorUserId は記録する人。
// 誤りは status（400＝入力の形、409＝いまの状態では足せない・古い画面）と errors で返す
export function normalizeApprovalStep(input, {approval, actorUserId, policy = APPROVAL_POLICY}) {
  const body = input && typeof input === 'object' ? input : {};
  const action = body.action;
  if (!Object.hasOwn(APPROVAL_ACTIONS, action ?? '')) {
    return {ok: false, status: 400, errors: [{field: 'action', message: '操作は apply（申請し直し）・approve（承認）・reject（却下）・pay（払込）のどれかです'}]};
  }
  if (!Number.isSafeInteger(body.previousVersionNo) || body.previousVersionNo < 1) {
    return {ok: false, status: 400, errors: [{field: 'previousVersionNo', message: '見ていた版の番号（previousVersionNo）を入れてください'}]};
  }
  if (body.previousVersionNo !== approval.latestVersionNo) {
    return {ok: false, status: 409, errors: [{field: 'previousVersionNo', message: `ほかの画面で版が足されています（いまは第${approval.latestVersionNo}版）。読み直してから入れてください`}]};
  }
  if (!NEXT_ACTIONS[approval.state].includes(action)) {
    const message = action === 'pay'
      ? (approval.state === 'paid_in_full' ? '承認の額まで払い込み済みです。追加の出資は新しい稟議で申請してください' : '承認の前に払込は入れられません')
      : `いまの状態（${approval.stateLabel}）では${APPROVAL_STATUS_LABELS[APPROVAL_ACTIONS[action]]}の版を足せません`;
    return {ok: false, status: 409, errors: [{field: 'action', message}]};
  }
  if ((action === 'approve' || action === 'reject') && !policy.sameApproverAllowed && actorUserId === approval.applicantUserId) {
    return {ok: false, status: 409, errors: [{field: 'action', message: '申請した人は承認・却下できません。ほかの人の承認を待ってください'}]};
  }
  const errors = [];
  const note = readText(body.note, 'note', errors, {required: false, max: 1000, label: 'メモ'});
  const base = {approvalNo: approval.approvalNo, versionNo: approval.latestVersionNo + 1, status: APPROVAL_ACTIONS[action], paidOn: null, note};
  if (action === 'apply') {
    const amountYen = readAmount(body.amountYen, 'amountYen', errors);
    const basisReference = readText(body.basisReference, 'basisReference', errors, {required: true, max: 500, label: '根拠の参照（企画書・試算など）'});
    return errors.length ? {ok: false, status: 400, errors} : {ok: true, value: {...base, amountYen, basisReference}};
  }
  if (action === 'approve' || action === 'reject') {
    // 承認・却下は申請の額のまま。額を送るなら申請の額と同じであること（申請していない額を承認しない）
    if (body.amountYen !== undefined && body.amountYen !== null && body.amountYen !== approval.applicationAmountYen) {
      errors.push({field: 'amountYen', message: `承認・却下は申請の額（${approval.applicationAmountYen}円）のままです。額を変えるときは申請し直してください`});
    }
    const basisReference = readText(body.basisReference, 'basisReference', errors, action === 'reject'
      ? {required: true, max: 500, label: '却下の理由'} : {required: false, max: 500, label: '根拠の参照'});
    return errors.length ? {ok: false, status: 400, errors} : {ok: true, value: {...base, amountYen: approval.applicationAmountYen, basisReference}};
  }
  // 払込: 払った日と額（承認の額のうち、まだ払っていない分まで）
  const amountYen = readAmount(body.amountYen, 'amountYen', errors, {max: approval.remainingYen});
  if (!isCalendarDate(body.paidOn)) errors.push({field: 'paidOn', message: '払った日を「2026-05-20」の形で入れてください'});
  const basisReference = readText(body.basisReference, 'basisReference', errors, {required: false, max: 500, label: '根拠の参照（振込の控えなど）'});
  return errors.length ? {ok: false, status: 400, errors} : {ok: true, value: {...base, amountYen, basisReference, paidOn: body.paidOn}};
}
