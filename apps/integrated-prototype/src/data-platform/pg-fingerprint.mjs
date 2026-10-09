// PostgreSQL だけにある「版の印」の表の名前（香盤表 #27・段2の準備 論点9）。scripts/pg-ddl.mjs が pg/schema.sql の最後に作り、
// 元の移行（migrations/）とアプリの DDL（APP_DDL_SOURCES）の指紋、生成器の版、生成した DDL の指紋、期待する数（表・トリガー・関数・
// IDENTITY・FK・索引）を1行入れる。pg/verify-catalog.sql がこの行と実際のカタログを並べる。
// D1・SQLite には作らない（移行の正本は migrations/ のまま。FR-CORE-DATA-017）。業務の表ではないので、PostgreSQL のカタログから
// 表を数える所（管理画面の ER 図・データ一覧の src/admin/pg-catalog-store.mjs、行数の scripts/seed-all-demo.mjs、比べる試験の
// test/pg-schema-compare.mjs）は、この名前を除いて SQLite と同じ表の一覧にする。Worker でも読む（node:* を import しない）
export const PG_FINGERPRINT_TABLE = 'schema_source_fingerprint';
