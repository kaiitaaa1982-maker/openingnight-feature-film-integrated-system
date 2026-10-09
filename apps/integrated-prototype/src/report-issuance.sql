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
