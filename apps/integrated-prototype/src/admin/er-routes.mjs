import {visibleDefinition} from './schema-visibility.mjs';
import {objects} from '../design-model.mjs';
import {tablesForRole} from './er-model.mjs';
import {readPgTableSchema} from './pg-catalog-store.mjs';

export function schemaForRole(tables, role) {
  const visible = tablesForRole(tables, role, objects);
  const names = new Set(visible.map((t) => t.name));
  return visible.map((t) => ({...t, foreignKeys: t.foreignKeys.filter((fk) => names.has(fk.table))}));
}

// 通常は3問い合わせ。表値関数を使えないDBでは、同じ対象表を従来のPRAGMAで読む。
const TABLE_FILTER = "m.type='table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%' AND m.name<>'d1_migrations'";

export async function readTableSchema(db) {
  if (db?.dialect === 'postgres') return readPgTableSchema(db);
  const names = await db.all(`SELECT m.name FROM sqlite_master m WHERE ${TABLE_FILTER} ORDER BY m.name`);
  let columns, keys;
  try {
    columns = await db.all(`SELECT m.name AS table_name, p.cid, p.name, p.type, p.[notnull], p.dflt_value, p.pk
    FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE ${TABLE_FILTER} ORDER BY m.name, p.cid`);
    keys = await db.all(`SELECT m.name AS table_name, p.id, p.seq, p.[table], p.[from], p.[to], p.on_update, p.on_delete, p.match
    FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) p WHERE ${TABLE_FILTER} ORDER BY m.name, p.id, p.seq`);
  } catch {
    const tables = [];
    // sqlite_masterとTABLE_FILTERで取得した名前だけを使い、識別子の引用符をエスケープする。
    for (const {name} of names) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const columns = (await db.all(`PRAGMA table_info(${quoted})`)).map((row) => ({...row}));
      const foreignKeys = (await db.all(`PRAGMA foreign_key_list(${quoted})`)).map((row) => ({...row}));
      tables.push({name, columns, foreignKeys});
    }
    return {tables, definitionSource: 'per-table'};
  }
  const tables = new Map(names.map(({name}) => [name, {name, columns: [], foreignKeys: []}]));
  for (const {table_name, ...column} of columns) tables.get(table_name)?.columns.push(column);
  for (const {table_name, ...key} of keys) tables.get(table_name)?.foreignKeys.push(key);
  return {tables: [...tables.values()], definitionSource: 'table-valued'};
}

export function registerErRoutes(app, {db}) {
  app.get('/api/er',async c=>{
    const schema = await readTableSchema(db);
    const tables = schemaForRole(schema.tables, c.get('identity').role).map(visibleDefinition);
    const body = {ok:true,entities:['組織 → 所属 → 案件権限','案件 → 作品 → シーン・営業・報告書・経費・宣伝','商品 ↔ 作品配賦 ↔ 作品','営業案件 → 版固定の営業資料スナップショット','元売上明細 → 請求スナップショット → 入金消込 → 逆仕訳','計上基準マスタ → 報告書の計上根拠 → 売上明細の実計上月','取引先別マッピング → 不変版 → 元CSV・共通CSVの変換根拠 → 報告書','調達ケース → 契約書参照・権利範囲・参加者 → 分配契約への明示リンク','権利契約 → 不変の条件版 ← 報告×配賦先作品の明示リンク','制作委員会調達 → 不変条件版 → 販路窓口・日程 → 不変draft報告','宣伝施策 → 露出 → 指標観測 → 項目定義'],tables,mapping:{projects:'core.projects',works:'core.works',products:'core.products',product_works:'core.product_works',partners:'master.partners',scenes:'genba.scenes',sale_lines:'ar.sales',report_imports:'ar.report_imports',sales_material_snapshots:'営業案件・作品・取引先・商品を固定した架空資料版（未移行試作）',billing_invoices:'ar.invoices_out / schema/005_inflow.sql を参照した不変請求試作',billing_invoice_lines:'元売上明細の税抜・明示税額・税込スナップショット（未移行試作）',billing_receipts:'ar.receipts を参照した入金イベント試作',billing_receipt_allocations:'schema/005_inflow.sql には未存在。複数請求への全額消込を検証する将来案の未移行試作',billing_receipt_reversals:'入金誤登録の追記型逆仕訳（未移行試作）',recognition_bases:'ローカル5基準。master.recognition_rulesとは別軸の未移行試作',report_recognition:'報告書ごとの計上根拠・実計上月（未移行試作）',expenses:'支払・費用の試作（既存apへ未移行）',rights_intake_cases:'調達3入口の不変入力スナップショット（未移行試作）',intake_settlement_links:'調達ケースと同作品の分配契約の明示リンク（未移行試作）',report_mapping_profiles:'組織・取引先・報告種別のCSV変換プロファイル（未移行試作）',report_mapping_versions:'許可演算だけを持つ不変マッピング版（未移行試作）',mapping_import_provenance:'元CSV・共通CSV・両ハッシュ・版・元行の変換根拠（未移行試作）',settlement_contracts:'core.contracts / ap.mg_ledger への未移行試作',settlement_term_versions:'契約条件の不変版（試作）',settlement_report_links:'報告×作品×契約条件版の試作リンク',committee_contracts:'制作委員会の調達ケース・契約参照に紐付く未移行試作',committee_term_versions:'参加者持分・販路窓口・手数料・日程の不変条件版（試作）',committee_report_snapshots:'作品配賦後売上と明示経費による不変draft報告（試作）'}};
    const mapping = Object.fromEntries(Object.entries(body.mapping).filter(([name]) => tables.some((t) => t.name === name)));
    return c.json({...body, mapping, definitionSource: schema.definitionSource, scope: c.get('identity').role === 'production' ? 'production' : 'all'});
  });
}
