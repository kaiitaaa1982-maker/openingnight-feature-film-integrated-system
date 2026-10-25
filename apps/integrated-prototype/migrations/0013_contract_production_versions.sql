-- 受託制作の契約の版（フェーズ1の仕様書 #10b。要件 FR-REV-CWORK-035・036、FR-REV-YOJITSU-022・044）。
-- 足すだけの移行: 型「受託制作」（contract_production）の案件に結ぶ追記だけの版と、その支払いの節目の子の行を作る。
-- 売上の4区分（自社作品の流通売上・買付の手数料・販売委託の手数料・受託制作）は表にも列にも持たない。案件の型・稼ぎ方・契約から
-- 読むたびに導く（U-9 の答え「案件・契約から導く」。導き方は src/revenue/revenue-class/revenue-class-model.mjs）。
-- 受託費＝総製作費×受託費率は、料率の額として truncate（FR-SETL-ACCR-009 と同じ。docs/rules/money.md）した整数円を版に残し、
-- 表の CHECK で式どおりかを確かめる（どちらも正の整数なので、整数の割り算の切り捨てが truncate と同じ）。
-- 受託費は自社の売上で、制作予備費（D-037 決定2。FR-EXP-PCOST-041）とは別の値（J-4 (a)・J-8 (a)）。
-- 手元の SQLite（src/db.mjs の LocalDatabase）は、0012 のあとに毎回このファイルを当てる（作るだけの文なので、2回目からは何もしない）。

-- 版（案件ごとの連番。最新の version_no が有効）。総製作費は税別の整数円で 1円〜1兆円（work_finance_versions の制作費と同じ上限。
-- 掛け算の途中の値〈1兆×1500〉も 64ビットの整数に収まる）。受託費率は案件ごと 1000〜1500 bps、既定 1000（J-4 (a)）。
-- milestone_count は節目の行の数で、節目の最後の行が入ったときに割合の和がちょうど 10000 かを確かめるのに使う
CREATE TABLE IF NOT EXISTS contract_production_versions (
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 budget_yen INTEGER NOT NULL CHECK(typeof(budget_yen)='integer' AND budget_yen BETWEEN 1 AND 1000000000000),
 markup_bps INTEGER NOT NULL DEFAULT 1000 CHECK(typeof(markup_bps)='integer' AND markup_bps BETWEEN 1000 AND 1500),
 fee_yen INTEGER NOT NULL CHECK(typeof(fee_yen)='integer' AND fee_yen=budget_yen*markup_bps/10000),
 milestone_count INTEGER NOT NULL CHECK(typeof(milestone_count)='integer' AND milestone_count BETWEEN 1 AND 60),
 contract_reference TEXT CHECK(contract_reference IS NULL OR length(trim(contract_reference)) BETWEEN 1 AND 500),
 note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,project_id,version_no),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
-- 0012 の案件のトリガーと同じく、トリガーの本体に CASE を書かず、決まりごとに WHEN 句のトリガーを1本ずつ作る。
-- 後ろの決まりの WHEN に「前の決まりに当たらない」を足し、D1 と PostgreSQL で同じ文で断る。決まりの順: 版の番号 → 案件の型。
-- 案件が無い（別の組織の案件を含む）ときは型の決まりに当てず、外部キーで断る
CREATE TRIGGER IF NOT EXISTS contract_production_versions_sequence BEFORE INSERT ON contract_production_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM contract_production_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id)
 BEGIN SELECT RAISE(ABORT,'stale contract production version'); END;
CREATE TRIGGER IF NOT EXISTS contract_production_versions_project_type BEFORE INSERT ON contract_production_versions
 WHEN NEW.version_no=(SELECT COALESCE(MAX(v.version_no),0)+1 FROM contract_production_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id)
  AND EXISTS(SELECT 1 FROM projects p WHERE p.org_id=NEW.org_id AND p.id=NEW.project_id AND p.project_type IS NOT 'contract_production')
 BEGIN SELECT RAISE(ABORT,'contract production version needs a contract production project'); END;
CREATE TRIGGER IF NOT EXISTS contract_production_versions_no_update BEFORE UPDATE ON contract_production_versions BEGIN SELECT RAISE(ABORT,'contract production version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS contract_production_versions_no_delete BEFORE DELETE ON contract_production_versions BEGIN SELECT RAISE(ABORT,'contract production version is append-only'); END;

-- 支払いの節目（版の子の行。連番 seq の順に月初の日が進み、割合 share_bps の和が 10000）。行は版と同じ batch で足し、あとから変えない。
-- 決まりの順: 連番 → 行の数 → 月の順 → 割合の和（後ろの決まりに「前の決まりに当たらない」を足す）。版が無いときは外部キーで断る
CREATE TABLE IF NOT EXISTS contract_production_milestones (
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL,
 seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq>0),
 due_on TEXT NOT NULL CHECK(length(due_on)=10 AND substr(due_on,5,1)='-' AND substr(due_on,8,1)='-'
  AND ltrim(substr(due_on,1,4)||substr(due_on,6,2),'0123456789')=''
  AND substr(due_on,6,2) BETWEEN '01' AND '12' AND substr(due_on,9,2)='01'),
 share_bps INTEGER NOT NULL CHECK(typeof(share_bps)='integer' AND share_bps BETWEEN 1 AND 10000),
 PRIMARY KEY(org_id,project_id,version_no,seq),
 FOREIGN KEY(org_id,project_id,version_no) REFERENCES contract_production_versions(org_id,project_id,version_no)
);
CREATE TRIGGER IF NOT EXISTS contract_production_milestones_order BEFORE INSERT ON contract_production_milestones
 WHEN NEW.seq<>(SELECT COALESCE(MAX(m.seq),0)+1 FROM contract_production_milestones m WHERE m.org_id=NEW.org_id AND m.project_id=NEW.project_id AND m.version_no=NEW.version_no)
 BEGIN SELECT RAISE(ABORT,'contract milestone out of order'); END;
CREATE TRIGGER IF NOT EXISTS contract_production_milestones_count BEFORE INSERT ON contract_production_milestones
 WHEN NEW.seq=(SELECT COALESCE(MAX(m.seq),0)+1 FROM contract_production_milestones m WHERE m.org_id=NEW.org_id AND m.project_id=NEW.project_id AND m.version_no=NEW.version_no)
  AND NEW.seq>(SELECT v.milestone_count FROM contract_production_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id AND v.version_no=NEW.version_no)
 BEGIN SELECT RAISE(ABORT,'contract milestone beyond the count'); END;
CREATE TRIGGER IF NOT EXISTS contract_production_milestones_month_order BEFORE INSERT ON contract_production_milestones
 WHEN NEW.seq=(SELECT COALESCE(MAX(m.seq),0)+1 FROM contract_production_milestones m WHERE m.org_id=NEW.org_id AND m.project_id=NEW.project_id AND m.version_no=NEW.version_no)
  AND NEW.seq<=(SELECT v.milestone_count FROM contract_production_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id AND v.version_no=NEW.version_no)
  AND EXISTS(SELECT 1 FROM contract_production_milestones m WHERE m.org_id=NEW.org_id AND m.project_id=NEW.project_id AND m.version_no=NEW.version_no AND m.seq=NEW.seq-1 AND m.due_on>=NEW.due_on)
 BEGIN SELECT RAISE(ABORT,'contract milestone month goes back'); END;
CREATE TRIGGER IF NOT EXISTS contract_production_milestones_share_total BEFORE INSERT ON contract_production_milestones
 WHEN NEW.seq=(SELECT COALESCE(MAX(m.seq),0)+1 FROM contract_production_milestones m WHERE m.org_id=NEW.org_id AND m.project_id=NEW.project_id AND m.version_no=NEW.version_no)
  AND NEW.seq<=(SELECT v.milestone_count FROM contract_production_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id AND v.version_no=NEW.version_no)
  AND NOT EXISTS(SELECT 1 FROM contract_production_milestones m WHERE m.org_id=NEW.org_id AND m.project_id=NEW.project_id AND m.version_no=NEW.version_no AND m.seq=NEW.seq-1 AND m.due_on>=NEW.due_on)
  AND ((SELECT COALESCE(SUM(m.share_bps),0) FROM contract_production_milestones m WHERE m.org_id=NEW.org_id AND m.project_id=NEW.project_id AND m.version_no=NEW.version_no)+NEW.share_bps>10000
   OR (NEW.seq=(SELECT v.milestone_count FROM contract_production_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id AND v.version_no=NEW.version_no)
    AND (SELECT COALESCE(SUM(m.share_bps),0) FROM contract_production_milestones m WHERE m.org_id=NEW.org_id AND m.project_id=NEW.project_id AND m.version_no=NEW.version_no)+NEW.share_bps<>10000))
 BEGIN SELECT RAISE(ABORT,'contract milestone shares must total 10000'); END;
CREATE TRIGGER IF NOT EXISTS contract_production_milestones_no_update BEFORE UPDATE ON contract_production_milestones BEGIN SELECT RAISE(ABORT,'contract production version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS contract_production_milestones_no_delete BEFORE DELETE ON contract_production_milestones BEGIN SELECT RAISE(ABORT,'contract production version is append-only'); END;
