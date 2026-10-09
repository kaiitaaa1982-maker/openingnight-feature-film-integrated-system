-- 取引先別の配信・販売リスト（営業基幹）。設計: docs/platform/team-development/eigyo-sales-sheet-design.md §3。
-- 取引先ごとのリスト（見出し）→ 明細の系列 → 明細の版 の3段。再契約は新しい明細で、前の明細を renews_entry_id で指す。
-- 追加の列は「列の定義」（型・適用範囲は変えない）・「列の状態」（表示名・使う／やめる・並び・選択肢を版で）・「値」（明細の版ごと）で増やす。
-- すべて追加だけ・変更と削除はトリガーで禁止（取込の確認表 partner_list_import_previews の consumed だけは更新する）。
-- 取込は 1つの文で複数行を入れる（INSERT … SELECT … FROM json_each(確認の表)）。行数によらず文の数は一定。

-- リストの種類（選択肢の制限ではなく表。行を足せば種類が増える）
CREATE TABLE IF NOT EXISTS partner_list_kinds (
  code TEXT PRIMARY KEY CHECK(length(code) BETWEEN 1 AND 40 AND substr(code,1,1) GLOB '[a-z]' AND code NOT GLOB '*[^a-z0-9_]*'),
  label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 40),
  sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 100000)
);
INSERT OR IGNORE INTO partner_list_kinds(code,label,sort_order) VALUES ('distribution','配信リスト',10),('sales','販売リスト',20);

-- リストの見出し（取引先ごと。1社に複数のサービスがあれば名前・サービス名で分ける）。取引先・種類・名前は変えない
CREATE TABLE IF NOT EXISTS partner_lists (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), partner_id INTEGER NOT NULL,
  list_kind TEXT NOT NULL REFERENCES partner_list_kinds(code),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  service_name TEXT CHECK(service_name IS NULL OR length(trim(service_name)) BETWEEN 1 AND 200),
  contract_reference TEXT CHECK(contract_reference IS NULL OR length(trim(contract_reference)) BETWEEN 1 AND 1000),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,partner_id,list_kind,name),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- Excel 取込の記録（1回の登録＝1行）。同じリストへ同じ内容のファイルを2回入れない（content_hash）
CREATE TABLE IF NOT EXISTS partner_list_import_batches (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, list_id INTEGER NOT NULL,
  file_name TEXT CHECK(file_name IS NULL OR length(file_name) BETWEEN 1 AND 200),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  template_version TEXT NOT NULL CHECK(length(template_version) BETWEEN 1 AND 40),
  mode TEXT NOT NULL CHECK(mode IN ('partial','full')),
  appended INTEGER NOT NULL CHECK(appended>=0), revised INTEGER NOT NULL CHECK(revised>=0),
  withdrawn INTEGER NOT NULL CHECK(withdrawn>=0), unchanged INTEGER NOT NULL CHECK(unchanged>=0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,list_id,content_hash),
  FOREIGN KEY(org_id,list_id) REFERENCES partner_lists(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 明細の系列（取引先×作品の1つの契約）。作品は変えない。再契約は新しい系列を作り、前の系列を renews_entry_id で指す
CREATE TABLE IF NOT EXISTS partner_list_entries (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, list_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  renews_entry_id INTEGER, created_batch_id INTEGER, created_source_row INTEGER CHECK(created_source_row IS NULL OR created_source_row>0),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,list_id,id), UNIQUE(org_id,work_id,id),
  FOREIGN KEY(org_id,list_id) REFERENCES partner_lists(org_id,id),
  FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
  FOREIGN KEY(org_id,renews_entry_id) REFERENCES partner_list_entries(org_id,id),
  FOREIGN KEY(org_id,created_batch_id) REFERENCES partner_list_import_batches(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
  CHECK((created_batch_id IS NULL) = (created_source_row IS NULL))
);

-- 明細の版（修正＝次の版、取り下げ＝status='withdrawn' の版）。流通ID（流通マスタ）から販売種別・取引方法を引く
CREATE TABLE IF NOT EXISTS partner_list_entry_versions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, list_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL CHECK(version_no>0),
  distribution_code TEXT NOT NULL REFERENCES distribution_types(code),
  partner_category TEXT CHECK(partner_category IS NULL OR length(trim(partner_category)) BETWEEN 1 AND 200),
  territory TEXT NOT NULL DEFAULT '日本' CHECK(length(trim(territory)) BETWEEN 1 AND 100),
  product_id INTEGER,
  partner_work_code TEXT CHECK(partner_work_code IS NULL OR length(trim(partner_work_code)) BETWEEN 1 AND 200),
  contract_start TEXT CHECK(contract_start IS NULL OR contract_start GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  contract_end TEXT CHECK(contract_end IS NULL OR contract_end GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  end_rule TEXT NOT NULL CHECK(end_rule IN ('date','auto_renew','perpetual','unknown')),
  announce_on TEXT CHECK(announce_on IS NULL OR announce_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  exclusivity TEXT NOT NULL CHECK(exclusivity IN ('unknown','exclusive','nonexclusive')),
  status TEXT NOT NULL CHECK(status IN ('planned','contracted','withdrawn')),
  settlement_method TEXT NOT NULL DEFAULT 'unverified' CHECK(settlement_method IN ('unverified','FLAT','MG','RS','other')),
  amount_ex_tax INTEGER CHECK(amount_ex_tax IS NULL OR amount_ex_tax>=0),
  rate_bps INTEGER CHECK(rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
  billing_partner_id INTEGER,
  agreement_id INTEGER,
  source_reference TEXT CHECK(source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 1000),
  note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  import_batch_id INTEGER, source_row INTEGER CHECK(source_row IS NULL OR source_row>0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,entry_id,version_no),
  CHECK(contract_end IS NULL OR contract_start IS NULL OR contract_end>=contract_start),
  CHECK(end_rule<>'date' OR contract_end IS NOT NULL),
  CHECK(status<>'contracted' OR contract_start IS NOT NULL),
  FOREIGN KEY(org_id,list_id,entry_id) REFERENCES partner_list_entries(org_id,list_id,id),
  FOREIGN KEY(org_id,work_id,entry_id) REFERENCES partner_list_entries(org_id,work_id,id),
  FOREIGN KEY(org_id,product_id,work_id) REFERENCES product_works(org_id,product_id,work_id),
  FOREIGN KEY(org_id,billing_partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,agreement_id,work_id) REFERENCES sales_agreements(org_id,id,work_id),
  FOREIGN KEY(org_id,import_batch_id) REFERENCES partner_list_import_batches(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 追加の列の定義。field_key・型・適用範囲（リストの種類・取引先。空欄は共通）は変えない
CREATE TABLE IF NOT EXISTS partner_list_field_definitions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id),
  field_key TEXT NOT NULL CHECK(length(field_key) BETWEEN 1 AND 40 AND substr(field_key,1,1) GLOB '[a-z]' AND field_key NOT GLOB '*[^a-z0-9_]*'),
  value_type TEXT NOT NULL CHECK(value_type IN ('text','integer','yen','date','month','choice')),
  list_kind TEXT REFERENCES partner_list_kinds(code),
  partner_id INTEGER,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,field_key),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 追加の列の状態（版）。表示名・使う／やめる・並び順・選択肢（choice のとき。JSON の文字の配列）
CREATE TABLE IF NOT EXISTS partner_list_field_states (
  org_id INTEGER NOT NULL, definition_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 40),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 100000),
  options_json TEXT CHECK(options_json IS NULL OR length(options_json) BETWEEN 2 AND 4000),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,definition_id,version_no),
  FOREIGN KEY(org_id,definition_id) REFERENCES partner_list_field_definitions(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 追加の列の値（明細の版ごと。文字か数値のどちらか一方）。変わっていない値も次の版へ写す
CREATE TABLE IF NOT EXISTS partner_list_field_values (
  org_id INTEGER NOT NULL, entry_version_id INTEGER NOT NULL, definition_id INTEGER NOT NULL,
  value_text TEXT CHECK(value_text IS NULL OR length(value_text) BETWEEN 1 AND 500),
  value_number INTEGER,
  PRIMARY KEY(org_id,entry_version_id,definition_id),
  FOREIGN KEY(org_id,entry_version_id) REFERENCES partner_list_entry_versions(org_id,id),
  FOREIGN KEY(org_id,definition_id) REFERENCES partner_list_field_definitions(org_id,id),
  CHECK((value_text IS NULL) <> (value_number IS NULL))
);

-- Excel 取込の確認（30分・確認した本人だけ・1回限り）。payload_json は登録する版の一覧（短いキーの JSON）
CREATE TABLE IF NOT EXISTS partner_list_import_previews (
  token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, list_id INTEGER NOT NULL,
  file_name TEXT CHECK(file_name IS NULL OR length(file_name) BETWEEN 1 AND 200),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  template_version TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('partial','full')),
  payload_json TEXT NOT NULL, unchanged INTEGER NOT NULL DEFAULT 0 CHECK(unchanged>=0), expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id),
  FOREIGN KEY(org_id,list_id) REFERENCES partner_lists(org_id,id)
);

CREATE INDEX IF NOT EXISTS partner_lists_partner_idx ON partner_lists(org_id,partner_id);
CREATE INDEX IF NOT EXISTS partner_list_entries_list_idx ON partner_list_entries(org_id,list_id);
CREATE UNIQUE INDEX IF NOT EXISTS partner_list_entries_batch_row ON partner_list_entries(org_id,created_batch_id,created_source_row) WHERE created_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS partner_list_entry_versions_work_idx ON partner_list_entry_versions(org_id,work_id,distribution_code);
CREATE UNIQUE INDEX IF NOT EXISTS partner_list_entry_versions_batch_entry ON partner_list_entry_versions(org_id,import_batch_id,entry_id) WHERE import_batch_id IS NOT NULL;

-- 変更・削除の禁止
CREATE TRIGGER IF NOT EXISTS partner_list_kinds_no_update BEFORE UPDATE ON partner_list_kinds BEGIN SELECT RAISE(ABORT,'partner list kind immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_kinds_no_delete BEFORE DELETE ON partner_list_kinds BEGIN SELECT RAISE(ABORT,'partner list kind immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_lists_no_update BEFORE UPDATE ON partner_lists BEGIN SELECT RAISE(ABORT,'partner list immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_lists_no_delete BEFORE DELETE ON partner_lists BEGIN SELECT RAISE(ABORT,'partner list immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_import_batches_no_update BEFORE UPDATE ON partner_list_import_batches BEGIN SELECT RAISE(ABORT,'partner list batch immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_import_batches_no_delete BEFORE DELETE ON partner_list_import_batches BEGIN SELECT RAISE(ABORT,'partner list batch immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_entries_no_update BEFORE UPDATE ON partner_list_entries BEGIN SELECT RAISE(ABORT,'partner list entry immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_entries_no_delete BEFORE DELETE ON partner_list_entries BEGIN SELECT RAISE(ABORT,'partner list entry immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_entry_versions_no_update BEFORE UPDATE ON partner_list_entry_versions BEGIN SELECT RAISE(ABORT,'partner list entry version immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_entry_versions_no_delete BEFORE DELETE ON partner_list_entry_versions BEGIN SELECT RAISE(ABORT,'partner list entry version immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_definitions_no_update BEFORE UPDATE ON partner_list_field_definitions BEGIN SELECT RAISE(ABORT,'partner list field immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_definitions_no_delete BEFORE DELETE ON partner_list_field_definitions BEGIN SELECT RAISE(ABORT,'partner list field immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_states_no_update BEFORE UPDATE ON partner_list_field_states BEGIN SELECT RAISE(ABORT,'partner list field state immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_states_no_delete BEFORE DELETE ON partner_list_field_states BEGIN SELECT RAISE(ABORT,'partner list field state immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_values_no_update BEFORE UPDATE ON partner_list_field_values BEGIN SELECT RAISE(ABORT,'partner list field value immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_values_no_delete BEFORE DELETE ON partner_list_field_values BEGIN SELECT RAISE(ABORT,'partner list field value immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_import_previews_no_delete BEFORE DELETE ON partner_list_import_previews BEGIN SELECT RAISE(ABORT,'partner list preview immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_import_previews_consume_only BEFORE UPDATE ON partner_list_import_previews
WHEN NOT (OLD.consumed=0 AND NEW.consumed=1 AND NEW.token=OLD.token AND NEW.org_id=OLD.org_id AND NEW.user_id=OLD.user_id AND NEW.list_id=OLD.list_id
  AND NEW.content_hash=OLD.content_hash AND NEW.payload_json=OLD.payload_json AND NEW.unchanged=OLD.unchanged AND NEW.expires_at=OLD.expires_at) BEGIN
  SELECT RAISE(ABORT,'partner list preview can only be consumed once');
END;

-- 版は1から順に積む（前の版の次の番号だけ）。流通IDは流通マスタ（H001〜 など）のもので、旧区分（svod など）では登録しない
CREATE TRIGGER IF NOT EXISTS partner_list_entry_versions_sequence BEFORE INSERT ON partner_list_entry_versions BEGIN
  SELECT CASE WHEN NEW.version_no<>COALESCE((SELECT MAX(version_no) FROM partner_list_entry_versions WHERE org_id=NEW.org_id AND entry_id=NEW.entry_id),0)+1
    THEN RAISE(ABORT,'stale partner list entry version') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM distribution_master m WHERE m.code=NEW.distribution_code)
    THEN RAISE(ABORT,'partner list distribution code must be in distribution_master') END;
END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_states_sequence BEFORE INSERT ON partner_list_field_states BEGIN
  SELECT CASE WHEN NEW.version_no<>COALESCE((SELECT MAX(version_no) FROM partner_list_field_states WHERE org_id=NEW.org_id AND definition_id=NEW.definition_id),0)+1
    THEN RAISE(ABORT,'stale partner list field state') END;
END;

-- 再契約の元は、同じリスト・同じ作品の明細だけ
CREATE TRIGGER IF NOT EXISTS partner_list_entries_renewal_scope BEFORE INSERT ON partner_list_entries WHEN NEW.renews_entry_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM partner_list_entries e WHERE e.org_id=NEW.org_id AND e.id=NEW.renews_entry_id AND e.list_id=NEW.list_id AND e.work_id=NEW.work_id)
    THEN RAISE(ABORT,'partner list renewal scope mismatch') END;
END;

-- 追加の列の値は、その明細のリストに当てはまる定義だけ・型どおり（整数・金額は整数、日付・年月は形、文字・選択肢は文字）
CREATE TRIGGER IF NOT EXISTS partner_list_field_values_type_check BEFORE INSERT ON partner_list_field_values BEGIN
  SELECT CASE WHEN NOT EXISTS(
      SELECT 1 FROM partner_list_entry_versions v
      JOIN partner_lists l ON l.org_id=v.org_id AND l.id=v.list_id
      JOIN partner_list_field_definitions d ON d.org_id=v.org_id AND d.id=NEW.definition_id
      WHERE v.org_id=NEW.org_id AND v.id=NEW.entry_version_id
        AND (d.list_kind IS NULL OR d.list_kind=l.list_kind) AND (d.partner_id IS NULL OR d.partner_id=l.partner_id)
        AND ((d.value_type IN ('integer','yen') AND NEW.value_number IS NOT NULL AND NEW.value_number=CAST(NEW.value_number AS INTEGER))
          OR (d.value_type='date' AND NEW.value_text GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')
          OR (d.value_type='month' AND NEW.value_text GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]')
          OR (d.value_type IN ('text','choice') AND NEW.value_text IS NOT NULL)))
    THEN RAISE(ABORT,'partner list field type mismatch') END;
END;
