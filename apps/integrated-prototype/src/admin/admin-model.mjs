// 管理系の画面（チーム・追加項目・分析）の論理。React に依存しない純関数（node --test で試す）。
// 日時は日本時間（JST, UTC+9 固定）で入力・表示する。ブラウザの時差設定に左右されない。
import {labelOf} from '../ui/labels.mjs';
import {dateJst, dateTimeJst, parseTimestamp} from '../ui/format.mjs';

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');

// ---- チーム（招待） ----

// サーバー（app.mjs の /api/team/invitations）と同じ規則。試作では実在のメールに送らない。
export const INVITE_EMAIL_PATTERN = /^[a-z0-9._+-]+@[a-z0-9.-]+\.invalid$/;

export const INVITE_ROLE_OPTIONS = Object.freeze([
  Object.freeze({value: 'editor', label: '編集担当', description: '案件の業務データを登録・修正できます'}),
  Object.freeze({value: 'production', label: '制作担当', description: '制作の画面だけを使い、金額は見えません'}),
]);

// 「2026-10-01T18:00」（日本時間の入力値）→ UTC の ISO 文字列。形や暦日が正しくなければ null。
export function jstInputToIso(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const [y, m, d, hh, mm] = match.slice(1).map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  const utc = Date.UTC(y, m - 1, d, hh, mm) - JST_OFFSET_MS;
  const back = new Date(utc + JST_OFFSET_MS);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return new Date(utc).toISOString();
}

// UTC の日時 → 日本時間の入力値「YYYY-MM-DDTHH:mm」。読めなければ空文字。
export function isoToJstInput(value) {
  const date = parseTimestamp(value);
  if (!date) return '';
  const s = new Date(date.getTime() + JST_OFFSET_MS);
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}T${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`;
}

// 日本時間の今日「YYYY-MM-DD」（分析の基準日の既定値）。
export function jstToday(now = new Date()) {
  const s = new Date(now.getTime() + JST_OFFSET_MS);
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
}

// 既定の期限: 今日から days 日後の日本時間 23:59。
export function defaultExpiryInput(now = new Date(), days = 7) {
  const s = new Date(now.getTime() + days * DAY_MS + JST_OFFSET_MS);
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}T23:59`;
}

export function projectTitle(projects, id) {
  const project = (projects || []).find((row) => Number(row.id) === Number(id));
  return project ? project.title : null;
}

// 招待の入力を確かめ、送る形（payload）を作る。errors は項目名→理由。
export function validateInvitation(form, {now = new Date(), projects} = {}) {
  const errors = {};
  const email = String(form?.email ?? '').trim().toLowerCase();
  if (!email) errors.email = 'メールアドレスを入れてください';
  else if (!INVITE_EMAIL_PATTERN.test(email)) errors.email = '試作では末尾が .invalid の架空のメールだけを使えます（例: reviewer@pilot.invalid）';
  const projectId = form?.projectId === null || form?.projectId === undefined || form?.projectId === '' ? null : Number(form.projectId);
  if (projectId === null || !Number.isInteger(projectId)) errors.projectId = '案件を一覧から選んでください';
  else if (Array.isArray(projects) && !projects.some((row) => Number(row.id) === projectId)) errors.projectId = '選べる案件の中から選んでください';
  const role = String(form?.role ?? '');
  if (!INVITE_ROLE_OPTIONS.some((option) => option.value === role)) errors.role = '役割を選んでください';
  const expiresAt = jstInputToIso(form?.expiresAt);
  if (!form?.expiresAt) errors.expiresAt = '期限を入れてください';
  else if (!expiresAt) errors.expiresAt = '期限の日付・時刻を確かめてください';
  else if (Date.parse(expiresAt) <= now.getTime()) errors.expiresAt = '期限は今より後の日時にしてください';
  const ok = Object.keys(errors).length === 0;
  return {ok, errors, payload: ok ? {email, projectId, role, expiresAt} : null};
}

// 招待1件の状態。サーバーは期限を過ぎても pending のまま持つため、画面では期限と今を比べて「期限切れ」と出す。
export function invitationState(invitation, now = new Date()) {
  const status = invitation?.status;
  const expires = parseTimestamp(invitation?.expires_at);
  const lapsed = !expires || expires.getTime() <= now.getTime();
  if (status === 'accepted') {
    return lapsed
      ? {code: 'accepted-lapsed', label: '参加済み（期限切れ）', tone: 'warn', canAccept: false, canRevoke: true, revokeLabel: 'この案件の権限を外す'}
      : {code: 'accepted', label: '参加済み', tone: 'ok', canAccept: false, canRevoke: true, revokeLabel: 'この案件の権限を外す'};
  }
  if (status === 'revoked') return {code: 'revoked', label: '取消済み', tone: 'muted', canAccept: false, canRevoke: false, revokeLabel: ''};
  if (status === 'expired' || (status === 'pending' && lapsed)) {
    return {code: 'expired', label: '期限切れ', tone: 'warn', canAccept: false, canRevoke: status === 'pending', revokeLabel: '招待を取り消す'};
  }
  if (status === 'pending') return {code: 'pending', label: '参加の確定待ち', tone: 'info', canAccept: true, canRevoke: true, revokeLabel: '招待を取り消す'};
  return {code: String(status ?? ''), label: labelOf('invitationStatus', status), tone: 'muted', canAccept: false, canRevoke: false, revokeLabel: ''};
}

// 取り消し前に画面に出す要約（2段確認の1段目）。
export function revokeSummary(invitation, projects) {
  const project = projectTitle(projects, invitation?.project_id) || '案件（名称未確認）';
  if (invitation?.status === 'accepted') {
    return `${invitation.email} から「${project}」の権限を外します。組織への所属は残ります。この操作は元に戻せません（必要なら新しく招待します）。`;
  }
  return `${invitation?.email} への「${project}」の招待を取り消します。取り消した招待は元に戻せません（必要なら新しく招待します）。`;
}

export function invitationRows(invitations, projects, now = new Date()) {
  return (invitations || []).map((row) => {
    const state = invitationState(row, now);
    return {...row, project_title: projectTitle(projects, row.project_id) || '案件（名称未確認）', state_label: state.label, state};
  });
}

// メンバー一覧（メンバー×案件の権限）。案件の権限が無い行は「案件の権限なし」。
export function memberRows(members, projects) {
  return (members || []).map((row) => ({
    ...row,
    key: `${row.email}|${row.project_id ?? '-'}`,
    active_label: Number(row.active) === 1 ? '有効' : '停止',
    project_title: row.project_id == null ? '案件の権限なし' : projectTitle(projects, row.project_id) || '案件（名称未確認）',
  }));
}

// ---- 追加項目の提案 ----

export const AFFECTED_APP_LABELS = Object.freeze({'publicity-form': '宣伝の入力', 'csv-import': 'CSV取込', analytics: '分析'});

export function affectedApps(json) {
  try {
    const list = JSON.parse(json || '[]');
    if (!Array.isArray(list)) return {ok: false, labels: []};
    return {ok: true, labels: list.map((key) => AFFECTED_APP_LABELS[key] || `未登録の影響先（${key}）`)};
  } catch {
    return {ok: false, labels: []};
  }
}

const PROPOSAL_TONES = Object.freeze({pending: 'info', adopted: 'ok', rejected: 'muted'});

// 提案1件の表示。主表示は業務の言葉、キー・照合値・版は technical（詳細の折りたたみ）へ。
export function proposalView(row) {
  const valueType = labelOf('valueType', row?.value_type);
  const aggregation = labelOf('metricAggregation', row?.aggregation);
  const unit = row?.unit ? row.unit : '単位なし';
  const affected = affectedApps(row?.affected_apps_json);
  return {
    id: row?.id,
    label: row?.label || '名称未確認',
    summary: `${valueType}・${unit}・${aggregation}`,
    valueType, unit, aggregation,
    request: row?.request_text || '',
    reason: row?.meaning_reason || '',
    affected: affected.ok ? affected.labels.join('、') : '未確認',
    source: labelOf('proposalSource', row?.source),
    status: row?.status,
    statusLabel: labelOf('proposalStatus', row?.status),
    tone: PROPOSAL_TONES[row?.status] || 'muted',
    created: dateTimeJst(row?.created_at),
    decided: row?.decided_at ? dateTimeJst(row.decided_at) : null,
    pending: row?.status === 'pending',
    technical: [
      ['提案番号', row?.id],
      ['項目キー', row?.field_key],
      ['報告書の見出し', row?.sample_header],
      ['値の型（コード）', row?.value_type],
      ['集計方法（コード）', row?.aggregation],
      ['元の項目定義の版', row?.base_schema_version],
      ['提案の照合値', row?.proposal_hash],
    ].filter(([, value]) => value !== undefined && value !== null && value !== ''),
  };
}

export function proposalCounts(rows) {
  const counts = {all: 0, pending: 0, adopted: 0, rejected: 0};
  for (const row of rows || []) {
    counts.all += 1;
    if (Object.hasOwn(counts, row.status)) counts[row.status] += 1;
  }
  return counts;
}

export function filterProposals(rows, status) {
  const list = rows || [];
  return status && status !== 'all' ? list.filter((row) => row.status === status) : list;
}

// 採用・不採用の前に出す要約（2段確認の1段目）。
export function decisionSummary(row, decision) {
  const view = proposalView(row);
  if (decision === 'adopt') {
    return `「${view.label}」（${view.summary}）を項目として追加します。${view.affected}で使えるようになり、採用は元に戻せません。`;
  }
  return `「${view.label}」を不採用にします。不採用にした提案は元に戻せません（必要なら新しく提案します）。`;
}

export function validateRequestText(text) {
  const value = String(text ?? '').trim();
  if (!value) return '記録したい内容を入れてください';
  if (value.length > 2000) return `2,000文字以内にしてください（いま${value.length.toLocaleString('ja-JP')}文字）`;
  return '';
}

// 外部AIで作った提案JSONを、送る前に読めるか確かめる。
export function parseProposalJson(text) {
  const value = String(text ?? '').trim();
  if (!value) return {ok: false, error: '提案のJSONを貼り付けてください'};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {ok: false, error: 'JSONとして読めません。{ から } までをそのまま貼り付けてください'};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {ok: false, error: '提案は1件ずつ、{ } で囲んだ形で貼り付けてください'};
  return {ok: true, value: parsed};
}

// ---- 分析 ----

const isForbidden = (error) => Boolean(error) && (error.kind === 'forbidden' || error.status === 403);
// 分析の経路そのものが無い環境（分析の登録をしていないローカル・試験）は「未接続」と同じに扱う。
const isMissingRoute = (error) => Boolean(error) && (error.kind === 'not_found' || error.status === 404);

// 分析画面の状態。state: loading | forbidden | error | unconfigured | busy | initial | stale | verified
export function analyticsView({status = null, error = null, role = null, pending = false} = {}) {
  const admin = role === 'admin';
  const base = {canSync: false, showRestart: false, canRestart: false, lastError: null, links: [], admin};
  if (isForbidden(error)) {
    return {...base, state: 'forbidden', tone: 'info', title: '分析の更新と履歴は管理者が扱います',
      message: 'この役割では分析版の更新・履歴を扱えません。売上の集計や年間の推移は帳票センターで確かめられます。',
      links: [{page: '帳票センター', label: '帳票センターを開く'}]};
  }
  if (isMissingRoute(error) && !status) status = {enabled: false};
  else if (error && !status) return {...base, state: 'error', tone: 'error', error};
  if (!status) return {...base, state: 'loading', tone: 'info', message: '分析の接続を確かめています…'};
  if (!status.enabled) {
    return {...base, state: 'unconfigured', tone: 'warn', title: 'この環境には分析の接続がありません',
      message: admin
        ? '分析版を作るには、架空データ用の分析環境をこの環境に登録します（手順は下の「接続の手順」）。売上の集計は帳票センターでそのまま確かめられます。'
        : '分析版を作るには、管理者が分析環境を登録する必要があります。売上の集計は帳票センターで確かめられます。',
      links: [{page: '帳票センター', label: '帳票センターを開く'}]};
  }
  const busy = Boolean(status.busy || pending);
  const withActions = {
    ...base,
    canSync: admin && !busy,
    showRestart: admin && status.runtime === 'cloud',
    canRestart: admin && status.runtime === 'cloud' && !busy,
    lastError: status.lastError ? {message: '前回の分析更新は完了しませんでした。前の分析版をそのまま表示しています。', technical: String(status.lastError)} : null,
  };
  if (busy) return {...withActions, state: 'busy', tone: 'info', message: '新しい分析版を作り、帳票と照合しています。終わるまで前の版を表示します。'};
  const active = status.active;
  if (!active) return {...withActions, state: 'initial', tone: 'info', message: 'まだ分析版がありません。基準日を選んで「最新データで分析を更新」を押すと作ります。'};
  if (active.stale) {
    return {...withActions, state: 'stale', tone: 'warn', message: active.definitionStale
      ? '集計の定義が変わりました。分析を更新すると新しい定義で作り直します。'
      : '分析版を作った後に業務データが更新されました。最新にするには分析を更新してください。'};
  }
  return {...withActions, state: 'verified', tone: 'ok', message: '帳票と照合済みの分析版を表示しています。'};
}

export function lightdashView(lightdash) {
  if (!lightdash?.url) return {connected: false, message: 'この環境には Lightdash（分析の画面）の接続がありません。照合帳票と売上CSVは上から確かめられます。'};
  const charts = Object.entries(lightdash.charts || {}).map(([key, chart]) => ({key, name: chart?.name || 'グラフ', url: chart?.url})).filter((chart) => chart.url);
  return {
    connected: true,
    verified: lightdash.status === 'verified',
    label: lightdash.status === 'verified' ? '帳票との一致を確認済み' : '分析版の更新後、接続の確認が必要です',
    tone: lightdash.status === 'verified' ? 'ok' : 'warn',
    verifiedAt: lightdash.verifiedAt ? dateTimeJst(lightdash.verifiedAt) : null,
    charts,
  };
}

// 分析の保存履歴の行。日時は日本時間、分析版の番号は詳細にだけ出す。
export function historyRows(runs, activeRunId = null) {
  return (runs || []).map((run) => ({
    key: run.runId,
    runId: run.runId,
    verified: dateTimeJst(run.verifiedAt),
    asOf: run.asOf ? dateJst(run.asOf) : '未確認',
    current: Boolean(activeRunId) && run.runId === activeRunId,
  }));
}
