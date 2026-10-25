-- 業務を問わない共通の原本の表（会社ルートの plans/2026-10-22-folder-parallel-design.md の X-1・X-7。代表の決定 2026-10-22）。
-- 要件は docs/requirements/core/data-platform.md の FR-CORE-DATA-056〜060。
-- 足すだけの移行: 1表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。
--
-- source_documents: 業務を問わず、受け取った原本を1通1行で持つ（売上報告書・契約書・見積・請求書・領収書・口座の明細・香盤・台本・予算書・企画書・
--   納品ガイド・映像・画像・音声など）。業務の表は原本を持たず、この表の ID を指す結び付きの表を業務ごとに持つ。
--   同じ組織で同じ中身（SHA-256）は1行だけ（二重の受け取りを断る）。追加のみ。変更と削除は DB が断る。
--   中身の置き方は2つ。inline は中身を base64 で持つ（Worker では 128KB を超える値を R2 の層が R2 へ逃がす。src/cloud-r2-db.mjs）。
--   R2 の経路は1値16MBまでなので、inline は元の大きさ 12MB（base64 で約16MB）まで。それより大きい映像・音楽などは external にして、
--   中身を置かず、名前・大きさ・ハッシュ・外の置き場の名前だけを持つ。
--   既存の原本の表（sales_source_files・expense_source_files・workflow_raw_artifacts）は動かさず、ID もそのまま使う。
--   それらの行をこの表から指したいときは legacy_table・legacy_id を持つ（同じ既存の行を2回は指さない）。
--   受けた日（received_on）は業務の基準日に使う日付（YYYY-MM-DD）で、登録した時刻（created_at）とは別に持つ。
--
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす）。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS source_documents (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('sales_report','contract','estimate','invoice','receipt','bank_statement','schedule','script','budget','planning_deck','delivery_guide','media','image','audio','other')),
 file_name TEXT NOT NULL CHECK(length(trim(file_name)) BETWEEN 1 AND 240),
 media_type TEXT CHECK(media_type IS NULL OR length(media_type) BETWEEN 1 AND 160),
 byte_length INTEGER NOT NULL CHECK(typeof(byte_length)='integer' AND byte_length>0),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND lower(sha256)=sha256 AND length(trim(sha256,'0123456789abcdef'))=0),
 storage TEXT NOT NULL CHECK(storage IN ('inline','external')),
 content_base64 TEXT,
 external_location TEXT CHECK(external_location IS NULL OR length(trim(external_location)) BETWEEN 1 AND 500),
 received_on TEXT NOT NULL CHECK(length(received_on)=10 AND substr(received_on,5,1)='-' AND substr(received_on,8,1)='-'),
 received_by INTEGER NOT NULL,
 legacy_table TEXT CHECK(legacy_table IS NULL OR legacy_table IN ('sales_source_files','expense_source_files','workflow_raw_artifacts')),
 legacy_id INTEGER CHECK(legacy_id IS NULL OR (typeof(legacy_id)='integer' AND legacy_id>0)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 UNIQUE(org_id,sha256),
 UNIQUE(org_id,legacy_table,legacy_id),
 FOREIGN KEY(org_id,received_by) REFERENCES memberships(org_id,user_id),
 CHECK((storage='inline' AND content_base64 IS NOT NULL AND external_location IS NULL AND byte_length<=12582912)
    OR (storage='external' AND content_base64 IS NULL AND external_location IS NOT NULL)),
 CHECK((legacy_table IS NULL AND legacy_id IS NULL) OR (legacy_table IS NOT NULL AND legacy_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS source_documents_kind_received ON source_documents(org_id,kind,received_on);

CREATE TRIGGER IF NOT EXISTS source_documents_no_update BEFORE UPDATE ON source_documents
BEGIN SELECT RAISE(ABORT,'受け取った原本は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS source_documents_no_delete BEFORE DELETE ON source_documents
BEGIN SELECT RAISE(ABORT,'受け取った原本は削除できません'); END;
