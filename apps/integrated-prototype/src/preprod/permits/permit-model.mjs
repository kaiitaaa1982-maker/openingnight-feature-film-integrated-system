// 撮影の許可申請の計算と判定（純関数。移行 0060。決まりの正本は brain の wiki/10_manual/road-use-permit.md）。
// - 受け取りまでの日数「中N日」: 申請の翌日から N 日の窓口の開く日をはさみ、その次の窓口の開く日から受け取れる
// - 申請の最終日: 使う日の前の窓口の開く日に受け取れるように、そこから逆算する
// - 窓口の開く日: 土日と、引数で渡す休みの日（'YYYY-MM-DD' の並び）を除く。祝日の表はまだ無いので、渡さなければ土日だけを除く
// 「今日」は引数で受け取る。DB・時刻・環境変数を読まない。

export const PERMIT_KINDS = Object.freeze({road: '道路', park: '公園', facility: '施設'});
export const PERMIT_STATES = Object.freeze({draft: '準備', submitted: '提出', permitted: '許可', returned: '差戻', withdrawn: '取下', done: '済み'});
export const PERMIT_DOCUMENT_ROLES = Object.freeze({application: '申請書', sketch: '略図', map: '地図', permit: '許可証', notice: '通知書', other: 'その他'});

const DAY_MS = 86400000;
const DATE = /^\d{4}-\d\d-\d\d$/;

// 'YYYY-MM-DD' を UTC の日の番号にする。形や暦が外れていれば null
export function dayNumber(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms).toISOString().slice(0, 10);
  return back === value ? ms / DAY_MS : null;
}
const fromDayNumber = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

export function isOpenDay(value, holidays = []) {
  const n = dayNumber(value);
  if (n == null) return false;
  const weekday = new Date(n * DAY_MS).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.includes(value);
}

// 窓口の開く日を step（+1 か -1）の向きに count 日進める。起点そのものは数えない
export function shiftOpenDays(value, count, step, holidays = []) {
  let n = dayNumber(value);
  if (n == null || !Number.isSafeInteger(count) || count < 0) return null;
  let left = count;
  while (left > 0) { n += step; if (isOpenDay(fromDayNumber(n), holidays)) left -= 1; }
  return fromDayNumber(n);
}

// 使う日（期間の始め）と中N日から、受け取りの最終日と申請の最終日を出す。N が未確定（null）なら両方 null
export function applyDeadline({useOn, leadBusinessDays, holidays = []}) {
  if (dayNumber(useOn) == null) throw new Error('使う日を確認してください');
  if (leadBusinessDays == null) return {pickupBy: null, applyBy: null};
  if (!Number.isSafeInteger(leadBusinessDays) || leadBusinessDays < 0) throw new Error('受け取りまでの日数を確認してください');
  const pickupBy = shiftOpenDays(useOn, 1, -1, holidays);
  const applyBy = shiftOpenDays(pickupBy, leadBusinessDays + 1, -1, holidays);
  return {pickupBy, applyBy};
}

// 申請した日から、受け取れる最初の日（受け取り予定日の既定）
export function pickupFrom({appliedOn, leadBusinessDays, holidays = []}) {
  if (dayNumber(appliedOn) == null || leadBusinessDays == null) return null;
  return shiftOpenDays(appliedOn, leadBusinessDays + 1, 1, holidays);
}

// 使う期間の日数（始めと終わりを含む）
export function spanDays(startsOn, endsOn) {
  const a = dayNumber(startsOn), b = dayNumber(endsOn);
  if (a == null || b == null || b < a) return null;
  return b - a + 1;
}

// 期間でまとめて申請できる上限の検査。上限が未確定（null）なら通す
export function checkSpan({startsOn, endsOn, maxSpanDays}) {
  const days = spanDays(startsOn, endsOn);
  if (days == null) return {ok: false, days: null, max: maxSpanDays ?? null, reason: 'range'};
  if (maxSpanDays == null || days <= maxSpanDays) return {ok: true, days, max: maxSpanDays ?? null};
  return {ok: false, days, max: maxSpanDays, reason: 'over'};
}

// 1行の印。差戻と、申請の最終日を過ぎた未提出（準備のまま）が赤（見た目の決まり §2）
export function rowAlert({state, applyBy}, today) {
  if (state === 'returned') return 'returned';
  if (state === 'draft' && applyBy && today && today > applyBy) return 'late';
  return null;
}

// 申請ごとの最新の版だけを残す
export function latestVersions(rows) {
  const map = new Map();
  for (const row of rows) { const prev = map.get(row.application_id); if (!prev || row.version_no > prev.version_no) map.set(row.application_id, row); }
  return map;
}

// 提出先ごとの最新の設定
export function latestOfficeSettings(rows) {
  const map = new Map();
  for (const row of rows) { const prev = map.get(row.office_id); if (!prev || row.version_no > prev.version_no) map.set(row.office_id, row); }
  return map;
}

// 一覧の1行を組み立てる。application は申請、version は最新の版、office は提出先と最新の設定
export function permitRow({application, version, office, work, documentCount = 0}, {today, holidays = []} = {}) {
  const lead = office?.lead_business_days ?? null;
  const {pickupBy, applyBy} = applyDeadline({useOn: version.starts_on, leadBusinessDays: lead, holidays});
  const span = checkSpan({startsOn: version.starts_on, endsOn: version.ends_on, maxSpanDays: office?.max_span_days ?? null});
  return {
    id: application.id, workId: application.work_id, workTitle: work?.title ?? null, kind: application.kind,
    versionNo: version.version_no, officeId: version.office_id, officeName: office?.name ?? null,
    leadBusinessDays: lead, maxSpanDays: office?.max_span_days ?? null,
    place: version.place, startsOn: version.starts_on, endsOn: version.ends_on, spanDays: span.days, spanOver: span.reason === 'over',
    appliedOn: version.applied_on, pickupOn: version.pickup_on, receivedOn: version.received_on,
    state: version.state, feeYen: version.fee_yen ?? null, note: version.note ?? null,
    documentCount, pickupBy, applyBy, alert: rowAlert({state: version.state, applyBy}, today),
  };
}

// 一覧の絞り込み（作品・種類・提出先・状態。null は絞らない）
export function filterRows(rows, {workId = null, kind = null, officeId = null, state = null} = {}) {
  return rows.filter((r) => (workId == null || r.workId === workId) && (kind == null || r.kind === kind)
    && (officeId == null || r.officeId === officeId) && (state == null || r.state === state));
}
