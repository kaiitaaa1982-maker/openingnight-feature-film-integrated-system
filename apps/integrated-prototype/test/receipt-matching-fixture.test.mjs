// 入金の確認の架空データ（test/fixtures/receipt-matching/。会社ルート plans/2026-10-08-loop-and-exception-ux.md の #3）が、
// 突き合わせ（同 #5）の正解表として使えるかを確かめる。期待値は計画・モックの案A と brain の ontology「業務フローの語彙」から持ち、
// 生成スクリプト（generate.py）を読まない。統合システムの関数も使わない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const dir = fileURLToPath(new URL('./fixtures/receipt-matching/', import.meta.url));
const FILES = ['invoices.json', 'receipts.json', 'answers.json', 'yojitsu-actuals.json'];
// 手元の Windows は autocrlf で CRLF になって出てくる。リポジトリの中身（LF）に戻して読む
const text = (folder, name) => readFileSync(join(folder, name), 'utf8').replace(/\r\n/g, '\n');
const load = () => ({
  inputs: JSON.parse(text(dir, 'invoices.json')),
  receipts: JSON.parse(text(dir, 'receipts.json')).receipts,
  truth: JSON.parse(text(dir, 'answers.json')),
  actuals: JSON.parse(text(dir, 'yojitsu-actuals.json')),
});

// brain wiki/01_rules/ontology.md「業務フローの語彙」（2026-10-09）: 差額の原因の5語、語で説明できない残り、名義が辞書に無い
const CAUSES = ['銀行手数料', '外国で源泉された額', '為替の確定', '返品の相殺', '一部入金'];
const LEFTOVERS = ['請求前の入金', '二重入金の疑い', '対応なし'];
const NAME_MISSING = '名義が辞書に無い';
const AUTO = '自動で一致', REVIEW = '確認が要る';
// 会社ルート ORG/事業計画/_build/build_yojitsu.py の COLS["実績"]（列と並び）と、入金で売上の元になる区分（KUBUN）
const ACTUAL_COLS = ['実績ID', '日付', '案件コード', '区分', '項目', '相手', '金額（円・税別）', '証憑', '記録した日', 'メモ'];
const SALES_KUBUN = ['流通売上', '販売委託の売上', '受託収益'];

const sum = (rows, field = 'amount_yen') => rows.reduce((n, row) => n + row[field], 0);
const positiveYen = value => Number.isInteger(value) && value > 0;

// 正解表の不変条件。破れた所を文で返す（壊した正解表でも同じ関数で落ちることを確かめる）
function violations({inputs, receipts, answers}) {
  const out = [];
  const invoices = new Map(inputs.invoices.map(v => [v.invoice_number, v]));
  const dictionary = new Map(inputs.payer_dictionary.map(d => [d.payer_name, d.partner_code]));
  const byId = new Map(answers.map(a => [a.receipt_id, a]));
  const allocated = new Map();
  if (receipts.length !== 128) out.push(`入金が ${receipts.length} 件（128 件のはず）`);
  if (answers.length !== receipts.length || byId.size !== answers.length) out.push(`正解が ${answers.length} 件で、入金と1対1でない`);
  for (const r of receipts) {
    const a = byId.get(r.receipt_id);
    if (!a) { out.push(`入金 ${r.receipt_id} の正解が無い`); continue; }
    const id = `入金 ${r.receipt_id}`;
    const allocation = sum(a.allocations), deduction = sum(a.deductions);
    if (allocation + a.unapplied_yen !== r.amount_yen + deduction) {
      out.push(`${id}: 消込 ${allocation}＋未充当 ${a.unapplied_yen} が 入金 ${r.amount_yen}＋控除 ${deduction} と合わない`);
    }
    if (!Number.isInteger(a.unapplied_yen) || a.unapplied_yen < 0) out.push(`${id}: 未充当 ${a.unapplied_yen} が0以上の整数でない`);
    for (const d of a.deductions) {
      // 一部入金は残りを請求に残す（入金予定の変更で承認する）ので、控除の行にしない
      if (!CAUSES.includes(d.kind) || d.kind === '一部入金') out.push(`${id}: 控除の種類「${d.kind}」が語彙に無い`);
      if (!positiveYen(d.amount_yen)) out.push(`${id}: 控除 ${d.kind} の額 ${d.amount_yen} が正の整数円でない`);
      if (d.kind === '外国で源泉された額' && !(typeof d.country === 'string' && Number.isInteger(d.rate_bps) && typeof d.certificate_received === 'boolean')) {
        out.push(`${id}: 外国で源泉された額の行に国・税率・納税の証明書の有無が無い`);
      }
    }
    const partner = dictionary.get(r.payer_name) ?? null;
    if (a.partner_code !== partner) out.push(`${id}: 取引先 ${a.partner_code} が名寄せの辞書（${partner}）と違う`);
    for (const x of a.allocations) {
      const v = invoices.get(x.invoice_number);
      if (!v) { out.push(`${id}: 請求 ${x.invoice_number} が無い`); continue; }
      if (!positiveYen(x.amount_yen)) out.push(`${id}: 請求 ${x.invoice_number} への消込 ${x.amount_yen} が正の整数円でない`);
      if (v.partner_code !== partner) out.push(`${id}: 請求 ${x.invoice_number} は別の取引先（${v.partner_code}）`);
      if (v.invoice_date > r.received_on) out.push(`${id}: 請求 ${x.invoice_number} の請求日 ${v.invoice_date} が入金日 ${r.received_on} より後`);
      allocated.set(x.invoice_number, (allocated.get(x.invoice_number) ?? 0) + x.amount_yen);
    }
    if (a.outcome === AUTO) {
      if (a.deductions.length || a.unapplied_yen || a.review !== null) out.push(`${id}: 自動で一致なのに控除・未充当・確認の理由がある`);
    } else if (a.outcome === REVIEW) {
      const reasons = a.review?.reasons ?? [];
      if (!reasons.length) out.push(`${id}: 確認が要るのに理由が無い`);
      for (const reason of reasons) {
        if (![...CAUSES, ...LEFTOVERS, NAME_MISSING].includes(reason)) out.push(`${id}: 確認の理由「${reason}」が語彙に無い`);
      }
      if ((partner === null) !== reasons.includes(NAME_MISSING)) out.push(`${id}: 名義が辞書に無いかどうかと理由が合わない`);
    } else {
      out.push(`${id}: 結果「${a.outcome}」が自動で一致・確認が要るのどちらでもない`);
    }
  }
  for (const [number, total] of allocated) {
    const v = invoices.get(number);
    if (total > v.amount_inc_tax) out.push(`請求 ${number}: 消込の合計 ${total} が請求額 ${v.amount_inc_tax} を超える`);
  }
  const review = answers.filter(a => a.outcome === REVIEW).length;
  if (review !== 9) out.push(`確認が要るが ${review} 件（9 件のはず）`);
  if (answers.filter(a => a.outcome === AUTO).length !== receipts.length - 9) out.push('自動で一致が 128 − 9 件でない');
  return out;
}

test('正解表は128件で、消込の合計＝入金額＋控除・各請求の消込は請求額以下・請求日は入金日以前・控除の種類は語彙の中、確認が要るのは9件', () => {
  const {inputs, receipts, truth} = load();
  assert.deepEqual(violations({inputs, receipts, answers: truth.answers}), []);
  assert.equal(receipts.length, 128);
  assert.equal(truth.answers.filter(a => a.outcome === REVIEW).length, 9);
  // 未充当の無い入金（自動で一致の119件と、差額を説明し切った確認の分）は、消込の合計が入金額＋控除にちょうどなる
  const closed = truth.answers.filter(a => a.unapplied_yen === 0 && a.allocations.length);
  assert.equal(closed.length, 119 + 5);
  const amount = new Map(receipts.map(r => [r.receipt_id, r.amount_yen]));
  for (const a of closed) assert.equal(sum(a.allocations), amount.get(a.receipt_id) + sum(a.deductions), `入金 ${a.receipt_id}`);
  const outcome = new Map(truth.answers.map(a => [a.receipt_id, a.outcome]));
  const counts = {};
  for (const reason of truth.answers.flatMap(a => a.review?.reasons ?? [])) counts[reason] = (counts[reason] ?? 0) + 1;
  assert.deepEqual(truth.summary, {
    receipts: 128, [AUTO]: 119, [REVIEW]: 9,
    [`${AUTO}の入金額`]: sum(receipts.filter(r => outcome.get(r.receipt_id) === AUTO)),
    [`${REVIEW}の入金額`]: sum(receipts.filter(r => outcome.get(r.receipt_id) === REVIEW)),
    理由ごとの件数: counts,
  });
});

test('わざと壊した正解表では、壊した観点の検査が落ちる', () => {
  const base = load();
  const answers = base.truth.answers;
  const find = predicate => answers.findIndex(predicate);
  const autoIndex = find(a => a.outcome === AUTO);
  const duplicate = find(a => a.review?.reasons.includes('二重入金の疑い'));
  const bundledFee = find(a => a.review?.reasons.join() === '銀行手数料' && a.deductions.length === 1);
  const withDeduction = find(a => a.deductions.length > 0);
  const cases = [
    ['消込を1円増やす', d => { d.answers[autoIndex].allocations[0].amount_yen += 1; }, /と合わない/],
    ['控除の種類を語彙に無い語にする', d => { d.answers[withDeduction].deductions[0].kind = '値引き'; }, /控除の種類「値引き」が語彙に無い/],
    ['一部入金を控除の行にする', d => { d.answers[withDeduction].deductions[0].kind = '一部入金'; }, /控除の種類「一部入金」が語彙に無い/],
    ['二重入金の疑いの入金で、まとめ払いの請求をもう一度消し込む', d => {
      const again = d.answers[bundledFee].allocations[0];
      d.answers[duplicate].allocations.push({...again});
      d.answers[duplicate].unapplied_yen -= again.amount_yen;
    }, /消込の合計 \d+ が請求額 \d+ を超える/],
    ['請求日を入金日の翌日にする', d => {
      const a = d.answers[autoIndex], r = d.receipts.find(x => x.receipt_id === a.receipt_id);
      const v = d.inputs.invoices.find(x => x.invoice_number === a.allocations[0].invoice_number);
      v.invoice_date = new Date(Date.parse(r.received_on) + 86400000).toISOString().slice(0, 10);
    }, /入金日 .* より後/],
    ['確認が要る1件を自動で一致にする', d => { d.answers[bundledFee].outcome = AUTO; }, /確認が要るが 8 件/],
    ['振込名義を別の取引先の名義にする', d => {
      const r = d.receipts.find(x => x.receipt_id === d.answers[autoIndex].receipt_id);
      r.payer_name = d.inputs.payer_dictionary.find(x => x.partner_code !== d.answers[autoIndex].partner_code).payer_name;
    }, /名寄せの辞書/],
    ['入金を1件落とす', d => { d.receipts.pop(); d.answers.pop(); }, /入金が 127 件/],
  ];
  for (const [label, breakIt, pattern] of cases) {
    const data = structuredClone({inputs: base.inputs, receipts: base.receipts, answers});
    breakIt(data);
    const found = violations(data);
    assert.ok(found.some(v => pattern.test(v)), `${label}: ${JSON.stringify(found)}`);
  }
});

// 取引先の未消込の請求（請求日が入金日以前）から、残高の合計が amount になる組をすべて数える（組の大きさに上限を置かない）
function matchingSets(open, balance, amount) {
  if (open.length > 20) throw new Error(`未消込の請求が ${open.length} 件で多すぎる`);
  const found = [];
  for (let mask = 1; mask < 1 << open.length; mask++) {
    let total = 0;
    const picked = [];
    for (let i = 0; i < open.length; i++) if (mask & (1 << i)) { total += balance.get(open[i].invoice_number); picked.push(open[i].invoice_number); }
    if (total === amount) found.push(picked.sort().join(','));
  }
  return found;
}

test('自動で一致の119件は、その時点で金額が合う請求の組がちょうど1つで、確認が要る9件は合う組が無い（正解が1つに決まる）', () => {
  const {inputs, receipts, truth} = load();
  const dictionary = new Map(inputs.payer_dictionary.map(d => [d.payer_name, d.partner_code]));
  const answer = new Map(truth.answers.map(a => [a.receipt_id, a]));
  const balance = new Map(inputs.invoices.map(v => [v.invoice_number, v.amount_inc_tax]));
  const ordered = [...receipts].sort((x, y) => x.bank_line - y.bank_line);
  let auto = 0, bundles = 0;
  for (const r of ordered) {
    const a = answer.get(r.receipt_id);
    const partner = dictionary.get(r.payer_name);
    const open = inputs.invoices.filter(v => balance.get(v.invoice_number) > 0 && v.invoice_date <= r.received_on);
    if (partner === undefined) {
      // 名義が辞書に無い入金は、全取引先の同じ額の未消込を候補に出す
      const hits = open.filter(v => balance.get(v.invoice_number) === r.amount_yen).map(v => v.invoice_number).sort();
      assert.deepEqual(a.review.candidates.map(c => c.invoice_number).sort(), hits, `入金 ${r.receipt_id}`);
      assert.equal(hits.length, 2, '候補は2社');
    } else {
      const sets = matchingSets(open.filter(v => v.partner_code === partner), balance, r.amount_yen);
      if (a.outcome === AUTO) {
        auto++;
        if (a.allocations.length > 1) bundles++;
        assert.deepEqual(sets, [a.allocations.map(x => x.invoice_number).sort().join(',')], `入金 ${r.receipt_id}`);
      } else {
        assert.deepEqual(sets, [], `入金 ${r.receipt_id}`);
      }
    }
    for (const x of a.allocations) {
      balance.set(x.invoice_number, balance.get(x.invoice_number) - x.amount_yen);
      assert.equal(balance.get(x.invoice_number), x.balance_after_yen, `入金 ${r.receipt_id} の後の請求 ${x.invoice_number} の残高`);
    }
  }
  assert.equal(auto, 119);
  assert.ok(bundles >= 5, `まとめ払いが ${bundles} 件`);
  // 取引先を見ずに額だけで当てると誤る紛れ（別の取引先に同じ額の未消込がある）と、請求日を見ないと誤る紛れがある
  const amounts = new Map();
  for (const v of inputs.invoices) amounts.set(v.amount_inc_tax, [...(amounts.get(v.amount_inc_tax) ?? []), v]);
  const twins = [...amounts.values()].filter(list => list.length > 1);
  assert.ok(twins.some(list => new Set(list.map(v => v.partner_code)).size > 1 && list.some(v => v.amount_inc_tax !== 77000)), '別の取引先に同じ額');
  assert.ok(twins.some(list => new Set(list.map(v => v.partner_code)).size === 1), '同じ取引先に同じ額（請求日で分かれる）');
});

test('確認が要る9件は、計画で選んだ受信箱（案A）のモックの9件と同じ理由と見え方の型', () => {
  const {truth} = load();
  const review = truth.answers.filter(a => a.outcome === REVIEW);
  const shape = review.map(a => `${a.review.level}:${a.review.reasons.join('+')}`).sort();
  // 会社ルート plans/_mocks/2026-10-08-exception-review/receipt-review.html の9件（ok＝内訳が根拠で説明できる、warn＝一部に確認が要る、bad＝決められない）
  assert.deepEqual(shape, [
    'bad:二重入金の疑い',
    'bad:名義が辞書に無い',
    'bad:請求前の入金',
    'bad:銀行手数料',
    'ok:銀行手数料',
    'warn:一部入金',
    'warn:外国で源泉された額+為替の確定+銀行手数料',
    'warn:為替の確定',
    'warn:返品の相殺',
  ].sort());
  // 差額の原因の5語はすべて出る。語で説明できない残りは、請求前の入金と二重入金の疑い（対応なしはモックに無い）
  const reasons = new Set(review.flatMap(a => a.review.reasons));
  for (const cause of CAUSES) assert.ok(reasons.has(cause), cause);
  assert.deepEqual(LEFTOVERS.filter(x => reasons.has(x)), ['請求前の入金', '二重入金の疑い']);
  // 説明できた額と残り: 差額＝説明できた額＋残り
  for (const a of review) {
    const {difference_yen: difference, explained_yen: explained, remaining_yen: remaining, breakdown} = a.review;
    assert.equal(explained, sum(breakdown), `入金 ${a.receipt_id}`);
    if (difference === null) assert.equal(remaining, null);
    else assert.equal(difference - explained, remaining, `入金 ${a.receipt_id}`);
  }
});

// 小数の文字（"147.0600"・"14000.00"）を、分子と10の冪の分母の BigInt にする
const decimal = s => {
  const [whole, frac = ''] = s.split('.');
  return {n: BigInt(whole + frac), d: 10n ** BigInt(frac.length)};
};
// 外貨×レートを0に向かって切り捨てた円（要件 FR-REV-INTAKE-082）
const yen = (amount, rate) => {
  const a = decimal(amount), r = decimal(rate);
  return Number((a.n * r.n) / (a.d * r.d));
};

test('外貨の入金の控除と残りは、為替の表と契約の税率から1円まで説明できる（入金日のレートで確定）', () => {
  const {inputs, receipts, truth} = load();
  const rate = (currency, date) => inputs.rates.find(x => x.currency === currency && x.date === date).ttm;
  const invoices = new Map(inputs.invoices.map(v => [v.invoice_number, v]));
  const contract = new Map(inputs.contracts.map(c => [c.partner_code, c]));
  const foreign = receipts.filter(r => r.currency !== 'JPY');
  assert.equal(foreign.length, 2);
  for (const r of foreign) {
    const a = truth.answers.find(x => x.receipt_id === r.receipt_id);
    const v = invoices.get(a.allocations[0].invoice_number);
    const atReceipt = rate(r.currency, r.received_on);
    assert.equal(v.amount_inc_tax, yen(v.foreign_amount, rate(v.currency, v.report_date)), '請求の円＝外貨×報告の日のレート');
    const kinds = Object.fromEntries(a.deductions.map(d => [d.kind, d]));
    // 為替の確定＝報告の日のレートの円 − 入金日のレートの円
    assert.equal(kinds['為替の確定'].amount_yen, v.amount_inc_tax - yen(v.foreign_amount, atReceipt));
    const bps = contract.get(a.partner_code).foreign_withholding_bps;
    if (bps) {
      const w = kinds['外国で源泉された額'];
      assert.equal(w.rate_bps, bps);
      assert.equal(decimal(w.foreign_amount).n * 10000n, decimal(v.foreign_amount).n * BigInt(bps), '源泉された外貨＝請求の外貨×税率');
      assert.equal(w.amount_yen, yen(w.foreign_amount, atReceipt));
      assert.equal(w.country, inputs.partners.find(p => p.partner_code === a.partner_code).country);
    } else {
      assert.equal(kinds['外国で源泉された額'], undefined);
    }
    // 届いた外貨を入金日のレートで円にした額と、届いた円との差が銀行手数料（当方負担）か、説明できない残り
    const gap = yen(r.foreign_amount, atReceipt) - r.amount_yen;
    if (gap > 0) assert.equal(kinds['銀行手数料'].amount_yen, gap);
    else assert.equal(a.unapplied_yen, -gap);
  }
});

test('正解表の消込から、案件コード付きの入金の行（build_yojitsu.py の実績の10列）を取り出せる', () => {
  const {inputs, receipts, truth, actuals} = load();
  const invoices = new Map(inputs.invoices.map(v => [v.invoice_number, v]));
  const project = new Map(inputs.works.map(w => [w.work_id, w.project_code]));
  const earning = new Map(inputs.projects.map(p => [p.project_code, p.earning_type]));
  const receipt = new Map(receipts.map(r => [r.receipt_id, r]));
  // 自動で一致の消込 → 請求明細の work_id → 作品の案件コード。全額を消した請求なので税別は明細の税抜額の和
  const expected = new Map();
  for (const a of truth.answers.filter(x => x.outcome === AUTO)) {
    const r = receipt.get(a.receipt_id);
    for (const x of a.allocations) {
      const v = invoices.get(x.invoice_number);
      assert.equal(x.amount_yen, v.amount_inc_tax, '自動で一致は請求を全額消す');
      for (const line of v.lines) {
        const code = project.get(line.work_id);
        assert.ok(code, `作品 ${line.work_id} に案件が無い`);
        const k = `${r.reference}|${v.invoice_number}|${code}`;
        const row = expected.get(k) ?? {日付: r.received_on, 案件コード: code, 金額: 0, 相手: a.partner_code};
        row.金額 += line.amount_ex_tax;
        expected.set(k, row);
      }
    }
  }
  const partnerName = new Map(inputs.partners.map(p => [p.partner_code, p.name]));
  const rows = actuals['実績'];
  assert.deepEqual(actuals.columns, ACTUAL_COLS);
  assert.equal(new Set(rows.map(row => row['実績ID'])).size, rows.length);
  const got = new Map();
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), ACTUAL_COLS);
    assert.ok(SALES_KUBUN.includes(row['区分']), row['区分']);
    assert.ok(['自社出資', '製作委員会', '買付'].includes(earning.get(row['案件コード'])), `作品のある稼ぎ方: ${row['案件コード']}`);
    const [, reference, number] = row['証憑'].match(/^入金 (\S+)・請求 (\S+)$/);
    got.set(`${reference}|${number}|${row['案件コード']}`, row);
  }
  assert.deepEqual([...got.keys()].sort(), [...expected.keys()].sort());
  for (const [k, want] of expected) {
    const row = got.get(k);
    assert.equal(row['日付'], want.日付, k);
    assert.equal(row['金額（円・税別）'], want.金額, k);
    assert.equal(row['相手'], partnerName.get(want.相手), k);
  }
  // 案件ごとの合計が、自動で一致した請求の税抜額の合計と一致する（取りこぼし・二重計上が無い）
  const autoInvoices = truth.answers.filter(a => a.outcome === AUTO).flatMap(a => a.allocations.map(x => invoices.get(x.invoice_number)));
  assert.equal(sum(rows, '金額（円・税別）'), sum(autoInvoices, 'amount_ex_tax'));
  // 確認が要る9件は承認するまで登録しないので、行にせず pending に残す
  assert.deepEqual(actuals.pending.map(p => p.receipt_id).sort((x, y) => x - y),
    truth.answers.filter(a => a.outcome === REVIEW).map(a => a.receipt_id).sort((x, y) => x - y));
});

test('正解表が置いてある入力から作ったもので、入金の行が置いてある正解表から作ったものである（ハッシュが一致）', () => {
  const {truth, actuals} = load();
  const sha = name => createHash('sha256').update(text(dir, name), 'utf8').digest('hex');
  assert.deepEqual(truth.inputs_sha256, {'invoices.json': sha('invoices.json'), 'receipts.json': sha('receipts.json')});
  assert.equal(actuals.answers_sha256, sha('answers.json'));
  for (const doc of [load().inputs, JSON.parse(text(dir, 'receipts.json')), truth, actuals]) assert.equal(doc.fictional, true);
});

const python = process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const probe = spawnSync(python, ['--version'], {encoding: 'utf8'});
const hasPython = !probe.error && probe.status === 0;

test('生成スクリプトは同じ種で2回作って同じバイト列になり、置いてある fixture と一致する', {skip: hasPython ? false : `Python が無い（${python}）`}, () => {
  const outs = [];
  try {
    for (let i = 0; i < 2; i++) {
      const out = mkdtempSync(join(tmpdir(), 'receipt-matching-'));
      outs.push(out);
      const run = spawnSync(python, [join(dir, 'generate.py'), '--out', out], {encoding: 'utf8'});
      assert.equal(run.status, 0, run.stderr);
    }
    for (const name of FILES) {
      assert.equal(readFileSync(join(outs[0], name), 'utf8'), readFileSync(join(outs[1], name), 'utf8'), `${name} が2回で違う`);
      assert.equal(readFileSync(join(outs[0], name), 'utf8'), text(dir, name), `${name} が置いてある fixture と違う（作り直してコミットする）`);
    }
  } finally {
    for (const out of outs) rmSync(out, {recursive: true, force: true});
  }
});
