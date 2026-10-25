// 指標マスタ（行動指標の計画 段B #9。要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-017・019）の純関数:
// 版の入力の読み取り（役×稼ぎ方×段の対応と、対応の出どころの状態）、有効な版の選び方（最新の version_no の、段の行がそろった版）、
// 読む形（役・稼ぎ方の並びと、段を YOJITSU の3ステップ〈面談・提案・契約〉へ畳む先）、段に設定の行の率と1件の時間を添える形。
// 段の率・1件の時間などの値は設定の行（フェーズ1 #11 の yojitsu_setting_versions）だけに持ち、指標マスタは対応と状態だけを持つ（二重に持たない）。
// 値はここで作らず、設定の行の有効な版（src/revenue/revenue-store.mjs の readEffectiveSettings）を受け取って添えるだけ。無い値は null（0 で埋めない）。
// DB・時刻・環境変数を読まない（docs/rules/architecture.md）。率は整数の bp、時間は100倍の整数（docs/rules/money.md）
import {isCalendarDate, ASSUMPTION_STATUSES} from '../../planning/project/project-model.mjs';

// 役（ontology の「行動の段」の役の列）。D-039 の2つの役（プロデューサー・営業）のうち、営業は相手（権利元・取引先）で2つに分けて持つ。
// group は予実の全体の表示の絞り（全部・プロデューサー・営業。申し送り §画面1）。earningTypes はその役が持つ稼ぎ方（ontology の「行動の段」の表の組。
// プロデューサー＝企画・出資・組成〈制作受託・自社出資・製作委員会〉、営業＝仕入れと売り〈買付・販売委託〉。表に無い組の段は設定の行の読み手に意味が無い）
export const METRIC_ROLES = Object.freeze([
  Object.freeze({code: 'producer', label: 'プロデューサー', group: 'producer', earningTypes: Object.freeze(['contract_work', 'own_investment', 'committee'])}),
  Object.freeze({code: 'sales_sourcing', label: '営業（仕入れ）', group: 'sales', earningTypes: Object.freeze(['acquisition', 'consignment'])}),
  Object.freeze({code: 'sales_selling', label: '営業（売り）', group: 'sales', earningTypes: Object.freeze(['acquisition', 'consignment'])}),
]);
export const METRIC_ROLE_GROUP_LABELS = Object.freeze({producer: 'プロデューサー', sales: '営業'});
// 対応の出どころの状態（計画の K-9。設定の行・既定の売上率の版と同じ4つ）
export const METRIC_STATUSES = ASSUMPTION_STATUSES;
// 1つの版の段の行の数と、役×稼ぎ方の段の数の上限（移行 0017 の CHECK と同じ）
export const MAX_METRIC_STEPS = 200;
export const MAX_CHAIN_STEPS = 20;
// 段に添える設定の変数（移行 0014・0017 の参照表のコード。どちらもステップごとに持つ変数）
export const STEP_SETTING_KEYS = Object.freeze({conversionBps: 'conversion_rate', hoursX100: 'step_hours'});

const isInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const roleIndex = new Map(METRIC_ROLES.map((role, i) => [role.code, i]));

// 段の畳む先（親の無い段はそれ自身。細目は親のステップ）と、畳む先の並び（面談・提案・契約の順）
function stepIndex(actionSteps) {
  const byCode = new Map(actionSteps.map((s) => [s.code, s]));
  const foldOf = (code) => {
    const step = byCode.get(code);
    if (!step) return null;
    return step.parent_code ?? step.parentCode ?? step.code;
  };
  const foldOrder = (code) => {
    const top = byCode.get(foldOf(code));
    return top ? Number(top.sort_order ?? top.sortOrder) : null;
  };
  return {byCode, foldOf, foldOrder};
}

// 版の入力の読み取り。raw は {previousVersionNo, createdOn, basis, chains: [{role, earningType, steps: [{step, status, basis}]}]}。
// earningTypes・actionSteps は参照表の行（code・sort_order・parent_code）。返す value の chains は役の並び・稼ぎ方の並びにそろえる。
// 決まり: 役は3つのどれか、稼ぎ方と段は参照表にある、稼ぎ方はその役の稼ぎ方（METRIC_ROLES の earningTypes）、役×稼ぎ方は版の中で1回、稼ぎ方×段も版の中で1回（設定の行を稼ぎ方×step で引くため）、
// 段は畳む先が面談 → 提案 → 契約 の順に戻らない、状態は K-9 の4つ（既定は仮置き。J-13）、段の数は役×稼ぎ方ごとに1〜20・版で200まで
export function normalizeMetricMasterInput(raw, {earningTypes, actionSteps}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const err = (field, message) => errors.push({field, message});
  if (!isInt(src.previousVersionNo ?? 0, 0, Number.MAX_SAFE_INTEGER)) err('previousVersionNo', '前の版の番号は0以上の整数です');
  if (!isCalendarDate(src.createdOn)) err('createdOn', '作った日は YYYY-MM-DD の日付で入れてください');
  const text = (value, field, label) => {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
    if (typeof value !== 'string' || value.trim().length > 1000) { err(field, `${label}は1000文字までの文字です`); return null; }
    return value.trim();
  };
  const basis = text(src.basis, 'basis', '版を足した理由');
  const earningOrder = new Map(earningTypes.map((e) => [e.code, Number(e.sort_order ?? e.sortOrder)]));
  const {byCode, foldOf, foldOrder} = stepIndex(actionSteps);
  const chainsIn = Array.isArray(src.chains) ? src.chains : [];
  if (!chainsIn.length) err('chains', '役×稼ぎ方の段を1つ以上入れてください');
  const seenChains = new Set();
  const seenSteps = new Set();
  const chains = [];
  let total = 0;
  chainsIn.forEach((chain, c) => {
    const at = `chains.${c}`;
    const role = chain?.role;
    const earningType = chain?.earningType;
    if (!roleIndex.has(role)) err(`${at}.role`, '役はプロデューサー・営業（仕入れ）・営業（売り）のどれかです');
    if (!earningOrder.has(earningType)) err(`${at}.earningType`, '稼ぎ方が参照表にありません');
    else if (roleIndex.has(role) && !METRIC_ROLES[roleIndex.get(role)].earningTypes.includes(earningType)) {
      err(`${at}.earningType`, '稼ぎ方がこの役の稼ぎ方ではありません（プロデューサーは制作受託・自社出資・製作委員会、営業は買付・販売委託）');
    }
    const chainKey = `${role}|${earningType}`;
    if (seenChains.has(chainKey)) err(`${at}`, '同じ役×稼ぎ方の段が2つあります');
    seenChains.add(chainKey);
    const stepsIn = Array.isArray(chain?.steps) ? chain.steps : [];
    if (stepsIn.length < 1 || stepsIn.length > MAX_CHAIN_STEPS) err(`${at}.steps`, `役×稼ぎ方の段は1〜${MAX_CHAIN_STEPS}個です`);
    total += stepsIn.length;
    let lastOrder = -Infinity;
    const steps = stepsIn.map((s, i) => {
      const field = `${at}.steps.${i}`;
      const step = s?.step;
      if (!byCode.has(step)) err(`${field}.step`, '段が行動のステップの参照表にありません');
      else {
        const order = foldOrder(step);
        if (order < lastOrder) err(`${field}.step`, '段の畳む先が面談 → 提案 → 契約の順に戻っています');
        lastOrder = Math.max(lastOrder, order);
      }
      const stepKey = `${earningType}|${step}`;
      if (seenSteps.has(stepKey)) err(`${field}.step`, '同じ稼ぎ方×段が版の中に2つあります（設定の行の率と時間を稼ぎ方×段で引くため1つだけにします）');
      seenSteps.add(stepKey);
      const status = s?.status ?? 'provisional';
      if (!METRIC_STATUSES.includes(status)) err(`${field}.status`, '状態は確認済み・監督申告・報道値・仮置きのどれかです');
      return {seq: i + 1, step, foldsTo: foldOf(step), status, basis: text(s?.basis, `${field}.basis`, '出どころ')};
    });
    chains.push({role, earningType, steps});
  });
  if (total > MAX_METRIC_STEPS) err('chains', `1つの版の段は${MAX_METRIC_STEPS}個までです`);
  chains.sort((a, b) => (roleIndex.get(a.role) ?? 99) - (roleIndex.get(b.role) ?? 99)
    || (earningOrder.get(a.earningType) ?? 99) - (earningOrder.get(b.earningType) ?? 99));
  return {ok: errors.length === 0, errors,
    value: {previousVersionNo: src.previousVersionNo ?? 0, createdOn: src.createdOn, basis, stepCount: total, chains}};
}

// 版のヘッダと段の行から、有効な版（段の行が step_count にそろった版のうち、最新の version_no）の id。無ければ null
export function effectiveMetricVersionId(versions, stepRows) {
  const counts = new Map();
  for (const row of stepRows) counts.set(Number(row.metric_version_id), (counts.get(Number(row.metric_version_id)) ?? 0) + 1);
  let best = null;
  for (const v of versions) {
    if ((counts.get(Number(v.id)) ?? 0) !== Number(v.step_count)) continue;
    if (!best || Number(v.version_no) > Number(best.version_no)) best = v;
  }
  return best ? Number(best.id) : null;
}

// 1つの版の読む形。stepRows は段の行に参照表の名前・並びを付けたもの（label・parent_code・earning_label・profit_source・earning_sort_order）。
// 役の並び → 稼ぎ方の並び → seq の順にそろえる
export function metricMasterView(version, stepRows, {effective}) {
  const chains = new Map();
  for (const row of stepRows) {
    const key = `${row.role}|${row.earning_type}`;
    if (!chains.has(key)) {
      const role = METRIC_ROLES[roleIndex.get(row.role)];
      chains.set(key, {role: row.role, roleLabel: role?.label ?? row.role, roleGroup: role?.group ?? null, earningType: row.earning_type,
        earningTypeLabel: row.earning_label ?? null, profitSource: row.profit_source === null || row.profit_source === undefined ? null : Number(row.profit_source),
        sortOrder: Number(row.earning_sort_order ?? 0), steps: []});
    }
    chains.get(key).steps.push({seq: Number(row.seq), step: row.step, label: row.step_label ?? null, foldsTo: row.parent_code ?? row.step,
      status: row.status, basis: row.basis ?? null});
  }
  const ordered = [...chains.values()].sort((a, b) => (roleIndex.get(a.role) ?? 99) - (roleIndex.get(b.role) ?? 99) || a.sortOrder - b.sortOrder);
  for (const chain of ordered) {
    chain.steps.sort((a, b) => a.seq - b.seq);
    delete chain.sortOrder;
  }
  return {versionNo: Number(version.version_no), stepCount: Number(version.step_count), createdOn: version.created_on, basis: version.basis ?? null,
    effective, chains: ordered};
}

// 段の数を3ステップ（面談・提案・契約）へ畳んだ数（役×稼ぎ方ごと）。細目は親へ、親の無い段はそれ自身へ数える
export function foldedStepCounts(chain) {
  const counts = {};
  for (const s of chain.steps) counts[s.foldsTo] = (counts[s.foldsTo] ?? 0) + 1;
  return counts;
}

// 読む形の段に、設定の行（有効な版。readEffectiveSettings の形）の率と1件の時間を添える。範囲が稼ぎ方×ステップの行だけを、
// 稼ぎ方×段で引く。無い値は null と状態 null（0 で埋めない）。値は設定の行のまま写し、指標マスタには持たない
export function attachStepSettings(view, settings) {
  const byKey = new Map();
  for (const s of settings) {
    if (s.scope !== 'earning_type_step') continue;
    byKey.set(`${s.variableKey}|${s.earningType}|${s.step}`, s);
  }
  const pick = (variableKey, earningType, step) => {
    const s = byKey.get(`${variableKey}|${earningType}|${step}`);
    return s ? {value: s.value.value, status: s.status, versionNo: s.versionNo} : {value: null, status: null, versionNo: null};
  };
  return {...view, chains: view.chains.map((chain) => ({...chain, steps: chain.steps.map((step) => {
    const rate = pick(STEP_SETTING_KEYS.conversionBps, chain.earningType, step.step);
    const hours = pick(STEP_SETTING_KEYS.hoursX100, chain.earningType, step.step);
    return {...step, conversionBps: rate.value, conversionStatus: rate.status, hoursX100: hours.value, hoursStatus: hours.status};
  })}))};
}
