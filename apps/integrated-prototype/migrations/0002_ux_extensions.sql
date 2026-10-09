-- 使いやすさ改修（2026-09-24）の追加表。src/ の ux-extensions.sql・report-issuance.sql・progress/expected-reports.sql をこの順で連結したもの。
-- scripts/build-ux-migration.mjs で作る（手で直さない）。既存の本番D1へ自動では適用しない（代表の手順で適用する）。

-- 使いやすさ改修（2026-09-24）で追加した表。ローカルは db.mjs が読み込み、D1 は migrations/0002_ux_extensions.sql。
-- 組織の年度設定。既定（行なし）は期首5月（決算4月）。confirmed=0 は解釈が未確認であることを表す。
CREATE TABLE IF NOT EXISTS fiscal_settings (
  org_id INTEGER PRIMARY KEY REFERENCES organizations(id),
  fiscal_start_month INTEGER NOT NULL CHECK(fiscal_start_month BETWEEN 1 AND 12),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1)),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Excel一括登録のプレビュー（30分・1回限り）と登録の記録。記録は変更・削除できない。
CREATE TABLE IF NOT EXISTS bulk_import_previews (
  token TEXT PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  entity TEXT NOT NULL CHECK(entity IN ('partners','projects','works','products','expenses')),
  file_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS bulk_import_batches (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  entity TEXT NOT NULL CHECK(entity IN ('partners','projects','works','products','expenses')),
  file_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  inserted_count INTEGER NOT NULL CHECK(inserted_count>=0),
  updated_count INTEGER NOT NULL CHECK(updated_count>=0),
  unchanged_count INTEGER NOT NULL CHECK(unchanged_count>=0),
  approval_count INTEGER NOT NULL CHECK(approval_count>=0),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS bulk_import_batches_no_update BEFORE UPDATE ON bulk_import_batches BEGIN SELECT RAISE(ABORT, '一括登録の記録は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS bulk_import_batches_no_delete BEFORE DELETE ON bulk_import_batches BEGIN SELECT RAISE(ABORT, '一括登録の記録は削除できません'); END;

-- 取引先の請求・連絡先情報（版）。区分は複数（得意先・仕入先・権利元・放送局・代理店）。締日・支払サイトは取引ラインで扱うため持たない。
CREATE TABLE IF NOT EXISTS partner_profile_versions (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  partner_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL CHECK(version_no>0),
  roles_json TEXT NOT NULL DEFAULT '[]',
  invoice_registration_number TEXT CHECK(invoice_registration_number IS NULL OR invoice_registration_number GLOB 'T[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  postal_code TEXT, address TEXT, phone TEXT, contact_name TEXT, contact_email TEXT, billing_note TEXT, effective_from TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, partner_id, version_no),
  FOREIGN KEY(org_id, partner_id) REFERENCES partners(org_id, id)
);
CREATE TRIGGER IF NOT EXISTS partner_profile_versions_no_update BEFORE UPDATE ON partner_profile_versions BEGIN SELECT RAISE(ABORT, '取引先情報の版は変更できません。新しい版を作ってください'); END;
CREATE TRIGGER IF NOT EXISTS partner_profile_versions_no_delete BEFORE DELETE ON partner_profile_versions BEGIN SELECT RAISE(ABORT, '取引先情報の版は削除できません'); END;
-- 表編集の開き直しで、同じ人・同じ範囲・同じ内容のスナップショットを再利用するための索引（workbench.mjs の snapshot()）。
CREATE INDEX IF NOT EXISTS workbench_snapshots_reuse ON workbench_snapshots(org_id, dataset, created_by, content_hash);

-- 帳票の発行記録（ロイヤリティ報告書・MG売上報告）。発行した内容（サーバーが同じ条件で作り直した帳票の本体）と
-- そのハッシュを残し、後から同じ版をExcelで出し直せるようにする。記録は変更・削除できない。取消は別の表に理由つきで残す。
-- 同じ帳票・同じ条件の有効な発行（取消されていないもの）は1件だけ。取り消すと同じ条件で再発行でき、版番号が1つ進む。
-- ローカルは db.mjs が読み込み、D1 は migrations/ の追加分で適用する。外部への送付はしない（人が行う）。
CREATE TABLE IF NOT EXISTS report_issuances (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  report_kind TEXT NOT NULL CHECK(report_kind IN ('royalty','mg-sales')),
  conditions_json TEXT NOT NULL CHECK(json_valid(conditions_json)),
  conditions_hash TEXT NOT NULL CHECK(length(conditions_hash)=64),
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  recipient_type TEXT NOT NULL CHECK(recipient_type IN ('partner','supplier')),
  recipient_id INTEGER NOT NULL CHECK(recipient_id>0),
  recipient_name TEXT NOT NULL CHECK(length(trim(recipient_name))>0),
  work_ids_json TEXT NOT NULL CHECK(json_valid(work_ids_json)),
  headline_yen INTEGER NOT NULL,
  version_no INTEGER NOT NULL CHECK(version_no>0),
  previous_issuance_id INTEGER,
  note TEXT CHECK(note IS NULL OR length(note)<=1000),
  issued_on TEXT NOT NULL CHECK(issued_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  issued_by INTEGER NOT NULL,
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, id),
  UNIQUE(org_id, report_kind, conditions_hash, version_no),
  CHECK((version_no=1 AND previous_issuance_id IS NULL) OR (version_no>1 AND previous_issuance_id IS NOT NULL)),
  FOREIGN KEY(org_id, previous_issuance_id) REFERENCES report_issuances(org_id, id),
  FOREIGN KEY(org_id, issued_by) REFERENCES memberships(org_id, user_id)
);
CREATE INDEX IF NOT EXISTS report_issuances_by_conditions ON report_issuances(org_id, report_kind, conditions_hash);

CREATE TABLE IF NOT EXISTS report_issuance_voids (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  issuance_id INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason))>0 AND length(reason)<=1000),
  voided_by INTEGER NOT NULL,
  voided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(issuance_id),
  FOREIGN KEY(org_id, issuance_id) REFERENCES report_issuances(org_id, id),
  FOREIGN KEY(org_id, voided_by) REFERENCES memberships(org_id, user_id)
);

-- 同じ帳票・同じ条件で、取り消されていない発行があるうちは新しい発行を記録しない（取り消してから再発行する）
CREATE TRIGGER IF NOT EXISTS report_issuances_one_active BEFORE INSERT ON report_issuances
WHEN EXISTS (
  SELECT 1 FROM report_issuances i
  WHERE i.org_id=NEW.org_id AND i.report_kind=NEW.report_kind AND i.conditions_hash=NEW.conditions_hash
    AND NOT EXISTS (SELECT 1 FROM report_issuance_voids v WHERE v.org_id=i.org_id AND v.issuance_id=i.id)
)
BEGIN SELECT RAISE(ABORT, '発行記録: この条件の帳票は発行済みです。取り消してから再発行してください'); END;

-- 再発行の前の版は、同じ帳票・同じ条件の直前の版で、取り消されていること
CREATE TRIGGER IF NOT EXISTS report_issuances_previous_voided BEFORE INSERT ON report_issuances
WHEN NEW.previous_issuance_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM report_issuances p JOIN report_issuance_voids v ON v.org_id=p.org_id AND v.issuance_id=p.id
  WHERE p.org_id=NEW.org_id AND p.id=NEW.previous_issuance_id AND p.report_kind=NEW.report_kind
    AND p.conditions_hash=NEW.conditions_hash AND p.version_no=NEW.version_no-1
)
BEGIN SELECT RAISE(ABORT, '発行記録: 再発行の前の版が取り消されていないか、条件が一致しません'); END;

CREATE TRIGGER IF NOT EXISTS report_issuances_no_update BEFORE UPDATE ON report_issuances
BEGIN SELECT RAISE(ABORT, '発行記録は変更できません。取り消してから再発行してください'); END;
CREATE TRIGGER IF NOT EXISTS report_issuances_no_delete BEFORE DELETE ON report_issuances
BEGIN SELECT RAISE(ABORT, '発行記録は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS report_issuance_voids_no_update BEFORE UPDATE ON report_issuance_voids
BEGIN SELECT RAISE(ABORT, '発行の取消記録は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS report_issuance_voids_no_delete BEFORE DELETE ON report_issuance_voids
BEGIN SELECT RAISE(ABORT, '発行の取消記録は削除できません'); END;

-- 届くはずの報告（受領進捗の母集合）。取引先×報告の種類（×作品）ごとに、報告の頻度・届く期限・有効期間を持つ。
-- 行は変更・削除できない。やめるときは expected_report_closures に最後の対象月と理由を足す。条件を変えるときは終了して新しく登録する。
-- ローカルは db.mjs、D1 は migrations/0002_ux_extensions.sql（scripts/build-ux-migration.mjs が連結）で適用する。
CREATE TABLE IF NOT EXISTS expected_reports (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  partner_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('theatrical','digital','package','broadcast','other')),
  work_id INTEGER,
  frequency TEXT NOT NULL CHECK(frequency IN ('monthly','quarterly','semiannual','annual')),
  due_day INTEGER CHECK(due_day IS NULL OR due_day BETWEEN 1 AND 31),
  active_from TEXT NOT NULL CHECK(active_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  note TEXT CHECK(note IS NULL OR length(note)<=500),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, id),
  FOREIGN KEY(org_id, partner_id) REFERENCES partners(org_id, id),
  FOREIGN KEY(org_id, work_id) REFERENCES works(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);
CREATE INDEX IF NOT EXISTS expected_reports_by_partner ON expected_reports(org_id, partner_id, kind);

CREATE TABLE IF NOT EXISTS expected_report_closures (
  org_id INTEGER NOT NULL,
  expected_report_id INTEGER NOT NULL,
  last_month TEXT NOT NULL CHECK(last_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id, expected_report_id),
  FOREIGN KEY(org_id, expected_report_id) REFERENCES expected_reports(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);

CREATE TRIGGER IF NOT EXISTS expected_reports_no_update BEFORE UPDATE ON expected_reports
BEGIN SELECT RAISE(ABORT, '届くはずの報告は変更できません。終了して新しく登録してください'); END;
CREATE TRIGGER IF NOT EXISTS expected_reports_no_delete BEFORE DELETE ON expected_reports
BEGIN SELECT RAISE(ABORT, '届くはずの報告は削除できません。終了の記録を足してください'); END;
CREATE TRIGGER IF NOT EXISTS expected_report_closures_no_update BEFORE UPDATE ON expected_report_closures
BEGIN SELECT RAISE(ABORT, '終了の記録は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS expected_report_closures_no_delete BEFORE DELETE ON expected_report_closures
BEGIN SELECT RAISE(ABORT, '終了の記録は削除できません'); END;
-- 同じ取引先・種類・作品（作品なし同士を含む）で有効期間が重なる登録は受け付けない（受領進捗で同じ報告を二重に数えないため）。
-- 前の登録が終了していない、または最後の対象月が新しい開始月以後なら重なりとみなす
CREATE TRIGGER IF NOT EXISTS expected_reports_no_overlap BEFORE INSERT ON expected_reports
WHEN EXISTS (SELECT 1 FROM expected_reports e LEFT JOIN expected_report_closures x ON x.org_id=e.org_id AND x.expected_report_id=e.id
  WHERE e.org_id=NEW.org_id AND e.partner_id=NEW.partner_id AND e.kind=NEW.kind AND e.work_id IS NEW.work_id
    AND (x.last_month IS NULL OR x.last_month>=NEW.active_from))
BEGIN SELECT RAISE(ABORT, '同じ取引先・種類・作品の届くはずの報告が有効期間中です。前の登録を終了してから登録してください'); END;
CREATE TRIGGER IF NOT EXISTS expected_report_closures_after_start BEFORE INSERT ON expected_report_closures
WHEN NEW.last_month < (SELECT active_from FROM expected_reports WHERE org_id=NEW.org_id AND id=NEW.expected_report_id)
BEGIN SELECT RAISE(ABORT, '最後の対象月は有効期間の開始月以後にしてください'); END;
