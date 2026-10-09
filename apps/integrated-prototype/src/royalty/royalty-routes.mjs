import {dbErrorOf, isUniqueViolation} from '../data-platform/db-errors.mjs';
import {expenseSource} from '../expense-sheet/expense-read.mjs';
// ロイヤリティのAPI（契約・条件版・サイクル・実額の計上・イレギュラー・期間・確定版・報告と支払・集計シート）。
// 設計: docs/platform/team-development/royalty-committee-design.md §3。Worker でも動くよう node:* を import しない。
// 権限: 制作担当は403。契約は作品の財務権限（settlementWork）が要る。報告書は権利者の全契約で1通なので、
// 権利者の契約に権限外の作品があれば、その権利者の報告書・イレギュラーは扱えない（403）。
// 書き込みはすべて1回の db.batch（明細・監査記録と同時）。数字は画面から受け取らず、サーバーで作り直す。
import {importLimits} from '../import/limits.mjs';
import {labelOf} from '../ui/labels.mjs';
import {
  CALCULATION_VERSION, ROYALTY_CATEGORIES, IRREGULAR_KINDS, normalizeTermInput, normalizeScheduleInput, termFor, phaseFor, cycleText, dueText,
  rateText, isMonth, isDate, monthsBetween, monthLabel, buildLedger, buildStatement, holderClosings, statementStatus, eventState, checksOk, enumerateClosings,
  holdStates, reportedMonths, scheduleConflicts, irregularReversalConflict, statementBlockReason, markBlockedPeriods, isCreatablePeriod, CYCLE_PRESETS, DUE_PRESETS, TARGET_CHANNELS,
} from './royalty-model.mjs';
import {todayJst, loadAgreements, loadEntries, loadManual, loadStatements, loadItems, holdersOf, royaltyPeriods, entryOf} from './royalty-data.mjs';

const fail = (message, status = 400, details) => Object.assign(new Error(message), {status, details});
// 一括作成で1回に作る確定版の数（D1 は1回の Worker 呼び出しあたりの問い合わせ数に上限があるため。残りは続けて作る）
export const GENERATE_LIMIT = 100;
// 1つの値（明細のまとまり・計算の内容の分割）の上限。クラウドの D1 は1つの値を128KBまでしか入れられない（cloud-r2-db）ため余裕を見る
export const VALUE_BYTES = 96 * 1024;
const encoder = new TextEncoder();
export const utf8Bytes = (value) => encoder.encode(value).length;
// 文字列を UTF-8 で maxBytes 以下に分ける（文字の途中では切らない）
export function splitUtf8(value, maxBytes) {
  const bytes = encoder.encode(value);
  const decoder = new TextDecoder();
  const parts = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + maxBytes, bytes.length);
    while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return parts;
}
// 行（配列）を、JSON にして maxBytes 以下のまとまりに分ける。返り値は JSON の文字列の配列（json_each で読む）
export function chunkRows(rows, maxBytes) {
  const chunks = [];
  let current = [];
  let size = 2;
  for (const row of rows) {
    const bytes = utf8Bytes(JSON.stringify(row)) + 1;
    if (current.length && size + bytes > maxBytes) { chunks.push(JSON.stringify(current)); current = []; size = 2; }
    current.push(row);
    size += bytes;
  }
  if (current.length) chunks.push(JSON.stringify(current));
  return chunks;
}
const text = (value) => (value === null || value === undefined ? '' : String(value).trim());
const positiveId = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && /^\d+$/.test(String(value).trim()) ? n : null;
};
const toInt = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,，\s円]/g, ''));
  return Number.isSafeInteger(n) ? n : NaN;
};
// DB のトリガー・制約の文（日本語）を取り出す。読めないときは既定の文
function dbMessage(error, fallback = '登録できませんでした。再読込してから、もう一度お試しください') {
  // トリガーの拒否は、DB の結果コード（D1 の : SQLITE_… など）を除いた文を共通のエラーの種類から読む
  const found = dbErrorOf(error);
  const message = String((found?.kind === 'raise' && found.message) || error?.message || '');
  const japanese = message.match(/[぀-ヿ一-鿿][^\n]*/);
  if (japanese) return japanese[0].trim();
  if (isUniqueViolation(error)) return '同じ内容がすでに登録されています。再読込して確かめてください';
  return fallback;
}

export function termSummary(term) {
  if (!term) return '条件版なし';
  if (term.calcMethod === 'fixed_monthly') return `毎月定額 ${Number(term.fixedAmountYen).toLocaleString('ja-JP')}円`;
  if (term.calcMethod === 'manual') return '実額入力（分配明細などの額を計上）';
  const window = term.windowFeeBps !== null && term.windowFeeBps !== undefined ? `・窓口手数料 ${rateText(term.windowFeeBps)}` : '';
  return `${labelOf('royaltyBaseKind', term.baseKind)} × ${rateText(term.rateBps)}${window}`;
}
export const channelSummary = (term) => (term?.calcMethod !== 'rate' ? '—' : term.channels?.length ? term.channels.map((c) => labelOf('royaltyChannel', c)).join('・') : 'すべての流通');

export function registerRoyaltyRoutes(app, ctx) {
  const {db, bad, body, sha256, canonical, settlementWork, mode} = ctx;
  const batchLimit = importLimits(mode).batchStatements;
  const deny = (c) => bad(c, 'ロイヤリティは財務担当の画面です', 403);
  const audit = (i, action, entityType, entityId, detail) => ({
    sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
    params: [i.org_id, i.user_id, action, entityType, String(entityId), JSON.stringify(detail)],
  });
  const nextId = async (table) => Number((await db.get(`SELECT COALESCE(MAX(id),0)+1 AS id FROM ${table}`)).id);
  const invalid = (errors) => fail(errors.map((e) => e.message).join(' ／ '), 400, {errors});
  async function readBody(c) {
    try { return await body(c); } catch (error) { throw fail(error.message); }
  }
  function asOfOf(c) {
    const raw = c.req.query('asOf');
    if (!raw) return todayJst();
    if (!isDate(raw)) throw fail('基準日を「2026-09-30」の形で指定してください');
    return raw;
  }
  // 例外を日本語の応答に変える（status のない例外は DB の制約として 409）
  const handle = (fn) => async (c) => {
    const i = c.get('identity');
    if (!i || i.role === 'production') return deny(c);
    try {
      return await fn(c, i);
    } catch (error) {
      if (error.status) return bad(c, error.message, error.status, error.details, error);
      return bad(c, dbMessage(error), 409);
    }
  };
  async function runBatch(statements) {
    if (statements.length > batchLimit) throw fail(`1回に登録できる行数（${batchLimit}行）を超えます。フェーズや明細を分けてください`, 413);
    try {
      return await db.batch(statements);
    } catch (error) {
      throw fail(dbMessage(error), 409);
    }
  }
  async function agreementFor(i, id) {
    const agreementId = positiveId(id);
    if (!agreementId) throw fail('契約の指定を読み取れません');
    const row = await db.get('SELECT id, work_id, holder_partner_id FROM royalty_agreements WHERE org_id=? AND id=?', [i.org_id, agreementId]);
    if (!row) throw fail('契約が見つかりません', 404);
    if (!await settlementWork(i, row.work_id)) throw fail('この契約の作品の財務権限がありません', 403);
    const {agreements, restrictedHolders} = await loadAgreements(db, i, ctx, {agreementIds: [agreementId]});
    return {agreement: agreements[0], restricted: restrictedHolders.has(row.holder_partner_id)};
  }
  // 権利者の報告書を扱えるか（権利者の契約すべてに財務権限がある）
  async function holderScope(i, holderId) {
    const id = positiveId(holderId);
    if (!id) throw fail('権利者を選んでください');
    const holder = await db.get('SELECT id, code, name FROM partners WHERE org_id=? AND id=?', [i.org_id, id]);
    if (!holder) throw fail('権利者が見つかりません', 404);
    const loaded = await loadAgreements(db, i, ctx, {holderId: id});
    if (loaded.restrictedHolders.has(id)) throw fail('この権利者の契約に、財務権限のない作品が含まれます。すべての作品の財務権限がある人が扱ってください', 403);
    if (!loaded.agreements.length) throw fail('この権利者のロイヤリティ契約がありません', 404);
    return {holder, agreements: loaded.agreements};
  }
  async function inputHash(holderId, draft) {
    return sha256(canonical({
      calculationVersion: CALCULATION_VERSION, holderId, closeMonth: draft.closeMonth, previousCloseMonth: draft.previousCloseMonth,
      lines: draft.lines.map((line) => [line.lineKind, line.agreementId, line.accrualMonth, line.termVersionId, line.irregularEntryId, line.salesYen, line.windowFeeYen,
        line.expenseYen, line.committeeIncomeYen, line.baseYen, line.rateBps, line.amountYen]),
      totals: draft.totals, holds: draft.holds.map((hold) => [hold.key, hold.holdSalesYen, hold.royaltyYen]),
    }));
  }
  function agreementView(agreement, month) {
    const term = termFor(agreement.terms, month) || agreement.terms.at(-1) || null;
    const phase = phaseFor(agreement.schedule, month) || agreement.schedule?.phases?.at(-1) || null;
    return {
      ...agreement, categoryLabel: labelOf('royaltyCategory', agreement.category), currentTerm: term, currentPhase: phase,
      termText: termSummary(term), channelText: channelSummary(term), cycleText: cycleText(phase),
      reportText: phase ? dueText(phase.reportOffsetMonths, phase.reportDay) : '—', paymentText: phase ? dueText(phase.paymentOffsetMonths, phase.paymentDay) : '—',
      advanceYen: term?.advanceYen ?? 0, minPaymentYen: term?.minPaymentYen ?? null,
    };
  }
  function termStatements(i, agreementId, termId, term) {
    const statements = [{
      sql: `INSERT INTO royalty_term_versions(id,org_id,agreement_id,version_no,effective_from,calc_method,base_kind,rate_bps,window_fee_bps,fixed_amount_yen,advance_yen,min_payment_yen,clause_reference,reason,created_by)
        VALUES(?,?,?,(SELECT COALESCE(MAX(version_no),0)+1 FROM royalty_term_versions WHERE org_id=? AND agreement_id=?),?,?,?,?,?,?,?,?,?,?,?)`,
      params: [termId, i.org_id, agreementId, i.org_id, agreementId, term.effectiveFrom, term.calcMethod, term.baseKind, term.rateBps, term.windowFeeBps, term.fixedAmountYen,
        term.advanceYen, term.minPaymentYen, term.clauseReference, term.reason, i.user_id],
    }];
    for (const channel of term.channels) statements.push({sql: 'INSERT INTO royalty_term_channels(org_id,term_version_id,channel_group,created_by) VALUES(?,?,?,?)', params: [i.org_id, termId, channel, i.user_id]});
    for (const category of term.expenseCategories) statements.push({sql: 'INSERT INTO royalty_term_expense_categories(org_id,term_version_id,category,created_by) VALUES(?,?,?,?)', params: [i.org_id, termId, category, i.user_id]});
    return statements;
  }
  function scheduleStatements(i, agreementId, scheduleId, schedule) {
    return [{
      sql: `INSERT INTO royalty_schedule_versions(id,org_id,agreement_id,version_no,statements_from,reason,created_by)
        VALUES(?,?,?,(SELECT COALESCE(MAX(version_no),0)+1 FROM royalty_schedule_versions WHERE org_id=? AND agreement_id=?),?,?,?)`,
      params: [scheduleId, i.org_id, agreementId, i.org_id, agreementId, schedule.statementsFrom, schedule.reason, i.user_id],
    }, ...schedule.phases.map((phase) => ({
      sql: `INSERT INTO royalty_schedule_phases(org_id,schedule_version_id,starts_month,ends_month,cycle_kind,anchor_month,custom_close_months,first_close_immediate,
          report_offset_months,report_day,payment_offset_months,payment_day,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [i.org_id, scheduleId, phase.startsMonth, phase.endsMonth, phase.cycleKind, phase.anchorMonth, phase.customCloseMonths, phase.firstCloseImmediate ? 1 : 0,
        phase.reportOffsetMonths, phase.reportDay, phase.paymentOffsetMonths, phase.paymentDay, phase.note, i.user_id],
    }))];
  }
  const prefixed = (prefix, errors) => errors.map((error) => ({...error, field: `${prefix}.${error.field}`}));

  // ---------- 契約 ----------
  app.get('/api/royalty/agreements', handle(async (c, i) => {
    const month = todayJst().slice(0, 7);
    const {agreements, restrictedHolders} = await loadAgreements(db, i, ctx, {});
    const categories = await db.all(`SELECT DISTINCT category FROM ${expenseSource()} WHERE org_id=? ORDER BY category`, [i.org_id]);
    return c.json({
      ok: true, agreements: agreements.map((agreement) => agreementView(agreement, month)),
      holders: holdersOf(agreements).map((holder) => ({...holder, restricted: restrictedHolders.has(holder.id)})),
      expenseCategories: categories.map((row) => row.category), cyclePresets: CYCLE_PRESETS, duePresets: DUE_PRESETS, targetChannels: TARGET_CHANNELS,
    });
  }));

  app.get('/api/royalty/agreements/:id', handle(async (c, i) => {
    const {agreement, restricted} = await agreementFor(i, c.req.param('id'));
    const today = todayJst();
    const month = today.slice(0, 7);
    const entries = await loadEntries(db, i.org_id, [agreement.holderId]);
    const manual = await loadManual(db, i.org_id, [agreement.id]);
    const statements = restricted ? [] : await loadStatements(db, i.org_id, [agreement.holderId]);
    const first = agreement.terms.map((t) => t.effectiveFrom).sort()[0] || month;
    const items = await loadItems(db, i, [agreement], entries, manual, {toMonth: month}, ctx);
    // 権利者全体（契約に付かない）の記録は、権利者の全契約に権限があるときだけ出す。支払・未払残は権利者全体の値なので契約の画面では出さない
    const own = entries.filter((e) => e.agreementId === agreement.id || (!e.agreementId && !restricted));
    const ledger = buildLedger({agreements: [agreement], items, entries: own, manualAccruals: manual, statements, from: first, to: month, paymentHolderIds: new Set()});
    const closings = [...enumerateClosings({agreement, entries, asOfMonth: month}).entries()].map(([closeMonth, due]) => ({closeMonth, ...due}));
    return c.json({
      ok: true, agreement: agreementView(agreement, month), restricted,
      terms: agreement.terms.map((term) => ({...term, summary: termSummary(term), channelText: channelSummary(term), calcMethodLabel: labelOf('royaltyCalcMethod', term.calcMethod)})),
      schedules: agreement.schedules.map((schedule) => ({...schedule, phases: schedule.phases.map((phase) => ({...phase, cycleText: cycleText(phase),
        reportText: dueText(phase.reportOffsetMonths, phase.reportDay), paymentText: dueText(phase.paymentOffsetMonths, phase.paymentDay)}))})),
      manualAccruals: manual.map((row) => ({...row, reversed: manual.some((other) => other.reversesEntryId === row.id)})),
      irregularEntries: ledger.irregular,
      accruals: ledger.detail, closings, ledgerTotals: ledger.totals,
    });
  }));

  app.post('/api/royalty/agreements', handle(async (c, i) => {
    const input = await readBody(c);
    const errors = [];
    const workId = positiveId(input.workId);
    const holderId = positiveId(input.holderPartnerId);
    const category = text(input.category);
    const code = text(input.agreementCode);
    const title = text(input.title);
    const documentReference = text(input.documentReference) || null;
    const note = text(input.note) || null;
    if (!workId) errors.push({field: 'workId', message: '作品を選んでください'});
    if (!holderId) errors.push({field: 'holderPartnerId', message: '権利者（取引先）を選んでください'});
    if (!ROYALTY_CATEGORIES.includes(category)) errors.push({field: 'category', message: '種別（監督料・脚本料など）を選んでください'});
    if (!code || code.length > 60) errors.push({field: 'agreementCode', message: '契約コードを60文字以内で入れてください'});
    if (!title || title.length > 200) errors.push({field: 'title', message: '契約名を200文字以内で入れてください'});
    if (documentReference && documentReference.length > 500) errors.push({field: 'documentReference', message: '契約書の参照先は500文字以内です'});
    if (note && note.length > 1000) errors.push({field: 'note', message: 'メモは1000文字以内です'});
    const term = normalizeTermInput(input.term || {});
    const schedule = normalizeScheduleInput(input.schedule || {});
    errors.push(...prefixed('term', term.errors), ...prefixed('schedule', schedule.errors));
    if (schedule.ok && term.ok && schedule.value.phases[0].startsMonth > term.value.effectiveFrom) {
      errors.push({field: 'schedule.phases', message: `サイクルの最初のフェーズは、条件の適用開始（${monthLabel(term.value.effectiveFrom)}）以前から始めてください`});
    }
    if (errors.length) throw invalid(errors);
    const work = await settlementWork(i, workId);
    if (!work) throw fail('作品の財務権限がありません', 403);
    if (!await db.get('SELECT 1 FROM partners WHERE org_id=? AND id=?', [i.org_id, holderId])) throw fail('権利者（取引先）が見つかりません', 404);
    if (await db.get('SELECT 1 FROM royalty_agreements WHERE org_id=? AND agreement_code=?', [i.org_id, code])) throw fail(`契約コード「${code}」は登録済みです`, 409, {errors: [{field: 'agreementCode', message: 'この契約コードは登録済みです'}]});
    const agreementId = await nextId('royalty_agreements');
    const termId = await nextId('royalty_term_versions');
    const scheduleId = await nextId('royalty_schedule_versions');
    await runBatch([
      {sql: `INSERT INTO royalty_agreements(id,org_id,project_id,work_id,holder_partner_id,category,agreement_code,title,document_reference,note,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, params: [agreementId, i.org_id, work.project_id, workId, holderId, category, code, title, documentReference, note, i.user_id]},
      ...termStatements(i, agreementId, termId, term.value),
      ...scheduleStatements(i, agreementId, scheduleId, schedule.value),
      audit(i, 'create', 'royalty_agreement', agreementId, {code, workId, holderId, category, termVersionId: termId, scheduleVersionId: scheduleId}),
    ]);
    return c.json({ok: true, id: agreementId, agreementId, termVersionId: termId, scheduleVersionId: scheduleId}, 201);
  }));

  app.post('/api/royalty/agreements/:id/terms', handle(async (c, i) => {
    const {agreement} = await agreementFor(i, c.req.param('id'));
    const input = await readBody(c);
    const term = normalizeTermInput(input);
    const errors = [...term.errors];
    const latest = agreement.terms.at(-1);
    if (latest && term.ok && term.value.effectiveFrom <= latest.effectiveFrom) errors.push({field: 'effectiveFrom', message: `適用開始は、前の版（${monthLabel(latest.effectiveFrom)}から）より後の月にしてください`});
    if (latest && !term.value.reason) errors.push({field: 'reason', message: '条件を変える理由（覚書・再契約など）を入れてください'});
    if (errors.length) throw invalid(errors);
    const termId = await nextId('royalty_term_versions');
    await runBatch([...termStatements(i, agreement.id, termId, term.value),
      audit(i, 'append', 'royalty_term_version', termId, {agreementId: agreement.id, effectiveFrom: term.value.effectiveFrom, calcMethod: term.value.calcMethod})]);
    return c.json({ok: true, id: termId, termVersionId: termId}, 201);
  }));

  app.post('/api/royalty/agreements/:id/schedules', handle(async (c, i) => {
    const {agreement} = await agreementFor(i, c.req.param('id'));
    const input = await readBody(c);
    const schedule = normalizeScheduleInput(input);
    const errors = [...schedule.errors];
    if (agreement.schedules.length && !schedule.value.reason) errors.push({field: 'reason', message: 'サイクルを変える理由を入れてください'});
    const first = agreement.terms.map((t) => t.effectiveFrom).sort()[0];
    if (schedule.ok && first && schedule.value.phases[0].startsMonth > first) errors.push({field: 'phases', message: `最初のフェーズは、条件の適用開始（${monthLabel(first)}）以前から始めてください`});
    if (errors.length) throw invalid(errors);
    // 確定版に載った計上月の扱い（締め月が決まること・移行前でないこと）を、後から足す版で変えない（表のトリガーでも止める）
    const conflicts = scheduleConflicts({agreement, schedule: schedule.value, statements: await loadStatements(db, i.org_id, [agreement.holderId]),
      entries: await loadEntries(db, i.org_id, [agreement.holderId])});
    if (conflicts.length) throw fail(conflicts.map((e) => e.message).join(' ／ '), 409, {errors: conflicts});
    const scheduleId = await nextId('royalty_schedule_versions');
    await runBatch([...scheduleStatements(i, agreement.id, scheduleId, schedule.value),
      audit(i, 'append', 'royalty_schedule_version', scheduleId, {agreementId: agreement.id, phases: schedule.value.phases.length, statementsFrom: schedule.value.statementsFrom})]);
    return c.json({ok: true, id: scheduleId, scheduleVersionId: scheduleId}, 201);
  }));

  // ---------- 実額の計上 ----------
  app.post('/api/royalty/manual-accruals', handle(async (c, i) => {
    const input = await readBody(c);
    const {agreement} = await agreementFor(i, input.agreementId);
    const errors = [];
    const accrualMonth = text(input.accrualMonth);
    const amountYen = toInt(input.amountYen);
    const sourceReference = text(input.sourceReference);
    const reason = text(input.reason);
    if (!isMonth(accrualMonth)) errors.push({field: 'accrualMonth', message: '計上月を「2026-04」の形で入れてください'});
    if (!Number.isSafeInteger(amountYen) || amountYen === 0) errors.push({field: 'amountYen', message: '金額を0以外の整数で入れてください（戻しはマイナス）'});
    if (!sourceReference || sourceReference.length > 200) errors.push({field: 'sourceReference', message: '元資料（分配明細の番号など）を200文字以内で入れてください'});
    if (!reason || reason.length > 1000) errors.push({field: 'reason', message: '理由を入れてください'});
    if (errors.length) throw invalid(errors);
    const term = termFor(agreement.terms, accrualMonth);
    if (!term) throw invalid([{field: 'accrualMonth', message: `この計上月には条件版がありません（最初の版は${monthLabel(agreement.terms[0]?.effectiveFrom)}から）`}]);
    if (term.calcMethod !== 'manual') throw invalid([{field: 'accrualMonth', message: `${monthLabel(accrualMonth)}の条件は「${labelOf('royaltyCalcMethod', term.calcMethod)}」です。実額の計上は計算方法が「実額入力」の月だけです（それ以外は金額の調整を使ってください）`}]);
    if (await db.get('SELECT 1 FROM royalty_manual_accruals WHERE org_id=? AND agreement_id=? AND accrual_month=? AND source_reference=? AND reverses_entry_id IS NULL', [i.org_id, agreement.id, accrualMonth, sourceReference])) {
      throw fail('同じ元資料・計上月の実額は計上済みです', 409, {errors: [{field: 'sourceReference', message: 'この元資料は計上済みです'}]});
    }
    const id = await nextId('royalty_manual_accruals');
    await runBatch([
      {sql: 'INSERT INTO royalty_manual_accruals(id,org_id,agreement_id,accrual_month,amount_yen,source_reference,reason,created_by) VALUES(?,?,?,?,?,?,?,?)',
        params: [id, i.org_id, agreement.id, accrualMonth, amountYen, sourceReference, reason, i.user_id]},
      audit(i, 'create', 'royalty_manual_accrual', id, {agreementId: agreement.id, accrualMonth, amountYen, sourceReference}),
    ]);
    return c.json({ok: true, id}, 201);
  }));

  app.post('/api/royalty/manual-accruals/:id/reverse', handle(async (c, i) => {
    const id = positiveId(c.req.param('id'));
    const row = id ? await db.get('SELECT * FROM royalty_manual_accruals WHERE org_id=? AND id=?', [i.org_id, id]) : null;
    if (!row) throw fail('実額の計上が見つかりません', 404);
    await agreementFor(i, row.agreement_id);
    const input = await readBody(c);
    const reason = text(input.reason);
    if (!reason || reason.length > 1000) throw invalid([{field: 'reason', message: '取り消す理由を入れてください'}]);
    if (row.reverses_entry_id) throw fail('取消の行は取り消せません', 409);
    if (await db.get('SELECT 1 FROM royalty_manual_accruals WHERE org_id=? AND reverses_entry_id=?', [i.org_id, id])) throw fail('この計上は取消済みです', 409);
    const reversalId = await nextId('royalty_manual_accruals');
    await runBatch([
      {sql: 'INSERT INTO royalty_manual_accruals(id,org_id,agreement_id,accrual_month,amount_yen,source_reference,reason,reverses_entry_id,created_by) VALUES(?,?,?,?,?,?,?,?,?)',
        params: [reversalId, i.org_id, row.agreement_id, row.accrual_month, -row.amount_yen, row.source_reference, reason, id, i.user_id]},
      audit(i, 'reverse', 'royalty_manual_accrual', id, {reversalId, reason}),
    ]);
    return c.json({ok: true, id: reversalId}, 201);
  }));

  // ---------- イレギュラーの台帳 ----------
  // 報告済み（取消されていない確定版に入った）計上月と、最新の確定版の締め月
  async function holderState(i, holderId) {
    const statements = await loadStatements(db, i.org_id, [holderId]);
    return {reported: reportedMonths(statements), latestClose: statements.map((s) => s.closeMonth).sort().at(-1) || null};
  }

  app.post('/api/royalty/irregular-entries', handle(async (c, i) => {
    const input = await readBody(c);
    const kind = text(input.kind);
    if (!IRREGULAR_KINDS.includes(kind)) throw invalid([{field: 'kind', message: '記録の種類を選んでください'}]);
    let agreement = null;
    if (input.agreementId !== null && input.agreementId !== undefined && input.agreementId !== '') agreement = (await agreementFor(i, input.agreementId)).agreement;
    const holderId = agreement ? agreement.holderId : positiveId(input.holderPartnerId);
    if (agreement && input.holderPartnerId && positiveId(input.holderPartnerId) !== agreement.holderId) throw invalid([{field: 'holderPartnerId', message: '権利者が契約の権利者と一致しません'}]);
    const {agreements} = await holderScope(i, holderId);
    const errors = [];
    const accrualMonth = text(input.accrualMonth) || null;
    const closeMonth = text(input.closeMonth) || null;
    const amountYen = toInt(input.amountYen);
    const reason = text(input.reason);
    const sourceReference = text(input.sourceReference) || null;
    if (!reason || reason.length > 1000) errors.push({field: 'reason', message: '理由を入れてください（1000文字以内）'});
    if (sourceReference && sourceReference.length > 200) errors.push({field: 'sourceReference', message: '根拠の資料は200文字以内です'});
    if (accrualMonth && !isMonth(accrualMonth)) errors.push({field: 'accrualMonth', message: '計上月を「2026-04」の形で入れてください'});
    if (closeMonth && !isMonth(closeMonth)) errors.push({field: 'closeMonth', message: '締め月を「2026-06」の形で入れてください'});
    const needAgreement = ['move_period', 'hold', 'release'].includes(kind);
    if (needAgreement && !agreement) errors.push({field: 'agreementId', message: 'この記録は契約を選んで記録します'});
    if (needAgreement && !accrualMonth) errors.push({field: 'accrualMonth', message: '対象の計上月を入れてください'});
    if ((kind === 'adjust_amount' || kind === 'move_period') && !closeMonth) errors.push({field: 'closeMonth', message: '報告書に入れる締め月を入れてください'});
    if (kind === 'adjust_amount' && (!Number.isSafeInteger(amountYen) || amountYen === 0)) errors.push({field: 'amountYen', message: '調整する金額を0以外の整数で入れてください（減らすときはマイナス）'});
    if (kind !== 'adjust_amount' && input.amountYen !== null && input.amountYen !== undefined && input.amountYen !== '') errors.push({field: 'amountYen', message: '金額は「金額の調整」のときだけ入れます'});
    if (kind === 'move_period' && accrualMonth && closeMonth && closeMonth < accrualMonth) errors.push({field: 'closeMonth', message: '締め月は計上月以後にしてください'});
    if (errors.length) throw invalid(errors);
    const state = await holderState(i, holderId);
    const key = agreement && accrualMonth ? `${agreement.id}:${accrualMonth}` : null;
    if ((kind === 'adjust_amount' || kind === 'move_period') && state.latestClose && closeMonth <= state.latestClose) {
      throw invalid([{field: 'closeMonth', message: `${monthLabel(state.latestClose)}締めまでの報告書は作成済みです。締め月はそれより後の月にしてください`}]);
    }
    if ((kind === 'move_period' || kind === 'hold') && state.reported.has(key)) {
      throw fail(`${monthLabel(accrualMonth)}の計上は${monthLabel(state.reported.get(key))}締めの報告書で報告済みです。直すときは「金額の調整」を使ってください`, 409);
    }
    const entries = await loadEntries(db, i.org_id, [holderId]);
    const held = holdStates(entries).get(key)?.held || false;
    if (kind === 'hold' && held) throw fail('この計上月はすでに保留中です', 409);
    if (kind === 'release' && !held) throw fail('この計上月は保留されていません', 409);
    const holderRow = await db.get('SELECT id FROM partners WHERE org_id=? AND id=?', [i.org_id, holderId]);
    if (!holderRow || !agreements.length) throw fail('権利者が見つかりません', 404);
    const id = await nextId('royalty_irregular_entries');
    await runBatch([
      {sql: `INSERT INTO royalty_irregular_entries(id,org_id,holder_partner_id,agreement_id,kind,accrual_month,close_month,amount_yen,reason,source_reference,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, params: [id, i.org_id, holderId, agreement?.id ?? null, kind, accrualMonth,
        kind === 'hold' || kind === 'release' ? null : closeMonth, kind === 'adjust_amount' ? amountYen : null, reason, sourceReference, i.user_id]},
      audit(i, 'create', 'royalty_irregular_entry', id, {holderId, agreementId: agreement?.id ?? null, kind, accrualMonth, closeMonth, amountYen: kind === 'adjust_amount' ? amountYen : null}),
    ]);
    return c.json({ok: true, id}, 201);
  }));

  app.post('/api/royalty/irregular-entries/:id/reverse', handle(async (c, i) => {
    const id = positiveId(c.req.param('id'));
    const row = id ? await db.get('SELECT * FROM royalty_irregular_entries WHERE org_id=? AND id=?', [i.org_id, id]) : null;
    if (!row) throw fail('イレギュラーの記録が見つかりません', 404);
    await holderScope(i, row.holder_partner_id);
    const input = await readBody(c);
    const reason = text(input.reason);
    if (!reason || reason.length > 1000) throw invalid([{field: 'reason', message: '取り消す理由を入れてください'}]);
    if (row.reverses_entry_id) throw fail('取消の記録は取り消せません', 409);
    if (await db.get('SELECT 1 FROM royalty_irregular_entries WHERE org_id=? AND reverses_entry_id=?', [i.org_id, id])) throw fail('この記録は取消済みです', 409);
    // 報告済みの計上月は、取消でも保留に戻さず、締め月も変えない（新しく「保留にする」「締め月の変更」を記録するときと同じ規則）
    if (['hold', 'release', 'move_period'].includes(row.kind)) {
      const conflict = irregularReversalConflict({entry: entryOf(row), entries: await loadEntries(db, i.org_id, [row.holder_partner_id]),
        reported: (await holderState(i, row.holder_partner_id)).reported});
      if (conflict) throw fail(conflict, 409);
    }
    const reversalId = await nextId('royalty_irregular_entries');
    await runBatch([
      {sql: `INSERT INTO royalty_irregular_entries(id,org_id,holder_partner_id,agreement_id,kind,accrual_month,close_month,amount_yen,reason,source_reference,reverses_entry_id,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, params: [reversalId, i.org_id, row.holder_partner_id, row.agreement_id, row.kind, row.accrual_month, row.close_month, row.amount_yen, reason, row.source_reference, id, i.user_id]},
      audit(i, 'reverse', 'royalty_irregular_entry', id, {reversalId, reason}),
    ]);
    return c.json({ok: true, id: reversalId}, 201);
  }));

  // ---------- 期間・確定版 ----------
  function periodSummary(row, hash) {
    const draft = row.draft;
    return {...row, blockedReason: row.blockedReason ?? null, draft: draft ? {
      totals: draft.totals, lineCount: draft.lines.length, holdCount: draft.holds.length, checksOk: checksOk(draft.checks), accrualFrom: draft.accrualFrom, accrualTo: draft.accrualTo,
      previousCloseMonth: draft.previousCloseMonth, inputHash: hash,
    } : null};
  }

  app.get('/api/royalty/periods', handle(async (c, i) => {
    const asOf = asOfOf(c);
    const holderId = c.req.query('holderId') ? positiveId(c.req.query('holderId')) : null;
    if (c.req.query('holderId') && !holderId) throw fail('権利者の指定を読み取れません');
    const result = await royaltyPeriods(db, i, ctx, {asOf, holderId, withDrafts: true});
    markBlockedPeriods(result.periods);
    const periods = [];
    for (const row of result.periods) periods.push(periodSummary(row, row.draft ? await inputHash(row.holderId, row.draft) : null));
    periods.sort((a, b) => a.closeMonth.localeCompare(b.closeMonth) || (a.holderName || '').localeCompare(b.holderName || '', 'ja'));
    const counts = Object.fromEntries(['open', 'pending', 'overdue', 'created', 'reported', 'paid', 'merged'].map((status) => [status, periods.filter((p) => p.status === status).length]));
    const creatable = periods.filter(isCreatablePeriod);
    const blocked = periods.filter((p) => p.blockedReason);
    return c.json({ok: true, asOf, periods, holders: result.holders, counts, generateLimit: GENERATE_LIMIT,
      creatable: {count: creatable.length, payableYen: creatable.reduce((n, p) => n + (p.payableYen ?? 0), 0)}, blocked: {count: blocked.length},
      latestImportAt: (await db.get("SELECT MAX(created_at) AS at FROM report_imports WHERE org_id=? AND status='active'", [i.org_id]))?.at || null});
  }));

  // 確定版1通を1回の batch で書く。明細は json_each で数文にまとめ（明細の行数によらず batch の文の数を抑える）、
  // 計算の内容はクラウドの1つの値の上限を超えるときに分割して保存する。行ごとのトリガー（行数・和・権利者の検査）はそのまま働く
  async function createStatement(i, holder, draft, asOf, hash, {id, versionNo}) {
    const t = draft.totals;
    const calculation = JSON.stringify({...draft, statementId: id, versionNo, inputHash: hash});
    const calculationBytes = utf8Bytes(calculation);
    const parts = calculationBytes > VALUE_BYTES ? splitUtf8(calculation, VALUE_BYTES) : [];
    const stored = parts.length ? JSON.stringify({calculationVersion: CALCULATION_VERSION, statementId: id, versionNo, inputHash: hash, calculationParts: parts.length, calculationBytes}) : calculation;
    const lineChunks = chunkRows(draft.lines.map((line) => [line.lineNo, line.lineKind, line.agreementId, line.accrualMonth, line.termVersionId, line.irregularEntryId, line.salesYen,
      line.windowFeeYen, line.expenseYen, line.committeeIncomeYen, line.baseYen, line.rateBps, line.amountYen, line.note ? String(line.note).slice(0, 500) : null]), VALUE_BYTES);
    const statements = [
      {sql: `INSERT INTO royalty_statements(id,org_id,holder_partner_id,close_month,report_due_on,payment_due_on,version_no,previous_statement_id,calculation_version,as_of,input_hash,
          calculation_json,royalty_yen,adjustment_yen,advance_recouped_yen,carried_in_yen,payable_yen,carried_out_yen,hold_count,line_count,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [id, i.org_id, holder.id, draft.closeMonth, draft.reportDueOn, draft.paymentDueOn, versionNo, draft.previousStatementId, CALCULATION_VERSION, asOf, hash,
        stored, t.royaltyYen, t.adjustmentYen, t.advanceRecoupedYen, t.carriedInYen, t.payableYen, t.carriedOutYen, t.holdCount, draft.lines.length, i.user_id]},
      ...lineChunks.map((chunk) => ({
        sql: `INSERT INTO royalty_statement_lines(org_id,statement_id,line_no,line_kind,agreement_id,accrual_month,term_version_id,irregular_entry_id,sales_yen,window_fee_yen,
            expense_yen,committee_income_yen,base_yen,rate_bps,amount_yen,note,created_by)
          SELECT ?, ?, json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]'), json_extract(value,'$[5]'),
            json_extract(value,'$[6]'), json_extract(value,'$[7]'), json_extract(value,'$[8]'), json_extract(value,'$[9]'), json_extract(value,'$[10]'), json_extract(value,'$[11]'),
            json_extract(value,'$[12]'), json_extract(value,'$[13]'), ? FROM json_each(?) ORDER BY CAST(key AS INTEGER)`,
        params: [i.org_id, id, i.user_id, chunk],
      })),
      ...parts.map((part, index) => ({sql: 'INSERT INTO royalty_statement_calculation_parts(org_id,statement_id,part_no,body,created_by) VALUES(?,?,?,?,?)', params: [i.org_id, id, index + 1, part, i.user_id]})),
      audit(i, 'create', 'royalty_statement', id, {holderId: holder.id, closeMonth: draft.closeMonth, versionNo, payableYen: t.payableYen, inputHash: hash, lineCount: draft.lines.length}),
    ];
    if (statements.length > batchLimit) {
      throw fail(`この報告書は内容が大きく（明細${draft.lines.length.toLocaleString('ja-JP')}行・計算の内容 約${Math.ceil(calculationBytes / 1024).toLocaleString('ja-JP')}KB）、1回で保存できる大きさを超えます。報告書は権利者×締め月で1通のため分けられません。管理者に連絡してください`, 413);
    }
    await runBatch(statements);
    return {id, versionNo};
  }

  // 作成待ち・期限超過の期間を古い順に確定版にする（1件ごとに1回の batch）。keys を渡すとその期間だけ（同じ権利者の前の期間を飛ばさない）。
  // 読み込み（契約・台帳・確定版・売上）は権利者ごとにせず1回だけ。1回に作るのは GENERATE_LIMIT 通までで、残りは remaining で返す（画面から続けて作る）
  app.post('/api/royalty/statements/generate', handle(async (c, i) => {
    const input = await readBody(c);
    if (input.confirmed !== true) throw fail('内容を確かめてから作成してください（確認が必要です）');
    const asOf = input.asOf ? text(input.asOf) : todayJst();
    if (!isDate(asOf)) throw fail('基準日を「2026-09-30」の形で指定してください');
    if (asOf > todayJst()) throw fail('基準日は今日以前にしてください（締めていない月の報告書は作れません）');
    const keys = Array.isArray(input.keys) ? [...new Set(input.keys.map(String))] : null;
    const expected = input.expectedHashes && typeof input.expectedHashes === 'object' ? input.expectedHashes : {};
    const result = await royaltyPeriods(db, i, ctx, {asOf, withDrafts: false});
    const holderIds = keys ? [...new Set(keys.map((key) => Number(key.split(':')[0])))] : result.holders.map((holder) => holder.id);
    const created = [];
    const skipped = [];
    const remaining = [];
    for (const key of keys || []) {
      if (!/^\d+:\d{4}-(0[1-9]|1[0-2])$/.test(key)) skipped.push({key, reason: '期間の指定を読み取れません'});
    }
    const plans = [];
    for (const holderId of holderIds.sort((a, b) => a - b)) {
      const holder = result.holders.find((h) => h.id === holderId);
      const wanted = (keys || []).filter((key) => key.startsWith(`${holderId}:`));
      if (!holder) { for (const key of wanted) skipped.push({key, reason: '権利者の契約が見つからないか、財務権限がありません'}); continue; }
      if (holder.restricted) {
        for (const key of wanted.length ? wanted : result.periods.filter((p) => p.holderId === holderId && (p.status === 'pending' || p.status === 'overdue')).map((p) => p.key)) {
          skipped.push({key, reason: '権利者の契約に財務権限のない作品が含まれるため作れません'});
        }
        continue;
      }
      const candidates = result.periods.filter((p) => p.holderId === holderId && !p.statementId && (p.status === 'pending' || p.status === 'overdue')).sort((a, b) => a.closeMonth.localeCompare(b.closeMonth));
      const selected = keys ? candidates.filter((p) => wanted.includes(p.key)) : candidates;
      for (const key of wanted) if (!candidates.some((p) => p.key === key)) {
        const period = result.periods.find((p) => p.key === key);
        skipped.push({key, reason: period ? `この期間は「${period.statusLabel}」のため作れません` : 'この期間は作成待ちではありません'});
      }
      if (selected.length) plans.push({holder, candidates, selected});
    }
    if (plans.length) {
      const holderSet = new Set(plans.map((plan) => plan.holder.id));
      const agreements = result.agreements.filter((agreement) => holderSet.has(agreement.holderId));
      const entries = result.entries.filter((entry) => holderSet.has(entry.holderId));
      const manual = await loadManual(db, i.org_id, agreements.map((a) => a.id));
      const toMonth = plans.flatMap((plan) => plan.selected.map((p) => p.closeMonth)).sort().at(-1);
      const items = await loadItems(db, i, agreements, entries, manual, {toMonth}, ctx);
      const versions = new Map((await db.all('SELECT holder_partner_id AS holder_id, close_month, COUNT(*) AS n FROM royalty_statements WHERE org_id=? GROUP BY holder_partner_id, close_month', [i.org_id]))
        .map((row) => [`${row.holder_id}:${row.close_month}`, Number(row.n)]));
      let nextStatementId = await nextId('royalty_statements');
      let budget = GENERATE_LIMIT;
      for (const {holder, candidates, selected} of plans) {
        const own = agreements.filter((a) => a.holderId === holder.id);
        const ownEntries = entries.filter((e) => e.holderId === holder.id);
        const ownItems = items.filter((item) => item.holderId === holder.id);
        const closings = holderClosings({agreements: own, entries: ownEntries, asOfMonth: asOf.slice(0, 7)});
        const chain = result.statements.filter((s) => s.holderId === holder.id).map((s) => ({id: s.id, closeMonth: s.closeMonth, carriedOutYen: s.carriedOutYen, lines: s.lines}));
        let blocked = false;
        for (const period of selected) {
          if (blocked) { skipped.push({key: period.key, reason: '前の期間を作れなかったため、この期間も作っていません'}); continue; }
          const earlier = candidates.filter((p) => p.closeMonth < period.closeMonth && !selected.includes(p));
          if (earlier.length) {
            skipped.push({key: period.key, reason: `先に前の期間（${earlier.map((p) => monthLabel(p.closeMonth)).join('、')}締め）を作成してください`});
            blocked = true;
            continue;
          }
          if (budget <= 0) { remaining.push(period.key); continue; }
          const draft = buildStatement({holder: {id: holder.id, name: holder.name, code: holder.code}, closeMonth: period.closeMonth, asOf, agreements: own, items: ownItems,
            adjustments: ownEntries.filter((e) => e.kind === 'adjust_amount'), priorStatements: chain, due: closings.get(period.closeMonth) || {}});
          const hash = await inputHash(holder.id, draft);
          if (expected[period.key] && expected[period.key] !== hash) {
            skipped.push({key: period.key, reason: '確認した後に元のデータが変わりました。一覧を再読込して金額を確かめてから作成してください'});
            blocked = true;
            continue;
          }
          const unchecked = statementBlockReason(draft);
          if (unchecked) {
            skipped.push({key: period.key, reason: unchecked, checks: draft.checks.filter((check) => check.value !== 0)});
            blocked = true;
            continue;
          }
          const versionKey = `${holder.id}:${period.closeMonth}`;
          try {
            const saved = await createStatement(i, holder, draft, asOf, hash, {id: nextStatementId, versionNo: (versions.get(versionKey) ?? 0) + 1});
            versions.set(versionKey, saved.versionNo);
            nextStatementId += 1;
            budget -= 1;
            created.push({key: period.key, statementId: saved.id, versionNo: saved.versionNo, holderName: holder.name, closeMonth: period.closeMonth, payableYen: draft.totals.payableYen});
            chain.push({id: saved.id, closeMonth: period.closeMonth, carriedOutYen: draft.totals.carriedOutYen, lines: draft.lines});
          } catch (error) {
            skipped.push({key: period.key, reason: error.message});
            blocked = true;
            nextStatementId = await nextId('royalty_statements');
          }
        }
      }
    }
    return c.json({ok: true, asOf, created, skipped, remaining: {count: remaining.length, keys: remaining}, limit: GENERATE_LIMIT}, created.length ? 201 : 200);
  }));

  app.get('/api/royalty/statements', handle(async (c, i) => {
    const asOf = asOfOf(c);
    const holderFilter = c.req.query('holderId') ? positiveId(c.req.query('holderId')) : null;
    const {agreements, restrictedHolders} = await loadAgreements(db, i, ctx, {holderId: holderFilter});
    const holderIds = [...new Set(agreements.map((a) => a.holderId))].filter((id) => !restrictedHolders.has(id));
    const includeVoided = c.req.query('includeVoided') === '1';
    const statements = await loadStatements(db, i.org_id, holderIds, {includeVoided});
    const latestActive = new Map();
    for (const statement of statements) if (!statement.voided && (!latestActive.has(statement.holderId) || latestActive.get(statement.holderId) < statement.closeMonth)) latestActive.set(statement.holderId, statement.closeMonth);
    const rows = statements.map((statement) => {
      const state = eventState(statement.events);
      const status = statement.voided ? 'voided' : statementStatus(statement, statement.events, asOf);
      const {lines, events, ...rest} = statement;
      return {...rest, status, statusLabel: status === 'voided' ? '取消済み' : labelOf('royaltyPeriodStatus', status), reportedOn: state.reportedOn, paidYen: state.paidYen,
        unpaidYen: statement.voided ? 0 : statement.payableYen - state.paidYen, eventCount: events.length,
        canVoid: !statement.voided && latestActive.get(statement.holderId) === statement.closeMonth && state.paidYen === 0};
    }).sort((a, b) => b.closeMonth.localeCompare(a.closeMonth) || (a.holderName || '').localeCompare(b.holderName || '', 'ja') || b.versionNo - a.versionNo);
    return c.json({ok: true, asOf, statements: rows, holders: holdersOf(agreements).map((holder) => ({...holder, restricted: restrictedHolders.has(holder.id)}))});
  }));

  app.get('/api/royalty/statements/preview', handle(async (c, i) => {
    const asOf = asOfOf(c);
    const closeMonth = text(c.req.query('closeMonth'));
    if (!isMonth(closeMonth)) throw fail('締め月を「2026-06」の形で指定してください');
    const {holder} = await holderScope(i, c.req.query('holderId'));
    const result = await royaltyPeriods(db, i, ctx, {asOf, holderId: holder.id, withDrafts: true});
    markBlockedPeriods(result.periods);
    const period = result.periods.find((p) => p.holderId === holder.id && p.closeMonth === closeMonth);
    if (!period) throw fail('この権利者の契約のサイクルに、この締め月はありません', 404);
    if (period.statementId) return c.json({ok: true, preview: false, statementId: period.statementId, status: period.status, statusLabel: period.statusLabel});
    if (!period.draft) throw fail(`この期間は「${period.statusLabel}」です。後の締め月の報告書に含めて報告します`, 409);
    return c.json({ok: true, preview: true, key: period.key, status: period.status, statusLabel: period.statusLabel, asOf,
      canCreate: (period.status === 'pending' || period.status === 'overdue') && !period.blockedReason, blockedReason: period.blockedReason ?? null,
      inputHash: await inputHash(holder.id, period.draft),
      statement: period.draft, holder: {id: holder.id, name: holder.name, code: holder.code}});
  }));

  async function statementFor(i, rawId) {
    const id = positiveId(rawId);
    if (!id) throw fail('報告書の指定を読み取れません');
    const row = await db.get('SELECT id, holder_partner_id FROM royalty_statements WHERE org_id=? AND id=?', [i.org_id, id]);
    if (!row) throw fail('報告書が見つかりません', 404);
    await holderScope(i, row.holder_partner_id);
    const [statement] = await loadStatements(db, i.org_id, [row.holder_partner_id], {includeVoided: true, withCalculation: true, statementIds: [id]});
    return statement;
  }

  app.get('/api/royalty/statements/:id', handle(async (c, i) => {
    const asOf = asOfOf(c);
    const statement = await statementFor(i, c.req.param('id'));
    const others = await loadStatements(db, i.org_id, [statement.holderId]);
    const latest = others.map((s) => s.closeMonth).sort().at(-1);
    const state = eventState(statement.events);
    const status = statement.voided ? 'voided' : statementStatus(statement, statement.events, asOf);
    const reversed = new Set(statement.events.filter((e) => e.reversesEventId).map((e) => e.reversesEventId));
    const {lines, calculation, ...rest} = statement;
    return c.json({ok: true, asOf, statement: {...rest, status, statusLabel: status === 'voided' ? '取消済み' : labelOf('royaltyPeriodStatus', status),
      reportedOn: state.reportedOn, paidYen: state.paidYen, unpaidYen: statement.voided ? 0 : statement.payableYen - state.paidYen,
      canVoid: !statement.voided && latest === statement.closeMonth && state.paidYen === 0,
      events: statement.events.map((event) => ({...event, kindLabel: labelOf('royaltyEventKind', event.eventKind), reversed: reversed.has(event.id), isReversal: Boolean(event.reversesEventId)}))},
    calculation, lineCount: lines.length});
  }));

  app.post('/api/royalty/statements/:id/void', handle(async (c, i) => {
    const statement = await statementFor(i, c.req.param('id'));
    const input = await readBody(c);
    const reason = text(input.reason);
    if (!reason || reason.length > 1000) throw invalid([{field: 'reason', message: '取り消す理由を入れてください'}]);
    if (statement.voided) throw fail('この報告書は取消済みです', 409);
    if (eventState(statement.events).paidYen > 0) throw fail('支払の記録があるため取り消せません。先に支払の記録を取り消してください', 409);
    const later = (await loadStatements(db, i.org_id, [statement.holderId])).filter((s) => s.closeMonth > statement.closeMonth);
    if (later.length) throw fail(`後の締め月の報告書（${later.map((s) => monthLabel(s.closeMonth)).join('、')}締め）があるため取り消せません。後の報告書から順に取り消してください`, 409);
    const id = await nextId('royalty_statement_voids');
    await runBatch([
      {sql: 'INSERT INTO royalty_statement_voids(id,org_id,statement_id,reason,created_by) VALUES(?,?,?,?,?)', params: [id, i.org_id, statement.id, reason, i.user_id]},
      audit(i, 'void', 'royalty_statement', statement.id, {reason, holderId: statement.holderId, closeMonth: statement.closeMonth}),
    ]);
    return c.json({ok: true, id}, 201);
  }));

  // 報告と支払の記録。kind: reported（報告日）／paid（支払日・金額・識別番号）／reverse（記録の取消。eventId と理由）
  app.post('/api/royalty/statements/:id/events', handle(async (c, i) => {
    const statement = await statementFor(i, c.req.param('id'));
    if (statement.voided) throw fail('取り消した報告書には記録できません', 409);
    const input = await readBody(c);
    const kind = text(input.kind);
    const errors = [];
    const note = text(input.note) || null;
    if (note && note.length > 1000) errors.push({field: 'note', message: 'メモは1000文字以内です'});
    const occurredOn = text(input.occurredOn) || (kind === 'reverse' ? todayJst() : '');
    if (!isDate(occurredOn)) errors.push({field: 'occurredOn', message: '日付を「2026-09-30」の形で入れてください'});
    else if (occurredOn > todayJst()) errors.push({field: 'occurredOn', message: '日付は今日以前にしてください（実際に報告・支払をした日を記録します）'});
    let row;
    if (kind === 'reported') {
      if (errors.length) throw invalid(errors);
      if (eventState(statement.events).reportedOn) throw fail('報告の記録は登録済みです。日付を直すときは取り消してから記録してください', 409);
      row = {kind: 'reported', amountYen: null, reference: text(input.reference) || null, reversesEventId: null, note};
    } else if (kind === 'paid') {
      const amountYen = toInt(input.amountYen);
      const reference = text(input.reference);
      if (!Number.isSafeInteger(amountYen) || amountYen <= 0) errors.push({field: 'amountYen', message: '支払額を1円以上の整数で入れてください'});
      if (!reference || reference.length > 200) errors.push({field: 'reference', message: '支払の識別番号（振込の番号など）を入れてください'});
      if (errors.length) throw invalid(errors);
      const state = eventState(statement.events);
      if (state.paidYen + amountYen > statement.payableYen) {
        throw invalid([{field: 'amountYen', message: `支払の合計が支払予定額（${statement.payableYen.toLocaleString('ja-JP')}円）を超えます。記録済みの支払は${state.paidYen.toLocaleString('ja-JP')}円です`}]);
      }
      row = {kind: 'paid', amountYen, reference, reversesEventId: null, note};
    } else if (kind === 'reverse') {
      const eventId = positiveId(input.eventId);
      const target = statement.events.find((event) => event.id === eventId);
      if (!target) throw fail('取り消す記録が見つかりません', 404);
      if (target.reversesEventId) throw fail('取消の記録は取り消せません', 409);
      if (statement.events.some((event) => event.reversesEventId === target.id)) throw fail('この記録は取消済みです', 409);
      const reason = text(input.reason) || note;
      if (!reason) errors.push({field: 'reason', message: '取り消す理由を入れてください'});
      if (isDate(occurredOn) && occurredOn < target.occurredOn) errors.push({field: 'occurredOn', message: '取消の日付は、取り消す記録の日付以後にしてください'});
      if (errors.length) throw invalid(errors);
      row = {kind: target.eventKind, amountYen: target.amountYen, reference: target.reference, reversesEventId: target.id, note: reason};
    } else throw invalid([{field: 'kind', message: '記録の種類（報告・支払・取消）を選んでください'}]);
    const id = await nextId('royalty_statement_events');
    await runBatch([
      {sql: 'INSERT INTO royalty_statement_events(id,org_id,statement_id,event_kind,occurred_on,amount_yen,reference,note,reverses_event_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
        params: [id, i.org_id, statement.id, row.kind, occurredOn, row.amountYen, row.reference, row.note, row.reversesEventId, i.user_id]},
      audit(i, row.reversesEventId ? 'reverse' : 'record', 'royalty_statement_event', id, {statementId: statement.id, kind: row.kind, occurredOn, amountYen: row.amountYen, reversesEventId: row.reversesEventId}),
    ]);
    return c.json({ok: true, id}, 201);
  }));

  // ---------- 集計シート ----------
  app.get('/api/royalty/ledger', handle(async (c, i) => {
    const from = text(c.req.query('from'));
    const to = text(c.req.query('to'));
    if (!isMonth(from) || !isMonth(to)) throw fail('期間（from・to）を「2026-05」の形で指定してください');
    if (from > to) throw fail('期間の開始月が終了月より後になっています');
    if (monthsBetween(from, to).length > 60) throw fail('期間は60か月以内で指定してください');
    const holderId = c.req.query('holderId') ? positiveId(c.req.query('holderId')) : null;
    const workId = c.req.query('workId') ? positiveId(c.req.query('workId')) : null;
    const category = text(c.req.query('category')) || null;
    if (category && !ROYALTY_CATEGORIES.includes(category)) throw fail('種別の指定を読み取れません');
    if (workId && !await settlementWork(i, workId)) throw fail('作品の財務権限がありません', 403);
    const {agreements, restrictedHolders} = await loadAgreements(db, i, ctx, {holderId, workId, category});
    const holderIds = [...new Set(agreements.map((a) => a.holderId))];
    const agreementIds = new Set(agreements.map((a) => a.id));
    // 作品・種別で絞ったときは、絞り込んだ契約の記録だけ（権利者全体の調整は絞込の契約に属さない）。
    // 権限外の作品の契約を持つ権利者の、権利者全体（契約に付かない）の記録は出さない
    const narrowed = Boolean(workId || category);
    const entries = holderIds.length ? (await loadEntries(db, i.org_id, holderIds))
      .filter((entry) => (entry.agreementId ? agreementIds.has(entry.agreementId) : !narrowed && !restrictedHolders.has(entry.holderId))) : [];
    const manual = await loadManual(db, i.org_id, agreements.map((a) => a.id));
    const items = await loadItems(db, i, agreements, entries, manual, {toMonth: to}, ctx);
    const statements = await loadStatements(db, i.org_id, holderIds.filter((id) => !restrictedHolders.has(id)));
    // 支払・報告済みは権利者の全契約で1つの値なので、作品・種別で絞った表と、権限外の作品の契約を持つ権利者には出さない
    const paymentHolderIds = new Set(narrowed ? [] : holderIds.filter((id) => !restrictedHolders.has(id)));
    const ledger = buildLedger({agreements, items, entries, manualAccruals: manual, statements, from, to, paymentHolderIds});
    const partial = holderIds.filter((id) => restrictedHolders.has(id));
    const notes = [];
    if (narrowed) notes.push('作品・種別で絞り込んだ表では、支払累計・報告済み・未払残を出していません（支払は権利者の全契約で1つの値のため）。権利者全体の調整も含めていません');
    if (partial.length) notes.push('財務権限のない作品の契約を持つ権利者は、権限のある契約だけを集計しています（支払・報告済み・未払残と、権利者全体の調整は出していません）');
    return c.json({ok: true, ...ledger, filters: {holderId, workId, category}, paymentScope: narrowed ? 'none' : partial.length ? 'partial' : 'all',
      holders: holdersOf(agreements), partialHolders: partial,
      dataAsOf: {latestImportAt: (await db.get("SELECT MAX(created_at) AS at FROM report_imports WHERE org_id=? AND status='active'", [i.org_id]))?.at || null, generatedAt: new Date().toISOString()},
      basis: '計上月・税抜。売上は商品の作品配賦で割り当てた額（帳票センターの年間売上と同じ数え方）。発生額は契約の条件版で計算し、保留の分は0円にせず別に示します。',
      notes});
  }));
}
