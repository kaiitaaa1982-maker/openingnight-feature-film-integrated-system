// 帳票の発行記録のAPI（ロイヤリティ報告書・MG売上報告）。Worker でも動くよう node:* を import しない。
// ・発行: 画面から送られた数字は使わず、サーバーが同じ条件で帳票を作り直して本体とハッシュを保存する。
//   ロイヤリティは /api/reports/royalty-statement、MGは /api/rights-reports/mg-portfolio と同じ組み立て。
// ・同じ条件の有効な発行は1件だけ（表のトリガーでも止める）。取消は理由必須で、取消後に同じ条件で再発行できる。
// ・発行の記録と取消の記録は変更・削除できない（report-issuance.sql のトリガー）。外部への送付はしない。
// ・制作担当は参照できない。発行・取消は、その帳票に含まれる作品すべての財務権限が要る（権限外を含む条件は403）。
import {isUniqueViolation} from './data-platform/db-errors.mjs';
import {allIn} from './sql-in.mjs';
import {buildRoyaltyStatement} from './reports/royalty-statement-model.mjs';
import {buildMgPortfolio} from './mg-portfolio.mjs';
import {ISSUANCE_KINDS, isIssuanceKind, normalizeConditions, keyFigures, headlineYen, compareIssued, voidReasonError} from './report-issuance.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
export const MAX_CONTENT_BYTES = 1_800_000;
export const LIST_LIMIT = 1000;
const byteLength = (text) => new TextEncoder().encode(text).length;

export function jstToday(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function latestImportAt(db, orgId) {
  const row = await db.get("SELECT MAX(created_at) AS at FROM report_imports WHERE org_id=? AND status='active'", [orgId]);
  return row?.at || null;
}

// ロイヤリティ報告書（権利元1者×期間）の本体。strict のとき、権利元の契約に財務権限のない作品があれば403。
// strict でないときは報告書の画面と同じく、権限のある作品だけで作る（試験で同じ結果になることを確かめる）。
export async function royaltyIssuanceContent({db, settlementWork, settlementPreviewData}, identity, conditions, {strict = true} = {}) {
  const {from, to, holderId, workId} = conditions;
  const holder = await db.get('SELECT id, code, name FROM partners WHERE org_id=? AND id=?', [identity.org_id, holderId]);
  if (!holder) throw fail('権利元が見つかりません', 404);
  if (workId && !await settlementWork(identity, workId)) throw fail('作品の財務権限がありません', 403);
  const contracts = await db.all(`SELECT c.*, w.title AS work_title, p.name AS holder_name, p.code AS holder_code FROM settlement_contracts c
      JOIN works w ON w.org_id=c.org_id AND w.id=c.work_id LEFT JOIN partners p ON p.org_id=c.org_id AND p.id=c.holder_partner_id
      WHERE c.org_id=? AND c.holder_partner_id=?${workId ? ' AND c.work_id=?' : ''} ORDER BY c.id`,
  workId ? [identity.org_id, holderId, workId] : [identity.org_id, holderId]);
  if (strict && !contracts.length) throw fail('この権利元の個別権利契約がありません（条件の作品も確かめてください）', 404);
  const workIds = [...new Set(contracts.map((contract) => contract.work_id))].sort((a, b) => a - b);
  const allowed = [];
  for (const id of workIds) if (await settlementWork(identity, id)) allowed.push(id);
  if (strict && allowed.length < workIds.length) throw fail('この権利元の契約に、財務権限のない作品が含まれます。すべての作品の財務権限がある人が発行を記録してください', 403);
  const scoped = contracts.filter((contract) => allowed.includes(contract.work_id));
  const lines = [];
  for (const id of allowed) lines.push(...(await settlementPreviewData(identity, id)).lineResults);
  const ids = scoped.map((contract) => contract.id);
  const payments = await allIn(db, 'SELECT * FROM rights_payment_events WHERE org_id=? AND settlement_contract_id IN (:in) ORDER BY paid_on, id', {before: [identity.org_id], ids, sortBy: (a, b) => String(a.paid_on).localeCompare(String(b.paid_on)) || a.id - b.id});
  const statement = buildRoyaltyStatement({lines, contracts: scoped, payments, from, to, holderId});
  return {
    body: {...statement, holder: {id: holder.id, name: holder.name, code: holder.code}},
    recipient: {type: 'partner', id: holder.id, name: holder.name},
    workIds: allowed,
    dataAsOf: {latestImportAt: await latestImportAt(db, identity.org_id)},
  };
}

// MG売上報告（取引先1社×基準月）の本体。/api/rights-reports/mg-portfolio の組み立てと同じ（generatedAt だけ除く）。
// strict のとき、取引先の契約に財務権限のない作品があれば403（画面の集計は黙って除くが、発行は一部だけにしない）。
export async function mgIssuanceContent({db, settlementWork}, identity, conditions, {strict = true} = {}) {
  const {direction, month, partyId} = conditions;
  const contractField = `${direction}_contract_id`;
  const partyField = direction === 'incoming' ? 'partner_id' : 'supplier_id';
  const partyTable = direction === 'incoming' ? 'partners' : 'mg_suppliers';
  const party = await db.get(`SELECT id, code, name FROM ${partyTable} WHERE org_id=? AND id=?`, [identity.org_id, partyId]);
  if (!party) throw fail('取引先が見つかりません', 404);
  const [contracts, versions, versionProducts, ledger, mappings, products, works] = await Promise.all([
    db.all(`SELECT * FROM mg_${direction}_contracts WHERE org_id=?`, [identity.org_id]),
    db.all(`SELECT * FROM mg_term_versions WHERE org_id=? AND ${contractField} IS NOT NULL`, [identity.org_id]),
    db.all('SELECT * FROM mg_version_products WHERE org_id=?', [identity.org_id]),
    db.all(`SELECT l.* FROM mg_ledger_entries l JOIN mg_term_versions v ON v.org_id=l.org_id AND v.id=l.term_version_id WHERE l.org_id=? AND v.${contractField} IS NOT NULL ORDER BY l.id`, [identity.org_id]),
    db.all('SELECT * FROM product_works WHERE org_id=?', [identity.org_id]),
    db.all('SELECT id,sku,name FROM products WHERE org_id=?', [identity.org_id]),
    db.all('SELECT id,title FROM works WHERE org_id=?', [identity.org_id]),
  ]);
  const own = contracts.filter((contract) => Number(contract[partyField]) === partyId);
  if (strict && !own.length) throw fail(`この取引先の${direction === 'incoming' ? '受取' : '支払'}MG契約がありません`, 404);
  const allowed = [];
  const access = new Map();
  const workIds = new Set();
  for (const contract of own) {
    const terms = versions.filter((v) => v[contractField] === contract.id).map((v) => ({...v, products: versionProducts.filter((p) => p.term_version_id === v.id)}));
    const termIds = new Set(terms.map((v) => v.id));
    const productIds = new Set(terms.flatMap((v) => v.products.map((p) => p.product_id)));
    const allocation = mappings.filter((m) => productIds.has(m.product_id));
    let canRead = true;
    for (const workId of new Set(allocation.map((m) => m.work_id))) {
      if (!access.has(workId)) access.set(workId, Boolean(await settlementWork(identity, workId)));
      if (!access.get(workId)) canRead = false;
    }
    if (!canRead) {
      if (strict) throw fail('この取引先のMG契約に、財務権限のない作品が含まれます。すべての作品の財務権限がある人が発行を記録してください', 403);
      continue;
    }
    // 商品の配賦が欠けた契約は、画面の集計と同じく対象外（作品単位の権限をすり抜けさせない）
    if (!productIds.size || [...productIds].some((id) => !allocation.some((m) => m.product_id === id))) continue;
    for (const m of allocation) workIds.add(m.work_id);
    allowed.push({direction, contract, versions: terms, ledger: ledger.filter((l) => termIds.has(l.term_version_id)), mappings: allocation,
      products: products.filter((p) => productIds.has(p.id)), party});
  }
  if (strict && !allowed.length) throw fail('発行できるMG契約がありません（商品の作品配賦が欠けた契約は集計の対象外です）', 404);
  const {generatedAt, ...body} = buildMgPortfolio({direction, accountingMonth: month, contracts: allowed, works});
  return {
    body,
    recipient: {type: direction === 'incoming' ? 'partner' : 'supplier', id: party.id, name: party.name},
    workIds: [...workIds].sort((a, b) => a - b),
    dataAsOf: {latestImportAt: await latestImportAt(db, identity.org_id), mgReportGeneratedAt: generatedAt},
  };
}

// 条件から帳票の本体を作り、ハッシュと主要な数字を添える。
export async function buildIssuanceContent(ctx, identity, kind, conditions, options) {
  const built = kind === 'royalty'
    ? await royaltyIssuanceContent(ctx, identity, conditions, options)
    : await mgIssuanceContent(ctx, identity, conditions, options);
  const contentHash = await ctx.sha256(ctx.canonical({kind, conditions, body: built.body}));
  return {...built, kind, conditions, contentHash, figures: keyFigures(kind, built.body), headlineYen: headlineYen(kind, built.body)};
}

export async function conditionsHashOf(ctx, kind, conditions) {
  return ctx.sha256(ctx.canonical({kind, conditions}));
}

const SUMMARY_SQL = `SELECT r.id, r.org_id, r.report_kind, r.conditions_json, r.conditions_hash, r.content_hash, r.recipient_type, r.recipient_id, r.recipient_name,
    r.work_ids_json, r.headline_yen, r.version_no, r.previous_issuance_id, r.note, r.issued_on, r.issued_by, r.issued_at,
    u.display_name AS issued_by_name, v.id AS void_id, v.reason AS void_reason, v.voided_at, vu.display_name AS voided_by_name
  FROM report_issuances r
  LEFT JOIN users u ON u.id=r.issued_by
  LEFT JOIN report_issuance_voids v ON v.org_id=r.org_id AND v.issuance_id=r.id
  LEFT JOIN users vu ON vu.id=v.voided_by`;

export function summarizeIssuance(row) {
  const voided = row.void_id != null;
  return {
    id: row.id, kind: row.report_kind, kindLabel: ISSUANCE_KINDS[row.report_kind]?.label || row.report_kind, versionNo: row.version_no,
    previousIssuanceId: row.previous_issuance_id ?? null, conditions: JSON.parse(row.conditions_json),
    recipient: {type: row.recipient_type, id: row.recipient_id, name: row.recipient_name}, workIds: JSON.parse(row.work_ids_json),
    headlineYen: row.headline_yen, issuedOn: row.issued_on, issuedAt: row.issued_at, issuedByName: row.issued_by_name || null, note: row.note || null,
    contentHash: row.content_hash, status: voided ? 'voided' : 'active',
    void: voided ? {reason: row.void_reason, voidedAt: row.voided_at, voidedByName: row.voided_by_name || null} : null,
  };
}

// 発行の記録の一意の違反（同じ条件の発行・取消が同時に入った）
const issuanceRace = (error) => /発行記録: /.test(String(error?.message || '')) || isUniqueViolation(error, ['report_issuances', 'report_issuance_voids']);

export function registerReportIssuanceRoutes(app, ctx) {
  const {db, bad, body, settlementWork} = ctx;
  const denied = (identity) => !identity || identity.role === 'production';

  function respond(c, error) {
    if (error?.status) return bad(c, error.message, error.status, undefined, error);
    if (issuanceRace(error)) {
      return bad(c, 'この条件の帳票は、ほかの操作で先に発行が記録されました。表示を読み直してください', 409);
    }
    console.error(error);
    return bad(c, '発行記録の処理に失敗しました。時間をおいて再試行してください', 500);
  }

  function accessChecker(identity) {
    const cache = new Map();
    return async (workIds) => {
      for (const workId of workIds) {
        if (!cache.has(workId)) cache.set(workId, Boolean(await settlementWork(identity, workId)));
        if (!cache.get(workId)) return false;
      }
      return true;
    };
  }

  async function readBody(c) {
    try {
      return await body(c);
    } catch (error) {
      throw fail(error?.message || 'JSON本文を確認できません', 400);
    }
  }

  async function loadRow(identity, id, {withContent = false} = {}) {
    const sql = withContent
      ? SUMMARY_SQL.replace('SELECT r.id,', 'SELECT r.content_json, r.id,') + ' WHERE r.org_id=? AND r.id=?'
      : `${SUMMARY_SQL} WHERE r.org_id=? AND r.id=?`;
    return db.get(sql, [identity.org_id, id]);
  }

  function readQueryConditions(c) {
    const q = (key) => c.req.query(key);
    return {from: q('from'), to: q('to'), holderId: q('holderId'), workId: q('workId'), direction: q('direction'), month: q('month'), partyId: q('partyId')};
  }

  async function compareWithCurrent(identity, row, content) {
    try {
      const current = await buildIssuanceContent(ctx, identity, row.report_kind, JSON.parse(row.conditions_json), {strict: true});
      return {...compareIssued({issuedHash: row.content_hash, issuedFigures: content?.figures || [], currentHash: current.contentHash, currentFigures: current.figures}), currentHash: current.contentHash};
    } catch (error) {
      if (error?.status === 403 || error?.status === 404) return {available: false, changed: null, diffs: [], primaryDiff: null, reason: error.message};
      throw error;
    }
  }

  // 一覧。kind と条件を渡すとその条件の版（新しい順）と、いまの計算での主要な数字・発行時との比較を返す。
  // all=1 のときは条件を問わず、閲覧できる発行記録を新しい順に返す（本体は含めない）。
  app.get('/api/reports/issuances', async (c) => {
    const identity = c.get('identity');
    if (denied(identity)) return bad(c, '発行記録は財務担当の帳票です', 403);
    try {
      const kind = c.req.query('kind') || null;
      if (kind && !isIssuanceKind(kind)) return bad(c, '発行を記録できる帳票ではありません');
      const canSee = accessChecker(identity);
      if (c.req.query('all') === '1') {
        const rows = await db.all(`${SUMMARY_SQL} WHERE r.org_id=?${kind ? ' AND r.report_kind=?' : ''} ORDER BY r.issued_at DESC, r.id DESC LIMIT ?`,
          kind ? [identity.org_id, kind, LIST_LIMIT + 1] : [identity.org_id, LIST_LIMIT + 1]);
        const issuances = [];
        for (const row of rows.slice(0, LIST_LIMIT)) if (await canSee(JSON.parse(row.work_ids_json))) issuances.push(summarizeIssuance(row));
        // 件数の上限を超えたときは黙って切らず、新しい順に上限まで返したことを示す
        return c.json({ok: true, issuances, truncated: rows.length > LIST_LIMIT, limit: LIST_LIMIT});
      }
      if (!kind) return bad(c, '帳票の種類（kind）を指定してください');
      const normalized = normalizeConditions(kind, readQueryConditions(c));
      if (!normalized.ok) return bad(c, normalized.error, normalized.status);
      const conditions = normalized.conditions;
      const conditionsHash = await conditionsHashOf(ctx, kind, conditions);
      const rows = await db.all(`${SUMMARY_SQL} WHERE r.org_id=? AND r.report_kind=? AND r.conditions_hash=? ORDER BY r.version_no DESC`, [identity.org_id, kind, conditionsHash]);
      const issuances = [];
      for (const row of rows) if (await canSee(JSON.parse(row.work_ids_json))) issuances.push(summarizeIssuance(row));
      let current = null;
      let blocked = null;
      try {
        const built = await buildIssuanceContent(ctx, identity, kind, conditions, {strict: true});
        current = {contentHash: built.contentHash, figures: built.figures, headlineYen: built.headlineYen, recipient: built.recipient, dataAsOf: built.dataAsOf};
      } catch (error) {
        if (error?.status === 403 || error?.status === 404) blocked = error.message; else throw error;
      }
      const active = issuances.find((item) => item.status === 'active') || null;
      let comparison = null;
      if (active && current) {
        const stored = await db.get('SELECT content_json FROM report_issuances WHERE org_id=? AND id=?', [identity.org_id, active.id]);
        const content = JSON.parse(stored.content_json);
        comparison = compareIssued({issuedHash: active.contentHash, issuedFigures: content.figures || [], currentHash: current.contentHash, currentFigures: current.figures});
      }
      return c.json({ok: true, kind, conditions, issuances, active, current, comparison, blocked});
    } catch (error) {
      return respond(c, error);
    }
  });

  // 1件の発行記録（発行した本体つき）と、いまの計算との比較。
  app.get('/api/reports/issuances/:id', async (c) => {
    const identity = c.get('identity');
    if (denied(identity)) return bad(c, '発行記録は財務担当の帳票です', 403);
    try {
      const id = Number(c.req.param('id'));
      if (!Number.isSafeInteger(id) || id < 1) return bad(c, '発行記録の指定を読み取れません');
      const row = await loadRow(identity, id, {withContent: true});
      if (!row) return bad(c, '発行記録が見つかりません', 404);
      if (!await accessChecker(identity)(JSON.parse(row.work_ids_json))) return bad(c, 'この発行記録に含まれる作品の財務権限がありません', 403);
      const content = JSON.parse(row.content_json);
      const comparison = await compareWithCurrent(identity, row, content);
      return c.json({ok: true, issuance: {...summarizeIssuance(row), content}, comparison});
    } catch (error) {
      return respond(c, error);
    }
  });

  // 発行を記録する。本体はサーバーが作り直す（本文の数字は読まない）。expectedContentHash は
  // 画面で確かめた内容と記録する内容が同じであることの照合にだけ使う。
  app.post('/api/reports/issuances', async (c) => {
    const identity = c.get('identity');
    if (denied(identity)) return bad(c, '発行記録は財務担当の帳票です', 403);
    try {
      const input = await readBody(c);
      const kind = String(input?.kind || '');
      if (!isIssuanceKind(kind)) return bad(c, '発行を記録できる帳票ではありません');
      const normalized = normalizeConditions(kind, input?.conditions || {});
      if (!normalized.ok) return bad(c, normalized.error, normalized.status);
      const conditions = normalized.conditions;
      const note = input?.note == null ? null : String(input.note).trim() || null;
      if (note && note.length > 1000) return bad(c, 'メモは1000文字以内で入力してください');
      const built = await buildIssuanceContent(ctx, identity, kind, conditions, {strict: true});
      if (input?.expectedContentHash && input.expectedContentHash !== built.contentHash) {
        return bad(c, '確認したあとに元データが変わりました。表示を読み直し、内容を確かめてから発行を記録してください', 409);
      }
      const conditionsHash = await conditionsHashOf(ctx, kind, conditions);
      const last = await db.get(`SELECT r.id, r.version_no, v.id AS void_id FROM report_issuances r
          LEFT JOIN report_issuance_voids v ON v.org_id=r.org_id AND v.issuance_id=r.id
          WHERE r.org_id=? AND r.report_kind=? AND r.conditions_hash=? ORDER BY r.version_no DESC LIMIT 1`, [identity.org_id, kind, conditionsHash]);
      if (last && last.void_id == null) return bad(c, `この条件の帳票は第${last.version_no}版として発行済みです。内容を改めるときは、取り消してから再発行してください`, 409);
      const versionNo = last ? last.version_no + 1 : 1;
      const content = {format: 1, kind, conditions, recipient: built.recipient, workIds: built.workIds, figures: built.figures, dataAsOf: built.dataAsOf, body: built.body};
      const contentJson = JSON.stringify(content);
      if (byteLength(contentJson) > MAX_CONTENT_BYTES) {
        return bad(c, `発行する内容が大きすぎて記録できません（約${Math.ceil(byteLength(contentJson) / 1024).toLocaleString('ja-JP')}KB）。期間を分けて発行してください`, 413);
      }
      const issuedOn = jstToday();
      const statements = [
        {sql: `INSERT INTO report_issuances(org_id, report_kind, conditions_json, conditions_hash, content_json, content_hash, recipient_type, recipient_id, recipient_name,
            work_ids_json, headline_yen, version_no, previous_issuance_id, note, issued_on, issued_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [identity.org_id, kind, JSON.stringify(conditions), conditionsHash, contentJson, built.contentHash, built.recipient.type, built.recipient.id, built.recipient.name,
          JSON.stringify(built.workIds), built.headlineYen, versionNo, last ? last.id : null, note, issuedOn, identity.user_id]},
        {sql: `INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,version_hash,detail_json)
            VALUES(?,?,'issue','report_issuance',CAST((SELECT id FROM report_issuances WHERE org_id=? AND report_kind=? AND conditions_hash=? AND version_no=?) AS TEXT),?,?)`,
        params: [identity.org_id, identity.user_id, identity.org_id, kind, conditionsHash, versionNo, built.contentHash,
          JSON.stringify({kind, conditions, versionNo, recipient: built.recipient, headlineYen: built.headlineYen})]},
      ];
      try {
        await db.batch(statements);
      } catch (error) {
        // 同時に別の人が同じ条件で発行した場合など（D1 はトリガーの文言を返さないことがあるので、表を読み直して判定する）
        const now = await db.get(`SELECT r.version_no FROM report_issuances r LEFT JOIN report_issuance_voids v ON v.org_id=r.org_id AND v.issuance_id=r.id
            WHERE r.org_id=? AND r.report_kind=? AND r.conditions_hash=? AND v.id IS NULL ORDER BY r.version_no DESC LIMIT 1`, [identity.org_id, kind, conditionsHash]);
        if (now) return bad(c, `この条件の帳票は、ほかの操作で第${now.version_no}版として先に発行が記録されました。表示を読み直してください`, 409);
        throw error;
      }
      const row = await db.get(`${SUMMARY_SQL} WHERE r.org_id=? AND r.report_kind=? AND r.conditions_hash=? AND r.version_no=?`, [identity.org_id, kind, conditionsHash, versionNo]);
      return c.json({ok: true, issuance: summarizeIssuance(row)}, 201);
    } catch (error) {
      return respond(c, error);
    }
  });

  // 発行を取り消す（理由必須）。取消の記録は変更・削除できない。取消後は同じ条件で再発行できる。
  app.post('/api/reports/issuances/:id/void', async (c) => {
    const identity = c.get('identity');
    if (denied(identity)) return bad(c, '発行記録は財務担当の帳票です', 403);
    try {
      const id = Number(c.req.param('id'));
      if (!Number.isSafeInteger(id) || id < 1) return bad(c, '発行記録の指定を読み取れません');
      const input = await readBody(c);
      const reasonError = voidReasonError(input?.reason);
      if (reasonError) return bad(c, reasonError);
      const reason = String(input.reason).trim();
      const row = await loadRow(identity, id);
      if (!row) return bad(c, '発行記録が見つかりません', 404);
      if (!await accessChecker(identity)(JSON.parse(row.work_ids_json))) return bad(c, 'この発行記録に含まれる作品の財務権限がありません', 403);
      if (row.void_id != null) return bad(c, 'この発行はすでに取り消されています', 409);
      await db.batch([
        {sql: 'INSERT INTO report_issuance_voids(org_id, issuance_id, reason, voided_by) VALUES(?,?,?,?)', params: [identity.org_id, id, reason, identity.user_id]},
        {sql: "INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,version_hash,detail_json) VALUES(?,?,'void','report_issuance',?,?,?)",
          params: [identity.org_id, identity.user_id, String(id), row.content_hash, JSON.stringify({reason, kind: row.report_kind, versionNo: row.version_no})]},
      ]);
      return c.json({ok: true, issuance: summarizeIssuance(await loadRow(identity, id))}, 201);
    } catch (error) {
      if (isUniqueViolation(error, 'report_issuance_voids')) return bad(c, 'この発行はすでに取り消されています', 409);
      return respond(c, error);
    }
  });
}
