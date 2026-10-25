// 案件収支の予実の golden（test/fixtures/yojitsu/expected.json。会社ルート plans/2026-10-08-phase1-five-second-yojitsu.md の #23c）が、
// 種（seed.json）と入金の確認の請求（receipt-matching/invoices.json）から独立に計算した値と合い、#11・#13・#14・#14b・#20 の照合の
// 土台に使えるかを確かめる。期待値は計画（K-6・K-16・K-19・U-5）、D-039 の 2026-10-10 の追記（J-9 (c)・J-11a (b)・J-11b (a)・J-14 (a)）、
// 会社ルート ORG/事業計画/_build/build_yojitsu.py の式の定義から持ち、生成スクリプト（golden.py）を読まない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const dir = fileURLToPath(new URL('./fixtures/yojitsu/', import.meta.url));
const rmDir = fileURLToPath(new URL('./fixtures/receipt-matching/', import.meta.url));
// 手元の Windows は autocrlf で CRLF になって出てくる。リポジトリの中身（LF）に戻して読む
const text = (folder, name) => readFileSync(join(folder, name), 'utf8').replace(/\r\n/g, '\n');
const loadGolden = () => JSON.parse(text(dir, 'expected.json'));
const loadSeed = () => JSON.parse(text(dir, 'seed.json'));
const loadInvoices = () => JSON.parse(text(rmDir, 'invoices.json'));
const sha = (folder, name) => createHash('sha256').update(text(folder, name), 'utf8').digest('hex');

// ---------------------------------------------------------------- 期待する語
const EARNINGS = ['買付', '販売委託', '自社出資', '製作委員会', '制作受託'];  // D-039 の 2026-10-10 の追記（J-2・J-3）
const STEPS = ['面談', '提案', '契約'];                                        // 行動の3ステップ（K-19）
const PERIOD_NAMES = ['1年目', '2年目', '3年目', '4年目', '5年目'];
const TOTAL = '5年通算';
const MONTH_FIRST = '2026-10', MONTH_COUNT = 61;                               // build_yojitsu.py の月の列（2026-10〜2031-10）
const AFTER_SUBMIT = ['予実の4段', 'タスク', '試算', '利益額', '説明の帳票'];   // 5秒の終点 T1 の5つ
const OWNER = 'demo-admin@openingnight.invalid';  // 目標・計画の行の持ち主（行動指標の計画 #15: A-4 の利用者）
// 利益額（K-16）の費目 → [向き, 状態]。確定: J-11b (a) の4費目は払った月に引く、宣伝費は負担者が自社のもの。未確定: U-5 の残り
// （源泉と税込・費用区分「制作費」の経費）、#14b（作品の無い案件の入金）、U-4 R-d・R-f（負担者が自社以外の P&A。#24）、
// U-4 の配給費の会計の科目（#24 は配給費の科目を U-4 まで「未確定」とする。負担者が自社の配給費も）。
// 除外: 制作の実費は粗利に入れない（J-14 (a)）、出資額は1回だけ引く（J-11b (a)。実績の出資の行は出資の記録の払込と同じ）
const PROFIT_ITEMS = {
  売上: ['売上', '確定'],
  '売上（源泉のある取引先）': ['売上', '未確定'],
  '売上（作品の無い案件）': ['売上', '未確定'],
  自社出資の出資額: ['経費', '確定'],
  '製作委員会の出資額（自社の分）': ['経費', '確定'],
  '買付の MG': ['経費', '確定'],
  買い切りの買付額: ['経費', '確定'],
  '宣伝費（負担者 自社）': ['経費', '確定'],
  '配給費（負担者 自社）': ['経費', '未確定'],
  '宣伝費（負担者 自社以外）': ['経費', '未確定'],
  '配給費（負担者 自社以外）': ['経費', '未確定'],
  '費用区分「制作費」の経費': ['経費', '未確定'],
  制作の実費: ['経費', '除外'],
  '出資の実績の行（出資の記録の払込と同じ）': ['経費', '除外'],
};
const ITEM_ORDER = Object.keys(PROFIT_ITEMS);

const num = v => typeof v === 'number' && Number.isFinite(v);
const sum = (rows, f) => rows.reduce((n, r) => n + f(r), 0);
// 浮動小数の額と率（Excel の式と同じく丸めない値）は相対 1e-9 か 1e-6 の差まで同じとみなす。文字と null はそのまま比べる
const close = (a, b) => (num(a) && num(b) ? Math.abs(a - b) <= Math.max(1e-9 * Math.abs(b), 1e-6) : a === b);
const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const k = y * 12 + m - 1 + n;
  return `${Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, '0')}`;
};
const monthEnd = ym => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// 税別の額×率（bps）を 0 に向かって切り捨てる（統合システムの signedRateAmount と同じ）
const rateAmount = (amount, bps) => Number((amount < 0 ? -1n : 1n) * (BigInt(Math.abs(amount)) * BigInt(bps) / 10000n));
// 件数の逆算は整数の bps（K-6）: ceil(a×10000 ÷ b)
const ceilDiv = (a, b) => Number((BigInt(a) + BigInt(b) - 1n) / BigInt(b));

// ---------------------------------------------------------------- 種から独立に計算する（build_yojitsu.py の式の定義どおり）
function model(seed) {
  const st = seed.設定;
  const periods = st.期間.map(p => ({name: p.期間, start: p.始め, end: p.終わり}));
  const periodOf = ym => periods.find(p => p.start <= `${ym}-01` && `${ym}-01` <= p.end)?.name ?? '';
  const months = Array.from({length: MONTH_COUNT}, (_, i) => addMonths(MONTH_FIRST, i));
  const proj = new Map(seed.案件.map(p => [p.案件コード, p]));
  const vocab = seed.vocabulary;
  const defaultRate = new Map(vocab.earning_types.map(t => [t.name, t.default_sales_rate_bps / 10000]));
  const stageProb = new Map(vocab.stages.map(s => [s.name, s.probability_bps / 10000]));
  const kubun = new Map(vocab.kubun.map(k => [k.name, k]));
  const rate = code => {
    const p = proj.get(code);
    if (!p) return null;
    return p.売上率 ?? defaultRate.get(p.稼ぎ方) ?? 0;
  };
  const prob = code => (proj.get(code)?.段階 ? stageProb.get(proj.get(code).段階) ?? 0 : null);
  const stage = code => proj.get(code)?.段階 ?? '';
  const earn = code => proj.get(code)?.稼ぎ方;
  const thr = st.着地確度;
  // 予測: 予測に使う＝はい、シナリオが採用シナリオか単一。売上額＝売上の元の区分の額×売上率（率を掛ける前の額が種の額）
  const fOk = r => r.予測に使う === 'はい' && (r.シナリオ === st.採用シナリオ || r.シナリオ === '単一');
  const fSales = r => (fOk(r) && kubun.get(r.区分)?.sales_source === 'はい' && rate(r.案件コード) != null ? r['金額（円・税別）'] * rate(r.案件コード) : 0);
  const fNet = r => (fOk(r) ? (kubun.get(r.区分)?.direction === '出金' ? -r['金額（円・税別）'] : r['金額（円・税別）']) : 0);
  const hi = r => prob(r.案件コード) != null && prob(r.案件コード) >= thr;
  const aSales = r => (kubun.get(r.区分)?.sales_source === 'はい' && rate(r.案件コード) != null ? r['金額（円・税別）'] * rate(r.案件コード) : 0);
  const aNet = r => (kubun.get(r.区分)?.direction === '出金' ? -r['金額（円・税別）'] : r['金額（円・税別）']);
  const unknown = r => !r.案件コード || !proj.has(r.案件コード);
  const fsum = (fn, ym, pred = () => true) => sum(seed.予測.filter(r => r.月.slice(0, 7) === ym && pred(r)), fn);
  const asum = (fn, ym, pred = () => true) => sum(seed.実績.filter(r => r.日付.slice(0, 7) === ym && pred(r)), fn);
  const tgtMonth = (kind, earning, ym, unit = '期間の合計', div = 12) => {
    const lab = periodOf(ym);
    if (!lab) return null;
    const rows = seed.目標.filter(t => t.期間 === lab && t.稼ぎ方 === earning && t.単位 === unit && t.状態 === '有効' && (kind == null || t.目標の種類 === kind));
    return rows.length ? sum(rows, t => t['目標額（円）']) / div : '未設定';
  };
  const planAmount = (lab, earning) => {
    const rows = seed.計画.filter(p => p.期間 === lab && (earning == null || p.稼ぎ方 === earning) && p.状態 === '有効');
    return rows.length ? sum(rows, p => p['計画額（円・税別）']) : '未設定';
  };
  const planMonth = (ym, earning) => {
    const lab = periodOf(ym);
    if (!lab) return null;
    const a = planAmount(lab, earning);
    return num(a) ? a / 12 : a;
  };
  const useEarn = a => a.稼ぎ方 || (a.案件コード ? earn(a.案件コード) ?? '' : '');
  // 行動: 1件の売上＝1件あたりの額×既定の売上率。目標件数は計画の額から整数の bps で逆算（契約→提案→面談）
  const action = new Map(seed.行動.map(a => [a.稼ぎ方, a]));
  const bps = x => Math.round(x * 10000);
  const targetCount = new Map();
  for (const e of EARNINGS) {
    const a = action.get(e);
    for (const lab of PERIOD_NAMES) {
      const plan = planAmount(lab, e);
      const contract = num(plan) ? ceilDiv(plan * 10000, a['1件あたりの額（円・税別）'] * bps(defaultRate.get(e))) : null;
      const proposal = contract == null ? null : ceilDiv(contract * 10000, bps(a['提案→契約の率']));
      const meeting = proposal == null ? null : ceilDiv(proposal * 10000, bps(a['面談→提案の率']));
      targetCount.set(`${e}/契約/${lab}`, contract).set(`${e}/提案/${lab}`, proposal).set(`${e}/面談/${lab}`, meeting);
    }
  }
  const doneCount = (e, s, lab) => seed.活動記録.filter(a => useEarn(a) === e && a.ステップ === s && periodOf(a.日付.slice(0, 7)) === lab).length;
  return {st, periods, periodOf, months, proj, kubun, rate, prob, stage, earn, thr, fSales, fNet, hi, aSales, aNet, unknown, fsum, asum,
    tgtMonth, planAmount, planMonth, useEarn, action, defaultRate, targetCount, doneCount};
}

// 予実の行の月の値を、種から独立に作る（行の鍵 → 61か月）
function yojitsuMonths(m, seed) {
  const out = {};
  const per = (f) => m.months.map(f);
  out.目標本人 = per(ym => m.tgtMonth('本人', '全体', ym));
  out.目標会社 = per(ym => m.tgtMonth('会社', '全体', ym));
  for (const s of STEPS) {
    out[`行動目標/${s}`] = per(ym => {
      const lab = m.periodOf(ym);
      return lab ? sum(EARNINGS, e => m.targetCount.get(`${e}/${s}/${lab}`) ?? 0) / 12 : null;
    });
    out[`行動実績/${s}`] = per(ym => seed.活動記録.filter(a => a.日付.slice(0, 7) === ym && a.ステップ === s && EARNINGS.includes(m.useEarn(a))).length);
  }
  out.計画 = per(ym => m.planMonth(ym));
  out.着地 = per(ym => m.fsum(m.fSales, ym, m.hi));
  out.加重 = per(ym => m.fsum(r => (m.prob(r.案件コード) != null ? m.fSales(r) * m.prob(r.案件コード) : 0), ym));
  out.実績 = per(ym => m.asum(m.aSales, ym));
  out.入金 = per(ym => m.asum(r => r['金額（円・税別）'], ym, r => m.kubun.get(r.区分)?.direction === '入金'));
  out.不明入金 = per(ym => m.asum(r => r['金額（円・税別）'], ym, r => m.kubun.get(r.区分)?.direction === '入金' && m.unknown(r)));
  for (const e of EARNINGS) {
    out[`計画/${e}`] = per(ym => m.planMonth(ym, e));
    out[`着地/${e}`] = per(ym => m.fsum(m.fSales, ym, r => m.earn(r.案件コード) === e && m.hi(r)));
    out[`実績/${e}`] = per(ym => m.asum(m.aSales, ym, r => m.earn(r.案件コード) === e));
  }
  return out;
}

// 月別の行の月の値を、種から独立に作る（月別の予測範囲は「企画中も含む」＝見送りの案件だけ外す）
function monthlyMonths(m, seed) {
  const out = {};
  const per = (f) => m.months.map(f);
  const incomes = seed.vocabulary.kubun.filter(k => k.direction === '入金').map(k => k.name);
  const outgoes = seed.vocabulary.kubun.filter(k => k.direction === '出金').map(k => k.name);
  const inScope = r => m.stage(r.案件コード) !== '見送り';
  for (const k of [...incomes, ...outgoes]) {
    out[`予測/${k}`] = per(ym => m.fsum(m.fNet, ym, r => r.区分 === k && inScope(r)));
    out[`実績/${k}`] = per(ym => m.asum(m.aNet, ym, r => r.区分 === k));
  }
  for (const [g, keys] of [['入金計', incomes], ['出金計', outgoes]]) {
    out[`予測/${g}`] = m.months.map((_, i) => sum(keys, k => out[`予測/${k}`][i]));
    out[`実績/${g}`] = m.months.map((_, i) => sum(keys, k => out[`実績/${k}`][i]));
  }
  out.目標 = per(ym => m.tgtMonth('本人', '全体', ym));
  out.予測契約 = per(ym => m.fsum(m.fNet, ym, r => m.prob(r.案件コード) === 1));
  out.予測着地 = per(ym => m.fsum(m.fNet, ym, m.hi));
  out.予測全部 = per(ym => m.fsum(m.fNet, ym, r => m.stage(r.案件コード) !== '見送り'));
  out.実績収支 = m.months.map((_, i) => out['実績/入金計'][i] + out['実績/出金計'][i]);
  const cut = m.st.締めた月 ? monthEnd(m.st.締めた月.slice(0, 7)) : '1900-01-01';
  out.見込み = m.months.map((ym, i) => (monthEnd(ym) <= cut ? out.実績収支[i] : out.予測着地[i]));
  out.取り分目標 = per(ym => m.tgtMonth(null, '制作の取り分', ym, '毎月', 1));
  out.取り分予測 = m.months.map((_, i) => out['予測/受託収益'][i] + out['予測/制作の実費'][i]);
  out.取り分実績 = m.months.map((_, i) => out['実績/受託収益'][i] + out['実績/制作の実費'][i]);
  out.案件数目標 = per(() => m.st.案件数目標);
  out.案件数実績 = per(ym => new Set(seed.活動記録.filter(a => a.日付 && a.案件コード && a.成果物 && a.日付.slice(0, 7) === ym).map(a => a.案件コード)).size);
  return out;
}

// 利益額（K-16）の明細を、種と入金の確認の請求から独立に作る
function profitDetails(seed, invoicesDoc) {
  const proj = new Map(seed.案件.map(p => [p.案件コード, p]));
  const kubun = new Map(seed.vocabulary.kubun.map(k => [k.name, k]));
  const withWork = new Set(seed.works.map(w => w.project_code));
  const workProject = new Map(seed.works.map(w => [w.work_id, w.project_code]));
  const projectOfWork = new Map(seed.works.map(w => [w.work_code, w.project_code]));
  const withholding = new Set(invoicesDoc.contracts.filter(c => c.foreign_withholding_bps).map(c => c.partner_code));
  const invoicePartner = new Map(invoicesDoc.invoices.map(v => [v.invoice_number, v.partner_code]));
  const raw = new Map();
  const unknown = new Map();
  const add = (basis, ym, code, item, amount) => {
    assert.ok(item in PROFIT_ITEMS, item);
    const k = JSON.stringify([basis, ym, code, item]);
    raw.set(k, (raw.get(k) ?? 0) + amount);
  };
  const saleItem = (code, partner) => (withholding.has(partner) ? '売上（源泉のある取引先）' : withWork.has(code) ? '売上' : '売上（作品の無い案件）');
  const payments = new Set(seed.investments.flatMap(x => x.payments.map(p => JSON.stringify([projectOfWork.get(x.work_code), p.paid_on, p.amount_yen]))));
  for (const r of seed.実績) {
    const k = kubun.get(r.区分), code = r.案件コード, ym = r.日付.slice(0, 7), amount = r['金額（円・税別）'];
    if (k.direction === '入金') {
      assert.equal(k.sales_source, 'はい', `売上に数えない入金は U-5 の残り: ${r.実績ID}`);
      if (!code || !proj.has(code)) unknown.set(`cash/${ym}`, (unknown.get(`cash/${ym}`) ?? 0) + amount);
      else add('cash', ym, code, saleItem(code, invoicePartner.get(r.invoice_number)), amount);
      continue;
    }
    let item;
    if (r.区分 === '出資') {
      assert.ok(payments.has(JSON.stringify([code, r.日付, amount])), `出資の実績の行が出資の記録の払込に無い: ${r.実績ID}`);
      item = '出資の実績の行（出資の記録の払込と同じ）';
    } else if (r.区分 === '買付') item = r.項目.includes('MG') ? '買付の MG' : '買い切りの買付額';
    else if (r.区分 === '制作の実費') item = '制作の実費';
    else assert.fail(`扱いを決めていない出金の区分: ${r.区分}`);
    for (const basis of ['cash', 'accrual']) add(basis, ym, code, item, amount);
  }
  for (const v of invoicesDoc.invoices) {
    for (const line of v.lines) {
      const code = workProject.get(line.work_id);
      if (!code || !proj.has(code)) unknown.set(`accrual/${line.accounting_month}`, (unknown.get(`accrual/${line.accounting_month}`) ?? 0) + line.amount_ex_tax);
      else add('accrual', line.accounting_month, code, saleItem(code, v.partner_code), line.amount_ex_tax);
    }
  }
  for (const x of seed.investments) {
    const item = x.kind === '自社出資' ? '自社出資の出資額' : '製作委員会の出資額（自社の分）';
    for (const p of x.payments) {
      if (p.paid_on > seed.as_of) continue;  // まだ払っていない払込は引かない（払った月に引く）
      for (const basis of ['cash', 'accrual']) add(basis, p.paid_on.slice(0, 7), projectOfWork.get(x.work_code), item, p.amount_yen);
    }
  }
  for (const x of seed.expenses) {
    const item = x.category === '制作費' ? '費用区分「制作費」の経費' : `${x.category}（負担者 ${x.bearer === '自社' ? '自社' : '自社以外'}）`;
    add('accrual', x.accounting_month.slice(0, 7), x.project_code, item, x.amount_ex_tax);
    if (x.paid_on && x.paid_on <= seed.as_of) add('cash', x.paid_on.slice(0, 7), x.project_code, item, x.amount_ex_tax);
  }
  const details = [...raw].map(([k, amount]) => {
    const [basis, ym, code, item] = JSON.parse(k);
    const [side, status] = PROFIT_ITEMS[item];
    const row = {基準: basis, 月: ym, 案件コード: code, 稼ぎ方: proj.get(code).稼ぎ方, 費目: item, 向き: side, 状態: status, 税別の額: amount};
    if (side === '売上') Object.assign(row, {売上率bps: proj.get(code).rate_bps, 額: rateAmount(amount, proj.get(code).rate_bps)});
    else row.額 = amount;
    return row;
  });
  details.sort((a, b) => cmp(a.基準, b.基準) || cmp(a.月, b.月) || cmp(a.案件コード, b.案件コード) || ITEM_ORDER.indexOf(a.費目) - ITEM_ORDER.indexOf(b.費目));
  return {details, unknown};
}

// ---------------------------------------------------------------- golden の不変条件。破れた所を文で返す
function gridViolations(rows, label, m) {
  const out = [];
  const byKey = new Map(rows.map(r => [r.鍵, r]));
  const periodMonths = PERIOD_NAMES.map(lab => m.months.map((ym, i) => [ym, i]).filter(([ym]) => m.periodOf(ym) === lab).map(([, i]) => i));
  const combine = (kind, a, b) => (!num(a) || !num(b) ? null : kind === 'diff' ? a - b : b !== 0 ? a / b : null);
  for (const r of rows) {
    if (r.月.length !== MONTH_COUNT) out.push(`${label} ${r.鍵}: 月が ${r.月.length} 個`);
    if (r.種類 === 'diff' || r.種類 === 'ratio') {
      const a = byKey.get(r.a), b = byKey.get(r.b);
      if (!a || !b) { out.push(`${label} ${r.鍵}: 式の行 ${r.a}・${r.b} が無い`); continue; }
      r.月.forEach((v, i) => { if (!close(v, combine(r.種類, a.月[i], b.月[i]))) out.push(`${label} ${r.鍵} ${m.months[i]}: 式（${r.種類}）と違う`); });
      for (const lab of [...PERIOD_NAMES, TOTAL]) {
        if (!close(r.期間[lab], combine(r.種類, a.期間[lab], b.期間[lab]))) out.push(`${label} ${r.鍵} ${lab}: 式（${r.種類}）と違う`);
      }
      continue;
    }
    const values = PERIOD_NAMES.map((lab, p) => {
      const items = periodMonths[p].map(i => r.月[i]);
      return r.種類 === 'target' && items.includes('未設定') ? '未設定' : sum(items.filter(num), x => x);
    });
    PERIOD_NAMES.forEach((lab, p) => { if (!close(r.期間[lab], values[p])) out.push(`${label} ${r.鍵} ${lab}: 期間の値が月の和と違う`); });
    const total = r.種類 === 'target' && values.includes('未設定') ? '未設定' : sum(values.filter(num), x => x);
    if (!close(r.期間[TOTAL], total)) out.push(`${label} ${r.鍵} ${TOTAL}: 期間の和と違う`);
  }
  // 目標・計画から出る行（target の行・行動の目標件数と、それを使う式の行）にだけ fictional: true
  const derived = new Set(rows.filter(r => r.種類 === 'target' || r.鍵.startsWith('行動目標/')).map(r => r.鍵));
  for (const r of rows) if ((r.種類 === 'diff' || r.種類 === 'ratio') && (derived.has(r.a) || derived.has(r.b))) derived.add(r.鍵);
  for (const r of rows) if ((r.fictional === true) !== derived.has(r.鍵)) out.push(`${label} ${r.鍵}: fictional の印が目標・計画から出た行と合わない`);
  return out;
}

function compareMonths(rows, want, label, months) {
  const out = [];
  const byKey = new Map(rows.map(r => [r.鍵, r]));
  for (const [key, values] of Object.entries(want)) {
    const row = byKey.get(key);
    if (!row) { out.push(`${label} ${key}: 行が無い`); continue; }
    values.forEach((v, i) => { if (!close(row.月[i], v)) out.push(`${label} ${key} ${months[i]}: 種から計算した値と違う`); });
  }
  return out;
}

// (1') 予実の整数（#14 の予実の API が照合する値）。予実の行と同じ鍵で期間の60か月を持ち、Excel の小数（予実.行。上の model で種から確かめた値）と
// 端数の決まりの範囲で合う: 整数が null のセルは Excel の 0・空・未設定、件数の年の値は同じ、料率の額は 0 ≤ 小数−整数 < 切り捨てた回数（案件×月。
// 1か月に案件は種の32件までなので、期間は 32×12、通算は 32×60 未満）、目標・計画の月の額は年÷12 との差が12円未満。比は整数の行から作った bp。
// 月の目標・計画は年÷12 を整数で割って端数を最後の月、月の目標件数は 年×100 を同じく割る。流れの値の期間は値のある月の和
function integerViolations(g) {
  const out = [];
  const z = g.予実の整数;
  if (!z) return ['予実の整数が無い'];
  const months = g.月.slice(0, 60);
  if (JSON.stringify(z.月) !== JSON.stringify(months)) out.push('予実の整数の月が期間の60か月と違う');
  if (JSON.stringify(z.期間) !== JSON.stringify(PERIOD_NAMES)) out.push('予実の整数の期間が1〜5年目と違う');
  if (JSON.stringify(z.行.map(r => r.鍵)) !== JSON.stringify(g.予実.行.map(r => r.鍵))) out.push('予実の整数の行の鍵が予実の行と違う');
  const flt = new Map(g.予実.行.map(r => [r.鍵, r]));
  const ints = new Map(z.行.map(r => [r.鍵, r]));
  const zeroLike = v => v === null || v === 0 || v === '' || v === '未設定';
  const ratio = (n, d) => (n === null || d === null || d <= 0 ? null : Number(BigInt(n) * 10000n / BigInt(d)));
  const sumPresent = values => values.reduce((s, v) => (v === null ? s : (s ?? 0) + v), null);
  const truncKeys = new Set(['着地', '加重', '実績', ...EARNINGS.flatMap(e => [`着地/${e}`, `実績/${e}`])]);
  const annualKeys = new Set(['目標本人', '目標会社', '計画', ...EARNINGS.map(e => `計画/${e}`), ...STEPS.map(s => `行動目標/${s}`)]);
  for (const r of z.行) {
    const f = flt.get(r.鍵);
    if (!f) continue;
    if (!zeroLike(f.月[60])) out.push(`予実の整数 ${r.鍵}: Excel の期間の外の月に値がある`);
    const cells = [...r.月.map((v, i) => [months[i], v, f.月[i], 32]), ...PERIOD_NAMES.map((p, k) => [p, r.期間[k], f.期間[p], 32 * 12]), [TOTAL, r.通算, f.期間[TOTAL], 32 * 60]];
    for (const [where, iv, fv, units] of cells) {
      if (iv === null) { if (!zeroLike(fv)) out.push(`予実の整数 ${r.鍵} ${where}: null なのに Excel は ${fv}`); continue; }
      if (!Number.isSafeInteger(iv)) { out.push(`予実の整数 ${r.鍵} ${where}: 整数でない`); continue; }
      if (r.単位 === 'bp') continue;
      if (typeof fv !== 'number') { out.push(`予実の整数 ${r.鍵} ${where}: Excel に値が無い`); continue; }
      const isMonth = where.length === 7 && where[4] === '-';
      if (r.単位 === '件数' && iv !== fv) out.push(`予実の整数 ${r.鍵} ${where}: 件数が Excel と違う`);
      if (r.単位.startsWith('件数（') && (isMonth ? Math.abs(fv * 100 - iv) >= 12 : iv !== fv)) out.push(`予実の整数 ${r.鍵} ${where}: 目標件数が Excel と違う`);
      if (truncKeys.has(r.鍵) && !(fv - iv >= 0 && fv - iv < units)) out.push(`予実の整数 ${r.鍵} ${where}: 料率の額の切り捨ての幅を超えて Excel と違う`);
      if (r.単位 === '円' && annualKeys.has(r.鍵) && (isMonth ? Math.abs(fv - iv) >= 12 : iv !== fv)) out.push(`予実の整数 ${r.鍵} ${where}: 目標・計画の額が Excel と違う`);
      if (r.鍵 === '入金' && iv !== fv) out.push(`予実の整数 入金 ${where}: Excel と違う`);
    }
    if (r.単位 === 'bp') {
      const a = ints.get(f.a), b = ints.get(f.b);
      const scale = r.鍵.startsWith('行動率/') ? 100 : 1;
      const want = {月: a.月.map((n, i) => ratio(n === null ? null : n * scale, b.月[i])), 期間: a.期間.map((n, k) => ratio(n, b.期間[k])), 通算: ratio(a.通算, b.通算)};
      if (JSON.stringify([r.月, r.期間, r.通算]) !== JSON.stringify([want.月, want.期間, want.通算])) out.push(`予実の整数 ${r.鍵}: 整数の行から作った bp と違う`);
    } else if (annualKeys.has(r.鍵)) {
      const scale = r.鍵.startsWith('行動目標/') ? 100 : 1;
      PERIOD_NAMES.forEach((p, k) => {
        const ms = r.月.slice(k * 12, k * 12 + 12);
        if (r.期間[k] === null) { if (ms.some(v => v !== null)) out.push(`予実の整数 ${r.鍵} ${p}: 年の値が無いのに月の値がある`); return; }
        const base = Math.floor(r.期間[k] * scale / 12);
        if (ms.slice(0, 11).some(v => v !== base) || ms[11] !== r.期間[k] * scale - base * 11) out.push(`予実の整数 ${r.鍵} ${p}: 月の値が年÷12（端数は最後の月）でない`);
      });
      if (r.通算 !== (r.期間.every(v => v !== null) ? r.期間.reduce((s, v) => s + v, 0) : null)) out.push(`予実の整数 ${r.鍵}: 通算が5年の和でない`);
    } else {
      const periods = PERIOD_NAMES.map((_, k) => sumPresent(r.月.slice(k * 12, k * 12 + 12)));
      if (JSON.stringify(periods) !== JSON.stringify(r.期間) || r.通算 !== sumPresent(periods)) out.push(`予実の整数 ${r.鍵}: 期間・通算が値のある月の和でない`);
    }
  }
  // 行動の表（稼ぎ方×ステップ×期間）: 計画の額・目標件数は Excel の行動の表と同じ、実績件数は Excel の 0 が null、達成率は bp
  const action = new Map(g.行動.目標件数と実績件数.map(r => [`${r.稼ぎ方}|${r.ステップ}|${r.期間}`, r]));
  if ((z.行動 ?? []).length !== action.size) out.push('予実の整数の行動の表の行の数が違う');
  for (const r of z.行動 ?? []) {
    const a = action.get(`${r.稼ぎ方}|${r.ステップ}|${r.期間}`);
    if (!a || a.計画の額 !== r.計画の額 || a.目標件数 !== r.目標件数 || (a.実績件数 || null) !== r.実績件数 || ratio(r.実績件数, r.目標件数) !== r.達成率bp) {
      out.push(`予実の整数の行動の表 ${r.稼ぎ方} ${r.ステップ} ${r.期間} が違う`);
    }
  }
  for (const t of z.行動の上の表 ?? []) {
    const a = g.行動.上の表.find(x => x.稼ぎ方 === t.稼ぎ方);
    if (!a || a['1件あたりの額'] !== t['1件あたりの額'] || !(a['1件の売上'] - t['1件の売上'] >= 0 && a['1件の売上'] - t['1件の売上'] < 1)) out.push(`予実の整数の行動の上の表 ${t.稼ぎ方} が違う`);
  }
  if (!(z.決まり ?? []).some(x => x.includes('要確認11'))) out.push('予実の整数の決まりに端数の要確認11 が無い');
  return out;
}

function violations(g, seed, invoicesDoc) {
  const out = [];
  const m = model(seed);
  // 出どころと印
  if (g.fictional !== true || !String(g.notice).includes('架空')) out.push('fictional: true と架空の注記が無い');
  const sources = {'yojitsu/seed.json': sha(dir, 'seed.json'), 'receipt-matching/invoices.json': sha(rmDir, 'invoices.json')};
  if (JSON.stringify(g.sources) !== JSON.stringify(sources)) out.push('sources の SHA-256 が置いてある種・請求と違う（作り直す）');
  if (JSON.stringify(g.稼ぎ方) !== JSON.stringify(EARNINGS) || JSON.stringify(seed.vocabulary.earning_types.map(t => t.name)) !== JSON.stringify(EARNINGS)) {
    out.push('稼ぎ方が種と同じ5つでない');
  }
  if (JSON.stringify(g.月) !== JSON.stringify(m.months)) out.push('月の並びが 2026-10〜2031-10 の61か月でない');
  if (JSON.stringify(g.期間) !== JSON.stringify(seed.設定.期間)) out.push('期間が種の設定と違う');
  // (2) 送信後: #20 のあとに作る空の枠
  const after = g.送信後;
  if (after?.状態 !== '未作成' || after?.依存 !== '#20' || !after?.理由 || after?.施策 !== null
      || JSON.stringify(Object.keys(after?.値 ?? {})) !== JSON.stringify(AFTER_SUBMIT) || Object.values(after.値).some(v => v !== null)) {
    out.push('送信後が #20 を待つ空の枠（5つの値が null と理由）になっていない');
  }
  // 目標・計画の行（#11）: 種の行と同じで、月の額は年÷12、持ち主は A-4 の利用者、fictional: true を引き継ぐ
  const targets = seed.目標.map(t => ({目標ID: t.目標ID, 版: t.版, 目標の種類: t.目標の種類, 期間: t.期間, 稼ぎ方: t.稼ぎ方, 単位: t.単位,
    年の額: t['目標額（円）'], 月の額: t.単位 === '期間の合計' ? t['目標額（円）'] / 12 : t['目標額（円）'], 状態: t.状態, owner_user_email: OWNER,
    fictional: true}));
  const plans = seed.計画.map(p => ({計画ID: p.計画ID, 版: p.版, 期間: p.期間, 稼ぎ方: p.稼ぎ方, 年の額: p['計画額（円・税別）'],
    月の額: p['計画額（円・税別）'] / 12, 状態: p.状態, owner_user_email: OWNER, fictional: true}));
  try { assert.deepEqual(g['目標・計画'], {目標: targets, 計画: plans}); } catch { out.push('目標・計画の行が種の行（年÷12・持ち主・fictional）と違う'); }
  if (![...seed.目標, ...seed.計画].every(t => t.fictional === true && t.owner_user_email === OWNER)) out.push('種の目標・計画の行に fictional: true か持ち主（A-4 の利用者）が無い');
  // (1) 予実と月別: 式の形と、種から独立に計算した値
  out.push(...gridViolations(g.予実.行, '予実', m), ...gridViolations(g.月別.行, '月別', m));
  out.push(...compareMonths(g.予実.行, yojitsuMonths(m, seed), '予実', m.months));
  if (m.st.月別の予測範囲 !== '企画中も含む') out.push('月別の予測範囲が「企画中も含む」でない（この試験の独立の計算が対応していない）');
  else out.push(...compareMonths(g.月別.行, monthlyMonths(m, seed), '月別', m.months));
  // 行動（K-19・K-6）
  const top = g.行動.上の表;
  for (const e of EARNINGS) {
    const row = top.find(r => r.稼ぎ方 === e), a = m.action.get(e);
    if (!row || row['1件あたりの額'] !== a['1件あたりの額（円・税別）'] || row.売上率 !== m.defaultRate.get(e)
        || !close(row['1件の売上'], a['1件あたりの額（円・税別）'] * m.defaultRate.get(e))
        || row['提案→契約の率'] !== a['提案→契約の率'] || row['面談→提案の率'] !== a['面談→提案の率']) out.push(`行動の上の表 ${e}: 種の行動と違う`);
  }
  const longWant = EARNINGS.flatMap(e => STEPS.map(s => PERIOD_NAMES.map(lab => {
    const target = m.targetCount.get(`${e}/${s}/${lab}`), done = m.doneCount(e, s, lab), plan = m.planAmount(lab, e);
    return {稼ぎ方: e, ステップ: s, 期間: lab, 計画の額: plan, 目標件数: target, 実績件数: done, 達成率: target > 0 ? done / target : null, fictional: true};
  })).flat());
  const sortKey = r => `${EARNINGS.indexOf(r.稼ぎ方)}/${r.期間}/${STEPS.indexOf(r.ステップ)}`;
  const longGot = [...g.行動.目標件数と実績件数].sort((a, b) => cmp(sortKey(a), sortKey(b)));
  longWant.sort((a, b) => cmp(sortKey(a), sortKey(b)));
  if (longGot.length !== longWant.length || longGot.some((r, i) => Object.keys(longWant[i]).some(k => !close(r[k], longWant[i][k])))) {
    out.push('行動の目標件数と実績件数が、計画から整数の bps で逆算した件数・活動記録の件数と違う');
  }
  const yRow = key => g.予実.行.find(r => r.鍵 === key);
  const sums = g.行動.期間ごとの計画と目標;
  for (const lab of PERIOD_NAMES) {
    const plan = yRow('計画')?.期間[lab], target = yRow('目標本人')?.期間[lab];
    const want = [plan, target, num(plan) && num(target) && target !== 0 ? plan / target : null];
    if (sums.length !== 3 || sums.some((r, i) => !close(r.期間[lab], want[i]) || r.fictional !== true)) out.push(`行動の期間ごとの計画と目標 ${lab}: 予実の計画・目標と違う`);
  }
  // 段階: 稼ぎ方×段階の件数・案件の売上見込・1年目の予測
  const y1 = m.periods[0];
  for (const row of g.段階.段階ごと) {
    const tot = {件数: 0, 案件の売上見込: 0, '1年目の予測': 0};
    for (const e of EARNINGS) {
      const ps = seed.案件.filter(p => p.稼ぎ方 === e && p.段階 === row.段階);
      const want = {件数: ps.length, 案件の売上見込: sum(ps.filter(p => p['基準額（円・税別）'] != null), p => p['基準額（円・税別）'] * (m.rate(p.案件コード) ?? 0)),
        '1年目の予測': sum(seed.予測.filter(r => m.earn(r.案件コード) === e && m.stage(r.案件コード) === row.段階 && y1.start <= r.月 && r.月 <= y1.end), m.fSales)};
      for (const k of Object.keys(want)) {
        if (!close(row.稼ぎ方[e]?.[k], want[k])) out.push(`段階 ${row.段階} ${e} ${k}: 種から計算した値と違う`);
        tot[k] += row.稼ぎ方[e]?.[k] ?? 0;
      }
    }
    for (const k of Object.keys(tot)) if (!close(row.合計[k], tot[k])) out.push(`段階 ${row.段階} 合計 ${k}: 稼ぎ方の和と違う`);
  }
  if (g.段階.段階ごと.map(r => r.段階).join() !== seed.vocabulary.stages.map(s => s.name).join()) out.push('段階の並びが種の段階と違う');
  const ref = {'目標（本人・全体）': [null, '目標本人'], 計画: ['計画', '計画'], 着地予測: ['着地', '着地'], '実績（売上）': ['実績', '実績']};
  const ratios = {'進み: 着地 ÷ 計画': ['着地予測', '計画'], '進み: 実績 ÷ 計画': ['実績（売上）', '計画'],
    '達成率: 着地 ÷ 目標': ['着地予測', '目標（本人・全体）'], '達成率: 実績 ÷ 目標': ['実績（売上）', '目標（本人・全体）']};
  const bottom = new Map(g.段階['1年目の計画と進み'].map(r => [r.項目, r]));
  for (const [label, [eKey, allKey]] of Object.entries(ref)) {
    const r = bottom.get(label);
    if (!r || !close(r.合計, yRow(allKey)?.期間['1年目']) || (eKey && EARNINGS.some(e => !close(r.稼ぎ方?.[e], yRow(`${eKey}/${e}`)?.期間['1年目'])))) {
      out.push(`段階の1年目の表 ${label}: 予実の1年目と違う`);
    }
  }
  for (const [label, [a, b]] of Object.entries(ratios)) {
    const r = bottom.get(label), x = bottom.get(a), y = bottom.get(b);
    const div = (p, q) => (num(p) && num(q) && q !== 0 ? p / q : null);
    if (!r || !close(r.合計, div(x?.合計, y?.合計)) || (r.稼ぎ方 && EARNINGS.some(e => !close(r.稼ぎ方[e], div(x?.稼ぎ方?.[e], y?.稼ぎ方?.[e]))))) {
      out.push(`段階の1年目の表 ${label}: 比が違う`);
    }
  }
  // 入力の表の印（重複・案件不明）は、種には無い
  if (JSON.stringify(g.印) !== JSON.stringify({目標の重複: [], 計画の重複: [], 予測の案件不明: [], 実績の案件不明: []})) out.push('入力の表に重複か案件不明の印がある');
  // (3) 利益額（K-16）
  const p = g.利益額;
  const {details, unknown} = profitDetails(seed, invoicesDoc);
  try { assert.deepEqual(p.明細, details); } catch { out.push('利益額の明細が種と請求から独立に計算した明細と違う'); }
  try {
    assert.deepEqual(p.費目.map(x => [x.費目, x.向き, x.状態]), Object.entries(PROFIT_ITEMS).map(([k, [side, status]]) => [k, side, status]));
  } catch { out.push('利益額の費目の向き・状態が計画と D-039 の決まり（確定・未確定・除外）と違う'); }
  const months = [...new Set([...p.明細.map(d => d.月), ...[...unknown.keys()].map(k => k.split('/')[1])])].sort();
  if (JSON.stringify(p.月) !== JSON.stringify(months)) out.push('利益額の月の並びが明細の月と違う');
  for (const basis of ['cash', 'accrual']) {
    const b = p.基準[basis], rows = p.明細.filter(d => d.基準 === basis);
    const at = (f) => months.map(ym => sum(rows.filter(d => d.月 === ym && f(d)), d => d.額));
    const sales = at(d => d.状態 === '確定' && d.向き === '売上'), cost = at(d => d.状態 === '確定' && d.向き === '経費');
    const profit = sales.map((s, i) => s - cost[i]);
    try {
      assert.deepEqual(b.確定, {売上: sales, 経費: cost, 利益額: profit, 合計: {売上: sum(sales, x => x), 経費: sum(cost, x => x), 利益額: sum(profit, x => x)}});
    } catch { out.push(`利益額 ${basis}: 確定の売上・経費・利益額が明細の和と違う`); }
    for (const status of ['未確定', '除外']) {
      const items = ITEM_ORDER.filter(k => PROFIT_ITEMS[k][1] === status && rows.some(d => d.費目 === k));
      const want = items.map(k => ({費目: k, 状態: status, 向き: PROFIT_ITEMS[k][0], 額: at(d => d.費目 === k), 合計: sum(rows.filter(d => d.費目 === k), d => d.額)}));
      const got = (b[status] ?? []).map(({理由, ...rest}) => rest);
      try { assert.deepEqual(got, want); } catch { out.push(`利益額 ${basis}: ${status}の行が明細の和と違う`); }
      if ((b[status] ?? []).some(x => !x.理由)) out.push(`利益額 ${basis}: ${status}の行に理由が無い`);
    }
    const byProject = [...new Set(rows.filter(d => d.状態 === '確定').map(d => d.案件コード))].sort().map(code => {
      const r = rows.filter(d => d.案件コード === code && d.状態 === '確定');
      const s = sum(r.filter(d => d.向き === '売上'), d => d.額), c = sum(r.filter(d => d.向き === '経費'), d => d.額);
      return {案件コード: code, 稼ぎ方: r[0].稼ぎ方, 売上: s, 経費: c, 利益額: s - c};
    });
    try { assert.deepEqual(b.案件別, byProject); } catch { out.push(`利益額 ${basis}: 案件別が明細の和と違う`); }
    const unknownRow = months.map(ym => unknown.get(`${basis}/${ym}`) ?? 0);
    if (JSON.stringify(b.案件不明?.額) !== JSON.stringify(unknownRow) || b.案件不明?.合計 !== sum(unknownRow, x => x)) out.push(`利益額 ${basis}: 案件不明の行が違う`);
  }
  // 入金の基準の売上（確定＋未確定）は、予実の実績（入金×売上率。丸めない）と、明細の行の数（1行につき1円未満の切り捨て）以内で合う
  const cash = p.明細.filter(d => d.基準 === 'cash' && d.向き === '売上');
  const actual = yRow('実績');
  for (const ym of new Set(cash.map(d => d.月))) {
    const rows = cash.filter(d => d.月 === ym), i = m.months.indexOf(ym);
    const diff = (actual?.月[i] ?? 0) - sum(rows, d => d.額);
    if (!(diff >= 0 && diff < rows.length)) out.push(`利益額 cash の売上 ${ym} が予実の実績と切り捨ての幅を超えて違う`);
  }
  // (1) の額は丸めない小数で、#14 が照合するのは (1') 予実の整数だと注記にある
  if (!g.notes.some(n => n.includes('端数') && n.includes('#14') && n.includes('money.md') && n.includes('予実の整数'))) out.push('(1) の額の端数と #14 が照合する値の注記が無い');
  out.push(...integerViolations(g));
  // 値の無い経路: 種に行が無く golden では確かめられない経路は、golden の明細・案件不明・実績から数えたものと同じ（#23e のあとに作り直す）
  const bases = ['cash', 'accrual'];
  const emptyWant = {
    利益額の明細が無い費目: Object.fromEntries(bases.map(b => [b, ITEM_ORDER.filter(k => !p.明細.some(d => d.基準 === b && d.費目 === k))])),
    利益額の案件不明が全月0の基準: bases.filter(b => p.基準[b].案件不明.額.every(v => v === 0)),
    予実の実績が全月0の稼ぎ方: EARNINGS.filter(e => yRow(`実績/${e}`).月.every(v => !v)),
  };
  const {理由: emptyReason, ...emptyGot} = g.値の無い経路 ?? {};
  try { assert.deepEqual(emptyGot, emptyWant); } catch { out.push('値の無い経路が golden の明細・案件不明・実績から数えたものと違う'); }
  if (!emptyReason?.includes('#23e') || !emptyReason.includes('#14b')) out.push('値の無い経路に #23e のあとに作り直すことと #14b の確かめ方が無い');
  return out;
}

// ---------------------------------------------------------------- 試験
const load = () => ({g: loadGolden(), seed: loadSeed(), inv: loadInvoices()});

test('golden は架空の印・種と請求の SHA-256・稼ぎ方5つ・61か月を持ち、案件コードは種の案件だけ', () => {
  const {g, seed, inv} = load();
  const found = violations(g, seed, inv);
  assert.deepEqual(found.filter(v => /fictional|sources|稼ぎ方|月の並び|期間/.test(v)), []);
  const codes = new Set(seed.案件.map(p => p.案件コード));
  for (const d of g.利益額.明細) assert.ok(codes.has(d.案件コード), d.案件コード);
  assert.ok(g.利益額.明細.every(d => d.案件コード.startsWith('YJ-P')));
  assert.equal(g.build_yojitsu.走らせ方.includes('--snapshot なし'), true);
});

test('golden 全体が、種と請求から独立に計算した値と式の形に合う（違反 0 件）', () => {
  const {g, seed, inv} = load();
  assert.deepEqual(violations(g, seed, inv), []);
});

test('目標・計画の行（#11）は種の行と同じで、月の額は年÷12、持ち主は A-4 の利用者、fictional: true を引き継ぐ', () => {
  const {g, seed} = load();
  assert.equal(g['目標・計画'].目標.length, seed.目標.length);
  assert.equal(g['目標・計画'].計画.length, seed.計画.length);
  for (const t of [...g['目標・計画'].目標, ...g['目標・計画'].計画]) {
    assert.equal(t.fictional, true);
    assert.equal(t.owner_user_email, OWNER);
    assert.equal(t.月の額, t.年の額 / 12);
  }
  // 予実の目標（本人）の月の値は、有効な版（状態＝有効）の年÷12
  const self = g.予実.行.find(r => r.鍵 === '目標本人');
  const y1 = seed.目標.filter(t => t.目標の種類 === '本人' && t.期間 === '1年目' && t.状態 === '有効');
  assert.equal(y1.length, 1);
  assert.equal(self.月[0], y1[0]['目標額（円）'] / 12);
  assert.equal(self.fictional, true);
});

test('予実の4段（目標→行動→予測→実績）の行がそろい、行動は面談・提案・契約の目標件数・実績件数・達成率、予測は計画・着地・確度加重を持つ（#14）', () => {
  const {g} = load();
  const keys = g.予実.行.map(r => r.鍵);
  const want = ['目標本人', '目標会社', ...STEPS.flatMap(s => [`行動目標/${s}`, `行動実績/${s}`, `行動率/${s}`]), '計画', '率計画', '着地', '率着計', '加重',
    '実績', '率実計', '率実績', '入金', '不明入金', ...EARNINGS.flatMap(e => [`計画/${e}`, `着地/${e}`, `実績/${e}`, `率実計/${e}`])];
  assert.deepEqual(keys, want);
  assert.deepEqual([...new Set(g.予実.行.map(r => r.段))], ['1. 目標', '2. 行動（面談 → 提案 → 契約）', '3. 予測', '4. 実績', '5. 稼ぎ方ごと']);
  // 行動の目標件数は整数（整数の bps で逆算した件数。K-6）、実績件数は整数
  for (const r of g.行動.目標件数と実績件数) {
    assert.ok(r.目標件数 === null || Number.isInteger(r.目標件数), JSON.stringify(r));
    assert.ok(Number.isInteger(r.実績件数));
  }
  // 種の1年目は、実績（入金×売上率）と着地・確度加重が 0 でない
  const y1 = key => g.予実.行.find(r => r.鍵 === key).期間['1年目'];
  for (const key of ['実績', '着地', '加重', '計画', '目標本人']) assert.ok(y1(key) > 0, key);
});

test('利益額（K-16）: 4費目は確定で払った月に引き、未確定（U-5 の残り・U-4）と除外（J-14 (a)・出資の重なり）を分ける（#14b）', () => {
  const {g, seed} = load();
  const p = g.利益額;
  const of = (basis, item) => p.明細.filter(d => d.基準 === basis && d.費目 === item);
  // 出資の記録の払込は、計上・入金とも払った月に引く。種の時点より後の払込（製作中の委員会の2回目）は入れない
  const paid = seed.investments.flatMap(x => x.payments.filter(q => q.paid_on <= seed.as_of));
  const future = seed.investments.flatMap(x => x.payments.filter(q => q.paid_on > seed.as_of));
  assert.ok(future.length > 0, '種に種の時点より後の払込がある');
  for (const basis of ['cash', 'accrual']) {
    const invested = [...of(basis, '自社出資の出資額'), ...of(basis, '製作委員会の出資額（自社の分）')];
    assert.equal(sum(invested, d => d.額), sum(paid, q => q.amount_yen), basis);
    assert.ok(invested.every(d => d.状態 === '確定'));
    assert.ok(!invested.some(d => future.some(q => q.paid_on.slice(0, 7) === d.月 && q.amount_yen === d.額)), '未来の払込が入っている');
    assert.equal(of(basis, '買付の MG').length, 1, basis);
    assert.ok(of(basis, '制作の実費').every(d => d.状態 === '除外'));
    assert.ok(of(basis, '費用区分「制作費」の経費').every(d => d.状態 === '未確定'));
  }
  // 入金の基準は、未払の経費（paid_on が null）を入れない
  const unpaid = seed.expenses.filter(x => !x.paid_on);
  assert.ok(unpaid.length > 0);
  const fromExpenses = d => d.費目 === '費用区分「制作費」の経費' || d.費目.includes('（負担者 ');  // 経費の表から来る費目
  const cashCost = sum(p.明細.filter(d => d.基準 === 'cash' && fromExpenses(d)), d => d.額);
  const accrualCost = sum(p.明細.filter(d => d.基準 === 'accrual' && fromExpenses(d)), d => d.額);
  assert.equal(accrualCost - cashCost, sum(unpaid, x => x.amount_ex_tax));
  // 源泉のある取引先の売上（計上）は未確定の行に出て、確定の売上に入らない
  assert.ok(p.基準.accrual.未確定.some(x => x.費目 === '売上（源泉のある取引先）' && x.合計 > 0));
  // 配給費は負担者が自社でも、科目が U-4 で決まるまで未確定の行に出す（#24）
  assert.ok(p.基準.accrual.未確定.some(x => x.費目 === '配給費（負担者 自社）' && x.合計 > 0));
  assert.ok(p.明細.every(d => d.費目 !== '配給費（負担者 自社）' || d.状態 === '未確定'));
  // 利益額＝売上−経費（確定だけ）。決まりと理由が書いてある
  for (const basis of ['cash', 'accrual']) {
    const b = p.基準[basis];
    assert.equal(b.確定.合計.利益額, b.確定.合計.売上 - b.確定.合計.経費);
    assert.ok(b.確定.合計.売上 > 0);
  }
  assert.ok(p.決まり.length >= 5 && p.式.includes('K-16'));
});

test('(2) 施策の送信後の期待値は #20 のあとに作る空の枠（5つの値が null と理由）', () => {
  const {g} = load();
  assert.equal(g.送信後.状態, '未作成');
  assert.equal(g.送信後.依存, '#20');
  assert.deepEqual(Object.keys(g.送信後.値), AFTER_SUBMIT);
  assert.ok(Object.values(g.送信後.値).every(v => v === null));
  assert.ok(g.送信後.理由.includes('#20'));
});

test('わざと壊した golden では、壊した観点の検査が落ちる', () => {
  const {g: base, seed, inv} = load();
  const row = (g, sheet, key) => g[sheet].行.find(r => r.鍵 === key);
  const cases = [
    ['着地の月の値を変える', g => { row(g, '予実', '着地').月[5] += 1000; }, /予実 着地 2027-03: 種から計算した値と違う/],
    ['実績の期間の値を変える', g => { row(g, '予実', '実績').期間['1年目'] += 1; }, /予実 実績 1年目: 期間の値が月の和と違う/],
    ['進みの比を変える', g => { row(g, '予実', '率実計').期間['1年目'] = 0.5; }, /予実 率実計 1年目: 式（ratio）と違う/],
    ['目標の行の fictional を消す', g => { delete row(g, '予実', '目標本人').fictional; }, /目標本人: fictional の印/],
    ['目標・計画の行の fictional を消す', g => { delete g['目標・計画'].計画[0].fictional; }, /目標・計画の行が種の行/],
    ['目標・計画の行の持ち主を消す', g => { delete g['目標・計画'].目標[0].owner_user_email; }, /目標・計画の行が種の行/],
    ['行動の目標件数を1件減らす', g => { g.行動.目標件数と実績件数[0].目標件数 -= 1; }, /整数の bps で逆算した件数/],
    ['月別の見込みを変える', g => { row(g, '月別', '見込み').月[0] += 1; }, /月別 見込み 2026-10: 種から計算した値と違う/],
    ['段階の件数を変える', g => { g.段階.段階ごと[10].稼ぎ方.買付.件数 += 1; }, /段階 契約済み 買付 件数/],
    ['利益額の明細の額を変える', g => { g.利益額.明細[0].額 += 1; }, /利益額の明細が/],
    ['制作費の経費を確定にする', g => { g.利益額.費目.find(x => x.費目 === '費用区分「制作費」の経費').状態 = '確定'; }, /費目の向き・状態/],
    ['負担者が自社の配給費を確定にする', g => { g.利益額.費目.find(x => x.費目 === '配給費（負担者 自社）').状態 = '確定'; }, /費目の向き・状態/],
    ['確定の利益額を変える', g => { g.利益額.基準.cash.確定.利益額[0] += 1; }, /利益額 cash: 確定の売上・経費・利益額/],
    ['送信後に値を入れる', g => { g.送信後.値.利益額 = 0; }, /送信後が #20 を待つ空の枠/],
    ['値の無い経路から費目を消す', g => { g.値の無い経路.利益額の明細が無い費目.cash.pop(); }, /値の無い経路が/],
    ['実績のある稼ぎ方を値の無い経路に足す', g => { g.値の無い経路.予実の実績が全月0の稼ぎ方.push('買付'); }, /値の無い経路が/],
    ['種の SHA-256 を変える', g => { g.sources['yojitsu/seed.json'] = '0'.repeat(64); }, /sources の SHA-256/],
    ['整数の実績の月を1円増やす', g => { g.予実の整数.行.find(r => r.鍵 === '実績').月[1] += 1; }, /予実の整数 実績 2026-11: 料率の額の切り捨ての幅|予実の整数 実績: 期間・通算/],
    ['整数の着地の値の無い月に 0 を入れる', g => { g.予実の整数.行.find(r => r.鍵 === '着地').月[0] = 0; }, /予実の整数 着地: 期間・通算|予実の整数 率着計/],
    ['整数の実績のある月を null にする', g => { g.予実の整数.行.find(r => r.鍵 === '実績').月[1] = null; }, /予実の整数 実績 2026-11: null なのに Excel/],
    ['整数の進みの bp を変える', g => { g.予実の整数.行.find(r => r.鍵 === '率実計').期間[0] += 1; }, /予実の整数 率実計: 整数の行から作った bp/],
    ['整数の計画の月の端数を最初の月に寄せる', g => { const m = g.予実の整数.行.find(r => r.鍵 === '計画').月; m[0] += m[11] - m[0]; m[11] = m[1]; }, /予実の整数 計画 1年目: 月の値が年÷12/],
    ['整数の行動の目標件数を変える', g => { g.予実の整数.行動[0].目標件数 += 1; }, /予実の整数の行動の表/],
  ];
  assert.deepEqual(violations(base, seed, inv), []);
  for (const [label, breakIt, pattern] of cases) {
    const g = structuredClone(base);
    breakIt(g);
    const found = violations(g, seed, inv);
    assert.ok(found.some(v => pattern.test(v)), `${label}: ${JSON.stringify(found.slice(0, 5))}`);
  }
});

// ---------------------------------------------------------------- 生成の再現（会社ルートの build_yojitsu.py と openpyxl がある手元だけ）
const python = process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
function findBuildYojitsu() {
  if (process.env.ON_BUILD_YOJITSU) return existsSync(process.env.ON_BUILD_YOJITSU) ? process.env.ON_BUILD_YOJITSU : null;
  for (let d = dir; dirname(d) !== d; d = dirname(d)) {
    const p = join(d, 'ORG', '事業計画', '_build', 'build_yojitsu.py');
    if (existsSync(p)) return p;
  }
  return null;
}
const buildYojitsu = findBuildYojitsu();
const probe = buildYojitsu ? spawnSync(python, ['-c', 'import openpyxl'], {encoding: 'utf8'}) : null;
const skipRegen = !buildYojitsu ? '会社ルートの build_yojitsu.py が無い（ON_BUILD_YOJITSU で渡す。CI は会社ルートを持たない）'
  : (probe.error || probe.status !== 0) ? `Python か openpyxl が無い（${python}）` : false;

test('生成スクリプトは同じ種で2回作って同じバイト列で、置いてある expected.json と一致する', {skip: skipRegen}, () => {
  const outs = [];
  try {
    for (let i = 0; i < 2; i++) {
      const out = mkdtempSync(join(tmpdir(), 'yojitsu-golden-'));
      outs.push(out);
      const run = spawnSync(python, [join(dir, 'golden.py'), '--build-yojitsu', buildYojitsu, '--out', out],
        {encoding: 'utf8', env: {...process.env, PYTHONIOENCODING: 'utf-8'}, timeout: 600_000});
      assert.equal(run.status, 0, run.stderr);
    }
    const first = readFileSync(join(outs[0], 'expected.json'), 'utf8');
    assert.equal(first, readFileSync(join(outs[1], 'expected.json'), 'utf8'), 'expected.json が2回で違う');
    assert.equal(first, text(dir, 'expected.json'), 'expected.json が置いてある golden と違う（作り直してコミットする）');
  } finally {
    for (const out of outs) rmSync(out, {recursive: true, force: true});
  }
});
