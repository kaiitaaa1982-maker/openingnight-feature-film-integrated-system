-- 番販・放送の放送履歴表・アベイルズリスト・放送ウィンドウ提案（2026-09-26）の追加表。src/ の broadcast/broadcast-windows.sql をこの順で連結したもの。
-- scripts/build-ux-migration.mjs で作る（手で直さない）。0004 の後に当てる（取引先別リストの明細を参照する）。既存の本番D1へ自動では適用しない。

-- 放送の項目の追加（2026-09-26）。設計: docs/platform/team-development/broadcast-windows.md §5。
-- 既存の表（取引先・取引先別リストの明細）は変えず、版つきの新しい表で持つ。どちらも追加だけで、変更・削除はトリガーで禁止。
-- ・放送局の種別（地上波・BS・CS・CATV・配信・その他）: 取引先ごとの版
-- ・取引先別リストの明細ごとの放送の条件: 許諾放送回数（空欄＝未確認）とホールドバック（月。その契約の放送期間の終了後、他局へ提案しない月数。空欄＝未確認）
-- トリガーの本体では CASE 式を使わない（本番の wrangler d1 migrations apply が「incomplete input」で落ちるため）。条件は WHEN 句に書く。

CREATE TABLE IF NOT EXISTS broadcast_station_type_versions (
  org_id INTEGER NOT NULL, partner_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  station_type TEXT NOT NULL CHECK(station_type IN ('terrestrial','bs','cs','catv','streaming','other')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,partner_id,version_no),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE IF NOT EXISTS broadcast_entry_term_versions (
  org_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  licensed_runs INTEGER CHECK(licensed_runs IS NULL OR licensed_runs BETWEEN 1 AND 9999),
  holdback_months INTEGER CHECK(holdback_months IS NULL OR holdback_months BETWEEN 0 AND 120),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,entry_id,version_no),
  FOREIGN KEY(org_id,entry_id) REFERENCES partner_list_entries(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TRIGGER IF NOT EXISTS broadcast_station_type_versions_no_update BEFORE UPDATE ON broadcast_station_type_versions BEGIN SELECT RAISE(ABORT,'broadcast station type version immutable'); END;
CREATE TRIGGER IF NOT EXISTS broadcast_station_type_versions_no_delete BEFORE DELETE ON broadcast_station_type_versions BEGIN SELECT RAISE(ABORT,'broadcast station type version immutable'); END;
CREATE TRIGGER IF NOT EXISTS broadcast_entry_term_versions_no_update BEFORE UPDATE ON broadcast_entry_term_versions BEGIN SELECT RAISE(ABORT,'broadcast entry terms version immutable'); END;
CREATE TRIGGER IF NOT EXISTS broadcast_entry_term_versions_no_delete BEFORE DELETE ON broadcast_entry_term_versions BEGIN SELECT RAISE(ABORT,'broadcast entry terms version immutable'); END;

-- 版は1から順に積む（前の版の次の番号だけ）
CREATE TRIGGER IF NOT EXISTS broadcast_station_type_versions_sequence BEFORE INSERT ON broadcast_station_type_versions
WHEN NEW.version_no<>COALESCE((SELECT MAX(x.version_no) FROM broadcast_station_type_versions x WHERE x.org_id=NEW.org_id AND x.partner_id=NEW.partner_id),0)+1 BEGIN
  SELECT RAISE(ABORT,'stale broadcast station type version');
END;
CREATE TRIGGER IF NOT EXISTS broadcast_entry_term_versions_sequence BEFORE INSERT ON broadcast_entry_term_versions
WHEN NEW.version_no<>COALESCE((SELECT MAX(x.version_no) FROM broadcast_entry_term_versions x WHERE x.org_id=NEW.org_id AND x.entry_id=NEW.entry_id),0)+1 BEGIN
  SELECT RAISE(ABORT,'stale broadcast entry terms version');
END;
-- 放送の条件は、最新の版の流通が放送（流通マスタの分類が「放送」）の明細にだけ付ける
CREATE TRIGGER IF NOT EXISTS broadcast_entry_term_versions_broadcast_only BEFORE INSERT ON broadcast_entry_term_versions
WHEN NOT EXISTS(SELECT 1 FROM partner_list_entry_versions v JOIN distribution_master m ON m.code=v.distribution_code
  WHERE v.org_id=NEW.org_id AND v.entry_id=NEW.entry_id AND m.distribution_name='放送'
    AND v.version_no=(SELECT MAX(z.version_no) FROM partner_list_entry_versions z WHERE z.org_id=v.org_id AND z.entry_id=v.entry_id)) BEGIN
  SELECT RAISE(ABORT,'broadcast entry terms need a broadcast entry');
END;
