import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {
  normalizeInvoice, receiptCandidates, partnerOptions, existingReceipts, normalizeReference, findDuplicateReceipts, defaultAllocation,
  initialReceiptState, setReceiptField, toggleInvoice, setAllocationText, autoAllocate, summarizeReceipt, validateReceipt,
  invoiceState, planRequestState, OPEN_BALANCE_AS_OF, DUPLICATE_NOTE_PREFIX, MAX_ALLOCATIONS,
  receiptSheetRows, receiptSheetTotals, pendingPlanRequests, billingInvoiceRows, billingSummary, receiptHistoryRows,
  taxCalculateBlockers, taxLedgerTotals, taxLedgerRows, taxRuleRows, latestRuleVersion, validateTaxRule,
} from '../src/billing/receipt-model.mjs';

// 架空の請求（/api/receipt-sheet の rows と同じ形）
const sheetRows = () => ([
  {id: 11, invoice_number: 'ON-INV-202609-0001', partner_id: 2, partner_name: '架空配信', invoice_date: '2026-09-10', due_date: '2026-10-31', plannedDate: '2026-10-31',
    amount_inc_tax: 110000, status: 'issued', voided_on: null, isVoid: false,
    events: [{receipt_id: 1, reference: 'PAY-1', received_on: '2026-10-20', amount_yen: 50000, reversed_on: null}]},
  {id: 12, invoice_number: 'ON-INV-202610-0001', partner_id: 2, partner_name: '架空配信', invoice_date: '2026-10-10', due_date: '2026-11-30', plannedDate: '2026-11-30',
    amount_inc_tax: 220000, status: 'issued', voided_on: null, isVoid: false, events: []},
  {id: 13, invoice_number: 'ON-INV-202610-0002', partner_id: 3, partner_name: '架空劇場', invoice_date: '2026-10-01', due_date: '2026-10-31', plannedDate: '2026-10-31',
    amount_inc_tax: 33000, status: 'issued', voided_on: null, isVoid: false,
    events: [{receipt_id: 2, reference: 'PAY-2', received_on: '2026-10-25', amount_yen: 33000, reversed_on: null}]},
  {id: 14, invoice_number: 'ON-INV-202610-0003', partner_id: 2, partner_name: '架空配信', invoice_date: '2026-10-02', due_date: '2026-10-31', plannedDate: '2026-10-31',
    amount_inc_tax: 5000, status: 'void', voided_on: '2026-10-03', isVoid: true, events: []},
]);

test('既定の消込額は min(未充当, 未消込)。入金額が未入力なら未消込の全額', () => {
  assert.equal(defaultAllocation(100000, 60000), 60000);
  assert.equal(defaultAllocation(40000, 60000), 40000);
  assert.equal(defaultAllocation(0, 60000), 0);
  assert.equal(defaultAllocation(-5, 60000), 0, '配分しすぎのときは0（負にしない）');
  assert.equal(defaultAllocation(null, 60000), 60000);
  assert.equal(defaultAllocation(undefined, 60000), 60000);
});

test('請求を共通の形に直す: 取消していない入金だけを消込済みに数え、取消済みの請求は未消込0', () => {
  const [a, , , voided] = sheetRows();
  const reversed = {...a, events: [...a.events, {receipt_id: 9, reference: 'X', received_on: '2026-10-21', amount_yen: 10000, reversed_on: '2026-10-22'}]};
  assert.deepEqual({allocated: normalizeInvoice(reversed).allocated, open: normalizeInvoice(reversed).open}, {allocated: 50000, open: 60000});
  assert.equal(normalizeInvoice(voided).open, 0);
  // /api/billing の invoices（receipts 付き）でも同じ結果
  const billingShape = {...a, receipts: a.events, events: undefined, plannedDate: undefined};
  assert.deepEqual(normalizeInvoice(billingShape), normalizeInvoice(a));
});

test('消込候補: 取引先で絞り、取消済み・消込済みを除き、期日の古い順。請求日が入金日より後なら理由付きで選べない', () => {
  const list = receiptCandidates(sheetRows(), {partnerId: '2', receivedOn: '2026-10-05'});
  assert.deepEqual(list.map((row) => row.invoiceId), [11, 12]);
  assert.equal(list[0].open, 60000);
  assert.equal(list[0].eligible, true);
  assert.equal(list[1].eligible, false);
  assert.match(list[1].reason, /請求日（2026-10-10）より前の入金日/);
  assert.deepEqual(receiptCandidates(sheetRows(), {partnerId: 3}), [], '全額入金済みの請求は候補にしない');
  const options = partnerOptions(sheetRows());
  assert.deepEqual(options.map((option) => option.value), ['2']);
  assert.equal(options[0].open, 280000);
});

test('請求の行から開くと、その請求の未消込を入金額の初期値にして全額を配分する', () => {
  const state = initialReceiptState({invoiceId: 11, rows: sheetRows(), receivedOn: '2026-11-20'});
  assert.equal(state.partnerId, '2');
  assert.equal(state.amountText, '60,000');
  assert.deepEqual(state.lines[11], {selected: true, touched: false, text: '60,000'});
});

test('複数請求への配分: 触っていない消込額は既定（min(未充当, 未消込)）に追従し、手で直した額は保つ', () => {
  const rows = sheetRows();
  const candidates = receiptCandidates(rows, {partnerId: 2, receivedOn: '2026-11-20'});
  let state = initialReceiptState({partnerId: 2, rows, receivedOn: '2026-11-20'});
  state = setReceiptField(state, 'amountText', '100,000', candidates);
  state = toggleInvoice(state, candidates, 11, true);
  assert.equal(state.lines[11].text, '60,000', '1件目は未消込の全額（入金額の方が大きい）');
  state = toggleInvoice(state, candidates, 12, true);
  assert.equal(state.lines[12].text, '40,000', '2件目は残りの未充当');
  assert.equal(summarizeReceipt(state, candidates).unallocated, 0);
  // 入金額を変えると、触っていない請求だけ入れ直す
  state = setAllocationText(state, candidates, 11, '10000');
  assert.equal(state.lines[12].text, '90,000', '手で直した1件目の残りを2件目へ');
  state = setReceiptField(state, 'amountText', '50000', candidates);
  assert.equal(state.lines[11].text, '10000', '手で直した額は保つ');
  assert.equal(state.lines[12].text, '40,000');
  // 選択を外すと残りの請求へ戻る
  state = toggleInvoice(state, candidates, 11, false);
  assert.equal(state.lines[12].text, '50,000');
  // 空欄にしても既定で埋め直さない（入力中の値が戻らない）
  state = setAllocationText(state, candidates, 12, '');
  assert.equal(state.lines[12].text, '');
  // 期日の古い順に配分し直す
  state = setReceiptField(state, 'amountText', '70,000', candidates);
  state = autoAllocate(state, candidates);
  assert.deepEqual(Object.fromEntries(Object.entries(state.lines).map(([id, line]) => [id, line.text])), {11: '60,000', 12: '10,000'});
  // 取引先を変えると配分は消える
  assert.deepEqual(setReceiptField(state, 'partnerId', '3', candidates).lines, {});
});

test('自動配分は選べない請求（請求日が入金日より後）を飛ばし、10請求を超えない', () => {
  const rows = sheetRows();
  const candidates = receiptCandidates(rows, {partnerId: 2, receivedOn: '2026-10-05'});
  const state = autoAllocate({...initialReceiptState({partnerId: 2, rows, receivedOn: '2026-10-05'}), amountText: '300000'}, candidates);
  assert.deepEqual(Object.keys(state.lines), ['11']);
  const many = Array.from({length: 12}, (_, index) => ({id: 100 + index, invoice_number: `N-${index}`, partner_id: 5, partner_name: '架空', invoice_date: '2026-01-01',
    due_date: `2026-02-${String(index + 1).padStart(2, '0')}`, amount_inc_tax: 1000, status: 'issued', events: []}));
  const manyCandidates = receiptCandidates(many, {partnerId: 5, receivedOn: '2026-03-01'});
  const spread = autoAllocate({...initialReceiptState({partnerId: 5, rows: many, receivedOn: '2026-03-01'}), amountText: '12000'}, manyCandidates);
  assert.equal(Object.keys(spread.lines).length, MAX_ALLOCATIONS);
});

test('登録前の検査: 未充当・超過・未消込超え・請求日・必須を項目ごとの理由で返す', () => {
  const rows = sheetRows();
  const candidates = receiptCandidates(rows, {partnerId: 2, receivedOn: '2026-11-20'});
  const empty = validateReceipt(initialReceiptState({rows, receivedOn: '2026-11-20'}), candidates, []);
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.partnerId && empty.errors.amount && empty.errors.reference && empty.errors.allocations);
  let state = {...initialReceiptState({partnerId: 2, rows, receivedOn: '2026-11-20'}), reference: 'PAY-9'};
  state = setReceiptField(state, 'amountText', '１００，０００円', candidates);
  state = toggleInvoice(state, candidates, 11, true);
  const short = validateReceipt(state, candidates, []);
  assert.match(short.errors.allocations, /未充当が40,000円あります/);
  state = setAllocationText(state, candidates, 11, '70,000');
  const over = validateReceipt(state, candidates, []);
  assert.match(over.errors.lines[11], /未消込（60,000円）を超えています/);
  state = setAllocationText(state, candidates, 11, '60,000');
  state = toggleInvoice(state, candidates, 12, true);
  const good = validateReceipt(state, candidates, []);
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.deepEqual(good.payload, {partnerId: 2, reference: 'PAY-9', receivedOn: '2026-11-20', amountYen: 100000,
    allocations: [{invoiceId: 11, amountYen: 60000}, {invoiceId: 12, amountYen: 40000}], note: null});
  // 入金日を請求日より前にすると、その請求は理由付きで止める
  const early = receiptCandidates(rows, {partnerId: 2, receivedOn: '2026-10-05'});
  const dated = validateReceipt({...state, receivedOn: '2026-10-05'}, early, []);
  assert.match(dated.errors.lines[12], /より前の入金日/);
});

test('二重登録の検出: 同じ取引先・入金日・金額・参照番号の有効な入金で止め、理由があれば注記に残して進める', () => {
  const receipts = existingReceipts(sheetRows());
  assert.deepEqual(receipts.map((row) => [row.receiptId, row.partnerId, row.amount, row.invoiceNumbers]), [[1, 2, 50000, ['ON-INV-202609-0001']], [2, 3, 33000, ['ON-INV-202610-0002']]]);
  assert.equal(normalizeReference(' ｐａｙ－１ '), normalizeReference('PAY-1'), '全角・空白・大小文字の違いは同じ参照番号');
  const probe = {partnerId: '2', receivedOn: '2026-10-20', amount: 50000, reference: 'ｐａｙ-1'};
  assert.equal(findDuplicateReceipts(receipts, probe).duplicates.length, 1);
  assert.equal(findDuplicateReceipts(receipts, {...probe, partnerId: 3}).duplicates.length, 0, '取引先が違えば別の入金');
  assert.equal(findDuplicateReceipts(receipts, {...probe, receivedOn: '2026-10-21'}).duplicates.length, 0, '日付が違えば別の入金');
  assert.equal(findDuplicateReceipts(receipts, {...probe, amount: 50001}).duplicates.length, 0, '金額が違えば別の入金');
  assert.equal(findDuplicateReceipts(receipts, {...probe, reference: 'PAY-10'}).duplicates.length, 0, '参照番号が違えば別の入金');
  // 複数の請求へ配分した入金は合計額で比べる
  const split = sheetRows();
  split[1].events = [{receipt_id: 1, reference: 'PAY-1', received_on: '2026-10-20', amount_yen: 20000, reversed_on: null}];
  const merged = existingReceipts(split).find((row) => row.receiptId === 1);
  assert.equal(merged.amount, 70000);
  assert.deepEqual(merged.invoiceNumbers, ['ON-INV-202609-0001', 'ON-INV-202610-0001']);
  // 取消済みの入金は重複に数えない（参考として返す）
  const reversed = sheetRows();
  reversed[0].events[0].reversed_on = '2026-10-22';
  const afterReverse = findDuplicateReceipts(existingReceipts(reversed), probe);
  assert.deepEqual([afterReverse.duplicates.length, afterReverse.reversed.length], [0, 1]);

  const rows = sheetRows();
  const candidates = receiptCandidates(rows, {partnerId: 2, receivedOn: '2026-10-20'});
  let state = {...initialReceiptState({partnerId: 2, rows, receivedOn: '2026-10-20'}), reference: 'PAY-1', note: '振込名義 カクウハイシン'};
  state = setReceiptField(state, 'amountText', '50,000', candidates);
  state = toggleInvoice(state, candidates, 11, true);
  const blocked = validateReceipt(state, candidates, receipts);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocking, true);
  assert.match(blocked.errors.duplicateReason, /同じ入金が登録済み/);
  const allowed = validateReceipt({...state, duplicateReason: '同日に同額の振込が2回あった（通帳で確認）'}, candidates, receipts);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.payload.note, `振込名義 カクウハイシン\n${DUPLICATE_NOTE_PREFIX}同日に同額の振込が2回あった（通帳で確認）`);
});

test('請求の状態は色と文字: 期日超過n日・一部入金・入金済み・取消済み・請求日前', () => {
  const base = {amount: 110000, invoiceDate: '2026-09-10', dueDate: '2026-10-31', plannedDate: '2026-10-31'};
  assert.deepEqual(invoiceState({...base, paid: 0, asOf: '2026-11-05'}), {key: 'overdue', label: '期日超過5日', tone: 'bad', overdueDays: 5});
  assert.deepEqual(invoiceState({...base, paid: 50000, asOf: '2026-11-05'}), {key: 'partial-overdue', label: '一部入金・期日超過5日', tone: 'bad', overdueDays: 5});
  assert.equal(invoiceState({...base, paid: 50000, asOf: '2026-10-20'}).label, '一部入金');
  assert.equal(invoiceState({...base, paid: 50000, asOf: '2026-10-20'}).tone, 'warn');
  assert.equal(invoiceState({...base, paid: 0, asOf: '2026-10-31'}).label, '未入金（本日期日）');
  assert.equal(invoiceState({...base, paid: 110000, asOf: '2026-12-01'}).label, '入金済み');
  assert.equal(invoiceState({...base, isVoid: true, asOf: '2026-12-01'}).label, '取消済み');
  assert.equal(invoiceState({...base, asOf: '2026-09-01'}).label, '請求日前');
  assert.equal(invoiceState({...base, plannedDate: '2026-11-30', paid: 0, asOf: '2026-11-05'}).label, '未入金', '承認済みの予定変更後の入金予定日から数える');
  assert.deepEqual([planRequestState({decision: null}).label, planRequestState({decision: 'approved'}).label, planRequestState({decision: 'rejected'}).label], ['承認待ち', '承認済み', '却下']);
});

async function fixture({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, body, cookie = admin, headers = {}) => {
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json', ...headers}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  };
  const ok = (r) => { assert.ok(r.status < 300 && r.data.ok !== false, JSON.stringify(r.data)); return r.data; };
  const sale = async (key, month, received, amount) => ok(await req('/sales', {workId: 1, report_key: key, kind: 'digital', partner_id: 2, product_id: 1, period_from: `${month}-01`, period_to: `${month}-28`,
    recognition_basis_id: 2, report_received_on: received, basis_reason: '架空の報告受領月', description: '架空配信売上', quantity: 1, amount_ex_tax: amount, tax_amount: amount / 10, amount_inc_tax: amount + amount / 10}));
  await sale('RCP-1', '2026-08', '2026-09-05', 100000);
  await sale('RCP-2', '2026-09', '2026-10-05', 200000);
  const reportId = async (key) => (await req('/reports?workId=1')).data.rows.find((row) => row.report_key === key).id;
  const first = ok(await req('/billing/invoices', {workId: 1, reportIds: [await reportId('RCP-1')], invoiceDate: '2026-09-10', dueDate: '2026-10-31', sourceAmountBasis: 'platform_net'}));
  const second = ok(await req('/billing/invoices', {workId: 1, reportIds: [await reportId('RCP-2')], invoiceDate: '2026-10-10', dueDate: '2026-11-30', sourceAmountBasis: 'platform_net'}));
  ok(await req('/billing/receipts', {partnerId: 2, reference: 'RCP-PAY-1', receivedOn: '2026-10-20', amountYen: 50000, allocations: [{invoiceId: first.invoiceId, amountYen: 50000}]}));
  return {db, req, ok, login, first, second};
}

const receiptRows = async (db) => ({
  receipts: (await db.all('SELECT id, partner_id, reference, received_on, amount_yen, allocation_count, note FROM billing_receipts ORDER BY id')).map((row) => ({...row})),
  allocations: (await db.all('SELECT receipt_id, invoice_id, amount_yen FROM billing_receipt_allocations ORDER BY receipt_id, invoice_id')).map((row) => ({...row})),
});

test('同じ入力を別々の複製DBで「月別入金表」と「請求・入金」のデータから登録すると、入金と配分の行が一致する', async (t) => {
  const results = [];
  for (const source of ['sheet', 'billing']) {
    const f = await fixture({t});
    const rows = source === 'sheet'
      ? f.ok(await f.req(`/receipt-sheet?start=2026-09&asOf=${OPEN_BALANCE_AS_OF}`)).rows
      : f.ok(await f.req('/billing?workId=1&asOf=2026-12-31')).invoices;
    const candidates = receiptCandidates(rows, {partnerId: 2, receivedOn: '2026-11-20'});
    assert.deepEqual(candidates.map((row) => [row.invoiceId, row.open]), [[f.first.invoiceId, 60000], [f.second.invoiceId, 220000]]);
    let state = {...initialReceiptState({invoiceId: f.first.invoiceId, rows, receivedOn: '2026-11-20'}), reference: 'RCP-PAY-2'};
    state = setReceiptField(state, 'amountText', '200,000', candidates);
    state = toggleInvoice(state, candidates, f.second.invoiceId, true);
    const checked = validateReceipt(state, candidates, existingReceipts(rows));
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
    assert.deepEqual(checked.payload.allocations, [{invoiceId: f.first.invoiceId, amountYen: 60000}, {invoiceId: f.second.invoiceId, amountYen: 140000}]);
    f.ok(await f.req('/billing/receipts', checked.payload));
    results.push(await receiptRows(f.db));

    // 登録後に同じ内容を入れると二重登録として止まる（どちらの画面のデータでも）
    const after = source === 'sheet'
      ? f.ok(await f.req(`/receipt-sheet?start=2026-09&asOf=${OPEN_BALANCE_AS_OF}`)).rows
      : f.ok(await f.req('/billing?workId=1&asOf=2026-12-31')).invoices;
    const again = validateReceipt({...state, reference: 'ｒｃｐ－ｐａｙ－２'}, candidates, existingReceipts(after));
    assert.equal(again.blocking, true);
    assert.equal(again.duplicate.duplicates.length, 1);
    assert.equal(again.duplicate.duplicates[0].amount, 200000);
    // 消込後の未消込: 1件目は入金済み、2件目は80,000円
    assert.deepEqual(receiptCandidates(after, {partnerId: 2}).map((row) => [row.invoiceId, row.open]), [[f.second.invoiceId, 80000]]);
  }
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].receipts.length, 2);
  assert.deepEqual(results[0].allocations.filter((row) => row.receipt_id === 2).map((row) => row.amount_yen), [60000, 140000]);
});

test('入金を取り消すと二重登録の対象から外れる。制作担当は入金の元データを読めない', async (t) => {
  const f = await fixture({t});
  const before = f.ok(await f.req(`/receipt-sheet?start=2026-09&asOf=${OPEN_BALANCE_AS_OF}`)).rows;
  const receipt = existingReceipts(before).find((row) => row.reference === 'RCP-PAY-1');
  assert.equal(findDuplicateReceipts(existingReceipts(before), {partnerId: 2, receivedOn: '2026-10-20', amount: 50000, reference: 'RCP-PAY-1'}).duplicates.length, 1);
  f.ok(await f.req(`/billing/receipts/${receipt.receiptId}/reverse`, {reversedOn: '2026-10-22', reason: '架空の誤登録'}, undefined, {'If-Match': '1'}));
  const after = f.ok(await f.req(`/receipt-sheet?start=2026-09&asOf=${OPEN_BALANCE_AS_OF}`)).rows;
  const found = findDuplicateReceipts(existingReceipts(after), {partnerId: 2, receivedOn: '2026-10-20', amount: 50000, reference: 'RCP-PAY-1'});
  assert.deepEqual([found.duplicates.length, found.reversed.length], [0, 1]);
  assert.equal(receiptCandidates(after, {partnerId: 2}).find((row) => row.invoiceId === f.first.invoiceId).open, 110000);
  const production = await f.login('production@openingnight.invalid');
  assert.equal((await f.req(`/receipt-sheet?start=2026-09&asOf=${OPEN_BALANCE_AS_OF}`, null, production)).status, 403);
  // 別組織の利用者には、この組織の請求・入金が1件も見えない（二重登録の照合にも使われない）
  const outsider = await f.login('outsider@other.invalid');
  const other = await f.req(`/receipt-sheet?start=2026-09&asOf=${OPEN_BALANCE_AS_OF}`, null, outsider);
  assert.ok(other.status === 403 || (other.data.rows || []).length === 0, JSON.stringify(other.data));
  assert.deepEqual(existingReceipts(other.data.rows || []), []);
});

test('月別入金表の行: 期日超過・一部入金を状態の文字と色で、月の列は m0〜、承認済みの予定変更後の日から期日超過を数える', async (t) => {
  const f = await fixture({t});
  const sheet = f.ok(await f.req('/receipt-sheet?start=2026-09&asOf=2026-11-05'));
  const rows = receiptSheetRows(sheet);
  const first = rows.find((row) => row.invoiceId === f.first.invoiceId);
  const second = rows.find((row) => row.invoiceId === f.second.invoiceId);
  assert.deepEqual([first.stateLabel, first.tone, first.balance, first.paid], ['一部入金・期日超過5日', 'bad', 60000, 50000]);
  assert.deepEqual([second.stateLabel, second.tone, second.canReceive], ['未入金', 'info', true]);
  assert.equal(first.m1, 50000, '10月（開始月の翌月）の列に入金額');
  assert.equal(first.m0, 0, '入金のない月は0（表示で空欄にする）');
  const totals = receiptSheetTotals(sheet);
  assert.deepEqual(totals.map((row) => row.label), ['実入金計', '残額の入金予定']);
  assert.equal(totals[0].m1, 50000);
  assert.equal(totals[1].m1, 60000, '10月予定の残額');
  // 予定変更の申請 → 承認待ちの一覧に出る → 承認すると一覧から消え、期日超過は新しい入金予定日から数える
  f.ok(await f.req('/receipt-plan/requests', {invoiceId: f.first.invoiceId, baseVersion: first.planVersion, proposedDueDate: '2026-11-30', reason: '架空の支払延長の連絡'}));
  const requested = f.ok(await f.req('/receipt-sheet?start=2026-09&asOf=2026-11-05'));
  const pending = pendingPlanRequests(requested);
  assert.deepEqual(pending.map((row) => [row.invoiceId, row.previousDueDate, row.proposedDueDate]), [[f.first.invoiceId, '2026-10-31', '2026-11-30']]);
  assert.equal(receiptSheetRows(requested).find((row) => row.invoiceId === f.first.invoiceId).pendingRequests, 1);
  f.ok(await f.req(`/receipt-plan/requests/${pending[0].id}/decide`, {decision: 'approved', effectiveOn: '2026-11-01', reason: '架空の承認'}));
  const approved = f.ok(await f.req('/receipt-sheet?start=2026-09&asOf=2026-11-05'));
  assert.deepEqual(pendingPlanRequests(approved), []);
  const moved = receiptSheetRows(approved).find((row) => row.invoiceId === f.first.invoiceId);
  assert.deepEqual([moved.plannedDate, moved.planChanged, moved.stateLabel, moved.tone], ['2026-11-30', true, '一部入金', 'warn']);
});

test('請求・入金の行: 基準日時点の状態・残高の合計・入金の履歴（取消は入金全体に及ぶので他の請求を示す）', async (t) => {
  const f = await fixture({t});
  // 1件の入金を2つの請求へ配分しておく
  f.ok(await f.req('/billing/receipts', {partnerId: 2, reference: 'RCP-PAY-3', receivedOn: '2026-11-20', amountYen: 30000,
    allocations: [{invoiceId: f.first.invoiceId, amountYen: 10000}, {invoiceId: f.second.invoiceId, amountYen: 20000}]}));
  const state = f.ok(await f.req('/billing?workId=1&asOf=2026-11-05'));
  const rows = billingInvoiceRows(state);
  const first = rows.find((row) => row.invoiceId === f.first.invoiceId);
  assert.deepEqual([first.stateLabel, first.tone, first.balance, first.canVoid, first.canReceive], ['一部入金・期日超過5日', 'bad', 60000, false, true]);
  const spread = first.receipts.find((receipt) => receipt.reference === 'RCP-PAY-3');
  assert.deepEqual(spread.otherInvoices, [rows.find((row) => row.invoiceId === f.second.invoiceId).invoiceNumber]);
  const summary = billingSummary(rows);
  assert.deepEqual(summary, {count: 2, openCount: 2, balance: 60000 + 220000, overdueCount: 1, overdue: 60000}, '基準日（11/5）より後の入金は残高から引かない');
  const history = receiptHistoryRows(rows);
  assert.deepEqual(history.map((row) => [row.reference, row.amount, row.stateLabel]), [['RCP-PAY-1', 50000, '有効'], ['RCP-PAY-3', 10000, '有効'], ['RCP-PAY-3', 20000, '有効']]);
  // 請求日前の請求は残高に数えない
  const early = billingInvoiceRows(f.ok(await f.req('/billing?workId=1&asOf=2026-10-01')));
  const future = early.find((row) => row.invoiceId === f.second.invoiceId);
  assert.deepEqual([future.stateLabel, future.balance], ['請求日前', null]);
  assert.equal(billingSummary(early).balance, 110000, '10/1時点では10/20の入金はまだ無い');
  assert.equal(billingSummary(early).count, 1, '請求日前の請求は「基準日時点の請求」の件数に入れない');
  // 入金をすべて取り消した請求だけが「請求を取り消す」を出せる
  for (const receipt of first.receipts) f.ok(await f.req(`/billing/receipts/${receipt.receiptId}/reverse`, {reversedOn: '2026-11-25', reason: '架空の取消'}, undefined, {'If-Match': '1'}));
  const reversed = billingInvoiceRows(f.ok(await f.req('/billing?workId=1&asOf=2026-11-30'))).find((row) => row.invoiceId === f.first.invoiceId);
  assert.equal(reversed.canVoid, true);
  assert.match(receiptHistoryRows([reversed])[0].stateLabel, /^取消済み（2026-11-25）$/);
});

test('「税額を計算して確認」を押せない理由: 報告未選択・税区分未確認・請求日なし・税ルール0件・請求日に使えるルールなし', () => {
  assert.deepEqual(taxCalculateBlockers({rules: {total: 1, resolved: true}, invoiceDate: '2026-10-01'}).map((row) => row.key), ['reports']);
  const none = taxCalculateBlockers({selectedCount: 1, lineCount: 2, unratedCount: 0, invoiceDate: '2026-10-01', rules: {total: 0}});
  assert.deepEqual(none.map((row) => [row.key, row.action]), [['no-rules', 'rules']]);
  assert.match(none[0].message, /税ルールが1件も登録されていません/);
  const late = taxCalculateBlockers({selectedCount: 1, lineCount: 2, invoiceDate: '2026-10-01', rules: {total: 2, resolved: false}});
  assert.deepEqual(late.map((row) => row.key), ['no-effective-rule']);
  assert.match(late[0].message, /2026-10-01/);
  const unrated = taxCalculateBlockers({selectedCount: 1, lineCount: 3, unratedCount: 2, invoiceDate: '', rules: {total: 1, resolved: true}});
  assert.deepEqual(unrated.map((row) => row.key), ['rates', 'invoiceDate']);
  assert.match(unrated[0].message, /2件/);
  assert.deepEqual(taxCalculateBlockers({selectedCount: 1, lineCount: 3, invoiceDate: '2026-10-01', rules: {loading: true}}), [], '読込中はルールを理由にしない');
  assert.deepEqual(taxCalculateBlockers({selectedCount: 1, lineCount: 1, invoiceDate: '2026-10-01', rules: {total: 1, resolved: true}}), []);
  assert.deepEqual(taxCalculateBlockers({selectedCount: 2, sourcesLoading: true, invoiceDate: '2026-10-01', rules: {total: 1, resolved: true}}).map((row) => row.key), ['loading']);
});

test('税計算台帳: 有効計は知っている項目だけを日本語で、行と税ルールは日本語の選択値に直す', () => {
  const totals = taxLedgerTotals({count: 2, amountExTax: 1000, billedTax: 100, amountIncTax: 1100, sourceTax: 99, delta: 1, unknownCount: 0, secretKey: 5});
  assert.deepEqual(totals.map((row) => row.label), ['有効な請求', '請求本体', '請求税額', '税込請求', '元報告の税額', '税額差', '計算由来不明']);
  assert.ok(!totals.some((row) => row.key === 'secretKey'));
  assert.deepEqual(taxLedgerTotals(null), []);
  const rows = taxLedgerRows({rows: [
    {invoice_id: 7, invoice_number: 'ON-INV-202610-0001', partner_name: '架空配信', invoice_date: '2026-10-01', statusAsOf: 'issued', provenance: 'calculated', snapshot_id: 3, amount_ex_tax: 1000, sourceTax: 99, billedTax: 100, delta: 1},
    {invoice_id: 8, invoice_number: 'ON-INV-202610-0002', partner_name: '架空配信', invoice_date: '2026-10-02', statusAsOf: 'void', provenance: 'unknown', snapshot_id: null, amount_ex_tax: 500, sourceTax: null, billedTax: 50, delta: null},
  ]});
  assert.deepEqual(rows.map((row) => [row.stateLabel, row.provenanceLabel, row.snapshotId]), [['有効', '計算履歴あり', 3], ['取消済み', '計算由来不明', null]]);
  const rules = [
    {id: 1, partner_id: null, version: 1, effective_from: '2026-01-01', basis: 'exclusive', grouping: 'invoice', rounding: 'truncate', precision: 0, reason: '架空', evidence: '架空'},
    {id: 2, partner_id: 2, version: 1, effective_from: '2026-04-01', basis: 'inclusive', grouping: 'voucher', rounding: 'half_up', precision: 2, reason: '架空', evidence: '架空'},
    {id: 3, partner_id: 2, version: 2, effective_from: '2026-07-01', basis: 'exclusive', grouping: 'invoice', rounding: 'ceil', precision: 0, reason: '架空', evidence: '架空'},
  ];
  const ruleRows = taxRuleRows(rules, [{id: 2, name: '架空配信'}]);
  assert.deepEqual(ruleRows.map((row) => [row.scopeLabel, row.version, row.basisLabel, row.groupingLabel, row.roundingLabel]), [
    ['組織標準', 1, '税抜起点', '請求書単位', '切り捨て'], ['架空配信', 1, '税込起点', '伝票単位', '四捨五入'], ['架空配信', 2, '税抜起点', '請求書単位', '切り上げ'],
  ]);
  assert.equal(latestRuleVersion(rules, ''), 1);
  assert.equal(latestRuleVersion(rules, '2'), 2);
  assert.equal(latestRuleVersion(rules, 9), 0);
  assert.equal(validateTaxRule({effectiveFrom: '2026-10-01', precision: '0', reason: '架空', evidence: '架空'}).ok, true);
  const bad = validateTaxRule({effectiveFrom: '2026-10-01', effectiveTo: '2026-09-01', precision: '5', reason: ' ', evidence: ''});
  assert.deepEqual(Object.keys(bad.errors).sort(), ['effectiveTo', 'evidence', 'precision', 'reason']);
});
