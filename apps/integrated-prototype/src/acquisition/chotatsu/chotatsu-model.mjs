// 調達（MG を払わずに販売権を調達し、製造へ渡すまで）の計算と判定。表は読まない純関数。
// 会社ルートの plans/2026-10-24-folder-chotatsu.md（代表の決定 2026-10-24。フォルダ台帳 F19）。
// 段の状態・粗利の見込み・素材の期限は表に持たず、記録から開くたびにここで導く。
import {rateAmountFloor, toSafeYen} from './money-chotatsu.mjs';

export const STAGES = Object.freeze(['wish', 'estimate', 'agreement', 'ringi', 'contract', 'materials', 'handoff']);
export const STAGE_LABELS = Object.freeze({wish: '希望', estimate: '試算', agreement: '合意', ringi: '稟議', contract: '契約', materials: '素材', handoff: '渡す'});
export const MEDIA_FAMILIES = Object.freeze({videogram: 'ビデオグラム', digital: '配信', broadcast: '放送', overseas: '海外', other: 'その他'});
export const FORMATS = Object.freeze({sell_dvd: 'セル DVD', sell_bd: 'セル BD', sell_dvd_bd: 'セル DVD・BD', rental_dvd: 'レンタル DVD', rental_bd: 'レンタル BD',
  digital: '配信', other: 'その他'});
export const RELEASE_SLOTS = Object.freeze({day25: '25日', first_wed: '第1水曜', other: 'その他'});
// 素材の納品希望物の並び（製造の約束 CH-5。調達の約束 Z-5）
export const MATERIAL_KINDS = Object.freeze({master: '本編マスター', preview_copy: '確認用', trailer: '予告編', bonus: '特典映像', music: '音楽素材',
  main_art: 'メインアート', logo: 'ロゴ', stills: '場面写真', poster: 'ポスター', work_info: '作品情報', other: 'その他'});
export const DOC_KINDS = Object.freeze({estimate: '見積', agreement: '合意', ringi: '稟議書', contract_draft: '契約書案', contract: '契約書', materials: '素材', other: 'その他'});
export const RINGI_RESULTS = Object.freeze({approved: '承認', returned: '差し戻し', rejected: '否決'});
const SOURCE_KIND_OF_DOC = Object.freeze({estimate: 'estimate', agreement: 'other', ringi: 'other', contract_draft: 'contract', contract: 'contract', materials: 'media', other: 'other'});
export const sourceKindForDoc = (docKind) => SOURCE_KIND_OF_DOC[docKind] ?? 'other';

const toSafe = toSafeYen;

// 試算の粗利の見込み: 売上の見込み（単価×数量）− 見積の行の和 − 権利料（率は切り捨て、1枚あたりは×数量）
export function estimateTotals(estimate, lines = []) {
  const quantity = BigInt(estimate.quantity);
  const revenue = BigInt(estimate.unitRevenueExTaxYen) * quantity;
  const cost = lines.reduce((sum, line) => sum + BigInt(line.amountExTaxYen), 0n);
  let royalty = 0n;
  if (estimate.royaltyKind === 'rate') royalty = rateAmountFloor(revenue, estimate.royaltyRateBps);
  else if (estimate.royaltyKind === 'per_unit') royalty = BigInt(estimate.royaltyPerUnitYen) * quantity;
  return {revenueYen: toSafe(revenue), costYen: toSafe(cost), royaltyYen: toSafe(royalty), grossYen: toSafe(revenue - cost - royalty)};
}

// 素材の納品の期限。製造の純関数 mfgMaterialDueDate（製造の約束 Z-2。既定は発売月の3か月前の20日）が core に入るまでの同じ型の写し。
// 製造の関数が入ったら、こちらを消して製造の関数を読む
export function materialDueDate({slotKind, releaseMonth} = {}) {
  if (!releaseMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(releaseMonth)) return null;
  void slotKind;
  const [year, month] = releaseMonth.split('-').map(Number);
  const index = year * 12 + (month - 1) - 3;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-20`;
}

// 素材の種類ごとのいまの状態（同じ種類の最後の行）
export function currentMaterials(rows) {
  const latest = new Map();
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) latest.set(row.materialKind, row);
  return [...latest.values()];
}

export function materialsDone(rows) {
  const current = currentMaterials(rows).filter((row) => row.required);
  return current.length > 0 && current.every((row) => row.checkResult === 'ok');
}

// 引き渡しの行ごとの状態: void の行があれば void、received があれば received、notice があれば notice
export function handoffState(events) {
  const kinds = new Set(events.map((e) => e.event));
  if (kinds.has('void')) return 'void';
  if (kinds.has('received')) return 'received';
  if (kinds.has('notice')) return 'notice';
  return 'none';
}

// 閉じた案件（見送り・MG_買付分へ移した）。取消された閉じの出来事は数えない
export function closedState(events) {
  const voided = new Set(events.filter((e) => e.event === 'void').map((e) => e.voidsSeq));
  const closing = events.filter((e) => (e.event === 'dropped' || e.event === 'moved_to_mg') && !voided.has(e.seq)).at(-1);
  return closing ? {event: closing.event, seq: closing.seq, reason: closing.reason, onDate: closing.onDate} : null;
}

// 段の状態。記録から導く: 希望＝案件がある、試算＝試算の版がある、合意＝合意の行がある、稟議＝最後の結果が承認、契約＝契約の行がある、
// 素材＝要る素材が全部 ok、渡す＝取消していない引き渡しが受領まで済み（予告だけなら「予」）
export function stageStates({estimates = [], agreements = [], ringi = [], contract = null, materials = [], handoffs = [], events = [], today, releaseMonth = null,
  offerUntil = null}) {
  const done = {
    wish: true,
    estimate: estimates.length > 0,
    agreement: agreements.length > 0,
    ringi: ringi.length > 0 && ringi.at(-1).result === 'approved',
    contract: Boolean(contract),
    materials: materialsDone(materials),
    handoff: handoffs.some((h) => handoffState(h.events) === 'received'),
  };
  const noticed = handoffs.some((h) => handoffState(h.events) === 'notice');
  const closed = closedState(events);
  const due = materialDueDate({releaseMonth});
  const firstOpen = STAGES.find((stage) => !done[stage]) ?? null;
  const states = {};
  for (const stage of STAGES) {
    if (done[stage]) { states[stage] = 'done'; continue; }
    if (closed) { states[stage] = 'stop'; continue; }
    if (stage !== firstOpen) { states[stage] = stage === 'handoff' && noticed ? 'notice' : 'todo'; continue; }
    const offerLate = ['estimate', 'agreement', 'ringi', 'contract'].includes(stage) && offerUntil && today && today > offerUntil;
    const materialsLate = stage === 'materials' && due && today && today > due;
    states[stage] = offerLate || materialsLate ? 'late' : (stage === 'handoff' && noticed ? 'notice' : 'now');
  }
  // 素材は契約の後に並んで進むので、契約が済んでいて素材が未了なら期限で遅れを見る
  if (!done.materials && !closed && done.contract && due && today && today > due) states.materials = 'late';
  return {states, done, firstOpen, closed, materialsDue: due};
}

// フォルダの状態（X-16 の folderStatus の形）。済＝契約・素材・受領の3つ（問い6 A）
export function caseFolderStatus({states, closed}) {
  const keys = ['contract', 'materials', 'handoff'];
  const doneCount = keys.filter((k) => states[k] === 'done').length;
  if (closed) return {state: 'done', done: doneCount, total: 3, reason: closed.event === 'moved_to_mg' ? '移' : '止'};
  if (doneCount === 3) return {state: 'done', done: 3, total: 3, reason: '済'};
  const open = STAGES.find((s) => states[s] !== 'done');
  const late = STAGES.some((s) => states[s] === 'late');
  return {state: late ? 'needs_review' : (STAGES.indexOf(open) <= 1 ? 'not_started' : 'in_progress'), done: doneCount, total: 3, reason: late ? '遅' : STAGE_LABELS[open]};
}

const formatChannel = (format) => (format.startsWith('rental') ? ['レンタル', 'ビデオグラム', 'rental', 'videogram'] : format.startsWith('sell')
  ? ['セル', 'ビデオグラム', 'sell', 'videogram'] : format === 'digital' ? ['配信', 'digital'] : []);

// 必ず成り立つ検査（引き渡しの前と画面を開くたび）。ok が false の行は例外として出す
export function caseChecks({version, estimates = [], ringi = [], contract = null, scopes = [], handoffs = [], openSiblings = 0}) {
  const checks = [];
  const approved = [...ringi].reverse().find((r) => r.result === 'approved');
  const liveHandoffs = handoffs.filter((h) => handoffState(h.events) !== 'void');
  for (const h of liveHandoffs) {
    const estimate = estimates.find((e) => e.id === h.estimateId);
    const approvedEstimate = approved ? estimates.find((e) => e.id === approved.estimateId) : null;
    checks.push({key: 'handoff_estimate', ok: Boolean(estimate && approvedEstimate && estimate.versionNo >= approvedEstimate.versionNo),
      message: '引き渡した試算の版が、稟議で承認した版より前です'});
  }
  const releaseMonth = version?.releaseMonth ?? null;
  if (contract && releaseMonth) {
    const inScope = scopes.some((s) => (!s.rightsStart || s.rightsStart.slice(0, 7) <= releaseMonth) && (!s.rightsEnd || s.rightsEnd.slice(0, 7) >= releaseMonth));
    checks.push({key: 'release_in_rights', ok: inScope, message: '発売予定月が権利範囲の期間の外です'});
  }
  const latestEstimate = estimates.at(-1);
  if (contract && latestEstimate && !['digital', 'other'].includes(latestEstimate.format)) {
    const words = formatChannel(latestEstimate.format);
    const allowed = scopes.some((s) => s.channel && words.some((w) => String(s.channel).toLowerCase().includes(w.toLowerCase())));
    checks.push({key: 'format_in_rights', ok: allowed, message: '製造する形態が権利範囲の媒体に入っていません'});
  }
  checks.push({key: 'no_duplicate', ok: openSiblings === 0, message: '同じ作品・権利元・媒体の、閉じていない案件がほかにあります'});
  return checks;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const isDate = (v) => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const optText = (v, max, label) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.trim().length < 1 || v.trim().length > max) throw new Error(`${label}は1〜${max}字にしてください`);
  return v.trim();
};
const reqText = (v, max, label) => {
  const t = optText(v, max, label);
  if (t == null) throw new Error(`${label}を入れてください`);
  return t;
};
const optInt = (v, label, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${label}は${min}以上${max}以下の整数にしてください`);
  return n;
};
const reqInt = (v, label, range) => {
  const n = optInt(v, label, range);
  if (n == null) throw new Error(`${label}を入れてください`);
  return n;
};
const optDate = (v, label) => {
  if (v == null || v === '') return null;
  if (!isDate(v)) throw new Error(`${label}は YYYY-MM-DD で入れてください`);
  return v;
};
const optMonth = (v, label) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !MONTH.test(v)) throw new Error(`${label}は YYYY-MM で入れてください`);
  return v;
};
const oneOf = (v, allowed, label) => {
  if (!Object.hasOwn(allowed, v)) throw new Error(`${label}を選んでください`);
  return v;
};

export function normalizeCaseVersionInput(input, {requireReason = false} = {}) {
  const origin = input.salesActivityId != null && input.salesActivityId !== '' ? 'sales_activity' : 'self';
  const value = {
    title: reqText(input.title, 200, '題'),
    holderPartnerId: optInt(input.holderPartnerId, '権利元', {min: 1}),
    distributorPartnerId: optInt(input.distributorPartnerId, '配給', {min: 1}),
    mediaFamily: oneOf(input.mediaFamily ?? 'videogram', MEDIA_FAMILIES, '媒体'),
    workId: optInt(input.workId, '作品', {min: 1}),
    origin,
    salesActivityId: origin === 'sales_activity' ? optInt(input.salesActivityId, '営業の活動記録', {min: 1}) : null,
    theatricalReleaseOn: optDate(input.theatricalReleaseOn, '劇場公開日'),
    offerFrom: optDate(input.offerFrom, '提案できる期間の始まり'),
    offerUntil: optDate(input.offerUntil, '提案できる期間の終わり'),
    releaseMonth: optMonth(input.releaseMonth, '発売予定月'),
    releaseSlot: input.releaseSlot == null || input.releaseSlot === '' ? null : oneOf(input.releaseSlot, RELEASE_SLOTS, '発売の枠'),
    note: optText(input.note, 2000, 'メモ'),
    reason: requireReason ? reqText(input.reason, 1000, '直す理由') : (optText(input.reason, 1000, '理由') ?? '希望として登録'),
  };
  if (value.offerFrom && value.offerUntil && value.offerUntil < value.offerFrom) throw new Error('提案できる期間の終わりが始まりより前です');
  if (value.releaseSlot && !value.releaseMonth) throw new Error('発売の枠を選ぶときは発売予定月も入れてください');
  return value;
}

export function normalizeEstimateInput(input) {
  const royaltyKind = oneOf(input.royaltyKind ?? 'rate', {rate: 1, per_unit: 1, none: 1}, '権利料の型');
  if (input.mgYen != null || input.royaltyKind === 'mg') throw new Error('MG を払う調達は MG_買付分で扱います');
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (lines.length > 200) throw new Error('見積の行は200行までです');
  return {
    format: oneOf(input.format, FORMATS, '形態'),
    setCount: reqInt(input.setCount ?? 1, '組数', {min: 1, max: 100}),
    bonusNote: optText(input.bonusNote, 500, '特典'),
    listPriceExTaxYen: optInt(input.listPriceExTaxYen, '予定価格', {max: 1000000000}),
    unitRevenueExTaxYen: reqInt(input.unitRevenueExTaxYen, '1枚の売上（税抜）', {max: 1000000000}),
    quantity: reqInt(input.quantity, '数量の見込み', {max: 100000000}),
    royaltyKind,
    royaltyRateBps: royaltyKind === 'rate' ? reqInt(input.royaltyRateBps, '権利料の率（bp）', {max: 10000}) : null,
    royaltyPerUnitYen: royaltyKind === 'per_unit' ? reqInt(input.royaltyPerUnitYen, '1枚あたりの権利料', {max: 1000000000}) : null,
    promotionNote: optText(input.promotionNote, 2000, '宣伝案'),
    reason: optText(input.reason, 1000, '理由') ?? '試算',
    lines: lines.map((line, index) => ({
      lineNo: index + 1,
      expenseType: reqText(line.expenseType, 60, `${index + 1}行目の経費の種類`),
      name: reqText(line.name, 200, `${index + 1}行目の名前`),
      amountExTaxYen: reqInt(line.amountExTaxYen, `${index + 1}行目の額`, {max: 1000000000000}),
      sourceDocumentId: optInt(line.sourceDocumentId, `${index + 1}行目の見積の原本`, {min: 1}),
    })),
  };
}

export function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error('権利範囲を1行以上入れてください');
  return scopes.map((s, i) => {
    const value = {
      channel: reqText(s.channel, 100, `${i + 1}行目の媒体`),
      territory: optText(s.territory, 100, `${i + 1}行目の地域`) ?? '日本',
      rightsStart: optDate(s.rightsStart, `${i + 1}行目の開始日`),
      rightsEnd: optDate(s.rightsEnd, `${i + 1}行目の終了日`),
      exclusivity: s.exclusivity == null || s.exclusivity === '' ? 'unknown' : oneOf(s.exclusivity, {exclusive: 1, nonexclusive: 1, unknown: 1}, `${i + 1}行目の独占性`),
    };
    if (value.rightsStart && value.rightsEnd && value.rightsEnd < value.rightsStart) throw new Error(`${i + 1}行目の終了日が開始日より前です`);
    return value;
  });
}

export const helpers = Object.freeze({optText, reqText, optInt, reqInt, optDate, optMonth, oneOf, isDate});
