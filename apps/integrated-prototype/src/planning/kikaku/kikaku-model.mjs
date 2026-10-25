// 企画の計算と判定（純関数。DB を読まない）。会社ルートの plans/2026-10-22-folder-kikaku.md、要件 docs/requirements/planning/kikaku.md。
// - 売上試算の3段の型（表紙 → 流通の大別 → 流通の詳細）の計算。式は会社ルートの ORG/企画/_build/build_shisan_3dan.py の xlsx と同じ:
//   売上＝単価×数量（または固定額）、権利元収入＝ROUND(売上×(1−先方の取り分)×(1−手数料−原作−監督・脚本の印税))−製造単価×数量、
//   作り手への印税＝ROUND(売上×(1−先方の取り分)×監督・脚本の印税率)。月あたり＝ROUND(権利元収入÷回収の月数)を開始月から月数だけ入れる
// - 判断までの4つの揃い（企画書の提出版・試算の版・予算書の確定版・判断）と、揃い終えた日（doneOn）
// - 企画書の準備ボード（32枚の型のページごとに、要る事実が揃ったか）
// 金額は整数の円。率は bp（10000＝100%）。丸めは money-allocation の divideHalfUp（0 から遠い方へ。Excel の ROUND と同じ）。導出値は保存しない
import {divideHalfUp} from '../../money-allocation.mjs';

export const SCENARIOS = Object.freeze(['even', 'good', 'max']);
export const SCENARIO_LABELS = Object.freeze({even: 'even', good: 'good', max: 'MAX'});
export const GROUPS = Object.freeze(['劇場', '配信', '放送', 'パッケージ', '海外', '商品化']);

// 販売の型と既定の率（試算の版を型から作るときの初期値。版ごとに直せる）
export const TRIAL_TYPES = Object.freeze([
  {code: 'THEA', label: '劇場配給', group: '劇場', shareBps: 5000, feeBps: 2000, originalBps: 0, creatorBps: 0, unitCostYen: 0},
  {code: 'EVNT', label: 'イベント上映', group: '劇場', shareBps: 3000, feeBps: 2000, originalBps: 0, creatorBps: 0, unitCostYen: 0},
  {code: 'PVOD', label: '配信 P-VOD', group: '配信', shareBps: 5000, feeBps: 1000, originalBps: 350, creatorBps: 200, unitCostYen: 0},
  {code: 'EST', label: '配信 EST', group: '配信', shareBps: 5000, feeBps: 1000, originalBps: 350, creatorBps: 200, unitCostYen: 0},
  {code: 'TVOD', label: '配信 T-VOD', group: '配信', shareBps: 5000, feeBps: 1000, originalBps: 350, creatorBps: 200, unitCostYen: 0},
  {code: 'SVOD', label: '配信 S-VOD', group: '配信', shareBps: 0, feeBps: 1000, originalBps: 350, creatorBps: 200, unitCostYen: 0},
  {code: 'AVOD', label: '配信 A-VOD', group: '配信', shareBps: 0, feeBps: 1000, originalBps: 350, creatorBps: 200, unitCostYen: 0},
  {code: 'BIZ', label: '業務用（ホテルなど）', group: '配信', shareBps: 0, feeBps: 1000, originalBps: 350, creatorBps: 200, unitCostYen: 0},
  {code: 'BCST', label: '放送', group: '放送', shareBps: 0, feeBps: 1000, originalBps: 400, creatorBps: 800, unitCostYen: 0},
  {code: 'SELL', label: 'パッケージ セル', group: 'パッケージ', shareBps: 3700, feeBps: 3000, originalBps: 335, creatorBps: 350, unitCostYen: 600},
  {code: 'RENT', label: 'パッケージ レンタル', group: 'パッケージ', shareBps: 0, feeBps: 3000, originalBps: 335, creatorBps: 670, unitCostYen: 250},
  {code: 'OVS', label: '海外', group: '海外', shareBps: 0, feeBps: 3000, originalBps: 500, creatorBps: 700, unitCostYen: 0},
  {code: 'GOOD', label: 'グッズ・商品化', group: '商品化', shareBps: 3000, feeBps: 2500, originalBps: 1000, creatorBps: 0, unitCostYen: 0},
]);
export const TYPE_CODES = Object.freeze(TRIAL_TYPES.map((t) => t.code));
const TYPE = new Map(TRIAL_TYPES.map((t) => [t.code, t]));

export const PROFILE_ORIGINS = Object.freeze({source: '原作', cast: 'キャスト', concept: 'コンセプト', sequel: '続編', other: 'その他'});
export const PEOPLE_ROLES = Object.freeze({director: '監督', writer: '脚本', lead: '主演', support: '助演', producer: 'プロデューサー', studio: '制作会社', other: 'その他'});
export const PEOPLE_STATUSES = Object.freeze({candidate: '候補', negotiating: '交渉中', confirmed: '確定'});
export const MATERIAL_KINDS = Object.freeze({similar: '類似作', market: '市場', own_record: '自社の実績', cast: 'キャスト', director: '監督', world: '世界観の文献',
  story: '物語の構造', title: '題名', report: '申告', other: 'その他'});
export const LABELS = Object.freeze({confirmed: '確', probable: '推', unknown: '不明'});
export const FACT_TARGETS = Object.freeze({deck_text: '企画書の文', trial: '試算の前提', team: '体制の候補', case: '事例'});

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const MAX_YEN = 1_000_000_000_000;

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${String((t - (t % 12)) / 12).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`;
}
export const monthDiff = (a, b) => {
  const [ya, ma] = a.split('-').map(Number); const [yb, mb] = b.split('-').map(Number);
  return (yb * 12 + mb) - (ya * 12 + ma);
};

// 1行の計算。rate は {shareBps, feeBps, originalBps, creatorBps, unitCostYen}
export function computeLine(line, rate) {
  const out = {};
  for (const s of SCENARIOS) {
    const v = Number(line[`${s}Value`] ?? 0);
    const sale = line.calc === 'fixed' ? v : Number(line.unitPriceYen) * v;
    const net = BigInt(sale) * BigInt(10000 - rate.shareBps);
    const creator = divideHalfUp(net * BigInt(rate.creatorBps), 100000000n);
    const income = divideHalfUp(net * BigInt(10000 - rate.feeBps - rate.originalBps - rate.creatorBps), 100000000n) - (line.calc === 'fixed' ? 0 : rate.unitCostYen * v);
    const monthly = line.months > 0 ? divideHalfUp(income, line.months) : 0;
    out[s] = {sale, creator, income, monthly};
  }
  return out;
}

// 試算の版の計算。rates は販売の型ごとの行、lines は詳細の行、investments は出資の行、costTotalYen は製作費、firstMonth は起点の月
export function computeTrial({costTotalYen, firstMonth, rates = [], lines = [], investments = []}) {
  const rateOf = new Map(rates.map((r) => [r.typeCode, r]));
  const rows = lines.map((line) => {
    const rate = rateOf.get(line.typeCode) ?? TYPE.get(line.typeCode);
    return {...line, group: TYPE.get(line.typeCode)?.group ?? 'その他', endMonth: addMonths(line.startMonth, line.months), result: computeLine(line, rate)};
  });
  const groups = GROUPS.map((group) => {
    const mine = rows.filter((r) => r.group === group);
    const by = {};
    for (const s of SCENARIOS) {
      const sale = mine.reduce((a, r) => a + r.result[s].sale, 0);
      const creator = mine.reduce((a, r) => a + r.result[s].creator, 0);
      const income = mine.reduce((a, r) => a + r.result[s].income, 0);
      by[s] = {sale, deduction: sale - creator - income, creator, income};
    }
    return {group, lines: mine.length, previousSalesYen: mine.reduce((a, r) => a + (r.previousSalesYen ?? 0), 0), ...by};
  });
  // 回収スケジュール: 起点の月から、最後の窓口の終わりか出資の月の遅い方まで（36か月は下回らない）
  const lastMonth = [...rows.map((r) => r.endMonth), ...investments.map((i) => addMonths(i.month, 1))].reduce((a, m) => (m > a ? m : a), addMonths(firstMonth, 36));
  const span = Math.max(1, monthDiff(firstMonth, lastMonth));
  const months = Array.from({length: span}, (_, i) => addMonths(firstMonth, i));
  const lastInvestment = investments.reduce((a, i) => (i.month > a ? i.month : a), firstMonth);
  const totals = {};
  for (const s of SCENARIOS) {
    const income = groups.reduce((a, g) => a + g[s].income, 0);
    const creator = groups.reduce((a, g) => a + g[s].creator, 0);
    let cum = 0;
    let breakEvenMonth = null;
    const schedule = months.map((m) => {
      const inflow = rows.reduce((a, r) => a + (r.startMonth <= m && m < r.endMonth ? r.result[s].monthly : 0), 0);
      const outflow = investments.reduce((a, i) => a + (i.month === m ? Number(i.amountYen) : 0), 0);
      cum += inflow - outflow;
      if (breakEvenMonth === null && m >= lastInvestment && cum >= 0 && costTotalYen > 0) breakEvenMonth = m;
      return {month: m, inflow, outflow, cumulative: cum};
    });
    totals[s] = {income, creator, profit: income - costTotalYen, recoveryBps: costTotalYen > 0 ? divideHalfUp(BigInt(income) * 10000n, costTotalYen) : null,
      breakEvenMonth, schedule};
  }
  return {rows, groups, totals, months};
}

// 試算の版の入力をそろえる（受け口が呼ぶ）。errors は {field, message}
export function normalizeTrialInput(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const costTotalYen = src.costTotalYen;
  if (!isInt(costTotalYen, 0, MAX_YEN)) errors.push({field: 'costTotalYen', message: '製作費は0以上の整数の円で入れてください'});
  const firstMonth = src.firstMonth;
  if (typeof firstMonth !== 'string' || !MONTH.test(firstMonth)) errors.push({field: 'firstMonth', message: '起点の月は YYYY-MM で入れてください'});
  const reason = typeof src.reason === 'string' ? src.reason.trim() : '';
  if (!reason || reason.length > 1000) errors.push({field: 'reason', message: '版の理由を1〜1000字で書いてください'});
  const rates = Array.isArray(src.rates) ? src.rates : [];
  const seen = new Set();
  rates.forEach((r, i) => {
    if (!TYPE_CODES.includes(r?.typeCode) || seen.has(r.typeCode)) errors.push({field: `rates.${i}.typeCode`, message: '販売の型が読めないか、重なっています'});
    seen.add(r?.typeCode);
    for (const k of ['shareBps', 'feeBps', 'originalBps', 'creatorBps']) if (!isInt(r?.[k], 0, 10000)) errors.push({field: `rates.${i}.${k}`, message: '率は 0〜10000 の bp で入れてください'});
    if (!isInt(r?.unitCostYen, 0, 100_000_000)) errors.push({field: `rates.${i}.unitCostYen`, message: '製造単価は0以上の整数の円で入れてください'});
    if ((r?.feeBps ?? 0) + (r?.originalBps ?? 0) + (r?.creatorBps ?? 0) > 10000) errors.push({field: `rates.${i}`, message: '手数料と印税の率の和が 100% を超えています'});
  });
  const lines = Array.isArray(src.lines) ? src.lines : [];
  if (lines.length > 500) errors.push({field: 'lines', message: '詳細の行は500行までです'});
  lines.forEach((l, i) => {
    if (!TYPE_CODES.includes(l?.typeCode)) errors.push({field: `lines.${i}.typeCode`, message: '販売の型が読めません'});
    if (typeof l?.partnerName !== 'string' || !l.partnerName.trim() || l.partnerName.length > 200) errors.push({field: `lines.${i}.partnerName`, message: '取引先を1〜200字で入れてください'});
    if (typeof l?.startMonth !== 'string' || !MONTH.test(l.startMonth)) errors.push({field: `lines.${i}.startMonth`, message: '開始月は YYYY-MM で入れてください'});
    if (!isInt(l?.months, 1, 120)) errors.push({field: `lines.${i}.months`, message: '回収の月数は1〜120で入れてください'});
    if (!['unit', 'fixed'].includes(l?.calc)) errors.push({field: `lines.${i}.calc`, message: '計算は単価×数量か固定額です'});
    if (!isInt(l?.unitPriceYen, 0, 100_000_000) || (l?.calc === 'unit' && l.unitPriceYen <= 0)) errors.push({field: `lines.${i}.unitPriceYen`, message: '単価×数量の行は単価を1円以上で入れてください'});
    for (const s of SCENARIOS) if (!isInt(l?.[`${s}Value`], 0, MAX_YEN)) errors.push({field: `lines.${i}.${s}Value`, message: '数量か額は0以上の整数で入れてください'});
  });
  const investments = Array.isArray(src.investments) ? src.investments : [];
  investments.forEach((v, i) => {
    if (typeof v?.month !== 'string' || !MONTH.test(v.month)) errors.push({field: `investments.${i}.month`, message: '出資の月は YYYY-MM で入れてください'});
    if (!isInt(v?.amountYen, 1, MAX_YEN)) errors.push({field: `investments.${i}.amountYen`, message: '出資の額は1円以上の整数で入れてください'});
  });
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return {ok: errors.length === 0, errors, value: {costTotalYen, firstMonth, reason,
    rates: rates.map((r) => ({typeCode: r.typeCode, shareBps: r.shareBps, feeBps: r.feeBps, originalBps: r.originalBps, creatorBps: r.creatorBps, unitCostYen: r.unitCostYen, source: text(r.source, 200)})),
    lines: lines.map((l, i) => ({lineNo: i + 1, typeCode: l.typeCode, partnerName: l.partnerName?.trim(), windowLabel: text(l.windowLabel, 100), startMonth: l.startMonth, months: l.months,
      calc: l.calc, unitPriceYen: l.calc === 'fixed' ? 0 : l.unitPriceYen, evenValue: l.evenValue, goodValue: l.goodValue, maxValue: l.maxValue, source: text(l.source, 200),
      previousSalesYen: isInt(l.previousSalesYen, 0, MAX_YEN) ? l.previousSalesYen : null})),
    investments: investments.map((v, i) => ({seq: i + 1, month: v.month, amountYen: v.amountYen}))}};
}

// 型から作る試算の版の初期値（架空の例の行を2つ。率は既定値）
export function templateTrial({costTotalYen = 0, firstMonth}) {
  return {costTotalYen, firstMonth, reason: '型から作った',
    rates: TRIAL_TYPES.map(({code, shareBps, feeBps, originalBps, creatorBps, unitCostYen}) => ({typeCode: code, shareBps, feeBps, originalBps, creatorBps, unitCostYen, source: '既定の率'})),
    lines: [
      {typeCode: 'SVOD', partnerName: '配信A（例）', windowLabel: '先行', startMonth: addMonths(firstMonth, 6), months: 1, calc: 'fixed', unitPriceYen: 0, evenValue: 0, goodValue: 0, maxValue: 0, source: '自社想定'},
      {typeCode: 'TVOD', partnerName: '配信B（例）', windowLabel: '開放', startMonth: addMonths(firstMonth, 6), months: 12, calc: 'unit', unitPriceYen: 500, evenValue: 0, goodValue: 0, maxValue: 0, source: '自社想定'},
    ],
    investments: costTotalYen > 0 ? [{month: firstMonth, amountYen: costTotalYen}] : []};
}

// 判断までの4つの揃い。documents は企画書の結び付き（role）、trialVersions は版、budgetFixedTotal は予算書の確定版の総合計（無ければ null）、
// approvals は稟議の版（status）、stage は相手の段階のコード。日付は doneOn の材料
export function readiness({documents = [], trialVersions = [], budgetFixed = null, approvals = [], stageCode = null, stageEnteredOn = null}) {
  const submitted = documents.filter((d) => d.kind === 'deck' && d.role === 'submitted').sort((a, b) => (a.submittedOn < b.submittedOn ? 1 : -1))[0] ?? null;
  const trial = trialVersions[trialVersions.length - 1] ?? null;
  const decided = approvals.filter((a) => ['approved', 'rejected', 'paid'].includes(a.status)).sort((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null;
  const stageDone = ['contracted', 'declined'].includes(stageCode);
  const marks = [
    {key: 'deck', label: '企', name: '企画書の提出版', done: Boolean(submitted), on: submitted?.submittedOn ?? null},
    {key: 'trial', label: '試', name: '試算', done: Boolean(trial), on: trial?.createdAt?.slice(0, 10) ?? null},
    {key: 'budget', label: '予', name: '予算書', done: Boolean(budgetFixed), on: budgetFixed?.fixedOn ?? null},
    {key: 'decision', label: '判', name: '判断', done: Boolean(decided) || stageDone, on: decided?.at?.slice(0, 10) ?? (stageDone ? stageEnteredOn : null)},
  ];
  const done = marks.filter((m) => m.done).length;
  const missing = marks.filter((m) => !m.done).map((m) => m.name);
  const declined = stageCode === 'declined';
  const doneOn = done === 4 ? marks.map((m) => m.on).filter(Boolean).sort().at(-1) ?? null : null;
  const state = declined ? 'declined' : done === 4 ? 'done' : done === 0 ? 'not_started' : 'in_progress';
  const verdict = declined ? '見送り' : done === 4 ? '✓ 判断済み' : `! 残り${missing.length}: ${missing.join('・')}`;
  return {marks, done, total: 4, missing, state, verdict, doneOn};
}

// 企画書の32枚の型（見本の章立て）。need はそのテーマに要る事実（無ければ必須なし）。auto は表紙・目次・章扉、trial は試算から自動で入るページ
export const DECK_PAGES = Object.freeze([
  [1, '', '表紙', 'auto'], [2, '', '目次', 'auto'], [3, '序', '王道の型', '類似作'], [4, '序', '王道→本作', '類似作'],
  [5, '01', '章扉', 'auto'], [6, '01', '作り方', '製作費の制約'], [7, '01', '実績', '自社の実績'], [8, '01', 'なぜ今か', '市場'], [9, '01', '流通の型', '流通の割合'],
  [10, '02', '章扉', 'auto'], [11, '02', 'シリーズ戦略', 'シリーズの実績'], [12, '02', 'ジャンルの力', '類似作'],
  [13, '03', '章扉', 'auto'], [14, '03', '役者と系譜', 'キャストの過去作'],
  [15, '04', '章扉', 'auto'], [16, '04', '企画意図', '物語の構造'], [17, '04', '主人公', '主人公'], [18, '04', '世界観', '世界観の文献'], [19, '04', '相関図', '相関'],
  [20, '04', '見せ場', '見せ場'], [21, '04', 'テーマ', 'テーマの裏付け'], [22, '04', '各話の型', '物語の構造'],
  [23, '05', '章扉', 'auto'], [24, '05', '製作概要', '製作費の制約'], [25, '05', '監督候補と体制', '監督の実績'],
  [26, '06', '章扉', 'auto'], [27, '06', '売上試算', 'trial'], [28, '06', '回収ライン', 'trial'], [29, '06', '回収の予測', 'trial'], [30, '06', '上積み', '上積みの根拠'],
  [31, '06', '座組', '座組'], [32, '06', 'スケジュール', '日程'],
].map(([no, chapter, theme, need]) => ({no, chapter, theme, need})));

// 事実は前の行に指されていない行（いまの行）だけを数える。state: none 素材も事実も無い／material 素材あり／draft 下書きあり／confirmed 確定／auto 自動
export function currentFacts(facts = []) {
  const replaced = new Set(facts.filter((f) => f.previousId != null).map((f) => Number(f.previousId)));
  return facts.filter((f) => !replaced.has(Number(f.id)));
}
export function parsePages(text) {
  return String(text ?? '').split(',').map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 32);
}
export function deckBoard({facts = [], hasTrial = false, materialCount = 0}) {
  const now = currentFacts(facts);
  const pages = DECK_PAGES.map((p) => {
    const mine = now.filter((f) => parsePages(f.pages).includes(p.no));
    let state;
    if (p.need === 'auto') state = 'auto';
    else if (p.need === 'trial') state = hasTrial ? 'confirmed' : 'none';
    else if (mine.some((f) => f.state === 'human_confirmed')) state = 'confirmed';
    else if (mine.length) state = 'draft';
    else state = 'none';
    const gap = !['auto'].includes(p.need) && state !== 'confirmed';
    return {...p, state, gap, facts: mine.map((f) => Number(f.id)), confirmed: mine.filter((f) => f.state === 'human_confirmed').length, total: mine.length};
  });
  return {pages, gaps: pages.filter((p) => p.gap).length, ready: pages.filter((p) => ['auto', 'confirmed'].includes(p.state)).length,
    counts: {materials: materialCount, drafts: now.filter((f) => f.state === 'ai_draft').length, confirmed: now.filter((f) => f.state === 'human_confirmed').length}};
}

export function normalizeProfileInput(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const text = (field, label, max, required = false) => {
    const v = typeof src[field] === 'string' ? src[field].trim() : '';
    if (!v) { if (required) errors.push({field, message: `${label}を入れてください`}); return null; }
    if (v.length > max) errors.push({field, message: `${label}は${max}字までです`});
    return v;
  };
  const value = {
    workingTitle: text('workingTitle', '作業題', 200, true), origin: src.origin, logline: text('logline', 'ログライン', 1000),
    synopsisShort: text('synopsisShort', 'あらすじ（短）', 1000), synopsisLong: text('synopsisLong', 'あらすじ（長）', 5000), format: text('format', '形式', 100),
    episodeCount: src.episodeCount ?? null, plannedReleaseYear: src.plannedReleaseYear ?? null, submitTo: text('submitTo', '提出先', 200),
    reason: text('reason', '版の理由', 1000, true), people: [],
  };
  if (!(src.origin in PROFILE_ORIGINS)) errors.push({field: 'origin', message: '起点は 原作・キャスト・コンセプト・続編・その他 のどれかです'});
  if (value.episodeCount !== null && !isInt(value.episodeCount, 1, 1000)) errors.push({field: 'episodeCount', message: '本数は1以上の整数です'});
  if (value.plannedReleaseYear !== null && !isInt(value.plannedReleaseYear, 1900, 2200)) errors.push({field: 'plannedReleaseYear', message: '予定の公開年は西暦の整数です'});
  const people = Array.isArray(src.people) ? src.people : [];
  if (people.length > 100) errors.push({field: 'people', message: '体制は100人までです'});
  people.forEach((p, i) => {
    if (!(p?.role in PEOPLE_ROLES)) errors.push({field: `people.${i}.role`, message: '役割が読めません'});
    if (!(p?.status in PEOPLE_STATUSES)) errors.push({field: `people.${i}.status`, message: '状態は 候補・交渉中・確定 のどれかです'});
    if (typeof p?.name !== 'string' || !p.name.trim() || p.name.length > 200) errors.push({field: `people.${i}.name`, message: '名前を1〜200字で入れてください'});
    else value.people.push({position: i + 1, role: p.role, name: p.name.trim(), status: p.status});
  });
  return {ok: errors.length === 0, errors, value};
}

export function normalizeMaterialInput(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  if (!(src.kind in MATERIAL_KINDS)) errors.push({field: 'kind', message: '素材の種類が読めません'});
  if (!(src.label in LABELS)) errors.push({field: 'label', message: '判定は 確・推・不明 のどれかです'});
  const title = typeof src.title === 'string' ? src.title.trim() : '';
  if (!title || title.length > 240) errors.push({field: 'title', message: '素材の名前を1〜240字で入れてください'});
  const url = typeof src.url === 'string' && src.url.trim() ? src.url.trim() : null;
  if (url && !/^https?:\/\//.test(url)) errors.push({field: 'url', message: 'URL は http:// か https:// で始めてください'});
  const acquiredOn = src.acquiredOn || null;
  if (acquiredOn && !DATE.test(acquiredOn)) errors.push({field: 'acquiredOn', message: '取得日は YYYY-MM-DD です'});
  const source = typeof src.source === 'string' && src.source.trim() ? src.source.trim().slice(0, 1000) : null;
  return {ok: errors.length === 0, errors, value: {kind: src.kind, label: src.label, title, url, acquiredOn, source}};
}

export function normalizeFactInput(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const body = typeof src.body === 'string' ? src.body.trim() : '';
  if (!body || body.length > 2000) errors.push({field: 'body', message: '事実を1〜2000字で書いてください'});
  if (!(src.label in LABELS)) errors.push({field: 'label', message: '判定は 確・推・不明 のどれかです'});
  if (!(src.target in FACT_TARGETS)) errors.push({field: 'target', message: '入る先が読めません'});
  const pages = Array.isArray(src.pages) ? [...new Set(src.pages.map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= 32).sort((a, b) => a - b) : [];
  if (!pages.length) errors.push({field: 'pages', message: '結ぶページ（1〜32）を1つ以上選んでください'});
  const valueInt = src.valueInt === null || src.valueInt === undefined || src.valueInt === '' ? null : src.valueInt;
  if (valueInt !== null && !Number.isSafeInteger(valueInt)) errors.push({field: 'valueInt', message: '数値は整数です'});
  const materialId = src.materialId == null || src.materialId === '' ? null : Number(src.materialId);
  if (materialId !== null && !isInt(materialId, 1, Number.MAX_SAFE_INTEGER)) errors.push({field: 'materialId', message: '素材が読めません'});
  return {ok: errors.length === 0, errors, value: {body, label: src.label, target: src.target, pages: pages.join(','), valueInt, materialId}};
}
