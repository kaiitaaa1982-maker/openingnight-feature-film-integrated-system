-- 生成物。手で直さない。元は src/*.sql の INSERT（手元の SQLite の LocalDatabase が入れる試作・初期の行）で、scripts/pg-ddl.mjs が作る
-- 試験の DB（test/test-db.mjs）の土台で、pg/schema.sql のあとに当てる。本番には当てない
-- 元の指紋: sha256 70e91562562354c5fa7f88e9f9bbe4052d7c82b8ecf219b0f2591b9a1c2684d2
-- 表 17・文 135

-- ===== src/schema.sql =====
INSERT INTO recognition_bases (id, code, name, source_field) VALUES
  (1, 'sales_month', '販売月', 'sales_month'),
  (2, 'report_received_month', '報告受領月', 'report_received_on'),
  (3, 'contract_start_month', '契約開始月', 'contract_start_on'),
  (4, 'license_start_month', 'ライセンス利用開始月', 'license_start_on'),
  (5, 'broadcast_month', '放送月', 'broadcast_on')
ON CONFLICT DO NOTHING;
INSERT INTO organizations (id, code, name) VALUES
  (1, 'demo', 'オープニングナイト試作チーム'),
  (2, 'other', '別組織（境界検証）')
ON CONFLICT DO NOTHING;
INSERT INTO schema_meta (org_id, version) VALUES
  (1, 1),
  (2, 1)
ON CONFLICT DO NOTHING;
INSERT INTO users (id, email, display_name) VALUES
  (1, 'admin@openingnight.invalid', '管理者'),
  (2, 'editor@openingnight.invalid', '編集担当'),
  (3, 'production@openingnight.invalid', '制作担当'),
  (4, 'outsider@other.invalid', '別組織担当')
ON CONFLICT DO NOTHING;
INSERT INTO memberships (org_id, user_id, role) VALUES
  (1, 1, 'admin'),
  (1, 2, 'editor'),
  (1, 3, 'production'),
  (2, 4, 'admin')
ON CONFLICT DO NOTHING;
INSERT INTO projects (id, org_id, code, title, status, budget_yen) VALUES
  (1, 1, 'PRJ-DEMO', '風のあとさき', 'active', 12000000),
  (2, 2, 'PRJ-OTHER', '別組織作品', 'active', 9999999)
ON CONFLICT DO NOTHING;
INSERT INTO project_memberships (org_id, project_id, user_id, permission) VALUES
  (1, 1, 2, 'edit'),
  (1, 1, 3, 'production'),
  (2, 2, 4, 'edit')
ON CONFLICT DO NOTHING;
INSERT INTO works (id, org_id, project_id, code, title, format, forecast_yen) VALUES
  (1, 1, 1, 'WRK-DEMO', '風のあとさき', 'film', 18000000),
  (2, 2, 2, 'WRK-OTHER', '別組織作品', 'film', 9999999)
ON CONFLICT DO NOTHING;
INSERT INTO partners (id, org_id, code, name, kind, region) VALUES
  (1, 1, 'PT-CINEMA', '架空シネマ', 'cinema', '関東'),
  (2, 1, 'PT-DIGITAL', '架空配信', 'platform', NULL),
  (3, 1, 'PT-STORE', '架空ストア', 'retailer', '全国'),
  (4, 2, 'PT-OTHER', '別組織取引先', 'other', NULL)
ON CONFLICT DO NOTHING;
INSERT INTO products (id, org_id, sku, name, channel) VALUES
  (1, 1, 'SKU-DIGI', 'デジタル視聴', 'digital'),
  (2, 1, 'SKU-PACK', 'パッケージ', 'package')
ON CONFLICT DO NOTHING;
INSERT INTO product_works (org_id, product_id, work_id, allocation_bps) VALUES
  (1, 1, 1, 10000),
  (1, 2, 1, 10000)
ON CONFLICT DO NOTHING;
INSERT INTO metric_definitions (id, org_id, field_key, label, value_type, unit, aggregation) VALUES
  (1, 1, 'impressions', '表示回数', 'integer', '回', 'sum'),
  (2, 1, 'engagement_rate', '反応率', 'decimal', '%', 'none'),
  (3, 1, 'qualitative_note', '定性メモ', 'text', NULL, 'none')
ON CONFLICT DO NOTHING;

-- ===== src/reporting.sql =====
INSERT INTO distribution_types VALUES
  ('theatrical', 'theatrical', '劇場配給', NULL, 10),
  ('package_rental', 'package', 'ビデオグラム・レンタル', 'rental', 20),
  ('package_sell', 'package', 'ビデオグラム・セル', 'sell', 21),
  ('package_unknown', 'package', 'ビデオグラム・区分未確認', NULL, 29),
  ('est', 'digital', '配信・EST', 'EST', 30),
  ('tvod', 'digital', '配信・TVOD', 'TVOD', 31),
  ('svod', 'digital', '配信・SVOD', 'SVOD', 32),
  ('avod', 'digital', '配信・AVOD', 'AVOD', 33),
  ('digital_unknown', 'digital', '配信・区分未確認', NULL, 39),
  ('broadcast_free', 'broadcast', '放送・地上波', NULL, 40),
  ('broadcast_bs', 'broadcast', '放送・BS', NULL, 41),
  ('broadcast_cs', 'broadcast', '放送・CS', NULL, 42),
  ('broadcast_cable', 'broadcast', '放送・CATV', NULL, 43),
  ('broadcast_unknown', 'broadcast', '放送・区分未確認', NULL, 49),
  ('other', 'other', 'その他・未確認', NULL, 90)
ON CONFLICT DO NOTHING;

-- ===== src/distribution-master.sql =====
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('H001', 'unverified', 'H001', NULL, 100)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('H001', '配給', 'RS', '劇場_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 2)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'H001' AND distribution_name = '配給' AND transaction_method = 'RS' AND sales_type = '劇場_RS' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('H002', 'unverified', 'H002', NULL, 101)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('H002', '配給', 'FLAT', '劇場_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 3)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'H002' AND distribution_name = '配給' AND transaction_method = 'FLAT' AND sales_type = '劇場_FLAT' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('H003', 'unverified', 'H003', NULL, 102)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('H003', '配給', 'RS', '非劇場_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 4)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'H003' AND distribution_name = '配給' AND transaction_method = 'RS' AND sales_type = '非劇場_RS' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('H004', 'unverified', 'H004', NULL, 103)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('H004', '配給', 'FLAT', '非劇場_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 5)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'H004' AND distribution_name = '配給' AND transaction_method = 'FLAT' AND sales_type = '非劇場_FLAT' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('H005', 'unverified', 'H005', NULL, 104)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('H005', '配給_物販', 'RS', '配給_物販', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 6)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'H005' AND distribution_name = '配給_物販' AND transaction_method = 'RS' AND sales_type = '配給_物販' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S001', 'unverified', 'S001', NULL, 105)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('S001', 'セル', '委託', 'セル_委託', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 7)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'S001' AND distribution_name = 'セル' AND transaction_method = '委託' AND sales_type = 'セル_委託' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S002', 'unverified', 'S002', NULL, 106)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('S002', 'セル', '委託返品', 'セル_委託返品', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 8)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'S002' AND distribution_name = 'セル' AND transaction_method = '委託返品' AND sales_type = 'セル_委託返品' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S003', 'unverified', 'S003', NULL, 107)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('S003', 'セル', '消化納品', 'セル_消化納品', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 9)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'S003' AND distribution_name = 'セル' AND transaction_method = '消化納品' AND sales_type = 'セル_消化納品' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S004', 'unverified', 'S004', NULL, 108)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('S004', 'セル', '消化売上', 'セル_消化売上', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 10)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'S004' AND distribution_name = 'セル' AND transaction_method = '消化売上' AND sales_type = 'セル_消化売上' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S005', 'unverified', 'S005', NULL, 109)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('S005', 'セル', '消化返品', 'セル_消化返品', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 11)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'S005' AND distribution_name = 'セル' AND transaction_method = '消化返品' AND sales_type = 'セル_消化返品' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S006', 'unverified', 'S006', NULL, 110)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('S006', 'セル', '買切', 'セル_買切', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 12)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'S006' AND distribution_name = 'セル' AND transaction_method = '買切' AND sales_type = 'セル_買切' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S007', 'unverified', 'S007', NULL, 111)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('S007', 'セル', '無償', 'セル_無償', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 13)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'S007' AND distribution_name = 'セル' AND transaction_method = '無償' AND sales_type = 'セル_無償' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('R001', 'unverified', 'R001', NULL, 112)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('R001', 'レンタル_RSS', 'LF', 'レンタル_RSS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 14)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'R001' AND distribution_name = 'レンタル_RSS' AND transaction_method = 'LF' AND sales_type = 'レンタル_RSS' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('R002', 'unverified', 'R002', NULL, 113)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('R002', 'レンタル_RSS', 'MG', 'レンタル_RSS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 15)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'R002' AND distribution_name = 'レンタル_RSS' AND transaction_method = 'MG' AND sales_type = 'レンタル_RSS' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('R003', 'unverified', 'R003', NULL, 114)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('R003', 'レンタル', '有償', 'レンタル_有償', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 16)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'R003' AND distribution_name = 'レンタル' AND transaction_method = '有償' AND sales_type = 'レンタル_有償' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('R004', 'unverified', 'R004', NULL, 115)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('R004', 'レンタル_RSS', 'RS', 'レンタル_RSS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 17)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'R004' AND distribution_name = 'レンタル_RSS' AND transaction_method = 'RS' AND sales_type = 'レンタル_RSS' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('R005', 'unverified', 'R005', NULL, 116)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('R005', 'レンタル', '無償', 'レンタル_無償', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 18)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'R005' AND distribution_name = 'レンタル' AND transaction_method = '無償' AND sales_type = 'レンタル_無償' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('R006', 'unverified', 'R006', NULL, 117)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('R006', 'レンタル', '返品', 'レンタル_返品', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 19)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'R006' AND distribution_name = 'レンタル' AND transaction_method = '返品' AND sales_type = 'レンタル_返品' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D001', 'unverified', 'D001', NULL, 118)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('D001', '配信', 'MG', '配信_MG', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 20)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'D001' AND distribution_name = '配信' AND transaction_method = 'MG' AND sales_type = '配信_MG' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D002', 'unverified', 'D002', NULL, 119)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('D002', '配信', 'FLAT', '配信_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 21)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'D002' AND distribution_name = '配信' AND transaction_method = 'FLAT' AND sales_type = '配信_FLAT' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D003', 'unverified', 'D003', NULL, 120)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('D003', '配信', 'RS', 'EST', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 22)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'D003' AND distribution_name = '配信' AND transaction_method = 'RS' AND sales_type = 'EST' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D004', 'unverified', 'D004', NULL, 121)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('D004', '配信', 'RS', 'TVOD', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 23)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'D004' AND distribution_name = '配信' AND transaction_method = 'RS' AND sales_type = 'TVOD' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D005', 'unverified', 'D005', NULL, 122)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('D005', '配信', 'RS', 'SVOD', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 24)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'D005' AND distribution_name = '配信' AND transaction_method = 'RS' AND sales_type = 'SVOD' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D006', 'unverified', 'D006', NULL, 123)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('D006', '配信', 'RS', 'AVOD', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 25)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'D006' AND distribution_name = '配信' AND transaction_method = 'RS' AND sales_type = 'AVOD' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('V001', 'unverified', 'V001', NULL, 124)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('V001', '業務用VOD', 'FLAT', '業務用VOD_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 26)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'V001' AND distribution_name = '業務用VOD' AND transaction_method = 'FLAT' AND sales_type = '業務用VOD_FLAT' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('V002', 'unverified', 'V002', NULL, 125)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('V002', '業務用VOD', 'RS', '業務用VOD_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 27)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'V002' AND distribution_name = '業務用VOD' AND transaction_method = 'RS' AND sales_type = '業務用VOD_RS' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('B001', 'unverified', 'B001', NULL, 126)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('B001', '放送', 'FLAT', '放送_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 28)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'B001' AND distribution_name = '放送' AND transaction_method = 'FLAT' AND sales_type = '放送_FLAT' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('B002', 'unverified', 'B002', NULL, 127)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('B002', '放送', 'RS', '放送_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 29)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'B002' AND distribution_name = '放送' AND transaction_method = 'RS' AND sales_type = '放送_RS' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('A001', 'unverified', 'A001', NULL, 128)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('A001', '海外', 'FLAT', '海外_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 30)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'A001' AND distribution_name = '海外' AND transaction_method = 'FLAT' AND sales_type = '海外_FLAT' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('A002', 'unverified', 'A002', NULL, 129)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('A002', '海外', 'RS', '海外_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 31)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'A002' AND distribution_name = '海外' AND transaction_method = 'RS' AND sales_type = '海外_RS' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('A003', 'unverified', 'A003', NULL, 130)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('A003', '海外', 'MG', 'クロスリクープ_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 32)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'A003' AND distribution_name = '海外' AND transaction_method = 'MG' AND sales_type = 'クロスリクープ_RS' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('G001', 'unverified', 'G001', NULL, 131)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('G001', 'グッズ', 'RS', 'グッズ_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 33)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'G001' AND distribution_name = 'グッズ' AND transaction_method = 'RS' AND sales_type = 'グッズ_RS' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('P001', 'unverified', 'P001', NULL, 132)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('P001', '製作委員会収入', '幹事', '製作委員会収入_幹事分_バンドル', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 34)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'P001' AND distribution_name = '製作委員会収入' AND transaction_method = '幹事' AND sales_type = '製作委員会収入_幹事分_バンドル' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('P002', 'unverified', 'P002', NULL, 133)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('P002', '製作委員会収入', '分配', '製作委員会収入_分配分_バンドル', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 35)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'P002' AND distribution_name = '製作委員会収入' AND transaction_method = '分配' AND sales_type = '製作委員会収入_分配分_バンドル' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('K001', 'unverified', 'K001', NULL, 134)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('K001', '相殺', 'FLAT', '相殺_FLAT', '代引き、印紙代、振込手数料、システム使用料', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 36)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'K001' AND distribution_name = '相殺' AND transaction_method = 'FLAT' AND sales_type = '相殺_FLAT' AND notes = '代引き、印紙代、振込手数料、システム使用料')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('E001', 'unverified', 'E001', NULL, 135)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('E001', '映像、画像使用', 'FLAT', '映像使用_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 37)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'E001' AND distribution_name = '映像、画像使用' AND transaction_method = 'FLAT' AND sales_type = '映像使用_FLAT' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('O001', 'unverified', 'O001', NULL, 136)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('O001', '稿料', 'FLAT', '稿料_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 38)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'O001' AND distribution_name = '稿料' AND transaction_method = 'FLAT' AND sales_type = '稿料_FLAT' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('O002', 'unverified', 'O002', NULL, 137)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('O002', '稿料', 'RS', '稿料_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 39)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'O002' AND distribution_name = '稿料' AND transaction_method = 'RS' AND sales_type = '稿料_RS' AND notes = '')
ON CONFLICT DO NOTHING;
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('F001', 'unverified', 'F001', NULL, 138)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('F001', '調整', '調整', '', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 40)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'F001' AND distribution_name = '調整' AND transaction_method = '調整' AND sales_type = '' AND notes = '')
ON CONFLICT DO NOTHING;

-- ===== src/channel-sales.sql =====
INSERT INTO report_channel_fact_seals (org_id, report_id)
  SELECT org_id, id FROM report_imports
ON CONFLICT DO NOTHING;

-- ===== src/sales-ops/partner-lists.sql =====
INSERT INTO partner_list_kinds (code, label, sort_order) VALUES
  ('distribution', '配信リスト', 10),
  ('sales', '販売リスト', 20)
ON CONFLICT DO NOTHING;

-- ===== src/sales-ops/distribution-additions.sql =====
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D007', 'unverified', 'D007', NULL, 139)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('D007', '配信', 'RS', 'PVOD', '2026-09-25 代表の判断で追加（元の流通マスタには無い）', 'added-2026-09-25', 0)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'D007' AND distribution_name = '配信' AND transaction_method = 'RS' AND sales_type = 'PVOD')
ON CONFLICT DO NOTHING;

-- ===== IDENTITY の次の値（ID を指定して入れた行のあと） =====
DO $seq$
BEGIN
  PERFORM setval(pg_get_serial_sequence('ai_usage', 'org_id'), COALESCE(MAX(org_id), 0) + 1, false) FROM ai_usage;
  PERFORM setval(pg_get_serial_sequence('audit_log', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM audit_log;
  PERFORM setval(pg_get_serial_sequence('billing_invoices', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM billing_invoices;
  PERFORM setval(pg_get_serial_sequence('billing_receipts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM billing_receipts;
  PERFORM setval(pg_get_serial_sequence('broadcast_airings', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM broadcast_airings;
  PERFORM setval(pg_get_serial_sequence('broadcast_sale_links', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM broadcast_sale_links;
  PERFORM setval(pg_get_serial_sequence('broadcast_slots', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM broadcast_slots;
  PERFORM setval(pg_get_serial_sequence('campaigns', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM campaigns;
  PERFORM setval(pg_get_serial_sequence('catalog_product_windows', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM catalog_product_windows;
  PERFORM setval(pg_get_serial_sequence('change_proposals', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM change_proposals;
  PERFORM setval(pg_get_serial_sequence('committee_contracts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_contracts;
  PERFORM setval(pg_get_serial_sequence('committee_report_snapshots', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_report_snapshots;
  PERFORM setval(pg_get_serial_sequence('committee_schedule_phases', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_schedule_phases;
  PERFORM setval(pg_get_serial_sequence('committee_term_members', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_term_members;
  PERFORM setval(pg_get_serial_sequence('committee_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_term_versions;
  PERFORM setval(pg_get_serial_sequence('committee_term_windows', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_term_windows;
  PERFORM setval(pg_get_serial_sequence('day_scene_assignments', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM day_scene_assignments;
  PERFORM setval(pg_get_serial_sequence('expenses', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expenses;
  PERFORM setval(pg_get_serial_sequence('exposures', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM exposures;
  PERFORM setval(pg_get_serial_sequence('invitations', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM invitations;
  PERFORM setval(pg_get_serial_sequence('joint_committee_contracts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_committee_contracts;
  PERFORM setval(pg_get_serial_sequence('joint_committee_costs', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_committee_costs;
  PERFORM setval(pg_get_serial_sequence('joint_committee_sales', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_committee_sales;
  PERFORM setval(pg_get_serial_sequence('joint_committee_snapshots', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_committee_snapshots;
  PERFORM setval(pg_get_serial_sequence('joint_committee_windows', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_committee_windows;
  PERFORM setval(pg_get_serial_sequence('joint_funding_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_funding_events;
  PERFORM setval(pg_get_serial_sequence('joint_production_milestones', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_production_milestones;
  PERFORM setval(pg_get_serial_sequence('metric_definitions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM metric_definitions;
  PERFORM setval(pg_get_serial_sequence('mg_contract_links', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_contract_links;
  PERFORM setval(pg_get_serial_sequence('mg_incoming_contracts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_incoming_contracts;
  PERFORM setval(pg_get_serial_sequence('mg_ledger_entries', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_ledger_entries;
  PERFORM setval(pg_get_serial_sequence('mg_outgoing_contracts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_outgoing_contracts;
  PERFORM setval(pg_get_serial_sequence('mg_suppliers', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_suppliers;
  PERFORM setval(pg_get_serial_sequence('mg_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_term_versions;
  PERFORM setval(pg_get_serial_sequence('mg_version_phases', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_version_phases;
  PERFORM setval(pg_get_serial_sequence('observations', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM observations;
  PERFORM setval(pg_get_serial_sequence('organizations', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM organizations;
  PERFORM setval(pg_get_serial_sequence('partners', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partners;
  PERFORM setval(pg_get_serial_sequence('prep_tasks', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM prep_tasks;
  PERFORM setval(pg_get_serial_sequence('products', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM products;
  PERFORM setval(pg_get_serial_sequence('projects', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM projects;
  PERFORM setval(pg_get_serial_sequence('receipt_plan_requests', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM receipt_plan_requests;
  PERFORM setval(pg_get_serial_sequence('recognition_bases', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM recognition_bases;
  PERFORM setval(pg_get_serial_sequence('report_imports', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM report_imports;
  PERFORM setval(pg_get_serial_sequence('report_mapping_profiles', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM report_mapping_profiles;
  PERFORM setval(pg_get_serial_sequence('report_mapping_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM report_mapping_versions;
  PERFORM setval(pg_get_serial_sequence('rights_intake_cases', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM rights_intake_cases;
  PERFORM setval(pg_get_serial_sequence('rights_intake_documents', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM rights_intake_documents;
  PERFORM setval(pg_get_serial_sequence('rights_intake_participants', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM rights_intake_participants;
  PERFORM setval(pg_get_serial_sequence('rights_intake_scopes', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM rights_intake_scopes;
  PERFORM setval(pg_get_serial_sequence('rights_payment_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM rights_payment_events;
  PERFORM setval(pg_get_serial_sequence('sale_distribution_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sale_distribution_versions;
  PERFORM setval(pg_get_serial_sequence('sale_lines', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sale_lines;
  PERFORM setval(pg_get_serial_sequence('sales_activities', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_activities;
  PERFORM setval(pg_get_serial_sequence('sales_agreement_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_agreement_term_versions;
  PERFORM setval(pg_get_serial_sequence('sales_agreements', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_agreements;
  PERFORM setval(pg_get_serial_sequence('sales_availability_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_availability_versions;
  PERFORM setval(pg_get_serial_sequence('sales_deliverables', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_deliverables;
  PERFORM setval(pg_get_serial_sequence('sales_material_snapshots', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_material_snapshots;
  PERFORM setval(pg_get_serial_sequence('sales_opportunities', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_opportunities;
  PERFORM setval(pg_get_serial_sequence('scenes', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM scenes;
  PERFORM setval(pg_get_serial_sequence('schema_meta', 'org_id'), COALESCE(MAX(org_id), 0) + 1, false) FROM schema_meta;
  PERFORM setval(pg_get_serial_sequence('settlement_contracts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM settlement_contracts;
  PERFORM setval(pg_get_serial_sequence('settlement_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM settlement_term_versions;
  PERFORM setval(pg_get_serial_sequence('shooting_days', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM shooting_days;
  PERFORM setval(pg_get_serial_sequence('tax_calculation_snapshots', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM tax_calculation_snapshots;
  PERFORM setval(pg_get_serial_sequence('tax_rule_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM tax_rule_versions;
  PERFORM setval(pg_get_serial_sequence('users', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM users;
  PERFORM setval(pg_get_serial_sequence('workflow_raw_artifacts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM workflow_raw_artifacts;
  PERFORM setval(pg_get_serial_sequence('workflow_report_commits', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM workflow_report_commits;
  PERFORM setval(pg_get_serial_sequence('workflow_report_selections', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM workflow_report_selections;
  PERFORM setval(pg_get_serial_sequence('workflow_script_commits', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM workflow_script_commits;
  PERFORM setval(pg_get_serial_sequence('workflow_script_reviews', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM workflow_script_reviews;
  PERFORM setval(pg_get_serial_sequence('works', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM works;
  PERFORM setval(pg_get_serial_sequence('fiscal_settings', 'org_id'), COALESCE(MAX(org_id), 0) + 1, false) FROM fiscal_settings;
  PERFORM setval(pg_get_serial_sequence('bulk_import_batches', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM bulk_import_batches;
  PERFORM setval(pg_get_serial_sequence('partner_profile_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_profile_versions;
  PERFORM setval(pg_get_serial_sequence('report_issuances', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM report_issuances;
  PERFORM setval(pg_get_serial_sequence('report_issuance_voids', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM report_issuance_voids;
  PERFORM setval(pg_get_serial_sequence('expected_reports', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expected_reports;
  PERFORM setval(pg_get_serial_sequence('royalty_agreements', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_agreements;
  PERFORM setval(pg_get_serial_sequence('royalty_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_term_versions;
  PERFORM setval(pg_get_serial_sequence('royalty_schedule_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_schedule_versions;
  PERFORM setval(pg_get_serial_sequence('royalty_schedule_phases', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_schedule_phases;
  PERFORM setval(pg_get_serial_sequence('royalty_manual_accruals', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_manual_accruals;
  PERFORM setval(pg_get_serial_sequence('royalty_irregular_entries', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_irregular_entries;
  PERFORM setval(pg_get_serial_sequence('royalty_statements', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_statements;
  PERFORM setval(pg_get_serial_sequence('royalty_statement_voids', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_statement_voids;
  PERFORM setval(pg_get_serial_sequence('royalty_statement_lines', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_statement_lines;
  PERFORM setval(pg_get_serial_sequence('royalty_statement_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_statement_events;
  PERFORM setval(pg_get_serial_sequence('sales_source_files', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_source_files;
  PERFORM setval(pg_get_serial_sequence('sales_source_selections', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_source_selections;
  PERFORM setval(pg_get_serial_sequence('sales_source_bindings', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_source_bindings;
  PERFORM setval(pg_get_serial_sequence('sales_source_partitions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_source_partitions;
  PERFORM setval(pg_get_serial_sequence('sales_source_commits', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_source_commits;
  PERFORM setval(pg_get_serial_sequence('org_switch_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM org_switch_events;
  PERFORM setval(pg_get_serial_sequence('release_window_types', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM release_window_types;
  PERFORM setval(pg_get_serial_sequence('work_release_windows', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM work_release_windows;
  PERFORM setval(pg_get_serial_sequence('partner_lists', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_lists;
  PERFORM setval(pg_get_serial_sequence('partner_list_import_batches', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_list_import_batches;
  PERFORM setval(pg_get_serial_sequence('partner_list_entries', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_list_entries;
  PERFORM setval(pg_get_serial_sequence('partner_list_entry_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_list_entry_versions;
  PERFORM setval(pg_get_serial_sequence('partner_list_field_definitions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_list_field_definitions;
  PERFORM setval(pg_get_serial_sequence('sales_sheet_views', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_sheet_views;
  PERFORM setval(pg_get_serial_sequence('org_profile_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM org_profile_versions;
  PERFORM setval(pg_get_serial_sequence('gl_accounts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM gl_accounts;
  PERFORM setval(pg_get_serial_sequence('gl_manual_amounts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM gl_manual_amounts;
  PERFORM setval(pg_get_serial_sequence('expense_payments', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_payments;
  PERFORM setval(pg_get_serial_sequence('committee_investment_payments', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_investment_payments;
  PERFORM setval(pg_get_serial_sequence('gl_account_class_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM gl_account_class_versions;
  PERFORM setval(pg_get_serial_sequence('expense_categories', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_categories;
  PERFORM setval(pg_get_serial_sequence('expense_tax_categories', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_tax_categories;
  PERFORM setval(pg_get_serial_sequence('expense_withholding_categories', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_withholding_categories;
  PERFORM setval(pg_get_serial_sequence('expense_category_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_category_versions;
  PERFORM setval(pg_get_serial_sequence('expense_category_alias_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_category_alias_versions;
  PERFORM setval(pg_get_serial_sequence('expense_tax_category_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_tax_category_versions;
  PERFORM setval(pg_get_serial_sequence('expense_withholding_category_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_withholding_category_versions;
  PERFORM setval(pg_get_serial_sequence('partner_payment_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_payment_term_versions;
  PERFORM setval(pg_get_serial_sequence('expense_accounting_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_accounting_versions;
  PERFORM setval(pg_get_serial_sequence('expense_cards', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_cards;
  PERFORM setval(pg_get_serial_sequence('expense_card_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_card_versions;
  PERFORM setval(pg_get_serial_sequence('expense_withholding_remittances', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_withholding_remittances;
  PERFORM setval(pg_get_serial_sequence('expense_withholding_allocations', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_withholding_allocations;
  PERFORM setval(pg_get_serial_sequence('expense_card_debits', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_card_debits;
  PERFORM setval(pg_get_serial_sequence('expense_refund_receipts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_refund_receipts;
  PERFORM setval(pg_get_serial_sequence('expense_invoices', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_invoices;
  PERFORM setval(pg_get_serial_sequence('expense_invoice_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_invoice_versions;
  PERFORM setval(pg_get_serial_sequence('expense_source_files', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_source_files;
  PERFORM setval(pg_get_serial_sequence('expense_invoice_file_links', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_invoice_file_links;
  PERFORM setval(pg_get_serial_sequence('expense_pending_rows', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_pending_rows;
  PERFORM setval(pg_get_serial_sequence('expense_import_batches', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_import_batches;
  PERFORM setval(pg_get_serial_sequence('expense_import_rows', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_import_rows;
  PERFORM setval(pg_get_serial_sequence('expense_import_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_import_versions;
  PERFORM setval(pg_get_serial_sequence('expense_import_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_import_events;
  PERFORM setval(pg_get_serial_sequence('expense_import_row_commits', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_import_row_commits;
  PERFORM setval(pg_get_serial_sequence('expense_pending_resolutions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_pending_resolutions;
  PERFORM setval(pg_get_serial_sequence('cloud_analytics_state', 'org_id'), COALESCE(MAX(org_id), 0) + 1, false) FROM cloud_analytics_state;
END
$seq$;
