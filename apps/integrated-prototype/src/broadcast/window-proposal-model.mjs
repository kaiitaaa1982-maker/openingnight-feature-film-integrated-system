// 商品別の放送ウィンドウ提案（純関数。ブラウザ・node・Worker 共通）。定型業務には無かった機能。読み取りだけで、何も登録しない。
// 設計: docs/platform/team-development/broadcast-windows.md §3。
//
// 放送してよい期間 A ＝ 権利範囲（媒体が放送・全媒体・空欄、地域が日本を含む）
//                    ∩ 放送の解禁のウィンドウ（全作品のウィンドウの放送の種別。取り下げは除く。月までは月初〜月末に広げる）
//                    ∩ 商品別の販売ウィンドウ（作品・商品マスタ）。無ければ作品共通の販売条件。どちらも無ければ絞らない。
//                      系列ごとの最新の版が確認済みならその期間、改訂中の下書きなら直前の確認済みの期間（要確認）、取り下げなら販売しない（要確認）
//                    ∩ [基準日, 基準日＋24か月]
// 塞がる期間 ＝ 独占の契約（取引先別リストの放送の明細で独占・契約済か予定。商品がこの商品か指定なし。自動更新・期限なし・終わり方未確認・9999-12-31 は終わりなし）
//             ＋ ホールドバック（明細ごとの月数。その契約の終了日の翌日から N か月。応当日の前日、応当日が無ければ末日まで。他局へ提案しない期間）
// 提案 ＝ A − 塞がる期間 を連続した区間に分けたもの。短い区間（既定3か月未満）は「短い」を付けて残す。
// 非独占の契約・独占かどうか未確認の契約と、他局の申請中〜確定の放送枠は「同時期の他局」として区間ごとに示す（塞がない。独占未確認は要確認にも出す）。
// 権利範囲が未登録・放送の解禁が未登録／未定のときは提案を出さず、要確認の理由にする。権利範囲の開始日・終了日が空欄なら、始まり・終わりなしとして計算して要確認に出す。
import {territoryKey} from '../sales-ops/sales-catalog-model.mjs';
import {rightsTerritoryCovers, dateBounds} from '../sales-ops/release-window-model.mjs';
import {stationKey, isActiveSlot} from './slot-duplicates.mjs';
import {
  interval, intersect, intersectLists, normalize, subtract, overlaps, shorterThanMonths, addDays, addMonthsDate, addMonthsYm, monthsPeriodEnd,
  ymOf, monthStart, monthEnd, intervalText, ymText, dateKanji, MAX_DATE,
} from './intervals.mjs';

export const PROPOSAL_HORIZON_MONTHS = 24;
export const PROPOSAL_MIN_MONTHS = 3;
export const STATION_TYPES = Object.freeze({terrestrial: '地上波', bs: 'BS', cs: 'CS', catv: 'CATV', streaming: '配信', other: 'その他'});
export const PROPOSAL_STATES = Object.freeze({ok: '提案あり', full: '空きなし', blocked: '提案なし（要確認）'});

const nfkc = (value) => String(value ?? '').normalize('NFKC').trim(); // 比べる・判定するときだけ使う（表示は元の文字）
const mediaName = (value) => nfkc(value).replace(/_/g, '・');
const coversJapan = (territory) => { const key = territoryKey(territory); return !key || key === 'JP' || key === 'WW'; };
const isBroadcastMedia = (channel) => { const m = mediaName(channel); return !m || m === '全媒体' || m === '放送'; };
const byFrom = (a, b) => String(a.from || '').localeCompare(String(b.from || ''));
// 契約の終わり（日付で終わる明細の終了日。9999-12-31 は「終わりなし」の番兵なので終わりなしとして扱う）
const contractEndOf = (e) => (e.end_rule === 'date' && e.contract_end && e.contract_end < MAX_DATE ? e.contract_end : null);

// 独占の契約・ホールドバックで塞がる期間と、同時期の他局（非独占・独占かどうか未確認）の材料。
// ownStationKey（局を指定した確かめ）: その局との独占の契約は、その局の枠を塞がない（その局と合意した契約）。ホールドバックは局を問わず塞ぐ
function contractBlocks(entries, terms, product, reasons, horizon, ownStationKey = '') {
  const blocks = [], holdbacks = [], nonexclusive = [];
  for (const e of entries) {
    if (!['contracted', 'planned'].includes(e.status)) continue;
    if (e.product_id && (!product || e.product_id !== product.id)) continue; // 別の商品の契約はこの商品を塞がない
    if (!coversJapan(e.territory)) continue;
    const station = e.partner_name || e.partner_code || '取引先未確認';
    const term = terms.get(e.entry_id) || null;
    const unknownExclusivity = e.exclusivity !== 'exclusive' && e.exclusivity !== 'nonexclusive';
    if (!e.contract_start) {
      if (e.exclusivity === 'exclusive') reasons.push(`独占の契約の開始日が未登録（${station}・明細 ${e.entry_id}）`);
      else if (unknownExclusivity) reasons.push(`独占かどうか未確認の契約の開始日が未登録（${station}・明細 ${e.entry_id}）`);
      continue;
    }
    const end = contractEndOf(e);
    if (e.exclusivity === 'exclusive' && e.end_rule === 'unknown') reasons.push(`独占の契約の終わり方が未確認（${station}・終わりなしとして扱う）`);
    const period = interval(e.contract_start, end);
    const base = {station, partnerId: e.partner_id ?? null, entryId: e.entry_id, planned: e.status === 'planned', productScoped: Boolean(e.product_id)};
    const own = Boolean(ownStationKey) && [e.partner_name, e.partner_code].some((name) => name && stationKey(name) === ownStationKey);
    if (e.exclusivity !== 'exclusive') nonexclusive.push({...period, ...base, kind: unknownExclusivity ? 'unknown' : 'nonexclusive'});
    else if (!own) blocks.push({...period, ...base, kind: 'exclusive'});
    // 独占かどうか未確認の契約は塞がずに計算し、提案の範囲と重なるものを要確認に出す（独占かもしれない期間を他局へ提案しない確認のため）
    if (unknownExclusivity && (!horizon || overlaps(period, horizon))) {
      reasons.push(`独占かどうか未確認の契約（${station}・${intervalText(period)}・塞がずに計算${e.end_rule === 'unknown' ? '・終わり方も未確認' : ''}）`);
    }
    // ホールドバック: 終了日の翌日から N か月（3/31 終了・3か月なら 4/1〜6/30、2/29 終了・1か月なら 3/1〜3/31、1/30 終了・1か月なら 1/31〜2/28）
    if (term?.holdback_months > 0 && end) holdbacks.push({from: addDays(end, 1), to: monthsPeriodEnd(addDays(end, 1), term.holdback_months), ...base, kind: 'holdback', months: term.holdback_months});
  }
  return {blocks, holdbacks, nonexclusive};
}

// 直近の放送局（確定の枠と実放送。基準日の月より後は予定）。仮押さえ・申請中・下書きは数えない
export function recentStations({slots = [], airings = [], asOf, limit = 3}) {
  const asOfYm = ymOf(asOf);
  const stations = new Map();
  const touch = (name) => {
    const key = stationKey(name);
    if (!stations.has(key)) stations.set(key, {key, label: String(name ?? '').trim(), months: new Set(), runs: 0});
    return stations.get(key);
  };
  const slotById = new Map(slots.map((s) => [s.slot_id, s]));
  for (const s of slots) if (s.status === 'confirmed') touch(s.station_name).months.add(s.broadcast_month);
  for (const a of airings) {
    const s = slotById.get(a.slot_id);
    if (!s) continue;
    const st = touch(s.station_name);
    st.months.add(ymOf(a.aired_on));
    st.runs += Number(a.run_count || 0);
  }
  const list = [...stations.values()].filter((s) => s.months.size).map((s) => {
    const months = [...s.months].sort();
    const last = months.at(-1);
    let first = last;
    while (s.months.has(addMonthsYm(first, -1))) first = addMonthsYm(first, -1);
    const past = months.some((m) => m <= asOfYm);
    const plan = first > asOfYm ? '（予定）' : last > asOfYm ? '（一部予定）' : '';
    const period = first === last ? ymText(first) : `${ymText(first)}～${ymText(last)}`;
    return {key: s.key, label: s.label, last, first, runs: s.runs, hasPast: past,
      stationText: `${s.label}${past ? '' : '（予定）'}`, historyText: `${period}${plan} ${s.label}様`, planned: plan};
  });
  list.sort((a, b) => b.last.localeCompare(a.last) || b.runs - a.runs || a.label.localeCompare(b.label, 'ja'));
  return list.slice(0, limit);
}

// 販売条件の段（商品別の販売ウィンドウ・作品共通の販売条件）を、系列ごとの最新の版の状態で決める。
// latest: 系列ごとの最新の版、confirmed: 系列ごとに直近の確認済みの版、keyOf: 系列の鍵
// → {decided（確認済み・改訂中・取り下げのどれかがある段）, intervals, withdrawn: [版], draftOnly: [版], revising: [{draft, confirmed}]}
function conditionStage(latest, confirmed, keyOf) {
  const confirmedOf = new Map(confirmed.filter((row) => row.status === 'confirmed' && coversJapan(row.territory)).map((row) => [keyOf(row), row]));
  const used = [], withdrawn = [], draftOnly = [], revising = [];
  for (const row of latest.filter((item) => coversJapan(item.territory))) {
    if (row.status === 'confirmed') { if (row.release_on && row.sales_end_on) used.push(row); continue; }
    if (row.status === 'withdrawn') { withdrawn.push(row); continue; }
    const previous = confirmedOf.get(keyOf(row));
    if (previous && previous.release_on && previous.sales_end_on) { used.push(previous); revising.push({draft: row, confirmed: previous}); } else draftOnly.push(row);
  }
  return {decided: used.length > 0 || withdrawn.length > 0, intervals: normalize(used.map((row) => interval(row.release_on, row.sales_end_on))), withdrawn, draftOnly, revising};
}
const productWindowKey = (w) => `${w.work_id}|${w.product_id}|${w.distribution_code}|${w.territory}|${w.window_key}`;
const conditionKey = (c) => `${c.work_id}|${c.distribution_code}|${c.territory}`;

// 1つの商品（product が null なら作品全体）の提案。
// productWindows・conditions は系列ごとの最新の版、confirmedProductWindows・confirmedConditions は系列ごとに直近の確認済みの版。
// forStation は局を指定した確かめ（提案から作った下書きの要確認）だけで使う: その局との独占の契約では塞がない。画面の提案（局を指定しない）は渡さない
export function proposeWindow({asOf, horizonMonths = PROPOSAL_HORIZON_MONTHS, minMonths = PROPOSAL_MIN_MONTHS, product = null,
  rights = [], releaseWindows = [], productWindows = [], conditions = [], confirmedProductWindows = [], confirmedConditions = [],
  entries = [], terms = new Map(), slots = [], airings = [], forStation = null}) {
  const reasons = [], basis = [];
  const horizon = interval(asOf, addMonthsDate(asOf, horizonMonths));
  // 1. 権利範囲
  const rightScopes = rights.filter((s) => isBroadcastMedia(s.channel) && rightsTerritoryCovers(s.territory, '日本'));
  const rightIntervals = normalize(rightScopes.map((s) => interval(s.rights_start, s.rights_end)));
  if (!rightScopes.length) reasons.push('権利範囲が未登録（媒体が放送・地域が日本の権利）');
  else basis.push(`権利: ${rightIntervals.map(intervalText).join('・')}${rightScopes.some((s) => !nfkc(s.channel)) ? '（媒体が空欄の権利を含む）' : ''}`);
  // 開始日・終了日が空欄の範囲は、始まり・終わりなしとして計算し、要確認に出す（調達の「足りない項目」と同じ）
  for (const s of rightScopes.filter((scope) => !scope.rights_start || !scope.rights_end)) {
    const missing = [!s.rights_start && '開始日', !s.rights_end && '終了日'].filter(Boolean).join('・');
    reasons.push(`権利範囲の${missing}が未入力（${s.case_code || '調達ケース'}・${intervalText(interval(s.rights_start, s.rights_end))}として計算）`);
  }
  // 2. 放送の解禁
  const windows = releaseWindows.filter((w) => w.status !== 'withdrawn' && coversJapan(w.territory));
  const dated = windows.filter((w) => ['day', 'month', 'year'].includes(w.date_precision) && dateBounds(w.start_on));
  const releaseIntervals = normalize(dated.map((w) => interval(dateBounds(w.start_on)[0], w.end_on && dateBounds(w.end_on) ? dateBounds(w.end_on)[1] : null)));
  if (!windows.length) reasons.push('放送の解禁が未登録（全作品のウィンドウの放送）');
  else if (!dated.length) reasons.push(`放送の解禁が未定（${windows.map((w) => w.timing_raw || '未定').join('・')}）`);
  else basis.push(`放送の解禁: ${releaseIntervals.map(intervalText).join('・')}${dated.some((w) => w.status === 'draft') ? '（予定を含む）' : ''}`);
  // 3. 商品別の販売ウィンドウ → 無ければ作品共通の販売条件。系列ごとの最新の版の状態で段を決める（未確定だけの段は次の段へ回す）
  const stages = [
    {label: '商品別の販売ウィンドウ', where: '作品・商品マスタ', ...conditionStage(productWindows, confirmedProductWindows, productWindowKey)},
    {label: '作品共通の販売条件', where: '番販・放送の販売条件', ...conditionStage(conditions, confirmedConditions, conditionKey)},
  ];
  const stage = stages.find((item) => item.decided) || null;
  let conditionIntervals = null;
  let conditionWithdrawn = false;
  const seriesText = (row) => [row.distribution_code, row.territory].filter(Boolean).join('・') || '流通・地域未確認';
  for (const item of stages) {
    // 未確定しか無い段は計算に使わず、要確認に出す（決めた段より前・同じ段のものだけ）
    if (stage && stages.indexOf(item) > stages.indexOf(stage)) break;
    for (const row of item.draftOnly) reasons.push(`${item.label}が未確定（${seriesText(row)}。確認済みの版なし・${item.where}で確かめてください）`);
  }
  if (stage) {
    for (const {draft, confirmed} of stage.revising) reasons.push(`${stage.label}に未確定の版がある（${seriesText(draft)}。直前の確認済み ${intervalText(interval(confirmed.release_on, confirmed.sales_end_on))} で計算）`);
    for (const row of stage.withdrawn) reasons.push(`${stage.label}が取り下げ（${seriesText(row)}。販売しない）`);
    conditionIntervals = stage.intervals;
    if (!conditionIntervals.length) {
      conditionWithdrawn = true;
      basis.push('販売条件: 取り下げ（販売しない）');
    } else basis.push(`${stage.label}: ${conditionIntervals.map(intervalText).join('・')}`);
  } else if (stages.some((item) => item.draftOnly.length)) basis.push('販売条件: 確認済みの版なし（絞らない・要確認）');
  else basis.push('販売条件: 登録なし（絞らない）');

  const blockedByInput = !rightScopes.length || !dated.length || conditionWithdrawn;
  let allowed = [];
  if (!blockedByInput) {
    allowed = intersectLists(intersectLists(rightIntervals, releaseIntervals), [horizon]);
    if (conditionIntervals) allowed = intersectLists(allowed, conditionIntervals);
  }
  // 4. 独占の契約とホールドバック
  const {blocks, holdbacks, nonexclusive} = contractBlocks(entries, terms, product, reasons, horizon, forStation ? stationKey(forStation) : '');
  const proposalsRaw = subtract(allowed, [...blocks, ...holdbacks]);
  // 同時期の他局に数える放送枠は、申請中から確定まで（下書き・差し戻し・中止は数えない。履歴表の競合と同じ）
  const live = slots.filter(isActiveSlot);
  const firstBroadcast = [
    ...slots.filter((s) => s.status === 'confirmed').map((s) => monthStart(s.broadcast_month)),
    ...airings.map((a) => a.aired_on),
  ].sort()[0] || null;
  const proposals = proposalsRaw.map((p) => {
    const others = [];
    for (const n of nonexclusive) if (overlaps(p, n)) others.push({station: n.station, kind: n.kind, from: n.from, to: n.to, planned: n.planned});
    for (const s of live) {
      const month = interval(monthStart(s.broadcast_month), monthEnd(s.broadcast_month));
      if (overlaps(p, month)) others.push({station: String(s.station_name).trim(), kind: 'slot', status: s.status, from: s.period_from, to: s.period_to, month: s.broadcast_month});
    }
    const seen = new Set();
    const uniqueOthers = others.filter((o) => { const key = `${stationKey(o.station)}|${o.kind}`; if (seen.has(key)) return false; seen.add(key); return true; });
    return {...p, short: shorterThanMonths(p, minMonths), run: firstBroadcast && firstBroadcast < (p.from || '') ? '再放送' : '初回', others: uniqueOthers};
  });
  // 5. 許諾回数と残り（明細ごと。実放送はその局・その契約期間の中の回数）
  const slotById = new Map(slots.map((s) => [s.slot_id, s]));
  const licenses = entries.filter((e) => ['contracted', 'planned'].includes(e.status) && (!e.product_id || (product && e.product_id === product.id))).map((e) => {
    const term = terms.get(e.entry_id) || null;
    const keys = new Set([stationKey(e.partner_name), stationKey(e.partner_code)].filter(Boolean));
    const end = contractEndOf(e);
    const used = airings.filter((a) => {
      const s = slotById.get(a.slot_id);
      return s && keys.has(stationKey(s.station_name)) && (!e.contract_start || a.aired_on >= e.contract_start) && (!end || a.aired_on <= end);
    }).reduce((n, a) => n + Number(a.run_count || 0), 0);
    const licensed = term?.licensed_runs ?? null;
    return {entryId: e.entry_id, station: e.partner_name || e.partner_code, exclusivity: e.exclusivity, status: e.status, from: e.contract_start, to: end,
      licensed, used, remaining: licensed === null ? null : licensed - used, holdbackMonths: term?.holdback_months ?? null,
      partnerId: e.partner_id ?? null, listId: e.list_id ?? null};
  });
  for (const l of licenses) if (l.remaining !== null && l.remaining < 0) reasons.push(`許諾回数を超えて放送している（${l.station}・${l.licensed}回に対し${l.used}回）`);
  const recent = recentStations({slots, airings, asOf});
  const state = blockedByInput ? 'blocked' : proposals.length ? 'ok' : 'full';
  return {
    state, horizon, allowed, basis, reasons,
    blocked: [...blocks, ...holdbacks].sort(byFrom),
    nonexclusive: nonexclusive.sort(byFrom),
    proposals, recent, licenses,
    timeline: timelineLanes({horizon, rightIntervals, releaseIntervals, conditionIntervals, blocks, holdbacks, nonexclusive, live, proposals}),
  };
}

// 行を開いたときの時間軸（基準日〜24か月後に切る）
function timelineLanes({horizon, rightIntervals, releaseIntervals, conditionIntervals, blocks, holdbacks, nonexclusive, live, proposals}) {
  const clip = (list, label) => list.map((i) => ({...intersect(i, horizon), label: label(i)})).filter((i) => i.from || i.to);
  const cut = (list) => list.filter((i) => intersect(i, horizon));
  return {
    from: horizon.from, to: horizon.to,
    lanes: [
      {key: 'rights', label: '権利', bars: clip(cut(rightIntervals), () => '権利')},
      {key: 'release', label: '放送の解禁', bars: clip(cut(releaseIntervals), () => '解禁')},
      {key: 'condition', label: '販売条件', bars: conditionIntervals ? (conditionIntervals.length ? clip(cut(conditionIntervals), () => '条件') : []) : [{...horizon, label: '絞らない'}],
        ...(conditionIntervals && !conditionIntervals.length ? {empty: '取り下げ'} : {})},
      {key: 'exclusive', label: '独占の契約', bars: clip(cut(blocks), (b) => `${b.station}${b.planned ? '（予定）' : ''}`)},
      {key: 'holdback', label: 'ホールドバック', bars: clip(cut(holdbacks), (b) => `${b.station} ${b.months}か月`)},
      {key: 'others', label: '同時期の他局', bars: [
        ...clip(cut(nonexclusive), (n) => `${n.station}（${n.kind === 'nonexclusive' ? '非独占' : '独占未確認'}${n.planned ? '・予定' : ''}）`),
        ...clip(cut(live.map((s) => ({from: monthStart(s.broadcast_month), to: monthEnd(s.broadcast_month), station: s.station_name}))), (s) => `${s.station}（放送枠）`),
      ]},
      {key: 'proposal', label: '提案する期間', bars: clip(proposals, (p) => (p.short ? '提案（短い）' : '提案'))},
    ],
  };
}

// 一文の要約（アベイルズリストの「放送アベイルズ状況」）。局へ出す資料なので、空きが無い理由（独占・ホールドバック）と、
// 独占かどうか未確認の契約・権利の日付の未入力も書く
export function proposalSummary(result) {
  if (!result) return '要確認';
  if (result.state === 'blocked') return `要確認：${result.reasons.filter((r) => /権利範囲|放送の解禁|販売条件|販売ウィンドウ/.test(r)).join('・') || result.reasons[0] || '材料が足りない'}`;
  const until = (b) => (b.to ? `〜${dateKanji(b.to)}` : '終わりなし');
  const exclusive = result.blocked.filter((b) => b.kind === 'exclusive' && overlaps(b, result.horizon));
  const exclusiveText = exclusive.length ? `独占契約中：${exclusive.map((b) => `${until(b)}（${b.station}${b.planned ? '・予定' : ''}）`).join('・')}` : '';
  const holdback = result.blocked.filter((b) => b.kind === 'holdback' && overlaps(b, result.horizon));
  const holdbackText = holdback.length ? `ホールドバック：${holdback.map((b) => `${until(b)}（${b.station}${b.planned ? '・予定' : ''}）`).join('・')}` : '';
  const unknown = (result.nonexclusive || []).filter((n) => n.kind === 'unknown' && overlaps(n, result.horizon));
  const unknownText = unknown.length ? `独占未確認：${unknown.map((n) => `${until(n)}（${n.station}${n.planned ? '・予定' : ''}）`).join('・')}` : '';
  const rightsText = result.reasons.some((r) => /権利範囲の(開始日|終了日)/.test(r)) ? '要確認：権利の開始日・終了日が未入力' : '';
  const tail = [unknownText, rightsText].filter(Boolean);
  if (!result.proposals.length) {
    const parts = [exclusiveText, holdbackText, ...tail].filter(Boolean);
    return `空きなし（24か月以内）${parts.length ? `：${parts.join('／')}` : result.allowed.length ? '' : '：放送してよい期間なし'}`;
  }
  const first = result.proposals[0];
  const others = result.proposals.some((p) => p.others.length);
  const range = `${first.from ? dateKanji(first.from) : ''}〜${first.to ? dateKanji(first.to) : ''}${first.short ? '（短い）' : ''}`;
  return `放送可：${range}${result.proposals.length > 1 ? ` ほか${result.proposals.length - 1}区間` : ''}${others ? '（同時期に他局あり）' : ''}${[exclusiveText, ...tail].filter(Boolean).map((text) => `／${text}`).join('')}`;
}

// 表と Excel の1行（文字にしたもの）
export function proposalRow({work, product, result}) {
  const others = [...new Set(result.proposals.flatMap((p) => p.others.map((o) => `${o.station}（${o.kind === 'slot' ? `放送枠 ${ymText(o.month)}` : o.kind === 'nonexclusive' ? '非独占' : '独占未確認'}）`)))];
  return {
    key: `${work.id}:${product?.id ?? 'work'}`,
    work_id: work.id, work_code: work.code, work_title: work.title, product_id: product?.id ?? null, product_sku: product?.sku || '', product_name: product?.name || '（放送用の商品が未登録・作品全体）',
    state: result.state,
    allowed_text: result.allowed.map(intervalText).join('\n') || 'なし',
    basis_text: result.basis.join('\n'),
    blocked_text: result.blocked.map((b) => `${intervalText(b)} ${b.station}${b.kind === 'holdback' ? `（ホールドバック ${b.months}か月）` : '（独占）'}${b.planned ? '・予定' : ''}`).join('\n'),
    proposal_text: result.proposals.map((p) => `${intervalText(p)}${p.short ? '（短い）' : ''}`).join('\n') || (result.state === 'blocked' ? '提案なし' : '空きなし'),
    run_text: [...new Set(result.proposals.map((p) => p.run))].join('・'),
    others_text: others.join('\n'),
    recent_text: result.recent.map((r) => r.historyText).join('\n') || '放送実績なし',
    license_text: result.licenses.map((l) => `${l.station}: ${l.licensed === null ? '許諾回数 未確認' : `${l.licensed}回中${l.used}回（残り${l.remaining}回）`}${l.holdbackMonths === null ? '' : `・ホールドバック${l.holdbackMonths}か月`}`).join('\n'),
    reasons_text: result.reasons.join('\n'),
    summary: proposalSummary(result),
  };
}

export const PROPOSAL_COLUMNS = Object.freeze([
  {key: 'work_code', label: '作品コード', type: 'code'},
  {key: 'work_title', label: '作品名', type: 'text', width: 24},
  {key: 'product_sku', label: '品番', type: 'code'},
  {key: 'product_name', label: '商品名', type: 'text', width: 24},
  {key: 'state', label: '判定', type: 'text', exportValue: (row) => PROPOSAL_STATES[row.state] || row.state},
  {key: 'allowed_text', label: '放送してよい期間', type: 'text', wrap: true, width: 26},
  {key: 'basis_text', label: '根拠', type: 'text', wrap: true, width: 36},
  {key: 'blocked_text', label: '独占・ホールドバックで塞がっている期間', type: 'text', wrap: true, width: 36},
  {key: 'proposal_text', label: '提案する期間', type: 'text', wrap: true, width: 26},
  {key: 'run_text', label: '初回／再放送', type: 'text'},
  {key: 'others_text', label: '同時期の他局', type: 'text', wrap: true, width: 30},
  {key: 'recent_text', label: '直近の放送局（3局まで）', type: 'text', wrap: true, width: 32},
  {key: 'license_text', label: '許諾回数と残り', type: 'text', wrap: true, width: 32},
  {key: 'reasons_text', label: '要確認の理由', type: 'text', wrap: true, width: 36},
]);
