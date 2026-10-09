-- 受領原本を作品から切り離し、作品・商品へ付け替え・分割するための表（0003）。
-- 設計: docs/platform/team-development/royalty-committee-design.md §5。すべて追加だけ・変更と削除はトリガーで禁止。
-- 流れ: 原本（作品を持たない）→ 表の選択（版）→ 割り当て（版。1つの作品／商品コードの列／作品コードの列）
--       → 作品ごとの分割（割り当ての版×選択の版×分け方の照合値ごと）→ 分割ごとの登録（報告1件）。
-- 旧方式の原本（workflow_raw_artifacts）は、付け替え・続きの取込のときに参照行（storage='legacy_artifact'）を作って引き継ぐ。
-- 旧経路と新経路で同じファイルを二重に取り込まないことは、この表のトリガーと、旧経路の書き込みと同じ batch の検査
-- （transaction_guards。src/workflow.mjs・src/app.mjs の commitImport）の両方で保証する。既存の表にはトリガーを足さない。

-- 原本。ハッシュで組織内一意。storage='inline' は中身を持ち、'legacy_artifact' は旧原本を参照するだけ（中身は複製しない）。
CREATE TABLE IF NOT EXISTS sales_source_files (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL,
  storage TEXT NOT NULL CHECK(storage IN ('inline','legacy_artifact')),
  file_name TEXT NOT NULL CHECK(length(trim(file_name)) BETWEEN 1 AND 240),
  media_type TEXT, byte_length INTEGER NOT NULL CHECK(byte_length>0),
  raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64),
  original_base64 TEXT, extraction_json TEXT,
  extractor_name TEXT NOT NULL, extractor_version TEXT NOT NULL,
  extraction_status TEXT NOT NULL CHECK(extraction_status IN ('extracted','ocr_pending')),
  legacy_artifact_id INTEGER,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,raw_sha256), UNIQUE(org_id,legacy_artifact_id),
  FOREIGN KEY(org_id,legacy_artifact_id) REFERENCES workflow_raw_artifacts(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
  CHECK((storage='inline' AND original_base64 IS NOT NULL AND extraction_json IS NOT NULL AND legacy_artifact_id IS NULL)
     OR (storage='legacy_artifact' AND original_base64 IS NULL AND extraction_json IS NULL AND legacy_artifact_id IS NOT NULL))
);

-- 表の選択（見出しの行と取り込まない行）。版ごとに追加する。excluded_json は取り込まない行・理由・金額。
CREATE TABLE IF NOT EXISTS sales_source_selections (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, file_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  sheet_name TEXT NOT NULL, header_row INTEGER NOT NULL CHECK(header_row>0),
  canonical_csv TEXT NOT NULL, canonical_sha256 TEXT NOT NULL CHECK(length(canonical_sha256)=64),
  source_rows_json TEXT NOT NULL, excluded_json TEXT NOT NULL DEFAULT '[]', suggestions_json TEXT NOT NULL DEFAULT '[]',
  suggestion_source TEXT NOT NULL CHECK(suggestion_source IN ('rule-based','imported-ai','configured-ai')),
  legacy_selection_id INTEGER,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,file_id,id), UNIQUE(org_id,file_id,version_no),
  FOREIGN KEY(org_id,file_id) REFERENCES sales_source_files(org_id,id),
  FOREIGN KEY(org_id,legacy_selection_id) REFERENCES workflow_report_selections(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 割り当て（版）。どの版が有効かは最大の版番号で決め、状態の列は持たない。付け替えは新しい版を足す（理由必須）。
-- single_work: 全行を1つの作品へ。by_product: 商品コードの列 → products.sku → product_works で作品を決める。
-- by_work_column: 作品コードの列 → works.code。商品コードの列を併せて指定すると、行ごとに商品も照合する。
CREATE TABLE IF NOT EXISTS sales_source_bindings (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, file_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  mode TEXT NOT NULL CHECK(mode IN ('single_work','by_product','by_work_column')),
  project_id INTEGER, work_id INTEGER, product_column TEXT, work_column TEXT,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,file_id,id), UNIQUE(org_id,file_id,version_no),
  FOREIGN KEY(org_id,file_id) REFERENCES sales_source_files(org_id,id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
  CHECK((mode='single_work' AND project_id IS NOT NULL AND work_id IS NOT NULL AND product_column IS NULL AND work_column IS NULL)
     OR (mode='by_product' AND project_id IS NULL AND work_id IS NULL AND length(trim(product_column)) BETWEEN 1 AND 200 AND work_column IS NULL)
     OR (mode='by_work_column' AND project_id IS NULL AND work_id IS NULL AND length(trim(work_column)) BETWEEN 1 AND 200
         AND (product_column IS NULL OR length(trim(product_column)) BETWEEN 1 AND 200)))
);

-- 作品ごとの分割。1回の分け方（plan_sha256）で作品ごとに1行。分割後の表は D1 に置かず、選択版と行番号から同じ規則で作り直す。
-- product_map_json は商品コード → 商品ID と、そのときの配賦の写し（照合の根拠）。
CREATE TABLE IF NOT EXISTS sales_source_partitions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, file_id INTEGER NOT NULL, selection_id INTEGER NOT NULL, binding_id INTEGER NOT NULL,
  plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
  project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  row_count INTEGER NOT NULL CHECK(row_count>0), source_rows_json TEXT NOT NULL, product_map_json TEXT NOT NULL DEFAULT '[]',
  partition_sha256 TEXT NOT NULL CHECK(length(partition_sha256)=64),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,file_id,id), UNIQUE(org_id,binding_id,selection_id,plan_sha256,work_id),
  FOREIGN KEY(org_id,file_id,selection_id) REFERENCES sales_source_selections(org_id,file_id,id),
  FOREIGN KEY(org_id,file_id,binding_id) REFERENCES sales_source_bindings(org_id,file_id,id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 分割ごとの登録（報告1件）。1つのファイルの登録は、すべて同じ割り当て・選択・分け方でなければならない。
CREATE TABLE IF NOT EXISTS sales_source_commits (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, file_id INTEGER NOT NULL, partition_id INTEGER NOT NULL,
  binding_id INTEGER NOT NULL, selection_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  mapping_version_id INTEGER NOT NULL, report_id INTEGER NOT NULL, preview_token TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,partition_id), UNIQUE(org_id,report_id), UNIQUE(preview_token),
  FOREIGN KEY(org_id,file_id) REFERENCES sales_source_files(org_id,id),
  FOREIGN KEY(org_id,work_id,partition_id) REFERENCES sales_source_partitions(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,report_id) REFERENCES report_imports(org_id,work_id,id),
  FOREIGN KEY(org_id,mapping_version_id) REFERENCES report_mapping_versions(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE INDEX IF NOT EXISTS sales_source_commits_file_idx ON sales_source_commits(org_id,file_id);

-- 変更・削除の禁止（直すときは版・付け替えを足す）
CREATE TRIGGER IF NOT EXISTS sales_source_files_no_update BEFORE UPDATE ON sales_source_files
BEGIN SELECT RAISE(ABORT,'受領した原本は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_files_no_delete BEFORE DELETE ON sales_source_files
BEGIN SELECT RAISE(ABORT,'受領した原本は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_selections_no_update BEFORE UPDATE ON sales_source_selections
BEGIN SELECT RAISE(ABORT,'原本の表の選択は変更できません。新しい版を作ってください'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_selections_no_delete BEFORE DELETE ON sales_source_selections
BEGIN SELECT RAISE(ABORT,'原本の表の選択は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_bindings_no_update BEFORE UPDATE ON sales_source_bindings
BEGIN SELECT RAISE(ABORT,'原本の割り当ては変更できません。付け替えは新しい版で行います'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_bindings_no_delete BEFORE DELETE ON sales_source_bindings
BEGIN SELECT RAISE(ABORT,'原本の割り当ては削除できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_partitions_no_update BEFORE UPDATE ON sales_source_partitions
BEGIN SELECT RAISE(ABORT,'原本の分割は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_partitions_no_delete BEFORE DELETE ON sales_source_partitions
BEGIN SELECT RAISE(ABORT,'原本の分割は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_commits_no_update BEFORE UPDATE ON sales_source_commits
BEGIN SELECT RAISE(ABORT,'原本の分割の登録は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_commits_no_delete BEFORE DELETE ON sales_source_commits
BEGIN SELECT RAISE(ABORT,'原本の分割の登録は削除できません'); END;

-- 中身を持つ原本は、同じハッシュの旧方式の原本があれば作れない（旧原本を引き継ぐ）
CREATE TRIGGER IF NOT EXISTS sales_source_files_inline_not_legacy BEFORE INSERT ON sales_source_files
WHEN NEW.storage='inline' AND EXISTS(SELECT 1 FROM workflow_raw_artifacts a WHERE a.org_id=NEW.org_id AND a.kind='sales_report' AND a.raw_sha256=NEW.raw_sha256)
BEGIN SELECT RAISE(ABORT,'同じ原本が旧方式の原本として保存済みです。その原本を引き継いでください'); END;
-- 旧原本の引き継ぎは、売上報告の原本で、ハッシュと大きさが一致し、旧経路でまだ登録していないものだけ
CREATE TRIGGER IF NOT EXISTS sales_source_files_legacy_takeover BEFORE INSERT ON sales_source_files
WHEN NEW.storage='legacy_artifact' AND (
  NOT EXISTS(SELECT 1 FROM workflow_raw_artifacts a WHERE a.org_id=NEW.org_id AND a.id=NEW.legacy_artifact_id AND a.kind='sales_report'
    AND a.raw_sha256=NEW.raw_sha256 AND a.byte_length=NEW.byte_length)
  OR EXISTS(SELECT 1 FROM workflow_report_commits x WHERE x.org_id=NEW.org_id AND x.artifact_id=NEW.legacy_artifact_id))
BEGIN SELECT RAISE(ABORT,'引き継げない旧方式の原本です（売上報告でない・中身が一致しない・旧方式で登録済みのいずれか）'); END;

-- 表の選択は、1件でも登録した原本には足せない。版番号は1から連番
CREATE TRIGGER IF NOT EXISTS sales_source_selections_before_commit BEFORE INSERT ON sales_source_selections
WHEN EXISTS(SELECT 1 FROM sales_source_commits x WHERE x.org_id=NEW.org_id AND x.file_id=NEW.file_id)
  OR NEW.version_no<>COALESCE((SELECT MAX(s.version_no) FROM sales_source_selections s WHERE s.org_id=NEW.org_id AND s.file_id=NEW.file_id),0)+1
BEGIN SELECT RAISE(ABORT,'登録を始めた原本の表の選択は変えられません（または版番号が連番ではありません）'); END;
-- 旧原本から写した選択は、その原本の旧選択だけ
CREATE TRIGGER IF NOT EXISTS sales_source_selections_legacy_match BEFORE INSERT ON sales_source_selections
WHEN NEW.legacy_selection_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM workflow_report_selections s JOIN sales_source_files f ON f.org_id=s.org_id AND f.legacy_artifact_id=s.artifact_id
  WHERE s.org_id=NEW.org_id AND s.id=NEW.legacy_selection_id AND f.id=NEW.file_id)
BEGIN SELECT RAISE(ABORT,'引き継ぐ旧選択がこの原本のものではありません'); END;

-- 付け替え（割り当ての版）は登録前だけ。版番号は1から連番
CREATE TRIGGER IF NOT EXISTS sales_source_bindings_before_commit BEFORE INSERT ON sales_source_bindings
WHEN EXISTS(SELECT 1 FROM sales_source_commits x WHERE x.org_id=NEW.org_id AND x.file_id=NEW.file_id)
  OR NEW.version_no<>COALESCE((SELECT MAX(b.version_no) FROM sales_source_bindings b WHERE b.org_id=NEW.org_id AND b.file_id=NEW.file_id),0)+1
BEGIN SELECT RAISE(ABORT,'登録を始めた原本は付け替えられません（または版番号が連番ではありません）'); END;

-- 分割は、その時点で最新の割り当て・最新の選択に対してだけ作る。1つの作品への割り当てなら、その作品だけ。登録を始めた原本には足さない
CREATE TRIGGER IF NOT EXISTS sales_source_partitions_consistent BEFORE INSERT ON sales_source_partitions
WHEN NEW.binding_id<>(SELECT b.id FROM sales_source_bindings b WHERE b.org_id=NEW.org_id AND b.file_id=NEW.file_id ORDER BY b.version_no DESC LIMIT 1)
  OR NEW.selection_id<>(SELECT s.id FROM sales_source_selections s WHERE s.org_id=NEW.org_id AND s.file_id=NEW.file_id ORDER BY s.version_no DESC LIMIT 1)
  OR EXISTS(SELECT 1 FROM sales_source_bindings b WHERE b.org_id=NEW.org_id AND b.id=NEW.binding_id AND b.mode='single_work' AND b.work_id<>NEW.work_id)
  OR EXISTS(SELECT 1 FROM sales_source_commits x WHERE x.org_id=NEW.org_id AND x.file_id=NEW.file_id)
BEGIN SELECT RAISE(ABORT,'原本の分割は、最新の割り当てと表の選択で、登録を始める前に作ります'); END;

-- 登録は、分割と同じ原本・割り当て・選択で、割り当てと選択が最新であり、同じ原本のほかの登録と分け方がそろっているときだけ
CREATE TRIGGER IF NOT EXISTS sales_source_commits_consistent BEFORE INSERT ON sales_source_commits
WHEN NOT EXISTS(SELECT 1 FROM sales_source_partitions p WHERE p.org_id=NEW.org_id AND p.id=NEW.partition_id AND p.file_id=NEW.file_id
    AND p.binding_id=NEW.binding_id AND p.selection_id=NEW.selection_id AND p.work_id=NEW.work_id)
  OR NEW.binding_id<>(SELECT b.id FROM sales_source_bindings b WHERE b.org_id=NEW.org_id AND b.file_id=NEW.file_id ORDER BY b.version_no DESC LIMIT 1)
  OR NEW.selection_id<>(SELECT s.id FROM sales_source_selections s WHERE s.org_id=NEW.org_id AND s.file_id=NEW.file_id ORDER BY s.version_no DESC LIMIT 1)
  OR EXISTS(SELECT 1 FROM sales_source_commits x JOIN sales_source_partitions xp ON xp.org_id=x.org_id AND xp.id=x.partition_id
    WHERE x.org_id=NEW.org_id AND x.file_id=NEW.file_id AND (x.binding_id<>NEW.binding_id OR x.selection_id<>NEW.selection_id
      OR xp.plan_sha256<>(SELECT p.plan_sha256 FROM sales_source_partitions p WHERE p.org_id=NEW.org_id AND p.id=NEW.partition_id)))
BEGIN SELECT RAISE(ABORT,'原本の割り当てか表の選択が更新されたため、この分割は登録できません。割り当てからやり直してください'); END;

-- 1つの原本から分けた報告は、最初の登録と同じ取引先・同じ報告の種類で登録する（1通の受領報告を別々の取引先・種類の売上にしない）。
-- 報告（report_imports）は同じ batch で先に入るので、登録済みの報告と、いま登録する報告の取引先・種類を比べる
CREATE TRIGGER IF NOT EXISTS sales_source_commits_same_terms BEFORE INSERT ON sales_source_commits
WHEN EXISTS(SELECT 1 FROM sales_source_commits x
    JOIN report_imports r ON r.org_id=x.org_id AND r.id=x.report_id
    JOIN report_imports n ON n.org_id=NEW.org_id AND n.id=NEW.report_id
  WHERE x.org_id=NEW.org_id AND x.file_id=NEW.file_id AND (r.partner_id IS NOT n.partner_id OR r.kind<>n.kind))
BEGIN SELECT RAISE(ABORT,'1つの原本から分けた報告は、最初の登録と同じ取引先・報告の種類で登録します'); END;
