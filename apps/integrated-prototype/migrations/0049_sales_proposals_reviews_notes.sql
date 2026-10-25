-- 営業管理の最初の切れ（会社ルートの plans/2026-10-22-folder-eigyo.md の表5〜8。2026-10-24 代表「15時までに使える形にし、業務で使いながら直す」）。
-- 足すだけの移行: 5表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0049 は調整役から受け取った（0041 が先に入ったので、まだ main に無い移行を 0042 から振り直した。調整役 2026-10-24 17:20）。
--
-- sales_proposals: 1回の提案。同じ相手に条件を変えて出し直したら別の行（問い10）。解禁日までの日数は結んだウィンドウの開始日から読むたびに出す（保存しない）。
--   MG の提案も1行持ち、MG の中身は MG_販売分の表がこの ID を指す（約束12。MG の行の amount_ex_tax は NULL）。
-- sales_proposal_windows: 提案で結んだ全作品のウィンドウ（作品・種別・地域の1窓口）。
-- sales_proposal_reviews: 結果と自己評価。最新の行が今の評価（追加だけ）。採用なら契約を指せる。
-- sales_proposal_review_factors: 効いた要因（評価ごとに要因1つにつき1行。プラスかマイナス）。
-- sales_activity_notes: 接点の言葉（事実・相手の言葉・自分の読み。温度は本人が付ける −2〜+2）。sales_activities の列は増やさない。
-- 原本の結び付き（提案資料・アベイルズ・送ったメール）は、共通の原本の表（source_documents）が入ってから足す。
--
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす）。
-- 形の CHECK は GLOB を使わない。手元の SQLite（src/db.mjs）は作るだけの文なので毎回当てる（0024 のあと）。

CREATE TABLE IF NOT EXISTS sales_proposals (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 opportunity_id INTEGER NOT NULL,
 proposed_on TEXT NOT NULL CHECK(length(proposed_on)=10 AND substr(proposed_on,5,1)='-' AND substr(proposed_on,8,1)='-'
  AND ltrim(substr(proposed_on,1,4)||substr(proposed_on,6,2)||substr(proposed_on,9,2),'0123456789')=''),
 settlement_method TEXT NOT NULL CHECK(settlement_method IN ('unverified','FLAT','MG','RS','other')),
 amount_ex_tax INTEGER CHECK(amount_ex_tax IS NULL OR (typeof(amount_ex_tax)='integer' AND amount_ex_tax BETWEEN 0 AND 1000000000000)),
 rate_bps INTEGER CHECK(rate_bps IS NULL OR (typeof(rate_bps)='integer' AND rate_bps BETWEEN 0 AND 10000)),
 term_start TEXT CHECK(term_start IS NULL OR (length(term_start)=10 AND substr(term_start,5,1)='-' AND substr(term_start,8,1)='-'
  AND ltrim(substr(term_start,1,4)||substr(term_start,6,2)||substr(term_start,9,2),'0123456789')='')),
 term_end TEXT CHECK(term_end IS NULL OR (length(term_end)=10 AND substr(term_end,5,1)='-' AND substr(term_end,8,1)='-'
  AND ltrim(substr(term_end,1,4)||substr(term_end,6,2)||substr(term_end,9,2),'0123456789')='')),
 exclusivity TEXT NOT NULL CHECK(exclusivity IN ('unknown','exclusive','nonexclusive')),
 material_snapshot_id INTEGER,
 pitch_note TEXT CHECK(pitch_note IS NULL OR length(trim(pitch_note)) BETWEEN 1 AND 2000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,opportunity_id) REFERENCES sales_opportunities(org_id,id),
 FOREIGN KEY(org_id,material_snapshot_id) REFERENCES sales_material_snapshots(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(term_end IS NULL OR term_start IS NULL OR term_end>=term_start),
 CHECK(settlement_method<>'RS' OR amount_ex_tax IS NULL),
 CHECK(settlement_method<>'FLAT' OR rate_bps IS NULL)
);
CREATE INDEX IF NOT EXISTS sales_proposals_opportunity ON sales_proposals(org_id,opportunity_id,proposed_on);
CREATE TRIGGER IF NOT EXISTS sales_proposals_no_update BEFORE UPDATE ON sales_proposals BEGIN SELECT RAISE(ABORT,'sales proposal record immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_proposals_no_delete BEFORE DELETE ON sales_proposals BEGIN SELECT RAISE(ABORT,'sales proposal record immutable'); END;

CREATE TABLE IF NOT EXISTS sales_proposal_windows (
 org_id INTEGER NOT NULL,
 proposal_id INTEGER NOT NULL,
 window_id INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,proposal_id,window_id),
 FOREIGN KEY(org_id,proposal_id) REFERENCES sales_proposals(org_id,id),
 FOREIGN KEY(org_id,window_id) REFERENCES work_release_windows(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS sales_proposal_windows_no_update BEFORE UPDATE ON sales_proposal_windows BEGIN SELECT RAISE(ABORT,'sales proposal record immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_proposal_windows_no_delete BEFORE DELETE ON sales_proposal_windows BEGIN SELECT RAISE(ABORT,'sales proposal record immutable'); END;

CREATE TABLE IF NOT EXISTS sales_proposal_reviews (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 proposal_id INTEGER NOT NULL,
 reviewed_on TEXT NOT NULL CHECK(length(reviewed_on)=10 AND substr(reviewed_on,5,1)='-' AND substr(reviewed_on,8,1)='-'
  AND ltrim(substr(reviewed_on,1,4)||substr(reviewed_on,6,2)||substr(reviewed_on,9,2),'0123456789')=''),
 outcome TEXT NOT NULL CHECK(outcome IN ('adopted','adopted_changed','rejected','no_answer','withdrawn')),
 score INTEGER NOT NULL CHECK(typeof(score)='integer' AND score BETWEEN 1 AND 5),
 worked TEXT CHECK(worked IS NULL OR length(trim(worked)) BETWEEN 1 AND 2000),
 missed TEXT CHECK(missed IS NULL OR length(trim(missed)) BETWEEN 1 AND 2000),
 agreement_id INTEGER,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,proposal_id) REFERENCES sales_proposals(org_id,id),
 FOREIGN KEY(org_id,agreement_id) REFERENCES sales_agreements(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(agreement_id IS NULL OR outcome IN ('adopted','adopted_changed'))
);
CREATE INDEX IF NOT EXISTS sales_proposal_reviews_proposal ON sales_proposal_reviews(org_id,proposal_id,id);
CREATE TRIGGER IF NOT EXISTS sales_proposal_reviews_no_update BEFORE UPDATE ON sales_proposal_reviews BEGIN SELECT RAISE(ABORT,'sales proposal record immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_proposal_reviews_no_delete BEFORE DELETE ON sales_proposal_reviews BEGIN SELECT RAISE(ABORT,'sales proposal record immutable'); END;

CREATE TABLE IF NOT EXISTS sales_proposal_review_factors (
 org_id INTEGER NOT NULL,
 review_id INTEGER NOT NULL,
 factor TEXT NOT NULL CHECK(factor IN ('material','price','term','timing','exclusivity','relationship','title_strength','competition','other')),
 effect TEXT NOT NULL CHECK(effect IN ('plus','minus')),
 PRIMARY KEY(org_id,review_id,factor),
 FOREIGN KEY(org_id,review_id) REFERENCES sales_proposal_reviews(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS sales_proposal_review_factors_no_update BEFORE UPDATE ON sales_proposal_review_factors BEGIN SELECT RAISE(ABORT,'sales proposal record immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_proposal_review_factors_no_delete BEFORE DELETE ON sales_proposal_review_factors BEGIN SELECT RAISE(ABORT,'sales proposal record immutable'); END;

CREATE TABLE IF NOT EXISTS sales_activity_notes (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 activity_id INTEGER NOT NULL,
 note_kind TEXT NOT NULL CHECK(note_kind IN ('fact','their_words','my_read')),
 body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 2000),
 tone INTEGER CHECK(tone IS NULL OR (typeof(tone)='integer' AND tone BETWEEN -2 AND 2)),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,activity_id) REFERENCES sales_activities(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE INDEX IF NOT EXISTS sales_activity_notes_activity ON sales_activity_notes(org_id,activity_id,id);
CREATE TRIGGER IF NOT EXISTS sales_activity_notes_no_update BEFORE UPDATE ON sales_activity_notes BEGIN SELECT RAISE(ABORT,'sales activity note immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_activity_notes_no_delete BEFORE DELETE ON sales_activity_notes BEGIN SELECT RAISE(ABORT,'sales activity note immutable'); END;
