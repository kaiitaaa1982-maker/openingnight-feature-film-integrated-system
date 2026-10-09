import {EXPENSE_TABLE_MEANINGS} from '../expense-sheet/expense-definitions.mjs';
import {SECRET_COLUMN, isLargeColumn, isDefinitionColumn, visibleDefinition} from './schema-visibility.mjs';
export {isLargeColumn} from './schema-visibility.mjs';
import {readTableSchema, schemaForRole} from './er-routes.mjs';
import {tableLabel, columnDisplayName, columnDescription} from './er-model.mjs';
import {objects} from '../design-model.mjs';
// 管理者向けの「データ一覧」と「取込履歴」。登録済みのデータを表のまま読み取り専用で確かめ、Excel/CSVで出す。
// 自組織の行だけ（org_id のある表）。セッション・利用者・組織・内部の排他用の表は出さず、秘密に見える列は伏せる。
const HIDDEN_TABLES = new Set(['sessions', 'users', 'organizations', 'transaction_guards']);
const ROW_LIMIT = 2000;
const OMITTED = '（大きな列のため表示を省略）';

export function registerDataBrowserRoutes(app, {db, bad}) {
  async function tables(role) {
    const schema = await readTableSchema(db);
    return {...schema, tables: schemaForRole(schema.tables, role).filter((t) => !HIDDEN_TABLES.has(t.name)).map((t) => ({...t, definition: t.columns, columns: t.columns.map((c) => c.name), orgScoped: t.columns.some((c) => c.name === 'org_id')}))};
  }

  const adminOnly = (c) => (c.get('identity').role === 'admin' ? null : bad(c, '行の中身・取込履歴は管理者だけが見られます。表の定義はデータ一覧で確認できます。', 403));

  app.get('/api/admin/tables', async (c) => {
    const role = c.get('identity').role;
    const schema = await tables(role);
    const list = schema.tables.map((table) => ({name: table.name, label: tableLabel(table.name), rows: null, columns: table.columns.filter((name) => isDefinitionColumn(table.name, name)).length, orgScoped: table.orgScoped}));
    return c.json({ok: true, tables: list, definitionSource: schema.definitionSource, role, scope: role === 'production' ? 'production' : 'all', canReadRows: role === 'admin'});
  });

  app.get('/api/admin/tables/:name/definition', async (c) => {
    const schema = await tables(c.get('identity').role);
    const table = schema.tables.find((t) => t.name === c.req.param('name'));
    if (!table) return bad(c, '表が見つからないか、この役割の表示範囲外です', 404);
    const definition = visibleDefinition({...table, columns: table.definition});
    const columns = definition.columns.map((column) => ({...column, label: columnDisplayName(column.name), description: columnDescription(table.name, column.name)}));
    const foreignKeys = definition.foreignKeys.filter((fk) => !HIDDEN_TABLES.has(fk.table) && !SECRET_COLUMN.test(fk.from) && !SECRET_COLUMN.test(fk.to));
    return c.json({ok: true, name: table.name, label: tableLabel(table.name), columns, foreignKeys, orgScoped: table.orgScoped, definitionSource: schema.definitionSource,
      meanings: [...(EXPENSE_TABLE_MEANINGS[table.name]?[{label:tableLabel(table.name),description:EXPENSE_TABLE_MEANINGS[table.name]}]:[]),...objects.filter((o) => o.tables.includes(table.name)).map((o) => ({label: o.label, description: o.meaning}))],
      hiddenColumnCount: table.columns.length - columns.length});
  });

  app.get('/api/admin/tables/:name', async (c) => {
    const denied = adminOnly(c);
    if (denied) return denied;
    const i = c.get('identity');
    const schema = await tables();
    const table = schema.tables.find((t) => t.name === c.req.param('name'));
    if (!table) return bad(c, '表が見つかりません', 404);
    const shown = table.columns.filter((column) => !SECRET_COLUMN.test(column));
    const hidden = table.columns.filter((column) => SECRET_COLUMN.test(column));
    const omitted = shown.filter((column) => isLargeColumn(table.name, column));
    const quoted = `"${table.name.replaceAll('"', '""')}"`;
    const select = shown.map((column) => {
      const name = `"${column.replaceAll('"', '""')}"`;
      return omitted.includes(column) ? `CASE WHEN ${name} IS NULL THEN NULL ELSE '${OMITTED}' END AS ${name}` : name;
    }).join(',');
    const where = table.orgScoped ? 'WHERE org_id=?' : '';
    const params = table.orgScoped ? [i.org_id] : [];
    const total = Number((await db.get(`SELECT COUNT(*) AS n FROM ${quoted} ${where}`, params))?.n || 0);
    const order = table.columns.includes('id') ? 'ORDER BY id DESC' : '';
    const rows = await db.all(`SELECT ${select} FROM ${quoted} ${where} ${order} LIMIT ${ROW_LIMIT}`, params);
    return c.json({ok: true, name: table.name, columns: shown, hiddenColumns: hidden, omittedColumns: omitted, rows, total, limit: ROW_LIMIT, definitionSource: schema.definitionSource});
  });

  app.get('/api/admin/import-history', async (c) => {
    const denied = adminOnly(c);
    if (denied) return denied;
    const i = c.get('identity');
    const reports = await db.all(`SELECT r.id, r.report_key, r.kind, r.period_from, r.period_to, r.accounting_month, r.status, r.supersedes_id, r.created_at,
        u.display_name AS created_by_name, p.name AS partner_name, w.title AS work_title,
        (SELECT COUNT(*) FROM sale_lines s WHERE s.org_id=r.org_id AND s.report_id=r.id) AS line_count,
        (SELECT COALESCE(SUM(s.amount_ex_tax),0) FROM sale_lines s WHERE s.org_id=r.org_id AND s.report_id=r.id) AS amount_ex_tax
      FROM report_imports r LEFT JOIN users u ON u.id=r.created_by LEFT JOIN partners p ON p.org_id=r.org_id AND p.id=r.partner_id
      LEFT JOIN works w ON w.org_id=r.org_id AND w.id=r.work_id WHERE r.org_id=? ORDER BY r.id DESC LIMIT 500`, [i.org_id]);
    const batches = await db.all(`SELECT b.*, u.display_name AS created_by_name FROM bulk_import_batches b LEFT JOIN users u ON u.id=b.created_by WHERE b.org_id=? ORDER BY b.id DESC LIMIT 500`, [i.org_id]);
    return c.json({ok: true, reports, batches});
  });
}
