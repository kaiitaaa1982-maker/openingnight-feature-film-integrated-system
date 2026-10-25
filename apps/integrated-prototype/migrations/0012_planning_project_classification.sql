-- 案件の型・稼ぎ方・段階と確度・基準額・売上率（フェーズ1の仕様書 #10。要件 FR-REV-YOJITSU-015・018〜020・024、FR-REV-CWORK-014〜016）。
-- 足すだけの移行: projects に列を足し、参照表（稼ぎ方・行動のステップ・段階）と、組織ごとの表（稼ぎ方の既定の売上率の版・区分マスタ）と、
-- 追記だけの段階の履歴を作る。既存の案件の行は書き換えず、足した列は NULL（未登録）のまま残す。
-- 稼ぎ方・ステップ・段階のコードは参照表の行で持ち、CHECK にしない（細目のステップは親の step を持つ行として種で足せる）。
-- 案件の型は CHECK で縛る（ontology の6つ）。組織ごとの値（既定の売上率・区分）はここで行を入れず、種かアプリで足す（K-9・K-12）。
-- 手元の SQLite（src/db.mjs の LocalDatabase）は、まだ当てていない DB にだけこのファイルを1回当てる。

-- 稼ぎ方（5つ。D-039 の 2026-10-10 の追記1）。案件の型との組・利益の源泉（1〜5）・基準額の中身・使う率の出どころは
-- 要件 revenue/project-cashflow-forecast-actual.md の「稼ぎ方×案件の型×売上の4区分の対応表」どおり。
-- rate_source: project＝案件の売上率（空なら組織の既定の版）、contract＝受託の契約の版の受託費率（フェーズ1 #10b）
CREATE TABLE IF NOT EXISTS earning_types (
 code TEXT PRIMARY KEY CHECK(length(code) BETWEEN 1 AND 40 AND ltrim(code,'abcdefghijklmnopqrstuvwxyz_')=''),
 label TEXT NOT NULL UNIQUE CHECK(length(trim(label)) BETWEEN 1 AND 40),
 project_type TEXT NOT NULL CHECK(project_type IN ('field_contract','production','acquisition','agency','sw_contract','contract_production')),
 profit_source INTEGER NOT NULL UNIQUE CHECK(profit_source>0),
 base_amount_kind TEXT NOT NULL CHECK(base_amount_kind IN ('rights_revenue','production_cost')),
 rate_source TEXT NOT NULL CHECK(rate_source IN ('project','contract')),
 sort_order INTEGER NOT NULL UNIQUE CHECK(sort_order>=0)
);

-- 行動のステップ。親の無い行が集計の3つ（面談・提案・契約）で、細目の段（ontology の「行動の段」）は親を持つ行として種で足す。
-- 細目は2段まで（親は親の無い行だけ）。コードと親は足したあと変えない（活動記録の数え方が後から変わるため）
CREATE TABLE IF NOT EXISTS action_steps (
 code TEXT PRIMARY KEY CHECK(length(code) BETWEEN 1 AND 60 AND ltrim(code,'abcdefghijklmnopqrstuvwxyz0123456789_')=''),
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 60),
 parent_code TEXT REFERENCES action_steps(code),
 sort_order INTEGER NOT NULL CHECK(sort_order>=0),
 CHECK(parent_code IS NULL OR parent_code<>code)
);
CREATE TRIGGER IF NOT EXISTS action_steps_two_levels BEFORE INSERT ON action_steps
 WHEN NEW.parent_code IS NOT NULL AND (SELECT s.parent_code FROM action_steps s WHERE s.code=NEW.parent_code) IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'action step detail must hang under a top step'); END;
CREATE TRIGGER IF NOT EXISTS action_steps_fixed BEFORE UPDATE OF code,parent_code ON action_steps
 BEGIN SELECT RAISE(ABORT,'action step code and parent are fixed'); END;

-- 段階（10段階＋見送り。D-039 の 2026-10-08 の追記）。確度は段階から導き、案件に手で入れさせない。
-- yomi は営業ヨミ表の番号（見送りは無い）。step_code は段階と行動のステップの対応（面談済み・提案済み・契約済み）。
-- requires_reason の段階（見送り）へ入るときは理由が要る
CREATE TABLE IF NOT EXISTS project_stages (
 code TEXT PRIMARY KEY CHECK(length(code) BETWEEN 1 AND 40 AND ltrim(code,'abcdefghijklmnopqrstuvwxyz_')=''),
 label TEXT NOT NULL UNIQUE CHECK(length(trim(label)) BETWEEN 1 AND 40),
 yomi INTEGER UNIQUE CHECK(yomi IS NULL OR yomi>0),
 probability_bps INTEGER NOT NULL CHECK(typeof(probability_bps)='integer' AND probability_bps BETWEEN 0 AND 10000),
 definition TEXT NOT NULL CHECK(length(trim(definition)) BETWEEN 1 AND 500),
 step_code TEXT REFERENCES action_steps(code),
 requires_reason INTEGER NOT NULL DEFAULT 0 CHECK(requires_reason IN (0,1)),
 sort_order INTEGER NOT NULL UNIQUE CHECK(sort_order>=0)
);

-- 段階の稼ぎ方ごとの意味（営業ヨミ表のステータス表の稼ぎ方の列）。行は種で足す
CREATE TABLE IF NOT EXISTS project_stage_meanings (
 stage_code TEXT NOT NULL REFERENCES project_stages(code),
 earning_type TEXT NOT NULL REFERENCES earning_types(code),
 meaning TEXT NOT NULL CHECK(length(trim(meaning)) BETWEEN 1 AND 500),
 PRIMARY KEY(stage_code,earning_type)
);

INSERT INTO earning_types(code,label,project_type,profit_source,base_amount_kind,rate_source,sort_order) VALUES
 ('acquisition','買付','acquisition',4,'rights_revenue','project',1),
 ('consignment','販売委託','agency',5,'rights_revenue','project',2),
 ('own_investment','自社出資','production',2,'rights_revenue','project',3),
 ('committee','製作委員会','production',3,'rights_revenue','project',4),
 ('contract_work','制作受託','contract_production',1,'production_cost','contract',5);

INSERT INTO action_steps(code,label,parent_code,sort_order) VALUES
 ('meeting','面談',NULL,1),
 ('proposal','提案',NULL,2),
 ('contract','契約',NULL,3);

INSERT INTO project_stages(code,label,yomi,probability_bps,definition,step_code,requires_reason,sort_order) VALUES
 ('declined','見送り',NULL,0,'進めないと決めた',NULL,1,0),
 ('memo','企画メモ',1,1000,'相手が企画・課題を認識し、「やる意味がある」の言質を得た',NULL,0,1),
 ('met','面談済み',2,2000,'相手が自社と組む価値を理解した言質を得た','meeting',0,2),
 ('exploring','条件の探り',3,3000,'予算割・試算・率を示し、相手が比べはじめた',NULL,0,3),
 ('proposed','提案済み',4,4000,'企画書・見積・条件書を提出した','proposal',0,4),
 ('staff_agreed','担当の合意',5,5000,'相手の担当者が進めたいと言った',NULL,0,5),
 ('approver_agreed','決裁者の合意',6,6000,'相手の決裁者が進める方向と言った',NULL,0,6),
 ('terms_agreed','条件の合意',7,7000,'予算・時期・配分を両者で合意した',NULL,0,7),
 ('informal_offer','内示',8,8000,'相手が発注・出資・許諾の意思を示した',NULL,0,8),
 ('contract_drafting','契約の調整',9,9000,'契約書を往復している・相手の社内で稟議中',NULL,0,9),
 ('contracted','契約済み',10,10000,'契約書を受領した（成立）','contract',0,10);

-- 稼ぎ方の型との組・利益の源泉・基準額の中身・使う率の出どころと、段階の確度・ステップ・理由の要否は、足したあと変えない
-- （変えると組のトリガーの意味と、過去の案件・段階の履歴の読み方が黙って変わる）。変えるときは移行で、意味の変わる行を確かめてから変える。
-- 表示の名前・定義の文・並び順は直せる。参照されている行の削除とコードの変更は外部キーが断る
CREATE TRIGGER IF NOT EXISTS earning_types_fixed BEFORE UPDATE OF project_type,profit_source,base_amount_kind,rate_source ON earning_types
 BEGIN SELECT RAISE(ABORT,'earning type kind is fixed'); END;
CREATE TRIGGER IF NOT EXISTS project_stages_fixed BEFORE UPDATE OF probability_bps,step_code,requires_reason ON project_stages
 BEGIN SELECT RAISE(ABORT,'project stage kind is fixed'); END;

-- 案件の列（要件 FR-REV-YOJITSU-018・020、FR-REV-CWORK-014）。既存の行は NULL のまま（型・稼ぎ方が未登録）。
-- 基準額の中身（権利売上の見込みか制作費）は稼ぎ方から決まるので列に持たない（earning_types.base_amount_kind）。
-- 確度は段階から導くので列に持たない。段階は履歴（project_stage_events）の最新の行から導く
ALTER TABLE projects ADD COLUMN project_type TEXT CHECK(project_type IS NULL OR project_type IN ('field_contract','production','acquisition','agency','sw_contract','contract_production'));
ALTER TABLE projects ADD COLUMN earning_type TEXT REFERENCES earning_types(code);
ALTER TABLE projects ADD COLUMN base_amount_yen INTEGER CHECK(base_amount_yen IS NULL OR (typeof(base_amount_yen)='integer' AND base_amount_yen BETWEEN 0 AND 9007199254740991));
ALTER TABLE projects ADD COLUMN revenue_rate_bps INTEGER CHECK(revenue_rate_bps IS NULL OR (typeof(revenue_rate_bps)='integer' AND revenue_rate_bps BETWEEN 0 AND 10000));
ALTER TABLE projects ADD COLUMN counterparty_name TEXT CHECK(counterparty_name IS NULL OR length(trim(counterparty_name)) BETWEEN 1 AND 200);
ALTER TABLE projects ADD COLUMN key_person TEXT CHECK(key_person IS NULL OR length(trim(key_person)) BETWEEN 1 AND 200);
ALTER TABLE projects ADD COLUMN started_on TEXT CHECK(started_on IS NULL OR (length(started_on)=10 AND substr(started_on,5,1)='-' AND substr(started_on,8,1)='-'
 AND ltrim(substr(started_on,1,4)||substr(started_on,6,2)||substr(started_on,9,2),'0123456789')=''
 AND substr(started_on,6,2) BETWEEN '01' AND '12' AND substr(started_on,9,2) BETWEEN '01' AND '31'));
ALTER TABLE projects ADD COLUMN planning_folder TEXT CHECK(planning_folder IS NULL OR length(trim(planning_folder)) BETWEEN 1 AND 500);
ALTER TABLE projects ADD COLUMN note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2000);

-- 型は登録のあと変えない（型の無い既存の案件には1回だけ入れられる。FR-REV-CWORK-037）。受託開発の型の案件は作品を持たない（FR-REV-CWORK-016）。
-- 稼ぎ方は型と対応表の組だけ（FR-REV-YOJITSU-018）。案件の売上率は、案件の売上率を使う稼ぎ方にだけ持つ（制作受託は受託の契約の版の率。FR-REV-YOJITSU-020・044）
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす。core の runbooks/07-cd.md 3-5）。
-- 決まりごとに WHEN 句のトリガーを1本ずつ作る。1つの書き込みが2つの決まりに当たっても D1 と PostgreSQL で同じ文で断るよう
-- （トリガーの動く順は D1 と PostgreSQL で違う）、後ろの決まりの WHEN に「前の決まりに当たらない」を足す。決まりの順: 型 → 受託開発と作品 → 稼ぎ方の組 → 売上率
CREATE TRIGGER IF NOT EXISTS projects_earning_type_insert BEFORE INSERT ON projects
 WHEN NEW.earning_type IS NOT NULL AND NOT EXISTS(SELECT 1 FROM earning_types e WHERE e.code=NEW.earning_type AND e.project_type=NEW.project_type)
 BEGIN SELECT RAISE(ABORT,'project earning type does not match project type'); END;
CREATE TRIGGER IF NOT EXISTS projects_revenue_rate_insert BEFORE INSERT ON projects
 WHEN NEW.revenue_rate_bps IS NOT NULL
  AND (NEW.earning_type IS NULL OR EXISTS(SELECT 1 FROM earning_types e WHERE e.code=NEW.earning_type AND e.project_type=NEW.project_type AND e.rate_source<>'project'))
 BEGIN SELECT RAISE(ABORT,'project revenue rate needs an earning type that uses it'); END;
CREATE TRIGGER IF NOT EXISTS projects_type_fixed BEFORE UPDATE OF project_type,earning_type,revenue_rate_bps ON projects
 WHEN OLD.project_type IS NOT NULL AND NEW.project_type IS NOT OLD.project_type
 BEGIN SELECT RAISE(ABORT,'project type is fixed after registration'); END;
CREATE TRIGGER IF NOT EXISTS projects_sw_contract_has_no_works BEFORE UPDATE OF project_type,earning_type,revenue_rate_bps ON projects
 WHEN (OLD.project_type IS NULL OR NEW.project_type IS OLD.project_type)
  AND NEW.project_type='sw_contract' AND EXISTS(SELECT 1 FROM works w WHERE w.org_id=NEW.org_id AND w.project_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'software contract project cannot have works'); END;
CREATE TRIGGER IF NOT EXISTS projects_earning_type_update BEFORE UPDATE OF project_type,earning_type,revenue_rate_bps ON projects
 WHEN (OLD.project_type IS NULL OR NEW.project_type IS OLD.project_type)
  AND (NEW.project_type IS NOT 'sw_contract' OR NOT EXISTS(SELECT 1 FROM works w WHERE w.org_id=NEW.org_id AND w.project_id=NEW.id))
  AND NEW.earning_type IS NOT NULL AND NOT EXISTS(SELECT 1 FROM earning_types e WHERE e.code=NEW.earning_type AND e.project_type=NEW.project_type)
 BEGIN SELECT RAISE(ABORT,'project earning type does not match project type'); END;
CREATE TRIGGER IF NOT EXISTS projects_revenue_rate_update BEFORE UPDATE OF project_type,earning_type,revenue_rate_bps ON projects
 WHEN (OLD.project_type IS NULL OR NEW.project_type IS OLD.project_type)
  AND (NEW.project_type IS NOT 'sw_contract' OR NOT EXISTS(SELECT 1 FROM works w WHERE w.org_id=NEW.org_id AND w.project_id=NEW.id))
  AND NEW.revenue_rate_bps IS NOT NULL
  AND (NEW.earning_type IS NULL OR EXISTS(SELECT 1 FROM earning_types e WHERE e.code=NEW.earning_type AND e.project_type=NEW.project_type AND e.rate_source<>'project'))
 BEGIN SELECT RAISE(ABORT,'project revenue rate needs an earning type that uses it'); END;
CREATE TRIGGER IF NOT EXISTS works_not_under_sw_contract_insert BEFORE INSERT ON works
 WHEN (SELECT p.project_type FROM projects p WHERE p.org_id=NEW.org_id AND p.id=NEW.project_id)='sw_contract'
 BEGIN SELECT RAISE(ABORT,'software contract project cannot have works'); END;
CREATE TRIGGER IF NOT EXISTS works_not_under_sw_contract_update BEFORE UPDATE OF project_id ON works
 WHEN (SELECT p.project_type FROM projects p WHERE p.org_id=NEW.org_id AND p.id=NEW.project_id)='sw_contract'
 BEGIN SELECT RAISE(ABORT,'software contract project cannot have works'); END;

-- 段階の履歴（追記だけ。FR-REV-YOJITSU-019）。案件ごとの連番 seq の最新の行が、いまの段階。入った日・前の段階・言質・見送りの理由を残す。
-- 前の段階は直前の行の段階と同じでなければ断る（古い画面からの書き込みを止める）。入った日は直前の行より前にしない
CREATE TABLE IF NOT EXISTS project_stage_events (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 seq INTEGER NOT NULL CHECK(seq>0),
 stage_code TEXT NOT NULL REFERENCES project_stages(code),
 previous_stage_code TEXT REFERENCES project_stages(code),
 entered_on TEXT NOT NULL CHECK(length(entered_on)=10 AND substr(entered_on,5,1)='-' AND substr(entered_on,8,1)='-'
  AND ltrim(substr(entered_on,1,4)||substr(entered_on,6,2)||substr(entered_on,9,2),'0123456789')=''
  AND substr(entered_on,6,2) BETWEEN '01' AND '12' AND substr(entered_on,9,2) BETWEEN '01' AND '31'),
 evidence TEXT CHECK(evidence IS NULL OR length(trim(evidence)) BETWEEN 1 AND 1000),
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,project_id,seq),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(previous_stage_code IS NULL OR previous_stage_code<>stage_code)
);
-- 上の案件のトリガーと同じく、決まりごとの WHEN 句のトリガーにし、後ろの決まりに「前の決まりに当たらない」を足す。決まりの順: 古い画面（連番・前の段階） → 日付 → 理由
CREATE TRIGGER IF NOT EXISTS project_stage_events_stale BEFORE INSERT ON project_stage_events
 WHEN NEW.seq<>(SELECT COALESCE(MAX(e.seq),0)+1 FROM project_stage_events e WHERE e.org_id=NEW.org_id AND e.project_id=NEW.project_id)
  OR NEW.previous_stage_code IS NOT (SELECT e.stage_code FROM project_stage_events e WHERE e.org_id=NEW.org_id AND e.project_id=NEW.project_id AND e.seq=NEW.seq-1)
 BEGIN SELECT RAISE(ABORT,'stale project stage'); END;
CREATE TRIGGER IF NOT EXISTS project_stage_events_date_order BEFORE INSERT ON project_stage_events
 WHEN NEW.seq=(SELECT COALESCE(MAX(e.seq),0)+1 FROM project_stage_events e WHERE e.org_id=NEW.org_id AND e.project_id=NEW.project_id)
  AND NEW.previous_stage_code IS (SELECT e.stage_code FROM project_stage_events e WHERE e.org_id=NEW.org_id AND e.project_id=NEW.project_id AND e.seq=NEW.seq-1)
  AND EXISTS(SELECT 1 FROM project_stage_events e WHERE e.org_id=NEW.org_id AND e.project_id=NEW.project_id AND e.seq=NEW.seq-1 AND e.entered_on>NEW.entered_on)
 BEGIN SELECT RAISE(ABORT,'project stage date goes back'); END;
CREATE TRIGGER IF NOT EXISTS project_stage_events_reason BEFORE INSERT ON project_stage_events
 WHEN NEW.seq=(SELECT COALESCE(MAX(e.seq),0)+1 FROM project_stage_events e WHERE e.org_id=NEW.org_id AND e.project_id=NEW.project_id)
  AND NEW.previous_stage_code IS (SELECT e.stage_code FROM project_stage_events e WHERE e.org_id=NEW.org_id AND e.project_id=NEW.project_id AND e.seq=NEW.seq-1)
  AND NOT EXISTS(SELECT 1 FROM project_stage_events e WHERE e.org_id=NEW.org_id AND e.project_id=NEW.project_id AND e.seq=NEW.seq-1 AND e.entered_on>NEW.entered_on)
  AND NEW.reason IS NULL AND (SELECT s.requires_reason FROM project_stages s WHERE s.code=NEW.stage_code)=1
 BEGIN SELECT RAISE(ABORT,'declined project stage needs a reason'); END;
CREATE TRIGGER IF NOT EXISTS project_stage_events_no_update BEFORE UPDATE ON project_stage_events BEGIN SELECT RAISE(ABORT,'project stage history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS project_stage_events_no_delete BEFORE DELETE ON project_stage_events BEGIN SELECT RAISE(ABORT,'project stage history is append-only'); END;

-- 稼ぎ方の既定の売上率（組織ごと・版を足して残す。最新の version_no が有効）。値は前提の数字なので状態（確認済み・監督申告・報道値・仮置き）を必ず持つ（K-9）。
-- 移行では行を入れない（初期値は種か設定の画面で足す。FR-REV-YOJITSU-014）。受託の契約の版の率を使う稼ぎ方（制作受託）には持たない
CREATE TABLE IF NOT EXISTS earning_type_rate_versions (
 org_id INTEGER NOT NULL REFERENCES organizations(id),
 earning_type TEXT NOT NULL REFERENCES earning_types(code),
 version_no INTEGER NOT NULL CHECK(version_no>0),
 revenue_rate_bps INTEGER NOT NULL CHECK(typeof(revenue_rate_bps)='integer' AND revenue_rate_bps BETWEEN 0 AND 10000),
 status TEXT NOT NULL CHECK(status IN ('confirmed','director_reported','press_reported','provisional')),
 basis TEXT CHECK(basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,earning_type,version_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
-- 決まりの順: 版の番号 → 使う率の出どころ（後ろに「版の番号が合う」を足す）
CREATE TRIGGER IF NOT EXISTS earning_type_rate_versions_sequence BEFORE INSERT ON earning_type_rate_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM earning_type_rate_versions v WHERE v.org_id=NEW.org_id AND v.earning_type=NEW.earning_type)
 BEGIN SELECT RAISE(ABORT,'stale earning type rate version'); END;
CREATE TRIGGER IF NOT EXISTS earning_type_rate_versions_project_rate_only BEFORE INSERT ON earning_type_rate_versions
 WHEN NEW.version_no=(SELECT COALESCE(MAX(v.version_no),0)+1 FROM earning_type_rate_versions v WHERE v.org_id=NEW.org_id AND v.earning_type=NEW.earning_type)
  AND (SELECT e.rate_source FROM earning_types e WHERE e.code=NEW.earning_type)<>'project'
 BEGIN SELECT RAISE(ABORT,'earning type uses the contract rate'); END;
CREATE TRIGGER IF NOT EXISTS earning_type_rate_versions_no_update BEFORE UPDATE ON earning_type_rate_versions BEGIN SELECT RAISE(ABORT,'earning type rate version immutable'); END;
CREATE TRIGGER IF NOT EXISTS earning_type_rate_versions_no_delete BEFORE DELETE ON earning_type_rate_versions BEGIN SELECT RAISE(ABORT,'earning type rate version immutable'); END;

-- 区分マスタ（組織ごと。入金4・出金5。FR-REV-YOJITSU-024）。入出金と「売上の元になるか」を区分で決め、金額は正で持って符号は区分で決める。
-- 出金は売上の元にならない。移行では行を入れない（種かアプリで足す。K-12 と同じ扱い）。入出金と売上の元は、足したあと変えない
CREATE TABLE IF NOT EXISTS cashflow_categories (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL REFERENCES organizations(id),
 code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 40 AND ltrim(code,'abcdefghijklmnopqrstuvwxyz0123456789_')=''),
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 60),
 direction TEXT NOT NULL CHECK(direction IN ('in','out')),
 counts_as_revenue INTEGER NOT NULL CHECK(counts_as_revenue IN (0,1)),
 sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order>=0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,code), UNIQUE(org_id,label),
 CHECK(direction='in' OR counts_as_revenue=0)
);
CREATE TRIGGER IF NOT EXISTS cashflow_categories_fixed BEFORE UPDATE OF org_id,code,direction,counts_as_revenue ON cashflow_categories
 BEGIN SELECT RAISE(ABORT,'cashflow category kind is fixed'); END;
