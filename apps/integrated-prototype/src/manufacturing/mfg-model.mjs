// 製造の純関数（会社ルートの plans/2026-10-24-folder-seizou.md の第2版。移行 0046）。
// 逆算の予定日は保存せず、商品の版（発売日と型）から毎回導く。人が直した日・依頼・承認・済は工程の記録（mfg_step_events）から読む。
// 型は実物の2つのテンプレートから起こした既定値: 25日の型は「発売月の n か月前の d 日」、ほかの日は「発売日の n 日前」。

// 工程の型（12）。request は権利元への依頼日、due は承認の〆切（依頼の無い工程は due だけ）。owner は持ち主の業務（chotatsu・mfg・eigyo）
export const MFG_STEPS = Object.freeze([
  {key: 'contract_draft', label: '契約のドラフト', group: 'contract', owner: 'chotatsu', day25: {request: [-3, 7], due: [-3, 10]}, offset: {request: -107, due: -104}},
  {key: 'material', label: '素材の納品', group: 'manufacture', owner: 'chotatsu', day25: {due: [-3, 15]}, offset: {due: -99}},
  {key: 'text_spec', label: '文字資料', group: 'manufacture', owner: 'mfg', day25: {request: [-3, 10], due: [-3, 17]}, offset: {request: -104, due: -97}},
  {key: 'authoring_flow', label: 'オーサリングのフロー', group: 'manufacture', owner: 'mfg', day25: {request: [-3, 10], due: [-3, 17]}, offset: {request: -104, due: -97}},
  {key: 'menu_design', label: 'メニューのデザイン', group: 'design', owner: 'mfg', day25: {request: [-3, 13], due: [-3, 20]}, offset: {request: -101, due: -94}},
  {key: 'rental_front', label: 'レンタル表1', group: 'design', owner: 'mfg', channels: ['rental'], day25: {request: [-3, 26], due: [-2, 6]}, offset: {request: -88, due: -80}},
  {key: 'rental_back', label: 'レンタル表4・背', group: 'design', owner: 'mfg', channels: ['rental'], day25: {request: [-3, 26], due: [-2, 6]}, offset: {request: -88, due: -80}},
  {key: 'check_disc', label: '検証盤', group: 'manufacture', owner: 'mfg', day25: {request: [-2, 13], due: [-2, 20]}, offset: {request: -73, due: -66}},
  {key: 'sell_jacket', label: 'セルのジャケット・レーベル', group: 'design', owner: 'mfg', channels: ['sell'], day25: {request: [-2, 13], due: [-2, 20]}, offset: {request: -73, due: -66}},
  {key: 'promo_banner', label: 'バナー・サムネイル', group: 'design', owner: 'mfg', day25: {request: [-2, 17], due: [-2, 24]}, offset: {request: -69, due: -62}},
  {key: 'announce', label: '情報解禁', group: 'announce', owner: 'eigyo', day25: {due: [-2, 25]}, offset: {due: -61}},
  {key: 'release', label: '発売', group: 'release', owner: 'eigyo', day25: {due: [0, 25]}, offset: {due: 0}},
].map(Object.freeze));

export const STEP_GROUPS = Object.freeze({contract: '契約書', manufacture: '製造', design: 'デザイン', announce: '情報解禁', release: 'リリース'});
export const CHANNELS = Object.freeze({sell: 'セル', rental: 'レンタル', print: '印刷物', other: 'その他'});
export const MEDIA = Object.freeze({dvd: 'DVD', bd: 'BD', print: '紙', other: 'その他'});
export const SOURCE_KINDS = Object.freeze({procure: '調達', mg_buy: 'MG_買付分', own: '自社の企画'});
export const PO_KINDS = Object.freeze({authoring: 'オーサリング', design: 'デザイン', manufacture: '製造', print: '印刷物', sample: '見本盤の発送'});
export const PO_STAGES = Object.freeze(['quote_requested', 'quoted', 'ordered', 'received', 'invoiced', 'paid']);
export const PO_STAGE_LABELS = Object.freeze({quote_requested: '依頼', quoted: '見積', ordered: '発注', received: '納品', invoiced: '請求', paid: '支払'});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

export function isDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// 発売月の n か月前（n は負）の d 日。その月に d 日が無ければ月末
export function monthDay(releaseOn, months, day) {
  const [y, m] = releaseOn.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}-${pad(Math.min(day, last))}`;
}

const pick = (rule, releaseOn, spec) => (spec == null ? null : rule === 'day25' ? monthDay(releaseOn, spec[0], spec[1]) : addDays(releaseOn, spec));

// 商品の版に当てはまる工程と、型から出した予定日
export function plannedSteps({releaseOn, scheduleRule, channel}) {
  return MFG_STEPS.filter((step) => !step.channels || step.channels.includes(channel)).map((step) => {
    const spec = scheduleRule === 'day25' ? step.day25 : step.offset;
    return {key: step.key, label: step.label, group: step.group, owner: step.owner,
      requestOn: pick(scheduleRule, releaseOn, spec.request), dueOn: pick(scheduleRule, releaseOn, spec.due)};
  });
}

// 素材の納品の期限（調達が読む。調達の約束 Z-5）
export function mfgMaterialDueDate({releaseOn, scheduleRule}) {
  const step = MFG_STEPS.find((s) => s.key === 'material');
  return pick(scheduleRule, releaseOn, (scheduleRule === 'day25' ? step.day25 : step.offset).due);
}

// 取消されていない記録だけ
export function liveEvents(events) {
  const voided = new Set(events.filter((e) => e.kind === 'void').map((e) => Number(e.voidsEventId)));
  return events.filter((e) => e.kind !== 'void' && !voided.has(Number(e.id)));
}

// 工程ごとの今。済（done か、依頼のある工程の approved）なら done、〆切を過ぎて済でなければ late
export function stepStates(version, events, today) {
  const live = liveEvents(events);
  return plannedSteps(version).map((step) => {
    const mine = live.filter((e) => e.stepKey === step.key).sort((a, b) => Number(a.id) - Number(b.id));
    const last = (kind) => mine.filter((e) => e.kind === kind).at(-1) ?? null;
    const planned = last('planned');
    const dueOn = planned ? planned.onDate : step.dueOn;
    const requested = last('requested');
    const approved = last('approved');
    const done = last('done');
    const doneOn = done?.onDate ?? (step.requestOn ? approved?.onDate : null) ?? null;
    const state = doneOn ? 'done' : dueOn && today && dueOn < today ? 'late' : requested ? 'requested' : 'open';
    return {...step, dueOn, plannedDueOn: step.dueOn, overridden: Boolean(planned), requestedOn: requested?.onDate ?? null,
      approvedOn: approved?.onDate ?? null, doneOn, state};
  });
}

export function productProgress(states) {
  return {done: states.filter((s) => s.state === 'done').length, total: states.length, late: states.filter((s) => s.state === 'late').length,
    next: states.find((s) => s.state !== 'done') ?? null};
}

// 発注書の段。取消なら void。納品は全部の明細が「合」の数量で揃ったとき
export function purchaseOrderState({events, lines, receipts}) {
  if (events.some((e) => e.kind === 'void')) return {stage: 'void', reached: []};
  const reached = new Set(events.map((e) => e.kind));
  const received = lines.length > 0 && lines.every((line) => receipts.filter((r) => Number(r.poLineId) === Number(line.id) && r.result === 'pass')
    .reduce((sum, r) => sum + Number(r.qty) - Number(r.defectQty), 0) >= Number(line.qty));
  if (received) reached.add('received');
  const list = PO_STAGES.filter((stage) => reached.has(stage));
  return {stage: list.at(-1) ?? 'none', reached: list};
}

export const lineAmount = (qty, unitPriceX100) => (qty * unitPriceX100) / 100;

// 円の単価（小数2桁まで）を銭の整数に。丸めない（docs/rules/money.md）
export function priceToX100(text) {
  const value = String(text ?? '').trim().replace(/,/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

const text = (value, max) => {
  const v = String(value ?? '').trim();
  return v && v.length <= max ? v : null;
};
const optional = (value, max) => (value == null || String(value).trim() === '' ? {ok: true, value: null} : text(value, max) ? {ok: true, value: text(value, max)} : {ok: false});
const intIn = (value, min, max) => (Number.isSafeInteger(Number(value)) && String(value).trim() !== '' && Number(value) >= min && Number(value) <= max ? Number(value) : null);

export function normalizeVersionInput(input) {
  const errors = [];
  const name = text(input.name, 200); if (!name) errors.push('商品の名前を入れてください');
  const channel = Object.hasOwn(CHANNELS, input.channel) ? input.channel : null; if (!channel) errors.push('形（セル・レンタル・印刷物）を選んでください');
  const media = Object.hasOwn(MEDIA, input.media) ? input.media : null; if (!media) errors.push('媒体を選んでください');
  const releaseOn = isDate(input.releaseOn) ? input.releaseOn : null; if (!releaseOn) errors.push('発売日を入れてください（YYYY-MM-DD）');
  const scheduleRule = releaseOn && releaseOn.endsWith('-25') ? 'day25' : 'offset';
  const edition = optional(input.editionLabel, 60); if (!edition.ok) errors.push('版の名前は60字まで');
  const note = optional(input.note, 1000); if (!note.ok) errors.push('メモは1000字まで');
  const reason = text(input.reason, 500) ?? '登録';
  const episodeFrom = input.episodeFrom == null || input.episodeFrom === '' ? null : intIn(input.episodeFrom, 1, 9999);
  const episodeTo = input.episodeTo == null || input.episodeTo === '' ? null : intIn(input.episodeTo, 1, 9999);
  if ((input.episodeFrom ?? '') !== '' && episodeFrom == null) errors.push('話の番号を確かめてください');
  if ((input.episodeTo ?? '') !== '' && episodeTo == null) errors.push('話の番号を確かめてください');
  if (episodeFrom != null && episodeTo != null && episodeFrom > episodeTo) errors.push('話の範囲を確かめてください');
  const plannedQty = input.plannedQty == null || input.plannedQty === '' ? null : intIn(input.plannedQty, 0, 100000000);
  if ((input.plannedQty ?? '') !== '' && plannedQty == null) errors.push('予定の枚数を確かめてください');
  if (errors.length) return {ok: false, errors};
  return {ok: true, value: {name, channel, media, releaseOn, scheduleRule, editionLabel: edition.value, note: note.value, reason, episodeFrom, episodeTo, plannedQty}};
}

export function normalizeStepEvent(input, version) {
  const keys = new Set(plannedSteps(version).map((s) => s.key));
  if (!keys.has(input.stepKey)) return {ok: false, errors: ['工程を選んでください']};
  if (input.kind === 'void') {
    const id = intIn(input.voidsEventId, 1, Number.MAX_SAFE_INTEGER);
    return id ? {ok: true, value: {stepKey: input.stepKey, kind: 'void', onDate: null, voidsEventId: id, note: text(input.note, 500)}} : {ok: false, errors: ['取消す記録を選んでください']};
  }
  if (!['requested', 'approved', 'done', 'planned'].includes(input.kind)) return {ok: false, errors: ['記録の種類を選んでください']};
  if (!isDate(input.onDate)) return {ok: false, errors: ['日付を入れてください（YYYY-MM-DD）']};
  return {ok: true, value: {stepKey: input.stepKey, kind: input.kind, onDate: input.onDate, voidsEventId: null, note: text(input.note, 500)}};
}

export function normalizeOrderInput(input) {
  const errors = [];
  const poKind = Object.hasOwn(PO_KINDS, input.poKind) ? input.poKind : null; if (!poKind) errors.push('発注の種類を選んでください');
  const partnerId = input.partnerId == null || input.partnerId === '' ? null : intIn(input.partnerId, 1, Number.MAX_SAFE_INTEGER);
  const partnerLabel = optional(input.partnerLabel, 120);
  if (!partnerId && !partnerLabel.value) errors.push('発注先（取引先か会社の名前）を入れてください');
  const deliverTo = optional(input.deliverTo, 120); if (!deliverTo.ok) errors.push('納品先は120字まで');
  const dueOn = input.dueOn == null || input.dueOn === '' ? null : isDate(input.dueOn) ? input.dueOn : undefined; if (dueOn === undefined) errors.push('納期を確かめてください');
  const note = optional(input.note, 1000);
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  if (!rawLines.length) errors.push('明細を1行以上入れてください');
  const lines = rawLines.map((line, index) => {
    const item = text(line.item, 120);
    const qty = intIn(line.qty, 1, 100000000);
    const unitPriceX100 = priceToX100(line.unitPrice);
    const spec = optional(line.spec, 500);
    if (!item || !qty || unitPriceX100 == null || !spec.ok) errors.push(`${index + 1}行目: 品目・数量・単価（小数2桁まで）を確かめてください`);
    const amount = qty && unitPriceX100 != null ? lineAmount(qty, unitPriceX100) : null;
    if (amount != null && !Number.isInteger(amount)) errors.push(`${index + 1}行目: 数量×単価が1円で割り切れません（単価を直してください）`);
    return {lineNo: index + 1, item, spec: spec.value, qty, unitPriceX100, amountExTaxYen: amount};
  });
  if (errors.length) return {ok: false, errors};
  return {ok: true, value: {poKind, partnerId, partnerLabel: partnerLabel.value, deliverTo: deliverTo.value, dueOn, note: note.value, lines}};
}
