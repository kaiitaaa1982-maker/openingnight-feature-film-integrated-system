// 案件収支の予実の架空の種（test/fixtures/yojitsu/seed.json。会社ルート plans/2026-10-08-phase1-five-second-yojitsu.md の #23a）が、
// golden（#23c）と seed スクリプト（#23d）の入力として使えるかを確かめる。期待値は計画（#23a の受け入れ基準と K-9・K-12・K-17・K-19）、
// brain の ontology「業務フローの語彙」、D-039 の 2026-10-10 の追記、会社ルート ORG/事業計画/_build/build_yojitsu.py の --seed の形から持ち、
// 生成スクリプト（generate.py）を読まない。入金の行は、入金の確認の正解表（test/fixtures/receipt-matching/）から独立に作り直して比べる。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const dir = fileURLToPath(new URL('./fixtures/yojitsu/', import.meta.url));
const rmDir = fileURLToPath(new URL('./fixtures/receipt-matching/', import.meta.url));
const RM_FILES = ['invoices.json', 'receipts.json', 'answers.json', 'yojitsu-actuals.json'];
// 手元の Windows は autocrlf で CRLF になって出てくる。リポジトリの中身（LF）に戻して読む
const text = (folder, name) => readFileSync(join(folder, name), 'utf8').replace(/\r\n/g, '\n');
const loadSeed = () => JSON.parse(text(dir, 'seed.json'));
const loadRm = () => ({
  inputs: JSON.parse(text(rmDir, 'invoices.json')),
  receipts: JSON.parse(text(rmDir, 'receipts.json')).receipts,
  truth: JSON.parse(text(rmDir, 'answers.json')),
  actuals: JSON.parse(text(rmDir, 'yojitsu-actuals.json')),
});

// ---------------------------------------------------------------- 期待する形と語
// build_yojitsu.py の COLS（入力の表の列と並び）・DATE_COLS・行動の見出し・設定の名前・期間・段階・区分・シナリオ
const COLS = {
  目標: ['目標ID', '版', '決めた日', '決めた人', '目標の種類', '期間', '稼ぎ方', '目標額（円）', '単位', '根拠', '状態'],
  計画: ['計画ID', '版', '作った日', '期間', '稼ぎ方', '計画額（円・税別）', '根拠', '状態'],
  案件: ['案件コード', '案件名', '稼ぎ方', '相手', 'キーパーソン', '段階', '基準額（円・税別）', '基準額の中身', '売上率', '始めた日', '企画フォルダ', 'メモ'],
  予測: ['予測ID', '版', '作った日', '案件コード', 'シナリオ', '月', '区分', '項目', '相手', '金額（円・税別）', '状態', '出所', '予測に使う'],
  実績: ['実績ID', '日付', '案件コード', '区分', '項目', '相手', '金額（円・税別）', '証憑', '記録した日', 'メモ'],
  活動記録: ['日付', '案件コード', '稼ぎ方', 'ステップ', '相手', 'したこと', '成果物', '次の一手', '期日'],
};
const DATE_COLS = {目標: ['決めた日'], 計画: ['作った日'], 案件: ['始めた日'], 予測: ['作った日', '月'], 実績: ['日付', '記録した日'], 活動記録: ['日付', '期日']};
const ACTION_HEADS = ['稼ぎ方', '1件あたりの額（円・税別）', '提案→契約の率', '面談→提案の率', '状態', '1件あたりの中身'];
const SETTING_KEYS = ['採用シナリオ', '締めた月', '着地確度', '案件数目標', '月別の予測範囲', '期間'];
const PERIOD_NAMES = ['1年目', '2年目', '3年目', '4年目', '5年目'];
const SCOPES = ['企画中も含む', '着地（確度以上）', '契約済み'];
const MONTH_FIRST = '2026-10-01', MONTH_LAST = '2031-10-01';  // build_yojitsu.py の月別の表の範囲（61か月）
// 入力の表の行に統合システムが足す英字の鍵（seed.json の notes に書いてある一覧）
const EXTRA = {
  目標: ['fictional', 'owner_user_email', 'target_basis'], 計画: ['fictional', 'owner_user_email'],
  案件: ['project_type', 'rate_bps', 'rate_status', 'base_status'], 予測: [], 実績: ['receipt_id', 'invoice_number'],
  活動記録: ['stage', 'result', 'work_code'],
};
const TOP_KEYS = ['fictional', 'notice', 'generator', 'seed', 'as_of', 'owner_user_email', 'sources', 'notes', 'vocabulary',
  '設定', '行動', '目標', '計画', 'plan_adoptions', '案件', 'works', 'investments', 'production_cost_versions', 'pa_budgets',
  'expenses', '予測', '実績', 'pending_receipts', '活動記録', '試算の案件'];
// 稼ぎ方5つ（D-039 の 2026-10-10 の追記、J-2・J-3）と入金の区分（build_yojitsu.py の KUBUN の「中身」: 流通売上＝自社が権利を持つ作品と
// 買付、販売委託の売上＝預かった作品、受託収益＝制作受託。委員会の分配の区分は無く、入金の確認の fixture も流通売上に置く）
const EARNINGS = ['買付', '販売委託', '自社出資', '製作委員会', '制作受託'];
const INFLOW = {買付: '流通売上', 販売委託: '販売委託の売上', 自社出資: '流通売上', 製作委員会: '流通売上', 制作受託: '受託収益'};
const PROJECT_TYPES = ['現場受託', '製作', '買付', '受託配給', '受託開発', '受託制作'];  // ontology「案件の型と稼ぎ方」
const STAGES = {見送り: 0, 企画メモ: 1000, 面談済み: 2000, 条件の探り: 3000, 提案済み: 4000, 担当の合意: 5000, 決裁者の合意: 6000,
  条件の合意: 7000, 内示: 8000, 契約の調整: 9000, 契約済み: 10000};
const KUBUN = {流通売上: ['入金', 'はい'], 販売委託の売上: ['入金', 'はい'], 受託収益: ['入金', 'はい'], クラウドファンディングの支援金: ['入金', 'いいえ'],
  出資: ['出金', 'いいえ'], 買付: ['出金', 'いいえ'], 制作の実費: ['出金', 'いいえ'], '作り手・権利元への分配': ['出金', 'いいえ'],
  クラウドファンディングの費用: ['出金', 'いいえ']};
const STATUSES = ['確認済み', '監督申告', '報道値', '仮置き'];  // 計画の K-9
const STEPS = ['面談', '提案', '契約', 'その他'];
const SCENARIOS = ['even', 'good', 'MAX', '単一'];
// ontology「行動の段」（2026-10-10）: 稼ぎ方ごとの段と畳む先のステップ（仕入れ・プロデューサーの段と、買付・販売委託の売りの段）
const ACT_STAGES = {
  制作受託: [['企画メモ', '面談'], ['予算割と見積', '提案'], ['提案', '提案'], ['契約', '契約']],
  自社出資: [['企画書', '面談'], ['稟議の申請', '提案'], ['決裁', '契約'], ['出資の払込', '契約']],
  製作委員会: [['打診', '面談'], ['内諾', '提案'], ['出資契約', '契約']],
  買付: [['権利元との面談', '面談'], ['条件書', '提案'], ['契約（MG）', '契約'], ['商品化', '面談'], ['取引先への提案', '提案'], ['採用', '契約']],
  販売委託: [['権利元との面談', '面談'], ['条件書', '提案'], ['預かりの契約', '契約'], ['商品化', '面談'], ['取引先への提案', '提案'], ['採用', '契約']],
};
const RESULTS = ['進んだ', '保留', '失注'];                 // フェーズ1 #13 の活動記録の result
const PA_BEARERS = ['自社', '配給会社', '委員会', '出資'];    // K-12
const PA_CATEGORIES = ['宣伝費', '配給費'];
const PCOST_BASIS = {自社出資: '出資額（作品の費用の版）', 製作委員会: '出資額（委員会の条件版）'};
const BURDEN_KINDS = ['出資者の追加出資', '制作会社の負担', '借入'];  // FR-EXP-PCOST-024
const OWNER = 'demo-admin@openingnight.invalid';              // 行動指標の計画 A-4 の利用者（段B の種の持ち主）
const K17_VERSION = '施策の既定の予測';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sum = (rows, f) => rows.reduce((n, row) => n + (typeof f === 'function' ? f(row) : row[f]), 0);
const yen = v => Number.isInteger(v) && v > 0;
const irregular = v => yen(v) && v % 100 !== 0;  // 不規則な桁（切りのよい実額と重ならない）
const fictionalName = v => typeof v === 'string' && v.includes('架空');
const groupBy = (rows, key) => rows.reduce((m, r) => m.set(key(r), [...(m.get(key(r)) ?? []), r]), new Map());
const addMonths = (iso, n) => {
  const [y, m] = iso.split('-').map(Number);
  const k = y * 12 + m - 1 + n;
  return `${Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, '0')}-01`;
};
const dayBefore = iso => new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

// 入金の確認の正解表から、自動で一致した入金の消込 → 請求明細の work_id → 種の作品 → 案件コードで入金の行を作り直す
function rebuildActuals(seed, rm) {
  const invoices = new Map(rm.inputs.invoices.map(v => [v.invoice_number, v]));
  const receipts = new Map(rm.receipts.map(r => [r.receipt_id, r]));
  const partner = new Map(rm.inputs.partners.map(p => [p.partner_code, p.name]));
  const projectOf = new Map(seed.works.map(w => [w.work_id, w.project_code]));
  const earning = new Map(seed.案件.map(p => [p.案件コード, p.稼ぎ方]));
  const rows = [];
  for (const a of rm.truth.answers.filter(x => x.outcome === '自動で一致')) {
    const r = receipts.get(a.receipt_id);
    for (const x of a.allocations) {
      const v = invoices.get(x.invoice_number);
      const byProject = new Map();
      for (const line of v.lines) {
        const code = projectOf.get(line.work_id);
        byProject.set(code, (byProject.get(code) ?? 0) + line.amount_ex_tax);
      }
      for (const [code, amount] of byProject) {
        rows.push({日付: r.received_on, 案件コード: code, 区分: INFLOW[earning.get(code)], 金額: amount, 相手: partner.get(a.partner_code),
          receipt_id: r.receipt_id, invoice_number: v.invoice_number, 証憑: `入金 ${r.reference}・請求 ${v.invoice_number}`});
      }
    }
  }
  return rows;
}

// 種の不変条件。破れた所を文で返す（壊した種でも同じ関数で落ちることを確かめる）
function violations(seed, rm) {
  const out = [];
  const bad = msg => out.push(msg);
  const projects = new Map(seed.案件.map(p => [p.案件コード, p]));
  const works = new Map(seed.works.map(w => [w.work_code, w]));
  const settings = seed.設定;
  // ---- 量（#23a の成果物）
  if (seed.案件.length !== 32) bad(`案件が ${seed.案件.length} 件（32 件のはず）`);
  const earnings = new Set(seed.案件.map(p => p.稼ぎ方));
  if (EARNINGS.some(e => !earnings.has(e))) bad(`稼ぎ方が5つそろわない: ${[...earnings]}`);
  if (seed.予測.length < 735) bad(`予測が ${seed.予測.length} 行（735 行以上のはず）`);
  if (seed.活動記録.length < 30) bad(`活動記録が ${seed.活動記録.length} 行（30 行以上のはず）`);
  if (seed.fictional !== true) bad('種の fictional が true でない');
  if (seed.owner_user_email !== OWNER) bad(`種の持ち主が ${seed.owner_user_email}`);

  // ---- build_yojitsu.py の入力の形
  for (const [name, cols] of Object.entries(COLS)) {
    const ids = new Set();
    seed[name].forEach((row, i) => {
      const where = `${name} の ${i + 1} 行目`;
      const keys = Object.keys(row);
      const want = [...cols, ...EXTRA[name]];
      if (keys.length !== want.length || want.some(k => !keys.includes(k))) bad(`${where}: 鍵が入力の表の列と決まった英字の鍵でない（${keys}）`);
      for (const c of DATE_COLS[name]) if (row[c] !== null && !DATE.test(row[c] ?? '')) bad(`${where}: ${c} が YYYY-MM-DD でない（${row[c]}）`);
      const id = row[cols[0]];
      if (name !== '活動記録' && ids.has(id)) bad(`${where}: ${cols[0]} ${id} が重なる`);
      ids.add(id);
    });
  }
  const unknownTop = Object.keys(seed).filter(k => !TOP_KEYS.includes(k));
  if (unknownTop.length) bad(`知らない最上位の鍵: ${unknownTop}`);
  if (Object.keys(settings).join() !== SETTING_KEYS.join()) bad(`設定の名前が ${Object.keys(settings)}`);
  if (!['even', 'good', 'MAX'].includes(settings.採用シナリオ)) bad(`採用シナリオ ${settings.採用シナリオ}`);
  if (!DATE.test(settings.締めた月) || !settings.締めた月.endsWith('-01')) bad(`締めた月が月初の日でない（${settings.締めた月}）`);
  if (!(settings.着地確度 > 0 && settings.着地確度 <= 1) || !yen(settings.案件数目標) || !SCOPES.includes(settings.月別の予測範囲)) bad('設定の値が範囲の外');
  if (settings.期間.map(p => p.期間).join() !== PERIOD_NAMES.join()) bad(`期間の名前が ${settings.期間.map(p => p.期間)}`);
  settings.期間.forEach((p, i) => {
    if (!p.始め.endsWith('-01')) bad(`${p.期間} の始めが月初の日でない`);
    if (i > 0 && dayBefore(p.始め) !== settings.期間[i - 1].終わり) bad(`${p.期間} が前の期間に続かない`);
  });
  if (seed.行動.length !== 5 || EARNINGS.some(e => seed.行動.filter(a => a.稼ぎ方 === e).length !== 1)) bad('行動が稼ぎ方5つの1行ずつでない');
  for (const a of seed.行動) {
    if (Object.keys(a).join() !== ACTION_HEADS.join()) bad(`行動 ${a.稼ぎ方}: 見出しが ${Object.keys(a)}`);
    // K-19: 率（面談→提案 50%・提案→契約 30%）と1件あたりの額は仮置きの印つき
    if (a['面談→提案の率'] !== 0.5 || a['提案→契約の率'] !== 0.3) bad(`行動 ${a.稼ぎ方}: 率が K-19 の 50%・30% でない`);
    if (a.状態 !== '仮置き') bad(`行動 ${a.稼ぎ方}: 状態が仮置きでない（${a.状態}）`);
    if (!irregular(a['1件あたりの額（円・税別）'])) bad(`行動 ${a.稼ぎ方}: 1件あたりの額が不規則な桁の架空額でない`);
  }
  if (typeof seed.試算の案件 !== 'object' || seed.試算の案件 === null) bad('試算の案件が object でない');

  // ---- 語
  const types = new Map(seed.vocabulary.earning_types.map(e => [e.name, e]));
  if (seed.vocabulary.earning_types.map(e => e.name).join() !== EARNINGS.join()) bad('語の稼ぎ方が5つでない');
  for (const e of seed.vocabulary.earning_types) {
    if (e.inflow_kubun !== INFLOW[e.name]) bad(`稼ぎ方 ${e.name} の入金の区分 ${e.inflow_kubun}`);
    if (!PROJECT_TYPES.includes(e.project_type)) bad(`稼ぎ方 ${e.name} の案件の型 ${e.project_type} が ontology の型に無い`);
    if (!Number.isInteger(e.default_sales_rate_bps) || !STATUSES.includes(e.rate_status)) bad(`稼ぎ方 ${e.name} の既定の売上率に bps と状態が無い`);
  }

  // ---- 案件
  for (const p of seed.案件) {
    const id = `案件 ${p.案件コード}`;
    if (!EARNINGS.includes(p.稼ぎ方)) bad(`${id}: 稼ぎ方 ${p.稼ぎ方} が5つの中に無い`);
    if (!(p.段階 in STAGES)) bad(`${id}: 段階 ${p.段階} が10段階＋見送りに無い`);
    if (p.project_type !== types.get(p.稼ぎ方)?.project_type) bad(`${id}: 案件の型が稼ぎ方の対応と違う`);
    if (!fictionalName(p.案件名) || !fictionalName(p.相手)) bad(`${id}: 名前が架空の名前でない`);
    if (!Number.isInteger(p.rate_bps) || Math.round(p.売上率 * 10000) !== p.rate_bps || Math.abs(p.売上率 * 10000 - p.rate_bps) > 1e-6) bad(`${id}: 売上率と bps が合わない`);
    if (!STATUSES.includes(p.rate_status)) bad(`${id}: 売上率に状態（K-9）が無い`);
    if (p.rate_bps !== types.get(p.稼ぎ方)?.default_sales_rate_bps && p.rate_status !== '仮置き') bad(`${id}: 既定と違う売上率に仮置きの印が無い`);
    if (p['基準額（円・税別）'] === null) {
      if (p.base_status !== null) bad(`${id}: 基準額が空なのに状態がある`);
    } else if (!yen(p['基準額（円・税別）']) || !STATUSES.includes(p.base_status)) bad(`${id}: 基準額が正の整数円でないか、状態（K-9）が無い`);
  }

  // ---- 目標・計画（fictional・不規則な桁・持ち主・有効な版）
  for (const [name, amountCol] of [['目標', '目標額（円）'], ['計画', '計画額（円・税別）']]) {
    for (const t of seed[name]) {
      const id = `${name} ${t[COLS[name][0]]}`;
      if (t.fictional !== true) bad(`${id}: fictional の印が無い`);
      if (t.owner_user_email !== OWNER) bad(`${id}: 持ち主が ${t.owner_user_email}`);
      if (!irregular(t[amountCol])) bad(`${id}: 額が不規則な桁の架空額でない（${t[amountCol]}）`);
      if (!PERIOD_NAMES.includes(t.期間) || !['有効', '改めた'].includes(t.状態)) bad(`${id}: 期間か状態が語に無い`);
    }
  }
  for (const [key, rows] of groupBy(seed.目標, t => [t.目標の種類, t.期間, t.稼ぎ方, t.単位].join('|'))) {
    const latest = Math.max(...rows.map(t => t.版));
    const live = rows.filter(t => t.状態 === '有効');
    if (live.length !== 1 || live[0].版 !== latest) bad(`目標 ${key}: 有効が最新の版の1行でない（目標の版は期間ごとの最新の version_no。K-8）`);
  }
  if (seed.目標.some(t => !['本人', '会社'].includes(t.目標の種類) || t.target_basis !== '額')) bad('目標の種類か根拠の種類が語に無い');
  // 行動指標の計画（plans/2026-10-09-sales-producer-kpi.md）: 目標（本人）＝人件費×倍率（既定3）、目標（会社）＝人件費×2。
  // 同じ人件費から出すので、有効な目標の 会社÷本人 は 2/3（架空額の不規則な桁の分だけずれてよい。1,000 円未満）
  for (const period of PERIOD_NAMES) {
    const live = kind => seed.目標.find(t => t.目標の種類 === kind && t.期間 === period && t.状態 === '有効')?.['目標額（円）'];
    const self = live('本人'), company = live('会社');
    if (self === undefined || company === undefined) bad(`目標 ${period}: 本人と会社の有効な目標がそろわない`);
    else if (Math.abs(company * 3 - self * 2) >= 3000) bad(`目標 ${period}: 会社÷本人が 2/3 でない（本人 ${self} 円・会社 ${company} 円）`);
  }
  const adoptions = groupBy(seed.plan_adoptions, a => a.period);
  for (const period of PERIOD_NAMES) {
    const list = [...(adoptions.get(period) ?? [])].sort((x, y) => x.adopted_on.localeCompare(y.adopted_on) || x.version_no - y.version_no);
    if (!list.length) { bad(`計画 ${period}: 採用の記録が無い（第1版も1行書く）`); continue; }
    const adopted = list.at(-1).version_no;
    const rows = seed.計画.filter(t => t.期間 === period);
    const live = rows.filter(t => t.状態 === '有効');
    if (live.some(t => t.版 !== adopted) || rows.some(t => t.版 === adopted && t.状態 !== '有効')) bad(`計画 ${period}: 有効の印が最新の採用の記録の版（第${adopted}版）と違う`);
    if (live.map(t => t.稼ぎ方).sort().join() !== [...EARNINGS].sort().join()) bad(`計画 ${period}: 有効な版が稼ぎ方5つの1行ずつでない`);
    for (const a of list) if (!rows.some(t => t.版 === a.version_no)) bad(`計画 ${period}: 採用の記録の第${a.version_no}版が無い`);
  }
  if (seed.plan_adoptions.some(a => a.owner_user_email !== OWNER || a.fictional !== true)) bad('採用の記録に持ち主か fictional の印が無い');

  // ---- 作品（入金の確認の作品をそのまま持ち、作品から案件へたどれる）
  for (const w of seed.works) {
    const p = projects.get(w.project_code);
    if (!p) { bad(`作品 ${w.work_code}: 案件 ${w.project_code} が種に無い`); continue; }
    if (p.稼ぎ方 === '制作受託') bad(`作品 ${w.work_code}: 制作受託の案件に作品がある（作品の無い案件）`);
    if (!fictionalName(w.title)) bad(`作品 ${w.work_code}: 題が架空の名前でない`);
  }
  if (new Set(seed.works.map(w => w.work_id)).size !== seed.works.length) bad('作品の work_id が重なる');
  // 案件を始めた日は、その案件の作品の出資の払込・制作費の版の契約書・経費の計上月・活動記録より前
  const startOf = code => projects.get(code)?.始めた日 ?? '9999-12-31';
  const dated = [
    ...seed.investments.flatMap(x => x.payments.map(pay => [works.get(x.work_code)?.project_code, pay.paid_on, `出資 ${x.investment_id} の払込`])),
    ...seed.production_cost_versions.filter(v => v.signed_on).map(v => [works.get(v.work_code)?.project_code, v.signed_on, `制作費の版 ${v.work_code} 第${v.version_no}版の締結日`]),
    ...seed.expenses.map(x => [x.project_code, x.accounting_month.slice(0, 7), `経費 ${x.expense_id} の計上月`]),
    ...seed.活動記録.filter(a => a.案件コード).map(a => [a.案件コード, a.日付, `活動記録 ${a.案件コード} ${a.日付}`]),
  ];
  for (const [code, date, label] of dated) if (date < startOf(code).slice(0, date.length)) bad(`${label} が案件 ${code} を始めた日より前`);
  const rmWorks = new Map(rm.inputs.works.map(w => [w.work_id, w]));
  for (const inv of rm.inputs.invoices) {
    for (const line of inv.lines) {
      const w = seed.works.find(x => x.work_id === line.work_id);
      if (!w) bad(`請求 ${inv.invoice_number} の ${line.line_no} 行目: work_id ${line.work_id} が種の作品に無い`);
      else if (w.work_code !== line.work_code) bad(`請求 ${inv.invoice_number}: 作品 ${line.work_id} のコードが種と違う`);
    }
  }
  for (const [id, w] of rmWorks) {
    const s = seed.works.find(x => x.work_id === id);
    if (!s || s.work_code !== w.work_code || s.title !== w.title || s.project_code !== w.project_code) bad(`入金の確認の作品 ${w.work_code} が種の作品と違う`);
  }
  for (const p of rm.inputs.projects) {
    const s = projects.get(p.project_code);
    if (!s || s.案件名 !== p.title || s.稼ぎ方 !== p.earning_type) bad(`入金の確認の案件 ${p.project_code} が種の案件と違う`);
  }

  // ---- 入金の行（入金の確認の正解表から）
  const want = rebuildActuals(seed, rm);
  const incoming = seed.実績.filter(r => KUBUN[r.区分]?.[0] === '入金');
  const key = r => `${r.receipt_id}|${r.invoice_number}|${r.案件コード}`;
  const got = new Map(incoming.map(r => [key(r), r]));
  if (got.size !== want.length || want.some(w => !got.has(key(w)))) bad(`入金の行が入金の確認の消込から作った ${want.length} 行と一致しない（種は ${got.size} 行）`);
  for (const w of want) {
    const r = got.get(key(w));
    if (r && (r.日付 !== w.日付 || r['金額（円・税別）'] !== w.金額 || r.区分 !== w.区分 || r.相手 !== w.相手 || r.証憑 !== w.証憑)) {
      bad(`入金の行 ${r.実績ID}: 日付・金額・区分・相手・証憑が消込から作った値と違う`);
    }
  }
  for (const r of seed.実績) {
    if (!(r.区分 in KUBUN)) bad(`実績 ${r.実績ID}: 区分 ${r.区分} が区分マスタに無い`);
    if (!projects.has(r.案件コード)) bad(`実績 ${r.実績ID}: 案件 ${r.案件コード} が種に無い`);
    if (!yen(r['金額（円・税別）'])) bad(`実績 ${r.実績ID}: 金額が正の整数円でない`);
    if (KUBUN[r.区分]?.[0] === '出金' && (r.receipt_id !== null || r.invoice_number !== null)) bad(`実績 ${r.実績ID}: 出金の行に入金の参照がある`);
    if (r.日付 > seed.as_of) bad(`実績 ${r.実績ID}: 日付が種の時点より後`);
  }
  const review = rm.truth.answers.filter(a => a.outcome === '確認が要る').map(a => a.receipt_id).sort((x, y) => x - y);
  if (seed.pending_receipts.map(p => p.receipt_id).sort((x, y) => x - y).join() !== review.join()) bad('pending が確認が要る入金と違う');
  if (incoming.some(r => review.includes(r.receipt_id))) bad('確認が要る入金が承認の前に入金の行になっている');

  // ---- 出資の記録
  const investments = new Map(seed.investments.map(x => [x.work_code, x]));
  for (const x of seed.investments) {
    const id = `出資 ${x.investment_id}`;
    const w = works.get(x.work_code), p = projects.get(w?.project_code);
    if (!p || p.稼ぎ方 !== x.kind || !(x.kind in PCOST_BASIS)) bad(`${id}: 作品の案件の稼ぎ方と出資の種類が違う`);
    if (sum(x.members, 'amount_yen') !== x.total_yen) bad(`${id}: 出資者の額の和が総額と違う`);
    if (x.members.find(m => m.name === '自社')?.amount_yen !== x.own_yen) bad(`${id}: 自社の額が出資者の行と違う`);
    if (x.own_yen * 10000 !== x.total_yen * x.own_ratio_bps) bad(`${id}: 自社の出資比率が額と合わない`);
    if (sum(x.payments, 'amount_yen') !== x.own_yen) bad(`${id}: 払込の和が自社の出資額と違う`);
    if (x.status !== '確定' || x.tax_basis !== '税抜') bad(`${id}: 確定・税抜の出資でない（FR-EXP-PCOST-003・022）`);
    if (x.kind === '製作委員会' && p && p.rate_bps !== x.own_ratio_bps) bad(`${id}: 委員会の案件の売上率が自社の出資比率と違う`);
    if (x.members.some(m => m.name !== '自社' && !fictionalName(m.name))) bad(`${id}: 出資者の名前が架空でない`);
  }
  for (const r of seed.実績.filter(x => x.区分 === '出資')) {
    const w = seed.works.find(x => x.project_code === r.案件コード && investments.has(x.work_code));
    if (!w || !investments.get(w.work_code).payments.some(pay => pay.paid_on === r.日付 && pay.amount_yen === r['金額（円・税別）'])) bad(`実績 ${r.実績ID}: 出資の行が出資の記録の払込と合わない`);
  }

  // ---- 制作費の版（全作品に版。連番・整数円・税抜・根拠・内訳）
  const versions = groupBy(seed.production_cost_versions, v => v.work_code);
  for (const w of seed.works) if (!versions.has(w.work_code)) bad(`作品 ${w.work_code}: 制作費の版が無い`);
  for (const [code, list] of versions) {
    const w = works.get(code), x = investments.get(code);
    if (!w) { bad(`制作費の版: 作品 ${code} が種に無い`); continue; }
    list.forEach((v, i) => {
      const id = `制作費の版 ${code} 第${v.version_no}版`;
      if (v.version_no !== i + 1) bad(`${id}: 版の番号が1からの連番でない`);
      if (!yen(v.amount_yen) || v.tax_basis !== '税抜') bad(`${id}: 額が正の整数円・税抜でない`);
      if (!STATUSES.includes(v.status)) bad(`${id}: 状態（K-9）が無い`);
      if (!DATE.test(v.recorded_on ?? '') || v.recorded_on > seed.as_of || (i > 0 && v.recorded_on < list[i - 1].recorded_on)) bad(`${id}: 記録した日が前の版より前か、種の時点より後`);
      if (v.signed_on && v.signed_on > v.recorded_on) bad(`${id}: 契約書の締結日が記録した日より後`);
      if (i === 0 && x) {
        if (v.basis_kind !== PCOST_BASIS[x.kind] || v.investment_id !== x.investment_id || v.amount_yen !== x.total_yen) bad(`${id}: 出資の記録から作った第1版でない（FR-EXP-PCOST-002）`);
      } else if (i === 0) {
        if (v.basis_kind !== '契約書' || !v.contract_ref || !DATE.test(v.signed_on ?? '') || !fictionalName(v.counterparty)) bad(`${id}: 出資の記録の無い作品の第1版に契約書の参照・締結日・相手が無い（FR-EXP-PCOST-039）`);
      } else if (v.basis_kind !== '追加の契約' || !v.contract_ref || !DATE.test(v.signed_on ?? '') || !yen(v.added_yen) ||
        !BURDEN_KINDS.includes(v.burden_kind) || v.amount_yen !== list[i - 1].amount_yen + v.added_yen) {
        bad(`${id}: 追加の版に契約書の参照・締結日・追加額・負担の種別が無いか、額が前の版＋追加額でない（FR-EXP-PCOST-005・024）`);
      }
      if (v.breakdown) {
        if (v.breakdown.map(b => b.part).join() !== '制作費,P&A' || sum(v.breakdown, 'amount_yen') !== v.amount_yen) bad(`${id}: 内訳（制作費・P&A）の和が額と違う（FR-EXP-PCOST-019）`);
        if (!x?.includes_pa || v.breakdown[1].amount_yen !== x.pa_yen) bad(`${id}: 内訳は出資に P&A を含む作品だけで、P&A は出資の P&A と同じ額`);
      }
    });
  }

  // ---- 経費（制作費の実費と P&A の実費。P&A には負担者）
  for (const x of seed.expenses) {
    const id = `経費 ${x.expense_id}`;
    const w = works.get(x.work_code);
    if (!w || w.project_code !== x.project_code) bad(`${id}: 作品と案件が種の作品に合わない`);
    if (![...PA_CATEGORIES, '制作費'].includes(x.category)) bad(`${id}: 費用区分 ${x.category}`);
    if (PA_CATEGORIES.includes(x.category) !== (x.bearer !== null)) bad(`${id}: 負担者は P&A（宣伝費・配給費）の行だけに付ける（K-12）`);
    if (x.bearer !== null && !PA_BEARERS.includes(x.bearer)) bad(`${id}: 負担者 ${x.bearer} が語に無い`);
    if (x.bearer === '出資' && !investments.get(x.work_code)?.includes_pa) bad(`${id}: 出資が負担した P&A なのに、出資に P&A を含まない作品`);
    if (x.bearer === '委員会' && investments.get(x.work_code)?.kind !== '製作委員会') bad(`${id}: 委員会が負担した P&A なのに、委員会の作品でない`);
    if (!yen(x.amount_ex_tax) || x.tax_amount !== Math.floor(x.amount_ex_tax / 10) || x.amount_inc_tax !== x.amount_ex_tax + x.tax_amount) bad(`${id}: 税抜・税額・税込が合わない`);
    if (!x.accounting_month.endsWith('-01') || (x.paid_on !== null && !(x.paid_on > x.accounting_month))) bad(`${id}: 計上月が月初の日でないか、支払日が計上月より前`);
    // 種の時点より後の支払は記録済みの支払にしない（未払の経費は paid_on が null。入金ベースの出金に数えない）
    if (x.paid_on !== null && !(DATE.test(x.paid_on) && x.paid_on <= seed.as_of)) bad(`${id}: 支払日が種の時点より後（未払なら null）`);
  }
  // 出資に P&A を含む作品: 負担者「出資」の P&A の実費は、出資に含む P&A の枠（FR-EXP-PCOST-019・020）を超えない
  for (const x of seed.investments.filter(v => v.includes_pa)) {
    const spentByInvestment = sum(seed.expenses.filter(e => e.work_code === x.work_code && e.bearer === '出資'), 'amount_ex_tax');
    if (spentByInvestment > x.pa_yen) bad(`出資 ${x.investment_id}: 負担者が出資の P&A の実費 ${spentByInvestment} 円が出資に含む P&A ${x.pa_yen} 円を超える`);
  }
  if (new Set(seed.expenses.map(x => x.expense_id)).size !== seed.expenses.length) bad('経費の ID が重なる');
  if (PA_BEARERS.some(b => !seed.expenses.some(x => x.bearer === b))) bad('P&A の負担者4種がそろわない');
  if (seed.pa_budgets.map(b => b.work_code).sort().join() !== seed.works.map(w => w.work_code).sort().join() || seed.pa_budgets.some(b => !yen(b.promotion_budget_yen))) {
    bad('P&A の予算が作品ごとに1行の正の整数円でない');
  }

  // ---- 予測
  const adopted = settings.採用シナリオ;
  for (const f of seed.予測) {
    const id = `予測 ${f.予測ID}`;
    if (!projects.has(f.案件コード)) bad(`${id}: 案件 ${f.案件コード} が種に無い`);
    if (!f.月.endsWith('-01')) bad(`${id}: 月が月初の日でない（${f.月}）`);
    if (f.月 < MONTH_FIRST || f.月 > MONTH_LAST) bad(`${id}: 月が月別の表の範囲の外`);
    if (!(f.区分 in KUBUN) || !SCENARIOS.includes(f.シナリオ) || !['はい', 'いいえ'].includes(f.予測に使う)) bad(`${id}: 区分・シナリオ・予測に使うが語に無い`);
    if (!STATUSES.includes(f.状態)) bad(`${id}: 状態（K-9）が無い（${f.状態}）`);
    if (!yen(f['金額（円・税別）'])) bad(`${id}: 金額が正の整数円でない`);
    if (f.作った日 > seed.as_of) bad(`${id}: 作った日が種の時点より後`);
  }
  for (const [code, rows] of groupBy(seed.予測, f => f.案件コード)) {
    const p = projects.get(code);
    if (!p) continue;
    const live = rows.filter(f => f.予測に使う === 'はい');
    if (new Set(live.map(f => f.版)).size !== 1) bad(`予測 ${code}: 予測に使う版が1つでない`);
    const sales = live.filter(f => (f.シナリオ === adopted || f.シナリオ === '単一') && KUBUN[f.区分]?.[1] === 'はい');
    if (sales.some(f => f.区分 !== INFLOW[p.稼ぎ方])) bad(`予測 ${code}: 売上の元の区分が稼ぎ方の入金の区分と違う`);
    if (sum(sales, '金額（円・税別）') !== p['基準額（円・税別）']) bad(`予測 ${code}: 基準額が採用シナリオの売上の元の入金の合計と違う`);
    for (const sc of ['even', 'MAX']) {
      const alt = live.filter(f => f.シナリオ === sc), base = live.filter(f => f.シナリオ === adopted);
      if (alt.length && alt.length !== base.length) bad(`予測 ${code}: ${sc} と採用シナリオの行の数が違う`);
    }
    // 制作受託: 受託費＝総製作費×率（行動指標の計画の源泉1・J-4）。発注元から受ける総製作費のうち、受託費を除いた分までしか
    // 実費に回せないので、率＋実費の割合 ≦ 100%（超えると受託の案件が原価超過になる）
    const workCost = sum(live.filter(f => f.区分 === '制作の実費'), '金額（円・税別）');
    if (p.稼ぎ方 === '制作受託' && workCost > 0 && workCost * 10000 + p['基準額（円・税別）'] * p.rate_bps > p['基準額（円・税別）'] * 10000) {
      bad(`予測 ${code}: 受託の案件の 率＋制作の実費の割合 が 100% を超える（実費 ${workCost} 円・総製作費 ${p['基準額（円・税別）']} 円・率 ${p.rate_bps} bps）`);
    }
    if (live[0]?.版 === K17_VERSION) {
      // K-17 の既定の予測行: 始まりの月＝最後の活動の期日の月、基準額を12か月に均等（端数は最後の月）、シナリオ＝採用シナリオ。
      // 基準額は率を掛ける前（12か月の合計＝基準額）。K-17 の文言「売上見込を均等」とどちらにするかは #12a の PR で代表が確かめる
      const last = seed.活動記録.filter(a => a.案件コード === code).sort((x, y) => x.日付.localeCompare(y.日付)).at(-1);
      const start = last?.期日 ? `${last.期日.slice(0, 7)}-01` : null;
      const months = live.map(f => f.月).sort();
      const each = Math.floor(p['基準額（円・税別）'] / 12);
      const amounts = [...live].sort((x, y) => x.月.localeCompare(y.月)).map(f => f['金額（円・税別）']);
      if (live.length !== 12 || months.some((m, i) => m !== addMonths(start ?? MONTH_FIRST, i)) || live.some(f => f.シナリオ !== adopted) ||
        amounts.slice(0, 11).some(a => a !== each) || amounts[11] !== p['基準額（円・税別）'] - each * 11) {
        bad(`予測 ${code}: 施策の既定の予測行が K-17 の形（期日の月から12か月・均等・端数は最後の月・採用シナリオ）でない`);
      }
    }
  }
  for (const p of seed.案件) {
    if (p['基準額（円・税別）'] === null && seed.予測.some(f => f.案件コード === p.案件コード)) bad(`案件 ${p.案件コード}: 基準額が未定なのに予測の行がある`);
  }
  const kubunSeen = new Set(seed.予測.map(f => f.区分));
  if (Object.keys(KUBUN).some(k => !kubunSeen.has(k))) bad('予測に区分（入金4・出金5）の全部が出ない');
  if (!seed.予測.some(f => f.予測に使う === 'いいえ')) bad('予測に使わない前の版の行が無い');

  // ---- 活動記録
  for (const [i, a] of seed.活動記録.entries()) {
    const id = `活動記録 ${i + 1} 行目（${a.日付}）`;
    if (!STEPS.includes(a.ステップ) || !RESULTS.includes(a.result)) bad(`${id}: ステップか結果が語に無い`);
    if (a.日付 > seed.as_of || (a.期日 !== null && a.期日 < a.日付)) bad(`${id}: 日付が種の時点より後か、期日が日付より前`);
    // 活動記録の案件は必須（FR-REV-YOJITSU-035）。作品の無い段の行も、企画メモの段階の案件に付ける（要件の要確認18）
    const p = projects.get(a.案件コード);
    if (!p) { bad(`${id}: 案件 ${a.案件コード} が種に無い（活動記録の案件は必須）`); continue; }
    const earning = p.稼ぎ方;
    if (a.稼ぎ方 !== null) bad(`${id}: 案件のある行に稼ぎ方を書いている（案件から取る）`);
    if (a.ステップ === 'その他') {
      if (a.stage !== null) bad(`${id}: その他の行に段がある`);
    } else if (!ACT_STAGES[earning]?.some(([s, step]) => s === a.stage && step === a.ステップ)) {
      bad(`${id}: 段「${a.stage}」→ステップ「${a.ステップ}」が ${earning} の行動の段に無い`);
    }
    if (a.work_code !== null && works.get(a.work_code)?.project_code !== a.案件コード) bad(`${id}: 作品がその案件の作品でない`);
    if (a.result === '失注' && p?.段階 !== '見送り') bad(`${id}: 失注の行の案件が見送りでない`);
    if (!fictionalName(a.相手)) bad(`${id}: 相手が架空の名前でない`);
  }
  for (const p of seed.案件.filter(x => x.段階 === '見送り')) {
    if (!seed.活動記録.some(a => a.案件コード === p.案件コード && a.result === '失注')) bad(`案件 ${p.案件コード}: 見送りなのに失注の行が無い`);
  }
  return out;
}

test('種は #23a の量と語を満たし、入力の表は build_yojitsu.py --seed の形（統合システムの鍵は決まった英字の鍵だけ）', () => {
  const seed = loadSeed();
  assert.deepEqual(violations(seed, loadRm()), []);
  assert.equal(seed.案件.length, 32);
  assert.ok(seed.予測.length >= 735, `予測 ${seed.予測.length} 行`);
  assert.ok(seed.活動記録.length >= 30, `活動記録 ${seed.活動記録.length} 行`);
  // 稼ぎ方5つすべてに案件があり、段階は10段階＋見送りの全部が出る
  for (const e of EARNINGS) assert.ok(seed.案件.filter(p => p.稼ぎ方 === e).length >= 5, e);
  assert.deepEqual(new Set(seed.案件.map(p => p.段階)), new Set(Object.keys(STAGES)));
  // 基準額が未定の案件（0円で埋めない）と、作品の無い案件（制作受託）がある
  assert.ok(seed.案件.some(p => p['基準額（円・税別）'] === null));
  assert.ok(seed.案件.filter(p => p.稼ぎ方 === '制作受託').every(p => !seed.works.some(w => w.project_code === p.案件コード)));
});

test('目標・計画の行は fictional: true の不規則な桁の架空額で、持ち主は公開版の利用者。有効な版は目標＝最新の版、計画＝最新の採用の記録の版', () => {
  const seed = loadSeed();
  assert.ok(seed.目標.length >= 10 && seed.計画.length >= 25);
  for (const t of [...seed.目標, ...seed.計画, ...seed.plan_adoptions]) {
    assert.equal(t.fictional, true);
    assert.equal(t.owner_user_email, OWNER);
  }
  for (const t of seed.目標) assert.ok(irregular(t['目標額（円）']), t.目標ID);
  for (const t of seed.計画) assert.ok(irregular(t['計画額（円・税別）']), t.計画ID);
  // 版を足して残す形を試せる: 目標と計画の1年目に第2版があり、第1版は「改めた」で残る
  assert.ok(seed.目標.some(t => t.版 === 2) && seed.目標.some(t => t.状態 === '改めた'));
  const y1 = seed.plan_adoptions.filter(a => a.period === '1年目').map(a => a.version_no);
  assert.deepEqual(y1, [1, 2]);
  assert.ok(seed.計画.filter(t => t.期間 === '1年目' && t.版 === 1).every(t => t.状態 === '改めた'));
});

test('仮置きの数字に印: 行動の率と1件の額（K-19）、稼ぎ方の既定の売上率、案件の売上率と基準額、予測の行に状態（K-9）がある', () => {
  const seed = loadSeed();
  for (const a of seed.行動) assert.equal(a.状態, '仮置き');
  for (const e of seed.vocabulary.earning_types) assert.ok(STATUSES.includes(e.rate_status), e.name);
  assert.ok(seed.vocabulary.earning_types.filter(e => e.name !== '制作受託').every(e => e.rate_status === '仮置き'));
  for (const p of seed.案件) assert.ok(STATUSES.includes(p.rate_status), p.案件コード);
  const states = new Set(seed.予測.map(f => f.状態));
  assert.ok(STATUSES.every(s => states.has(s)), `予測の状態: ${[...states]}`);
  assert.ok(seed.予測.filter(f => f.状態 === '仮置き').length > seed.予測.length / 2);
});

test('(1) 入金の確認の請求明細の work_id は種の作品に結び、作品から種の案件へたどれる', () => {
  const seed = loadSeed(), rm = loadRm();
  const works = new Map(seed.works.map(w => [w.work_id, w]));
  const projects = new Map(seed.案件.map(p => [p.案件コード, p]));
  let lines = 0;
  for (const inv of rm.inputs.invoices) {
    for (const line of inv.lines) {
      const w = works.get(line.work_id);
      assert.ok(w, `請求 ${inv.invoice_number} の作品 ${line.work_id}`);
      assert.ok(projects.has(w.project_code), `作品 ${w.work_code} の案件`);
      lines++;
    }
  }
  assert.ok(lines > 159);
  // 入金の確認の作品・案件（仮の対応）を種がそのまま持つ
  for (const w of rm.inputs.works) assert.equal(works.get(w.work_id).project_code, w.project_code);
});

test('(2) 入金の行は入金の確認の正解表の消込から作り直した行と一致し、入金の確認の入金の行とも同じ。確認が要る9件は行にしない', () => {
  const seed = loadSeed(), rm = loadRm();
  const want = rebuildActuals(seed, rm);
  const incoming = seed.実績.filter(r => KUBUN[r.区分][0] === '入金');
  assert.equal(incoming.length, want.length);
  // 入金の確認の fixture の yojitsu-actuals.json と、build_yojitsu.py の実績の10列で同じ（種の作品の対応が入金の確認と同じ）
  assert.deepEqual(incoming.map(r => Object.fromEntries(COLS.実績.map(c => [c, r[c]]))), rm.actuals.実績);
  // 入金の行の合計は、自動で一致した請求の税抜額の合計と一致する（取りこぼし・二重計上が無い）
  const invoices = new Map(rm.inputs.invoices.map(v => [v.invoice_number, v]));
  const auto = rm.truth.answers.filter(a => a.outcome === '自動で一致');
  assert.equal(sum(incoming, '金額（円・税別）'), sum(auto.flatMap(a => a.allocations.map(x => invoices.get(x.invoice_number))), 'amount_ex_tax'));
  assert.equal(new Set(incoming.map(r => r.receipt_id)).size, auto.length);
  assert.equal(seed.pending_receipts.length, 9);
  // 出金の行（入金の確認の外）は払った月に引く行で、入金の参照を持たない
  const outgoing = seed.実績.filter(r => KUBUN[r.区分][0] === '出金');
  assert.ok(outgoing.length >= 1 && outgoing.every(r => r.receipt_id === null));
});

test('制作費の版は全作品にあり、出資の記録から作った第1版・契約書の第1版・追加の契約の第2版・内訳（制作費・P&A）の形がそろう', () => {
  const seed = loadSeed();
  const kinds = new Set(seed.production_cost_versions.map(v => v.basis_kind));
  for (const k of ['出資額（作品の費用の版）', '出資額（委員会の条件版）', '契約書', '追加の契約']) assert.ok(kinds.has(k), k);
  assert.ok(seed.production_cost_versions.some(v => v.breakdown));
  // 「制作費の版なし」の作品は0（フェーズ1の伸ばす指標）
  const withVersion = new Set(seed.production_cost_versions.map(v => v.work_code));
  assert.equal(seed.works.filter(w => !withVersion.has(w.work_code)).length, 0);
});

test('P&A の負担者は4種がそろい、会社の入口の「予算超過」(a)(b) と、追加の契約で超過が収まった作品を架空の作品で試せる', () => {
  const seed = loadSeed();
  const latest = new Map(seed.production_cost_versions.map(v => [v.work_code, v]));  // 版の順に並ぶので最後が最新
  const first = new Map([...seed.production_cost_versions].reverse().map(v => [v.work_code, v]));
  const spent = (code, category) => sum(seed.expenses.filter(x => x.work_code === code && x.category === category), 'amount_ex_tax');
  const costBase = v => v.breakdown ? v.breakdown[0].amount_yen : v.amount_yen;
  // (a) 制作費の版（税抜）より費用区分「制作費」の経費（税抜）が大きい作品
  const overCost = seed.works.filter(w => spent(w.work_code, '制作費') > costBase(latest.get(w.work_code)));
  // (b) P&A の予算より宣伝費の経費が大きい作品（負担者別の絞りは #24 のあと）
  const budgets = new Map(seed.pa_budgets.map(b => [b.work_code, b.promotion_budget_yen]));
  const overPa = seed.works.filter(w => spent(w.work_code, '宣伝費') > budgets.get(w.work_code));
  assert.ok(overCost.length >= 1, '制作費の超過');
  assert.ok(overPa.length >= 1, 'P&A の予算超過');
  // 第1版では超えるが、追加の契約の第2版で収まる作品（版を見ずに第1版と比べると誤る）
  assert.ok(seed.works.some(w => latest.get(w.work_code).version_no > 1 && spent(w.work_code, '制作費') > costBase(first.get(w.work_code)) &&
    spent(w.work_code, '制作費') <= costBase(latest.get(w.work_code))));
  assert.deepEqual(new Set(seed.expenses.filter(x => x.bearer).map(x => x.bearer)), new Set(PA_BEARERS));
  // 計上済みで未払の経費がある（入金ベースでは出金に数えず、計上ベースでは数える差を試せる）
  assert.ok(seed.expenses.some(x => x.paid_on === null && x.accounting_month <= seed.as_of), '未払の経費');
});

test('予測: 基準額＝採用シナリオの売上の元の入金の合計、施策の既定の予測行は K-17 の形、前の版は予測に使わない、見送りの案件の行も残る', () => {
  const seed = loadSeed();
  const k17 = new Set(seed.予測.filter(f => f.版 === K17_VERSION).map(f => f.案件コード));
  assert.ok(k17.size >= 3, `既定の予測行の案件 ${k17.size}`);
  const scenarios = new Set(seed.予測.map(f => f.シナリオ));
  for (const sc of SCENARIOS) assert.ok(scenarios.has(sc), sc);
  const dropped = new Set(seed.案件.filter(p => p.段階 === '見送り').map(p => p.案件コード));
  assert.ok(seed.予測.some(f => dropped.has(f.案件コード)), '見送りの案件の予測の行（月別の表の範囲で外れることを試す）');
  // 期日を過ぎた次の一手（会社の入口の例外「次の一手の期限切れ」）がある
  const lastByProject = groupBy(seed.活動記録.filter(a => a.案件コード), a => a.案件コード);
  const overdue = [...lastByProject.values()].map(rows => rows.at(-1)).filter(a => a.期日 && a.期日 < seed.as_of);
  assert.ok(overdue.length >= 1);
  assert.ok(overdue.every(a => a.result === '保留' && a.次の一手), '期限切れの次の一手は、進めていない（保留の）行だけ');
});

test('わざと壊した種では、壊した観点の検査が落ちる', () => {
  const base = loadSeed(), rm = loadRm();
  const firstIncoming = base.実績.findIndex(r => r.receipt_id !== null);
  const cases = [
    ['案件を1件落とす', s => { s.案件.pop(); }, /案件が 31 件/],
    ['活動記録の案件コードを空にする（作品の無い段の行も案件が必須）', s => { s.活動記録.find(a => a.案件コード === 'YJ-P31').案件コード = null; }, /案件 null が種に無い（活動記録の案件は必須）/],
    ['目標の行から fictional の印を外す', s => { delete s.目標[0].fictional; s.目標[0].owner_user_email = OWNER; }, /鍵が入力の表の列|fictional の印が無い/],
    ['計画の額を切りのよい額にする', s => { s.計画[0]['計画額（円・税別）'] = 10_000_000; }, /不規則な桁/],
    ['計画の有効の印を前の版に付ける', s => { s.計画.find(t => t.版 === 1 && t.期間 === '1年目').状態 = '有効'; }, /最新の採用の記録/],
    ['目標の第2版を消して第1版を改めたのまま残す', s => { s.目標 = s.目標.filter(t => t.版 !== 2); }, /有効が最新の版/],
    ['行動の率を K-19 と違う値にする', s => { s.行動[0]['面談→提案の率'] = 0.4; }, /K-19/],
    ['作品の案件を種に無い案件にする', s => { s.works[0].project_code = 'YJ-P99'; }, /案件 YJ-P99 が種に無い/],
    ['入金の行の金額を1円変える', s => { s.実績[firstIncoming]['金額（円・税別）'] += 1; }, /消込から作った値と違う/],
    ['確認が要る入金を入金の行にする', s => { s.実績[firstIncoming].receipt_id = s.pending_receipts[0].receipt_id; }, /承認の前に入金の行/],
    ['予測の月を15日にする', s => { s.予測[0].月 = s.予測[0].月.replace(/-01$/, '-15'); }, /月初の日でない/],
    ['予測の状態を空にする', s => { s.予測[0].状態 = null; }, /状態（K-9）が無い/],
    ['基準額を1円変える', s => { s.案件.find(p => p['基準額（円・税別）'] && s.予測.some(f => f.案件コード === p.案件コード))['基準額（円・税別）'] += 1; }, /基準額が採用シナリオ/],
    ['既定の予測行の端数を最初の月に寄せる', s => {
      const rows = s.予測.filter(f => f.版 === K17_VERSION).sort((x, y) => x.案件コード.localeCompare(y.案件コード) || x.月.localeCompare(y.月)).slice(0, 12);
      const rest = rows[11]['金額（円・税別）'] - rows[0]['金額（円・税別）'];
      if (rest === 0) { rows[0]['金額（円・税別）'] += 1; rows[11]['金額（円・税別）'] -= 1; } else { rows[0]['金額（円・税別）'] += rest; rows[11]['金額（円・税別）'] -= rest; }
    }, /K-17 の形/],
    ['活動記録の段を別の稼ぎ方の段にする', s => { s.活動記録.find(a => a.stage === '条件書').stage = '内諾'; }, /行動の段に無い/],
    ['制作費の版の番号を飛ばす', s => { s.production_cost_versions.find(v => v.version_no === 2).version_no = 3; }, /連番でない/],
    ['案件を始めた日を出資の払込より後にする', s => { s.案件.find(p => p.稼ぎ方 === '自社出資').始めた日 = '2026-11-29'; }, /払込 が案件 .* を始めた日より前/],
    ['第2版を第1版より前に記録する', s => { const v = s.production_cost_versions.find(x => x.version_no === 2); v.recorded_on = v.signed_on = '2026-01-05'; }, /記録した日が前の版より前/],
    ['作品の制作費の版を全部消す', s => { s.production_cost_versions = s.production_cost_versions.filter(v => v.work_code !== s.works[0].work_code); }, /制作費の版が無い/],
    ['制作費の実費に負担者を付ける', s => { s.expenses.find(x => x.category === '制作費').bearer = '自社'; }, /負担者は P&A/],
    ['委員会の作品でない P&A を委員会の負担にする', s => {
      const x = s.expenses.find(e => e.bearer === '自社'); x.bearer = '委員会';
    }, /委員会の作品でない/],
    ['委員会の出資者の額を1円変える', s => { s.investments.find(x => x.kind === '製作委員会').members[1].amount_yen += 1; }, /出資者の額の和/],
    ['受託の案件の制作の実費を総製作費の9割を超える額にする', s => {
      const code = s.案件.find(p => p.稼ぎ方 === '制作受託' && s.予測.some(f => f.案件コード === p.案件コード && f.区分 === '制作の実費')).案件コード;
      const p = s.案件.find(x => x.案件コード === code);
      const rows = s.予測.filter(f => f.案件コード === code && f.区分 === '制作の実費' && f.予測に使う === 'はい');
      rows[0]['金額（円・税別）'] += Math.ceil(p['基準額（円・税別）'] * 9 / 10) - sum(rows, '金額（円・税別）') + 1;
    }, /率＋制作の実費の割合 が 100% を超える/],
    ['未払の経費に種の時点より後の支払日を入れる', s => { s.expenses.at(-1).paid_on = '2026-12-21'; }, /支払日が種の時点より後/],
    ['出資が負担した P&A を出資に含む P&A の枠より多くする', s => {
      const x = s.investments.find(v => v.includes_pa);
      s.expenses.find(e => e.work_code === x.work_code && e.bearer === '出資').amount_ex_tax += x.pa_yen;
    }, /出資に含む P&A \d+ 円を超える/],
    ['目標（会社）を本人の半分にする', s => {
      const self = s.目標.find(t => t.目標の種類 === '本人' && t.期間 === '1年目' && t.状態 === '有効')['目標額（円）'];
      s.目標.find(t => t.目標の種類 === '会社' && t.期間 === '1年目')['目標額（円）'] = Math.floor(self / 2) + 7;
    }, /会社÷本人が 2\/3 でない/],
  ];
  for (const [label, breakIt, pattern] of cases) {
    const seed = structuredClone(base);
    breakIt(seed);
    const found = violations(seed, rm);
    assert.ok(found.some(v => pattern.test(v)), `${label}: ${JSON.stringify(found.slice(0, 5))}`);
  }
});

test('種が読んだ入金の確認の fixture は置いてあるものと同じ（入金の確認を作り直したら種も作り直す）', () => {
  const seed = loadSeed();
  const sha = name => createHash('sha256').update(text(rmDir, name), 'utf8').digest('hex');
  assert.deepEqual(seed.sources, Object.fromEntries(RM_FILES.map(name => [`receipt-matching/${name}`, sha(name)])));
});

const python = process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const probe = spawnSync(python, ['--version'], {encoding: 'utf8'});
const hasPython = !probe.error && probe.status === 0;

test('生成スクリプトは同じ種で2回作って同じバイト列で、置いてある seed.json と一致し、build_yojitsu.py に渡す写しは列の名前だけ', {skip: hasPython ? false : `Python が無い（${python}）`}, () => {
  const outs = [];
  try {
    for (let i = 0; i < 2; i++) {
      const out = mkdtempSync(join(tmpdir(), 'yojitsu-seed-'));
      outs.push(out);
      const run = spawnSync(python, [join(dir, 'generate.py'), '--out', out, '--build-yojitsu-input', join(out, 'build-yojitsu-input.json')], {encoding: 'utf8'});
      assert.equal(run.status, 0, run.stderr);
    }
    assert.equal(readFileSync(join(outs[0], 'seed.json'), 'utf8'), readFileSync(join(outs[1], 'seed.json'), 'utf8'), 'seed.json が2回で違う');
    assert.equal(readFileSync(join(outs[0], 'seed.json'), 'utf8'), text(dir, 'seed.json'), 'seed.json が置いてある fixture と違う（作り直してコミットする）');
    const input = JSON.parse(readFileSync(join(outs[0], 'build-yojitsu-input.json'), 'utf8'));
    assert.deepEqual(Object.keys(input), [...Object.keys(COLS), '行動', '設定', '試算の案件']);
    for (const [name, cols] of Object.entries(COLS)) {
      for (const row of input[name]) assert.deepEqual(Object.keys(row), cols, name);
    }
    for (const row of input.行動) assert.deepEqual(Object.keys(row), ACTION_HEADS);
    assert.equal(input.予測.length, loadSeed().予測.length);
  } finally {
    for (const out of outs) rmSync(out, {recursive: true, force: true});
  }
});
