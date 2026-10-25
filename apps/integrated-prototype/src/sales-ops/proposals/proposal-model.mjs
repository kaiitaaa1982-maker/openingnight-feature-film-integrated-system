// 営業管理の最初の切れの純関数（会社ルートの plans/2026-10-22-folder-eigyo.md の表5〜8・解禁月のページ・提案の振り返り）。
// - 入力の確かめ（1回の提案・結果と自己評価・接点の言葉）と、解禁月のページ・提案の振り返り・要因の集計・CSV の組み立て。
// - 状態は保存せず、読むたびに導く。件数が5未満の組は率を出さない（取引先が少ないので、率より事例で見る）。
// - node:* を import しない（Worker と画面でも動く）。
// 比の bp は整数の式で（分子×10000÷分母を切り捨て。docs/rules/money.md）
import {ratioBps} from '../../revenue/yojitsu/money-yojitsu.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;

// to − from の日数（どちらも YYYY-MM-DD の暦日）。形式が違えば null（sales-ops/pipeline-routes.mjs の daysBetween と同じ。計算の役は受け口の部品を読まない）
export function daysBetween(from, to) {
  const a = DATE_PARTS.exec(String(from ?? ''));
  const b = DATE_PARTS.exec(String(to ?? ''));
  if (!a || !b) return null;
  return (Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / DAY_MS;
}

// 「50」「33.33」「50%」「５０」→ bp（整数）。0〜100・小数は2桁まで。文字のまま桁を組み立て、小数の掛け算と丸めを使わない（docs/rules/money.md）
export function percentToBps(text) {
  const raw = String(text ?? '').normalize('NFKC').replace(/[%\s]/g, '');
  if (!raw) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) throw new Error('料率は0〜100の%で、小数は2桁までにしてください');
  const [whole, fraction = ''] = raw.split('.');
  const bps = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (bps > 10000) throw new Error('料率は0〜100の%で、小数は2桁までにしてください');
  return bps;
}

export const SETTLEMENT_METHODS = Object.freeze({unverified: '未確認', FLAT: 'FLAT（固定額）', MG: 'MG', RS: 'RS（料率）', other: 'その他'});
export const EXCLUSIVITY = Object.freeze({unknown: '未確認', exclusive: '独占', nonexclusive: '非独占'});
export const OUTCOMES = Object.freeze({adopted: '採用', adopted_changed: '条件を変えて採用', rejected: '不採用', no_answer: '返事なし', withdrawn: '取り下げ'});
export const ADOPTED = Object.freeze(['adopted', 'adopted_changed']);
export const FACTORS = Object.freeze({material: '資料', price: '金額', term: '期間', timing: 'タイミング（解禁まで）', exclusivity: '独占', relationship: '関係', title_strength: '作品の力', competition: '他社の状況', other: 'その他'});
export const NOTE_KINDS = Object.freeze({fact: '事実', their_words: '相手の言葉', my_read: '自分の読み'});
export const MIN_RATE_COUNT = 5;

// 解禁月のページの流通のまとまり（問い9 A。6列）。ウィンドウの種別の family と type_key から決める
export const LAUNCH_GROUPS = Object.freeze([
  Object.freeze({key: 'pf', label: '配信プラットフォーム'}),
  Object.freeze({key: 'tv', label: '放送局'}),
  Object.freeze({key: 'cn', label: '劇場'}),
  Object.freeze({key: 'hv', label: '業務用VOD'}),
  Object.freeze({key: 'os', label: '海外'}),
  Object.freeze({key: 'pk', label: 'パッケージ'}),
]);

export function launchGroupOf({family, type_key: typeKey} = {}) {
  if (typeKey === 'business_vod') return 'hv';
  return {digital: 'pf', broadcast: 'tv', theatrical: 'cn', overseas: 'os', package: 'pk'}[family] || null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function text(value, label, {max = 2000, required = false} = {}) {
  const trimmed = value == null ? '' : String(value).trim();
  if (!trimmed) {
    if (required) throw new Error(`${label}を入れてください`);
    return null;
  }
  if (trimmed.length > max) throw new Error(`${label}は${max}文字以内にしてください`);
  return trimmed;
}

function date(value, label, {required = false} = {}) {
  const trimmed = value == null ? '' : String(value).trim();
  if (!trimmed) {
    if (required) throw new Error(`${label}を入れてください`);
    return null;
  }
  if (!DATE_RE.test(trimmed) || Number.isNaN(Date.parse(`${trimmed}T00:00:00Z`))) throw new Error(`${label}は YYYY-MM-DD の日付で入れてください`);
  return trimmed;
}

function whole(value, label, {min, max}) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,，円\s]/g, ''));
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}は${min}〜${max}の整数で入れてください`);
  return n;
}

function idOf(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label}を選んでください`);
  return n;
}

function oneOf(value, domain, label, fallback) {
  const key = value == null || value === '' ? fallback : String(value);
  if (!Object.hasOwn(domain, key)) throw new Error(`${label}の値が正しくありません`);
  return key;
}

// 1回の提案（表5）。料率は % で受け取り bps にする（50 → 5000）。結んだウィンドウは ID の配列
export function normalizeProposalInput(input = {}) {
  const settlementMethod = oneOf(input.settlementMethod, SETTLEMENT_METHODS, '精算の方法', 'unverified');
  const amountExTax = whole(input.amountExTax, '金額（税抜）', {min: 0, max: 1_000_000_000_000});
  const rateBps = percentToBps(input.ratePercent);
  if (settlementMethod === 'RS' && amountExTax != null) throw new Error('RS（料率）の提案には金額を入れず、料率だけを入れてください');
  if (settlementMethod === 'FLAT' && rateBps != null) throw new Error('FLAT（固定額）の提案には料率を入れないでください');
  const termStart = date(input.termStart, '期間の開始');
  const termEnd = date(input.termEnd, '期間の終了');
  if (termStart && termEnd && termEnd < termStart) throw new Error('期間の終了は開始より後にしてください');
  const windowIds = [...new Set((Array.isArray(input.windowIds) ? input.windowIds : []).map((value) => idOf(value, 'ウィンドウ')))];
  return {
    opportunityId: idOf(input.opportunityId, '営業案件'),
    proposedOn: date(input.proposedOn, '提案日', {required: true}),
    settlementMethod, amountExTax, rateBps, termStart, termEnd,
    exclusivity: oneOf(input.exclusivity, EXCLUSIVITY, '独占', 'unknown'),
    materialSnapshotId: input.materialSnapshotId == null || input.materialSnapshotId === '' ? null : idOf(input.materialSnapshotId, '営業資料の版'),
    pitchNote: text(input.pitchNote, '提案の内容'),
    windowIds,
  };
}

// 結果と自己評価（表6・7）。要因は {factor: 'plus'|'minus'} か [{factor, effect}]
export function normalizeReviewInput(input = {}) {
  const outcome = oneOf(input.outcome, OUTCOMES, '結果');
  const score = whole(input.score, '点数', {min: 1, max: 5});
  if (score == null) throw new Error('点数（1〜5）を入れてください');
  const rawFactors = Array.isArray(input.factors) ? input.factors : Object.entries(input.factors || {}).map(([factor, effect]) => ({factor, effect}));
  const factors = [];
  const seen = new Set();
  for (const item of rawFactors) {
    if (!item || item.effect == null || item.effect === '') continue;
    const factor = oneOf(item.factor, FACTORS, '要因');
    if (!['plus', 'minus'].includes(item.effect)) throw new Error('要因はプラスかマイナスを選んでください');
    if (seen.has(factor)) throw new Error(`要因「${FACTORS[factor]}」が2回あります`);
    seen.add(factor);
    factors.push({factor, effect: item.effect});
  }
  const agreementId = input.agreementId == null || input.agreementId === '' ? null : idOf(input.agreementId, '契約');
  if (agreementId && !ADOPTED.includes(outcome)) throw new Error('契約を結べるのは、採用か条件を変えて採用のときだけです');
  return {
    reviewedOn: date(input.reviewedOn, '評価した日', {required: true}),
    outcome, score, agreementId, factors,
    worked: text(input.worked, '効いたこと'),
    missed: text(input.missed, '足りなかったこと'),
  };
}

// 接点の言葉（表8）。温度は −2〜+2 か空
export function normalizeNoteInput(input = {}) {
  return {
    activityId: idOf(input.activityId, '営業活動'),
    noteKind: oneOf(input.noteKind, NOTE_KINDS, '言葉の種類'),
    body: text(input.body, '言葉', {required: true}),
    tone: whole(input.tone, '温度', {min: -2, max: 2}),
  };
}

export function normalizeMonth(value, fallback) {
  const month = value == null || value === '' ? fallback : String(value).trim();
  if (!MONTH_RE.test(month)) throw new Error('月は YYYY-MM で入れてください');
  return month;
}

// その窓口の開始が「日」か「月」まで決まっていて、その月に入るか
export function startsInMonth(version, month) {
  const start = version?.start_on ? String(version.start_on) : '';
  if (!start || !['day', 'month'].includes(version.date_precision)) return false;
  return start.slice(0, 7) === month;
}

const dayOf = (version) => (version.date_precision === 'day' && version.start_on ? Number(String(version.start_on).slice(8, 10)) : null);

// 評価は最新の行が今の評価（ID の大きいほう）
export function latestReviewByProposal(reviews = []) {
  const latest = new Map();
  for (const review of reviews) {
    const current = latest.get(review.proposal_id);
    if (!current || review.id > current.id) latest.set(review.proposal_id, review);
  }
  return latest;
}

// 解禁月のページ（問い9 A）。行＝その月に始まる窓口を持つ作品。マス＝流通のまとまり
// cell.state: done（採用あり）・proposed（提案あり・採用なし）・urgent（解禁まで30日以内で提案なし）・none（提案なし）・blocked（取り下げた窓口だけ）
export function buildLaunchMonth({month, asOf, works = [], windows = [], proposals = [], proposalWindows = [], reviews = [], opportunities = []}) {
  const latest = latestReviewByProposal(reviews);
  const partnerOfOpportunity = new Map(opportunities.map((row) => [row.id, row.partner_id]));
  const proposalById = new Map(proposals.map((row) => [row.id, row]));
  const proposalsByWindow = new Map();
  for (const link of proposalWindows) {
    const list = proposalsByWindow.get(link.window_id) || [];
    const proposal = proposalById.get(link.proposal_id);
    if (proposal) list.push(proposal);
    proposalsByWindow.set(link.window_id, list);
  }
  const workById = new Map(works.map((work) => [work.id, work]));
  const rows = new Map();
  for (const window of windows) {
    if (window.status === 'withdrawn' || !startsInMonth(window, month)) continue;
    const group = launchGroupOf(window);
    const work = workById.get(window.work_id);
    if (!group || !work) continue;
    const row = rows.get(work.id) || {workId: work.id, code: work.code, title: work.title, cells: {}};
    const cell = row.cells[group] || {group, windows: [], partners: new Set(), proposals: 0, adopted: 0, earliestDay: null, firstStart: null};
    cell.windows.push({windowId: window.window_id ?? window.id, typeLabel: window.type_label, startOn: window.start_on, status: window.status});
    const day = dayOf(window);
    if (day != null && (cell.earliestDay == null || day < cell.earliestDay)) cell.earliestDay = day;
    if (window.start_on && (!cell.firstStart || String(window.start_on) < cell.firstStart)) cell.firstStart = String(window.start_on);
    for (const proposal of proposalsByWindow.get(window.window_id ?? window.id) || []) {
      cell.proposals += 1;
      const partnerId = partnerOfOpportunity.get(proposal.opportunity_id);
      if (partnerId) cell.partners.add(partnerId);
      if (ADOPTED.includes(latest.get(proposal.id)?.outcome)) cell.adopted += 1;
    }
    row.cells[group] = cell;
    rows.set(work.id, row);
  }
  const out = [...rows.values()].sort((a, b) => String(a.code).localeCompare(String(b.code))).map((row) => ({
    ...row,
    cells: Object.fromEntries(Object.entries(row.cells).map(([key, cell]) => {
      const until = cell.firstStart && cell.firstStart.length === 10 ? daysBetween(asOf, cell.firstStart) : null;
      const state = cell.adopted ? 'done' : cell.proposals ? 'proposed' : until != null && until <= 30 ? 'urgent' : 'none';
      return [key, {group: key, windows: cell.windows, typeCount: cell.windows.length, earliestDay: cell.earliestDay, partnerCount: cell.partners.size, proposals: cell.proposals, adopted: cell.adopted, daysUntil: until, state}];
    })),
  }));
  const cells = out.flatMap((row) => Object.values(row.cells));
  return {month, asOf, groups: LAUNCH_GROUPS, rows: out, summary: {works: out.length, proposals: cells.reduce((n, cell) => n + cell.proposals, 0), urgent: cells.filter((cell) => cell.state === 'urgent').length}};
}

// 提案の振り返り（問い10・11・12）。1提案＝1行に、結んだ窓口・解禁日までの日数・最新の評価と要因・直前の相手の言葉を並べる
export function buildProposalReview({proposals = [], proposalWindows = [], windows = [], reviews = [], factors = [], opportunities = [], activities = [], notes = [], works = []}) {
  const latest = latestReviewByProposal(reviews);
  const factorsByReview = new Map();
  for (const factor of factors) factorsByReview.set(factor.review_id, [...(factorsByReview.get(factor.review_id) || []), factor]);
  const windowById = new Map(windows.map((row) => [row.window_id ?? row.id, row]));
  const windowsByProposal = new Map();
  for (const link of proposalWindows) windowsByProposal.set(link.proposal_id, [...(windowsByProposal.get(link.proposal_id) || []), windowById.get(link.window_id)].filter(Boolean));
  const opportunityById = new Map(opportunities.map((row) => [row.id, row]));
  const workById = new Map(works.map((row) => [row.id, row]));
  const activityById = new Map(activities.map((row) => [row.id, row]));
  const wordsByOpportunity = new Map();
  for (const note of notes) {
    if (note.note_kind !== 'their_words') continue;
    const activity = activityById.get(note.activity_id);
    if (!activity) continue;
    wordsByOpportunity.set(activity.opportunity_id, [...(wordsByOpportunity.get(activity.opportunity_id) || []), {...note, occurred_on: activity.occurred_on}]);
  }
  const rows = proposals.map((proposal) => {
    const opportunity = opportunityById.get(proposal.opportunity_id) || {};
    const linked = windowsByProposal.get(proposal.id) || [];
    const starts = linked.map((row) => row.start_on).filter((value) => value && String(value).length === 10).sort();
    const review = latest.get(proposal.id) || null;
    const until = review?.reviewed_on || proposal.proposed_on;
    const words = (wordsByOpportunity.get(proposal.opportunity_id) || []).filter((note) => String(note.occurred_on) <= String(until)).sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on)) || b.id - a.id)[0] || null;
    const work = workById.get(opportunity.work_id) || {};
    return {
      id: proposal.id, opportunityId: proposal.opportunity_id, opportunityName: opportunity.name || null,
      partnerId: opportunity.partner_id || null, partnerName: opportunity.partner_name || null,
      workId: opportunity.work_id || null, workCode: work.code || null, workTitle: work.title || null,
      proposedOn: proposal.proposed_on, settlementMethod: proposal.settlement_method, amountExTax: proposal.amount_ex_tax, rateBps: proposal.rate_bps,
      termStart: proposal.term_start, termEnd: proposal.term_end, exclusivity: proposal.exclusivity, materialSnapshotId: proposal.material_snapshot_id, pitchNote: proposal.pitch_note,
      windows: linked.map((row) => ({windowId: row.window_id ?? row.id, typeLabel: row.type_label, startOn: row.start_on})),
      leadDays: starts.length ? daysBetween(proposal.proposed_on, starts[0]) : null,
      review: review ? {id: review.id, reviewedOn: review.reviewed_on, outcome: review.outcome, score: review.score, worked: review.worked, missed: review.missed, agreementId: review.agreement_id,
        factors: (factorsByReview.get(review.id) || []).map(({factor, effect}) => ({factor, effect}))} : null,
      lastWords: words ? {body: words.body, tone: words.tone, occurredOn: words.occurred_on} : null,
    };
  }).sort((a, b) => String(b.proposedOn).localeCompare(String(a.proposedOn)) || b.id - a.id);
  return {rows, factorTally: tallyFactors(rows)};
}

// 要因の集計。採用（条件を変えた採用を含む）と不採用（不採用・返事なし）ごとに、プラスとマイナスの件数。件数が5未満は率を出さない
export function tallyFactors(rows = []) {
  return Object.keys(FACTORS).map((factor) => {
    const tally = {factor, label: FACTORS[factor], adoptedPlus: 0, adoptedMinus: 0, rejectedPlus: 0, rejectedMinus: 0, proposalIds: []};
    for (const row of rows) {
      const hit = row.review?.factors.find((item) => item.factor === factor);
      if (!hit) continue;
      const adopted = ADOPTED.includes(row.review.outcome);
      const rejected = ['rejected', 'no_answer'].includes(row.review.outcome);
      if (!adopted && !rejected) continue;
      tally[`${adopted ? 'adopted' : 'rejected'}${hit.effect === 'plus' ? 'Plus' : 'Minus'}`] += 1;
      tally.proposalIds.push(row.id);
    }
    const n = tally.proposalIds.length;
    const adoptedCount = tally.adoptedPlus + tally.adoptedMinus;
    return {...tally, count: n, enough: n >= MIN_RATE_COUNT, adoptedRateBps: n >= MIN_RATE_COUNT ? ratioBps(adoptedCount, n) : null};
  }).filter((tally) => tally.count > 0);
}

const csvCell = (value) => {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const PROPOSAL_CSV_HEADERS = Object.freeze(['提案ID', '提案日', '作品コード', '作品', '取引先', '営業案件', '窓口', '解禁日', '解禁まで（日）', '精算', '金額（税抜）', '料率（%）', '期間の開始', '期間の終了', '独占', '営業資料の版', '提案の内容', '結果', '点数', '効いた要因（+）', '効いた要因（−）', '効いたこと', '足りなかったこと', '直前の相手の言葉', '温度']);

// つないだ表（提案1行）を CSV にする。先頭に BOM を付け、Excel で文字化けしないようにする
export function proposalCsv(rows = []) {
  const lines = [PROPOSAL_CSV_HEADERS.join(',')];
  for (const row of rows) {
    const plus = row.review?.factors.filter((f) => f.effect === 'plus').map((f) => FACTORS[f.factor]).join('・') || '';
    const minus = row.review?.factors.filter((f) => f.effect === 'minus').map((f) => FACTORS[f.factor]).join('・') || '';
    lines.push([
      row.id, row.proposedOn, row.workCode, row.workTitle, row.partnerName, row.opportunityName,
      row.windows.map((w) => w.typeLabel).join('・'), row.windows.map((w) => w.startOn).filter(Boolean).join('・'), row.leadDays,
      SETTLEMENT_METHODS[row.settlementMethod] || row.settlementMethod, row.amountExTax, row.rateBps == null ? '' : (row.rateBps / 100).toString(),
      row.termStart, row.termEnd, EXCLUSIVITY[row.exclusivity] || row.exclusivity, row.materialSnapshotId, row.pitchNote,
      row.review ? OUTCOMES[row.review.outcome] : '', row.review?.score, plus, minus, row.review?.worked, row.review?.missed,
      row.lastWords?.body, row.lastWords?.tone,
    ].map(csvCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
