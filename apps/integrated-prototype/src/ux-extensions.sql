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
