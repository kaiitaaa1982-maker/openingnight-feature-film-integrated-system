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
