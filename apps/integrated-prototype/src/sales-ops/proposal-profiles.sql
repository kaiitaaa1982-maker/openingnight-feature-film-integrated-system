-- 提案資料に出す作品情報（営業基幹の提案資料・作品・商品マスタの入力欄）。設計: docs/platform/team-development/sales-proposals.md §3。
-- 作品カタログ（catalog.sql の catalog_profiles）に無い項目（フリガナ・英題・ジャンル・コピーライト・提案時の注意事項・
-- イントロダクション（短・長）・作品情報URL・画像の参照）を、作品ごとの版で持つ。版は1から順に積み、変更・削除はトリガーで禁止。
-- 画像はファイルを持たず、参照（URL か保存済みの原本のキー）とファイル名だけを持つ（Excel には URL・キー・ファイル名を出す）。
-- 1行の大きさは最大でも約35KB（文字の上限の合計×3バイト）で、D1 の1行の上限（128KB）に収まる。
-- トリガーの本体では CASE 式を使わない（本番の wrangler d1 migrations apply が「incomplete input」で落ちるため）。条件は WHEN 句に書く。
CREATE TABLE IF NOT EXISTS work_proposal_profiles (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  title_kana TEXT CHECK(title_kana IS NULL OR length(trim(title_kana)) BETWEEN 1 AND 200),
  title_en TEXT CHECK(title_en IS NULL OR length(trim(title_en)) BETWEEN 1 AND 300),
  genre TEXT CHECK(genre IS NULL OR length(trim(genre)) BETWEEN 1 AND 100),
  copyright_notice TEXT CHECK(copyright_notice IS NULL OR length(trim(copyright_notice)) BETWEEN 1 AND 300),
  caution TEXT CHECK(caution IS NULL OR length(trim(caution)) BETWEEN 1 AND 2000),
  intro_short TEXT CHECK(intro_short IS NULL OR length(trim(intro_short)) BETWEEN 1 AND 1000),
  intro_long TEXT CHECK(intro_long IS NULL OR length(trim(intro_long)) BETWEEN 1 AND 4000),
  info_url TEXT CHECK(info_url IS NULL OR (length(info_url) BETWEEN 10 AND 1000 AND (info_url GLOB 'https://?*' OR info_url GLOB 'http://?*'))),
  image_url TEXT CHECK(image_url IS NULL OR (length(image_url) BETWEEN 10 AND 1000 AND (image_url GLOB 'https://?*' OR image_url GLOB 'http://?*'))),
  image_key TEXT CHECK(image_key IS NULL OR (length(image_key) BETWEEN 1 AND 300 AND image_key NOT GLOB '*[^A-Za-z0-9/._-]*')),
  image_file_name TEXT CHECK(image_file_name IS NULL OR length(trim(image_file_name)) BETWEEN 1 AND 240),
  source_reference TEXT NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,work_id,revision),
  FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
  CHECK(image_url IS NULL OR image_key IS NULL),
  CHECK(image_file_name IS NULL OR image_url IS NOT NULL OR image_key IS NOT NULL)
);

CREATE TRIGGER IF NOT EXISTS work_proposal_profiles_no_update BEFORE UPDATE ON work_proposal_profiles BEGIN SELECT RAISE(ABORT,'work proposal profile immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_proposal_profiles_no_delete BEFORE DELETE ON work_proposal_profiles BEGIN SELECT RAISE(ABORT,'work proposal profile immutable'); END;
-- 版は1から順に積む（前の版の次の番号だけ）
CREATE TRIGGER IF NOT EXISTS work_proposal_profiles_sequence BEFORE INSERT ON work_proposal_profiles
WHEN NEW.revision<>COALESCE((SELECT MAX(p.revision) FROM work_proposal_profiles p WHERE p.org_id=NEW.org_id AND p.work_id=NEW.work_id),0)+1 BEGIN
  SELECT RAISE(ABORT,'stale work proposal profile');
END;
