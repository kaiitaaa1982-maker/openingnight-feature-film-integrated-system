import {isUniqueViolation} from '../data-platform/db-errors.mjs';
import {expenseSource} from '../expense-sheet/expense-read.mjs';
// Excel一括登録のAPI。ファイルはブラウザで読み、見出しと値の表をサーバーへ送る。サーバーは見出しの対応・型・
// 参照コード・権限・二重登録を検証したプレビューを保存し、登録時にもう一度同じ検証をして、1回のバッチで全件成立か全件不成立にする。
// 既存のマスタ（取引先・作品・商品）の修正は、承認の経路（業務データ編集）を通すため、ここでは反映しない。
import {allIn} from '../sql-in.mjs';
import {BULK_ENTITIES, BULK_ENTITY_ORDER, TEMPLATE_VERSION, entityDef} from './bulk-entities.mjs';
import {mapHeaders, planBulk, planFingerprint} from './bulk-validate.mjs';
import {importLimits, limitReason} from '../import/limits.mjs';

const PREVIEW_MINUTES = 30;
const json = (value) => JSON.stringify(value);

export function publicSpec(entity) {
  const def = entityDef(entity);
  return {
    entity, label: def.label, key: def.key, update: def.update, approvalPage: def.approvalPage || null, version: TEMPLATE_VERSION,
    columns: def.columns.map(({key, header, type, required, domain, lookup, hint, example, allowNegative, min, max}) => ({key, header, type, required: Boolean(required), domain, lookup, hint, example, allowNegative, min, max})),
  };
}

export function registerBulkRoutes(app, {db, bad, body, permittedProjects, sha256, mode = 'local'}) {
  const limits = importLimits(mode);

  async function scope(i) {
    const projects = (await permittedProjects(db, i)).map((p) => p.id);
    const finance = new Set((await permittedProjects(db, i, true)).map((p) => p.id));
    return {projects: new Set(projects), finance};
  }

  // 検証に使う既存行・参照コード・判定関数
  async function context(i, entity) {
    const s = await scope(i);
    const projectRows = await allIn(db, 'SELECT id, code, title, status, budget_yen, version FROM projects WHERE org_id=? AND id IN (:in)', {before: [i.org_id], ids: [...s.projects]});
    const workRows = await allIn(db, 'SELECT w.id, w.code, w.project_id, w.title, w.format, w.forecast_yen, w.version, p.code AS project_code FROM works w JOIN projects p ON p.org_id=w.org_id AND p.id=w.project_id WHERE w.org_id=? AND w.project_id IN (:in)', {before: [i.org_id], ids: [...s.projects]});
    const partnerRows = await db.all('SELECT id, code, name, kind, region, version FROM partners WHERE org_id=?', [i.org_id]);
    const lookups = {
      projects: new Map(projectRows.map((row) => [row.code, row.id])),
      works: new Map(workRows.map((row) => [row.code, row.id])),
      partners: new Map(partnerRows.map((row) => [row.code, row.id])),
    };
    const workProject = new Map(workRows.map((row) => [row.id, row.project_id]));
    const ctx = {lookups, workProject, scope: s};
    if (entity === 'partners') ctx.existing = new Map(partnerRows.map((row) => [row.code, row]));
    if (entity === 'projects') {
      const all = await db.all('SELECT id, code, title, status, budget_yen, version FROM projects WHERE org_id=?', [i.org_id]);
      ctx.existing = new Map(all.map((row) => [row.code, s.projects.has(row.id) ? row : {...row, title: null, budget_yen: null, hidden: true}]));
    }
    if (entity === 'works') {
      ctx.existing = new Map(workRows.map((row) => [row.code, row]));
      // 閲覧できない案件の作品コード（中身は持たず、使われていることだけ）
      ctx.takenKeys = new Set((await db.all('SELECT code FROM works WHERE org_id=?', [i.org_id])).map((row) => row.code).filter((code) => !ctx.existing.has(code)));
    }
    if (entity === 'products') {
      const products = await db.all('SELECT id, sku, name, channel, version FROM products WHERE org_id=?', [i.org_id]);
      const maps = await db.all('SELECT product_id, work_id, allocation_bps FROM product_works WHERE org_id=?', [i.org_id]);
      ctx.allocations = new Map();
      for (const m of maps) {
        if (!ctx.allocations.has(m.product_id)) ctx.allocations.set(m.product_id, []);
        ctx.allocations.get(m.product_id).push({workId: m.work_id, bps: m.allocation_bps});
      }
      ctx.existing = new Map(products.map((row) => [row.sku, row]));
    }
    if (entity === 'expenses') {
      const expenses = await allIn(db, `SELECT * FROM ${expenseSource()} WHERE org_id=? AND project_id IN (:in)`, {before: [i.org_id], ids: [...s.finance]});
      ctx.existing = new Map(expenses.map((row) => [String(row.id), row]));
      ctx.usedExpenses = new Set((await db.all('SELECT expense_id FROM committee_snapshot_expenses WHERE org_id=?', [i.org_id])).map((row) => row.expense_id));
      const contentKey = (v) => json([v.project_id, v.work_id ?? null, v.partner_id ?? null, v.incurred_on, v.accounting_month, v.category, v.description, v.budget_yen ?? null, v.actual_ex_tax, v.tax_amount]);
      const byContent = new Map(expenses.map((row) => [contentKey(row), row.id]));
      ctx.duplicateExpense = (values) => byContent.get(contentKey(values)) || null;
      ctx.expenseContentKey = contentKey;
    }
    ctx.can = (action, values, before) => {
      if (entity === 'projects' && before?.hidden) return 'この案件コードは別の案件で使われています';
      if (entity === 'works' && values.forecast_yen != null && !s.finance.has(values.project_id)) return '売上見込を入れるには案件の財務編集権限が必要です';
      if (entity === 'expenses') {
        if (!s.finance.has(values.project_id)) return '案件の財務編集権限がありません';
        if (before && !s.finance.has(before.project_id)) return '元の案件の財務編集権限がありません';
      }
      return null;
    };
    return ctx;
  }

  function parsedRows(entity, headers, rows) {
    const mapping = mapHeaders(entity, headers);
    const parsed = rows.map((row, index) => {
      const cells = {};
      for (const [col, key] of mapping.columns) cells[key] = row.values?.[col] ?? null;
      return {rowNo: Number(row.rowNo) || index + 2, cells};
    });
    return {mapping, parsed};
  }

  function guard(c) {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, 'この役割では一括登録できません', 403);
    const entity = c.req.param('entity');
    if (!BULK_ENTITIES[entity]) return bad(c, '一括登録できない種類です', 404);
    return null;
  }

  app.get('/api/bulk/entities', (c) => c.json({ok: true, entities: BULK_ENTITY_ORDER.map(publicSpec), limits: {...limits, reason: limitReason(mode)}}));

  app.get('/api/bulk/:entity/spec', (c) => guard(c) || c.json({ok: true, spec: publicSpec(c.req.param('entity')), limits: {...limits, reason: limitReason(mode)}}));

  // 現在の登録内容（Excel出力用）。見出しは日本語、参照はコードで返す。
  app.get('/api/bulk/:entity/rows', async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const i = c.get('identity');
    const entity = c.req.param('entity');
    const ctx = await context(i, entity);
    const codeOf = (list, id) => [...ctx.lookups[list].entries()].find(([, value]) => value === id)?.[0] ?? '';
    const rows = [];
    for (const row of ctx.existing.values()) {
      if (row.hidden) continue;
      if (entity === 'partners') rows.push({code: row.code, name: row.name, kind: row.kind, region: row.region});
      if (entity === 'projects') rows.push({code: row.code, title: row.title, status: row.status, budget_yen: ctx.scope.finance.has(row.id) ? row.budget_yen : null});
      if (entity === 'works') rows.push({code: row.code, project_id: row.project_code, title: row.title, format: row.format, forecast_yen: ctx.scope.finance.has(row.project_id) ? row.forecast_yen : null});
      if (entity === 'products') {
        const allocations = ctx.allocations.get(row.id) || [];
        const out = {sku: row.sku, name: row.name, channel: row.channel};
        allocations.slice(0, 3).forEach((a, index) => { out[`alloc_work_${index + 1}`] = codeOf('works', a.workId); out[`alloc_rate_${index + 1}`] = a.bps / 100; });
        if (allocations.length > 3) out.note = '4作品以上に配賦しています（先頭3件のみ出力。取込では配賦を変えません）';
        rows.push(out);
      }
      if (entity === 'expenses') rows.push({id: row.id, project_id: codeOf('projects', row.project_id), work_id: row.work_id ? codeOf('works', row.work_id) : '', partner_id: row.partner_id ? codeOf('partners', row.partner_id) : '', incurred_on: row.incurred_on, accounting_month: row.accounting_month, category: row.category, description: row.description, budget_yen: row.budget_yen, actual_ex_tax: row.actual_ex_tax, tax_amount: row.tax_amount, actual_inc_tax: row.actual_inc_tax});
    }
    return c.json({ok: true, spec: publicSpec(entity), rows});
  });

  // 登録の文（1回の batch）。プレビューでも同じ関数で数を数え、D1 の1回あたりの文の上限を超えるなら登録前に止める
  function commitStatements(i, entity, plan, {token, fileName, contentHash}) {
      const audit = (action, key, detail) => ({sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)', params: [i.org_id, i.user_id, action, entity, String(key), json({...detail, bulkPreview: token})]});
      const updatedIds = [];
      const statements = [
        {sql: 'INSERT INTO transaction_guards(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM bulk_import_previews WHERE token=? AND used_at IS NOT NULL)', params: [token]},
        {sql: 'UPDATE bulk_import_previews SET used_at=CURRENT_TIMESTAMP WHERE token=?', params: [token]},
      ];
      const pick = (values, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
      const insertSql = (table, data) => ({sql: `INSERT INTO ${table}(org_id,${Object.keys(data).join(',')}) VALUES(?,${Object.keys(data).map(() => '?').join(',')})`, params: [i.org_id, ...Object.values(data)]});
      for (const row of plan.rows) {
        if (row.action === 'insert') {
          if (entity === 'partners') statements.push(insertSql('partners', pick(row.values, ['code', 'name', 'kind', 'region'])));
          if (entity === 'projects') {
            statements.push(insertSql('projects', pick(row.values, ['code', 'title', 'status', 'budget_yen'])));
            if (i.role !== 'admin') statements.push({sql: "INSERT INTO project_memberships(org_id,project_id,user_id,permission) SELECT org_id,id,?,'edit' FROM projects WHERE org_id=? AND code=?", params: [i.user_id, i.org_id, row.values.code]});
          }
          if (entity === 'works') statements.push(insertSql('works', pick(row.values, ['project_id', 'code', 'title', 'format', 'forecast_yen'])));
          if (entity === 'products') {
            statements.push(insertSql('products', pick(row.values, ['sku', 'name', 'channel'])));
            for (const a of row.allocations || []) statements.push({sql: 'INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) SELECT org_id,id,?,? FROM products WHERE org_id=? AND sku=?', params: [a.workId, a.bps, i.org_id, row.values.sku]});
          }
          if (entity === 'expenses' && plan.canCommit) throw new Error('経費の新規登録は請求書が必要です。経費集計シートの取込を使ってください');
          statements.push(audit('bulk_create', row.key ?? `row:${row.rowNo}`, {rowNo: row.rowNo, values: row.values}));
        }
        if (row.action === 'update' && entity === 'expenses') {
          const data = pick(row.values, ['project_id', 'work_id', 'partner_id', 'incurred_on', 'accounting_month', 'category', 'description', 'budget_yen', 'actual_ex_tax', 'tax_amount', 'actual_inc_tax']);
          statements.push({sql: 'INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM expenses WHERE org_id=? AND id=? AND version=?)', params: [i.org_id, row.before.id, row.before.version]});
          statements.push({sql: 'INSERT INTO transaction_guards(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM committee_snapshot_expenses WHERE org_id=? AND expense_id=?)', params: [i.org_id, row.before.id]});
          statements.push({sql: `UPDATE expenses SET ${Object.keys(data).map((k) => `${k}=?`).join(',')},version=version+1 WHERE org_id=? AND id=? AND version=?`, params: [...Object.values(data), i.org_id, row.before.id, row.before.version]});
          statements.push(audit('bulk_update', row.before.id, {rowNo: row.rowNo, before: row.before, after: data}));
          updatedIds.push(row.before.id);
        }
      }
      statements.push({sql: 'INSERT INTO bulk_import_batches(org_id, entity, file_name, content_hash, inserted_count, updated_count, unchanged_count, approval_count, created_by) VALUES(?,?,?,?,?,?,?,?,?)',
        params: [i.org_id, entity, fileName, contentHash, plan.summary.insert, plan.summary.update, plan.summary.unchanged, plan.summary.approval, i.user_id]});
    return {statements, updatedIds};
  }

  const tooManyStatements = (count, rowCount) => {
    const perBatch = Math.max(1, Math.floor(rowCount * limits.batchStatements / count));
    return `この内容は1回で登録できる処理の数（${limits.batchStatements}件）を超えます（${count}件）。${perBatch}行ずつにファイルを分けてください（${limitReason(mode)}）`;
  };

  app.post('/api/bulk/:entity/preview', async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const i = c.get('identity');
    const entity = c.req.param('entity');
    const input = await body(c);
    const headers = Array.isArray(input.headers) ? input.headers.map((h) => String(h ?? '')) : [];
    const rows = Array.isArray(input.rows) ? input.rows : [];
    if (!headers.length) return bad(c, '見出しの行が見つかりません。テンプレートの「入力」シートの1行目を見出しにしてください');
    if (!rows.length) return bad(c, '登録する行がありません');
    if (rows.length > limits.bulkRows) return bad(c, `1回に登録できるのは${limits.bulkRows.toLocaleString('ja-JP')}行までです（${limitReason(mode)}）。ファイルを分けてください`, 413);
    if (input.meta?.entity && input.meta.entity !== entity) return bad(c, `このファイルは「${BULK_ENTITIES[input.meta.entity]?.label || input.meta.entity}」のテンプレートです。「${BULK_ENTITIES[entity].label}」のテンプレートを使ってください`);
    const {mapping, parsed} = parsedRows(entity, headers, rows);
    if (mapping.missingRequired.length) return bad(c, `必須の列がありません: ${mapping.missingRequired.join('、')}`, 400, {missingColumns: mapping.missingRequired});
    const ctx = await context(i, entity);
    const plan = planBulk(entity, parsed, ctx);
    if(entity==='expenses' && plan.canCommit && plan.rows.some(row=>row.action==='insert')) return bad(c,'経費の新規登録は請求書が必要です。経費集計シートの取込を使ってください',400);
    const contentHash = await sha256(json({entity, headers, rows}));
    const statementCount = commitStatements(i, entity, plan, {token: 'preview', fileName: '', contentHash}).statements.length;
    if (plan.canCommit && statementCount > limits.batchStatements) return bad(c, tooManyStatements(statementCount, rows.length), 413);
    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + PREVIEW_MINUTES * 60 * 1000).toISOString();
    await db.run('INSERT INTO bulk_import_previews(token, org_id, user_id, entity, file_name, content_hash, rows_json, fingerprint, expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [token, i.org_id, i.user_id, entity, String(input.fileName || '（ファイル名なし）').slice(0, 200), contentHash, json({headers, rows}), planFingerprint(plan), expires]);
    const previous = await db.get('SELECT id, created_at FROM bulk_import_batches WHERE org_id=? AND entity=? AND content_hash=? ORDER BY id DESC LIMIT 1', [i.org_id, entity, contentHash]);
    return c.json({
      ok: true, token, expiresAt: expires, entity, spec: publicSpec(entity), summary: plan.summary, canCommit: plan.canCommit,
      rows: plan.rows.map(({before, ...row}) => ({...row, before: before ? Object.fromEntries(Object.entries(before).filter(([key]) => !['org_id', 'hidden'].includes(key))) : null})),
      ignoredColumns: mapping.ignored, unknownColumns: mapping.unknown, duplicateColumns: mapping.duplicate,
      previousBatch: previous ? {id: previous.id, createdAt: previous.created_at} : null,
    });
  });

  app.post('/api/bulk/:entity/commit', async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const i = c.get('identity');
    const entity = c.req.param('entity');
    const def = entityDef(entity);
    const input = await body(c);
    if (input.confirmed !== true) return bad(c, '内容を確認したうえで登録してください');
    const preview = await db.get('SELECT * FROM bulk_import_previews WHERE token=? AND org_id=? AND user_id=? AND entity=?', [String(input.token || ''), i.org_id, i.user_id, entity]);
    if (!preview) return bad(c, 'プレビューが見つかりません。もう一度ファイルを読み込んでください', 404);
    if (preview.used_at) return bad(c, 'このプレビューは登録済みです。同じ内容を二重に登録しないよう止めました', 409);
    if (preview.expires_at < new Date().toISOString()) return bad(c, 'プレビューの有効期限（30分）が切れました。もう一度ファイルを読み込んでください', 410);
    const {headers, rows} = JSON.parse(preview.rows_json);
    const {parsed} = parsedRows(entity, headers, rows);
    const ctx = await context(i, entity);
    const plan = planBulk(entity, parsed, ctx);
    if(entity==='expenses' && plan.canCommit && plan.rows.some(row=>row.action==='insert')) return bad(c,'経費の新規登録は請求書が必要です。経費集計シートの取込を使ってください',400);
    if (planFingerprint(plan) !== preview.fingerprint) return bad(c, 'プレビューの後に他の変更がありました。もう一度ファイルを読み込んで確かめてください', 409);
    if (!plan.canCommit) return bad(c, plan.summary.error ? 'エラーのある行があるため登録しません（1件でもエラーがあれば全件登録しません）' : '登録する行がありません', 400);
    const {statements, updatedIds} = commitStatements(i, entity, plan, {token: preview.token, fileName: preview.file_name, contentHash: preview.content_hash});
    if (statements.length > limits.batchStatements) return bad(c, tooManyStatements(statements.length, plan.rows.length), 413);
    try {
      await db.batch(statements);
    } catch (error) {
      if (/exceeds \d+ statements/i.test(error.message)) return bad(c, tooManyStatements(statements.length, plan.rows.length), 413);
      const message = isUniqueViolation(error) ? '同じコードが同時に登録されました。もう一度読み込んで確かめてください' : 'プレビューの後に他の変更がありました。もう一度読み込んで確かめてください';
      return bad(c, message, 409);
    }
    const batch = await db.get('SELECT * FROM bulk_import_batches WHERE org_id=? AND entity=? AND content_hash=? ORDER BY id DESC LIMIT 1', [i.org_id, entity, preview.content_hash]);
    // 登録後にDBを読み直した結果を返す（「入ったつもり」を防ぐ）
    const keys = plan.rows.filter((row) => row.action === 'insert' || row.action === 'update').map((row) => row.key).filter(Boolean).slice(0, 10);
    let saved = [];
    if (entity === 'expenses') {
      // 登録・修正した行だけを、その id で読み直す（ほかの人・ほかの案件の経費を返さない）
      // 経費の新規登録はこの経路では受け付けない（上の commitStatements が止める）ので、読み直すのは修正した行だけ
      const ids = updatedIds.slice(0, 10);
      saved = await allIn(db, `SELECT id, category, description, actual_inc_tax, version FROM ${expenseSource()} WHERE org_id=? AND id IN (:in)`, {before: [i.org_id], ids, sortBy: (a, b) => b.id - a.id});
    } else if (keys.length) {
      saved = await db.all(`SELECT * FROM ${def.table} WHERE org_id=? AND ${def.key} IN (${keys.map(() => '?').join(',')})`, [i.org_id, ...keys]);
    }
    return c.json({ok: true, batch, summary: plan.summary, saved, approvalRows: plan.rows.filter((row) => row.action === 'approval' || row.action === 'blocked').map((row) => ({rowNo: row.rowNo, key: row.key, note: row.note, changes: row.changes}))});
  });

  app.get('/api/bulk/batches', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, 'この役割では参照できません', 403);
    const entity = c.req.query('entity');
    const rows = await db.all(`SELECT b.*, u.display_name AS created_by_name FROM bulk_import_batches b LEFT JOIN users u ON u.id=b.created_by WHERE b.org_id=? ${entity ? 'AND b.entity=?' : ''} ORDER BY b.id DESC LIMIT 50`, entity ? [i.org_id, entity] : [i.org_id]);
    return c.json({ok: true, rows});
  });
}
