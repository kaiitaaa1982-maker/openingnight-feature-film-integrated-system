// 製作委員会の日程の式（純関数）。締め・報告・支払の日を、日程の版のフェーズと「回だけの変更」から導く。回の表は持たない。
// 要件: docs/requirements/settlement/committee.md（FR-SETL-COMM-010〜014）。設計: 会社ルート plans/2026-10-23-committee-terms-ledger.md の B。
//
// 段（tier）: to_manager（業務担当者 → 幹事）／ to_members（幹事 → 当事者）。
// フェーズ: 基準日（公開日など）から数えた年（1年目 = 基準日から1年間）の範囲ごとに、締めの月・報告の期限・支払の期限を持つ。
//   reportOffsetMonths: 締め月から何か月後の末日に報告するか
//   payFrom: 'close'（締め月から数える）か 'report'（報告の月から数える）。payOffsetMonths か月後の末日に支払う
//   holidayRule: 'previous_business_day'（支払日が土日・休業日なら前の営業日へ）か 'none'
// 日付は 'YYYY-MM-DD' の文字。時刻と時差を持ち込まないよう、UTC の日付だけで計算する。

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const TIERS = Object.freeze(['to_manager', 'to_members']);

function parse(date, label) {
  const m = DATE.exec(String(date || ''));
  if (!m) throw new Error(`${label}は YYYY-MM-DD で指定してください`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== date) throw new Error(`${label}は実在する日付にしてください（${date}）`);
  return d;
}
const fmt = (d) => d.toISOString().slice(0, 10);
// y 年 m 月（13 以上・0 以下は年をまたぐ）の末日
function endOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0));
}
function addYears(d, n) {
  const y = d.getUTCFullYear() + n;
  const m = d.getUTCMonth();
  const last = endOfMonth(y, m + 1).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}

// 基準日から数えて date が何年目か（1始まり）。基準日より前は 0
export function yearIndex(baseDate, date) {
  const base = parse(baseDate, '基準日');
  const d = parse(date, '日付');
  if (d < base) return 0;
  let n = 1;
  while (addYears(base, n) <= d) n += 1;
  return n;
}

// 支払日の休業日の扱い。土日と holidays（'YYYY-MM-DD' の並び）を飛ばして前の営業日へ
export function previousBusinessDay(date, holidays = []) {
  const off = new Set(holidays);
  const d = parse(date, '支払日');
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || off.has(fmt(d))) d.setUTCDate(d.getUTCDate() - 1);
  return fmt(d);
}

function checkPhase(p, i) {
  if (!TIERS.includes(p.tier)) throw new Error(`フェーズ${i + 1}の段（tier）は to_manager か to_members にしてください`);
  if (!Number.isInteger(p.fromYear) || p.fromYear < 1) throw new Error(`フェーズ${i + 1}の始まりの年は1以上の整数にしてください`);
  if (p.toYear != null && (!Number.isInteger(p.toYear) || p.toYear < p.fromYear)) throw new Error(`フェーズ${i + 1}の終わりの年は始まりの年以上にしてください`);
  if (!Array.isArray(p.closeMonths) || !p.closeMonths.length || p.closeMonths.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) throw new Error(`フェーズ${i + 1}の締めの月は1〜12で指定してください`);
  for (const key of ['reportOffsetMonths', 'payOffsetMonths']) if (!Number.isInteger(p[key]) || p[key] < 0 || p[key] > 24) throw new Error(`フェーズ${i + 1}の ${key} は0〜24か月にしてください`);
  if (!['close', 'report'].includes(p.payFrom)) throw new Error(`フェーズ${i + 1}の支払の数え始め（payFrom）は close か report にしてください`);
  if (!['previous_business_day', 'none'].includes(p.holidayRule)) throw new Error(`フェーズ${i + 1}の休業日の扱いは previous_business_day か none にしてください`);
}

// 段 tier の回を、基準日から untilDate まで並べる。overrides: [{tier, closeOn, field: 'reportOn'|'payOn'|'skip', value, reason}]
export function roundsFor({baseDate, phases, tier, untilDate, overrides = [], holidays = []}) {
  phases.forEach(checkPhase);
  const own = phases.filter((p) => p.tier === tier);
  if (!own.length) throw new Error(`段 ${tier} のフェーズがありません`);
  const base = parse(baseDate, '基準日');
  const until = parse(untilDate, '終わりの日');
  for (const o of overrides) if (!String(o.reason || '').trim()) throw new Error(`回だけの変更（${o.closeOn}）には理由を書いてください`);
  const rounds = [];
  let y = base.getUTCFullYear();
  let m = base.getUTCMonth() + 1;
  for (;;) {
    const close = endOfMonth(y, m);
    if (close > until) break;
    const closeOn = fmt(close);
    const year = yearIndex(baseDate, closeOn);
    const phase = own.find((p) => year >= p.fromYear && (p.toYear == null || year <= p.toYear));
    if (phase && phase.closeMonths.includes(m)) {
      const report = endOfMonth(y, m + phase.reportOffsetMonths);
      const payBase = phase.payFrom === 'report' ? report : close;
      const payRaw = fmt(endOfMonth(payBase.getUTCFullYear(), payBase.getUTCMonth() + 1 + phase.payOffsetMonths));
      const round = {tier, closeOn, yearIndex: year, phaseIndex: phases.indexOf(phase), reportOn: fmt(report),
        payOn: phase.holidayRule === 'previous_business_day' ? previousBusinessDay(payRaw, holidays) : payRaw, overrides: []};
      let skipped = false;
      for (const o of overrides.filter((x) => x.tier === tier && x.closeOn === closeOn)) {
        if (o.field === 'skip') skipped = true;
        else if (o.field === 'reportOn' || o.field === 'payOn') { parse(o.value, '変更後の日'); round[o.field] = o.value; }
        else throw new Error(`回だけの変更で変えられるのは reportOn・payOn・skip です（${o.field}）`);
        round.overrides.push({field: o.field, value: o.value ?? null, reason: o.reason});
      }
      if (!skipped) rounds.push(round);
    }
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return rounds;
}

// 配分の繰越。当事者ごとに、前回までの繰越＋今回 が下限額未満なら今回は払わず全額を繰り越す（契約の「配分金の合計額が下限額未満なら翌期に繰り越す」）
export function applyCarry({amounts, carriedIn = {}, thresholdYen}) {
  if (!Number.isSafeInteger(thresholdYen) || thresholdYen < 0) throw new Error('繰越の下限額は0以上の整数の円にしてください');
  return amounts.map(({partnerId, amountYen}) => {
    const total = amountYen + (carriedIn[partnerId] ?? 0);
    if (!Number.isSafeInteger(total)) throw new Error('繰越を足した額が安全な整数を超えました');
    return total < thresholdYen ? {partnerId, payYen: 0, carryOutYen: total} : {partnerId, payYen: total, carryOutYen: 0};
  });
}
