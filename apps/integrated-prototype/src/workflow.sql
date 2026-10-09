CREATE TABLE IF NOT EXISTS workflow_raw_artifacts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('script','sales_report')), file_name TEXT NOT NULL,
  media_type TEXT, byte_length INTEGER NOT NULL CHECK(byte_length>0), raw_sha256 TEXT NOT NULL,
  original_base64 TEXT NOT NULL, extractor_name TEXT NOT NULL, extractor_version TEXT NOT NULL,
  extraction_json TEXT NOT NULL, extraction_status TEXT NOT NULL CHECK(extraction_status IN ('extracted','ocr_pending')),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,kind,raw_sha256),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS workflow_script_reviews (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, artifact_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL, scenes_json TEXT NOT NULL, review_hash TEXT NOT NULL,
  reviewed_by INTEGER NOT NULL, reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,artifact_id,version_no), UNIQUE(org_id,artifact_id,review_hash),
  FOREIGN KEY(org_id,work_id,artifact_id) REFERENCES workflow_raw_artifacts(org_id,work_id,id),
  FOREIGN KEY(org_id,reviewed_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS workflow_schedule_previews (
  token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, artifact_id INTEGER NOT NULL, review_id INTEGER NOT NULL,
  work_id INTEGER NOT NULL, user_id INTEGER NOT NULL, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
  proposal_json TEXT NOT NULL, proposal_hash TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(org_id,artifact_id) REFERENCES workflow_raw_artifacts(org_id,id),
  FOREIGN KEY(org_id,review_id) REFERENCES workflow_script_reviews(org_id,id)
);
CREATE TABLE IF NOT EXISTS workflow_script_commits (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, artifact_id INTEGER NOT NULL, review_id INTEGER NOT NULL,
  work_id INTEGER NOT NULL, preview_token TEXT NOT NULL, proposal_hash TEXT NOT NULL,
  committed_by INTEGER NOT NULL, committed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,artifact_id), UNIQUE(preview_token),
  FOREIGN KEY(org_id,artifact_id) REFERENCES workflow_raw_artifacts(org_id,id),
  FOREIGN KEY(org_id,review_id) REFERENCES workflow_script_reviews(org_id,id)
);
CREATE TABLE IF NOT EXISTS workflow_report_selections (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, artifact_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL, sheet_name TEXT NOT NULL, header_row INTEGER NOT NULL CHECK(header_row>0),
  canonical_csv TEXT NOT NULL, canonical_sha256 TEXT NOT NULL, source_rows_json TEXT NOT NULL DEFAULT '[]', suggestions_json TEXT NOT NULL,
  suggestion_source TEXT NOT NULL CHECK(suggestion_source IN ('rule-based','imported-ai','configured-ai')),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,artifact_id,version_no),
  FOREIGN KEY(org_id,artifact_id) REFERENCES workflow_raw_artifacts(org_id,id)
);
CREATE TABLE IF NOT EXISTS workflow_script_commit_scenes (
  org_id INTEGER NOT NULL, commit_id INTEGER NOT NULL, work_id INTEGER NOT NULL, scene_id INTEGER NOT NULL, source_index INTEGER NOT NULL,
  PRIMARY KEY(org_id,commit_id,scene_id), UNIQUE(org_id,commit_id,source_index),
  FOREIGN KEY(org_id,commit_id) REFERENCES workflow_script_commits(org_id,id), FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id)
);
CREATE TABLE IF NOT EXISTS workflow_script_commit_days (
  org_id INTEGER NOT NULL, commit_id INTEGER NOT NULL, work_id INTEGER NOT NULL, shooting_day_id INTEGER NOT NULL, proposal_index INTEGER NOT NULL,
  PRIMARY KEY(org_id,commit_id,shooting_day_id), UNIQUE(org_id,commit_id,proposal_index),
  FOREIGN KEY(org_id,commit_id) REFERENCES workflow_script_commits(org_id,id), FOREIGN KEY(org_id,work_id,shooting_day_id) REFERENCES shooting_days(org_id,work_id,id)
);
CREATE TRIGGER IF NOT EXISTS workflow_script_commit_link_scenes AFTER INSERT ON workflow_script_commits BEGIN
  INSERT INTO workflow_script_commit_scenes(org_id,commit_id,work_id,scene_id,source_index)
  SELECT NEW.org_id,NEW.id,NEW.work_id,s.id,CAST(j.key AS INTEGER)
  FROM workflow_script_reviews r,json_each(r.scenes_json) j
  JOIN scenes s ON s.org_id=r.org_id AND s.work_id=r.work_id AND s.scene_no=json_extract(j.value,'$.sceneNo')
  WHERE r.org_id=NEW.org_id AND r.id=NEW.review_id;
END;
CREATE TRIGGER IF NOT EXISTS workflow_script_commit_link_days AFTER INSERT ON workflow_script_commits BEGIN
  INSERT INTO workflow_script_commit_days(org_id,commit_id,work_id,shooting_day_id,proposal_index)
  SELECT NEW.org_id,NEW.id,NEW.work_id,d.id,CAST(j.key AS INTEGER)
  FROM workflow_schedule_previews p,json_each(p.proposal_json,'$.days') j
  JOIN shooting_days d ON d.org_id=p.org_id AND d.work_id=p.work_id AND d.shoot_date=json_extract(j.value,'$.date')
    AND d.unit=json_extract(p.input_json,'$.unit')
  WHERE p.org_id=NEW.org_id AND p.token=NEW.preview_token;
END;
CREATE TABLE IF NOT EXISTS workflow_report_commits (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, artifact_id INTEGER NOT NULL, selection_id INTEGER NOT NULL,
  mapping_version_id INTEGER NOT NULL, report_id INTEGER NOT NULL, preview_token TEXT NOT NULL, committed_by INTEGER NOT NULL,
  committed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,artifact_id), UNIQUE(org_id,report_id), UNIQUE(preview_token),
  FOREIGN KEY(org_id,work_id,artifact_id) REFERENCES workflow_raw_artifacts(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,selection_id) REFERENCES workflow_report_selections(org_id,work_id,id),
  FOREIGN KEY(org_id,mapping_version_id) REFERENCES report_mapping_versions(org_id,id),
  FOREIGN KEY(org_id,work_id,report_id) REFERENCES report_imports(org_id,work_id,id)
);
CREATE TRIGGER IF NOT EXISTS workflow_raw_artifacts_immutable BEFORE UPDATE ON workflow_raw_artifacts BEGIN SELECT RAISE(ABORT,'workflow raw artifacts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workflow_raw_artifacts_no_delete BEFORE DELETE ON workflow_raw_artifacts BEGIN SELECT RAISE(ABORT,'workflow raw artifacts cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS workflow_script_reviews_immutable BEFORE UPDATE ON workflow_script_reviews BEGIN SELECT RAISE(ABORT,'workflow script reviews are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workflow_script_reviews_no_delete BEFORE DELETE ON workflow_script_reviews BEGIN SELECT RAISE(ABORT,'workflow script reviews cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS workflow_report_selections_immutable BEFORE UPDATE ON workflow_report_selections BEGIN SELECT RAISE(ABORT,'workflow report selections are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workflow_report_selections_no_delete BEFORE DELETE ON workflow_report_selections BEGIN SELECT RAISE(ABORT,'workflow report selections cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS workflow_report_commits_immutable BEFORE UPDATE ON workflow_report_commits BEGIN SELECT RAISE(ABORT,'workflow report commits are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workflow_report_commits_no_delete BEFORE DELETE ON workflow_report_commits BEGIN SELECT RAISE(ABORT,'workflow report commits cannot be deleted'); END;
