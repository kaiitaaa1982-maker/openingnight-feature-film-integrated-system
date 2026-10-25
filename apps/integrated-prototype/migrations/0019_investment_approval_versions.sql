-- 稟議の版（行動指標の計画 段B #4。K2-2・K2-17。要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-038・039）。
-- 足すだけの移行: 1表を作る（investment_approval_versions）。追記だけで、変更・削除・同じ番号の入れ直しは DB が断る（最初の版も消せない）。
-- 稟議＝自社出資の申請・承認・却下・払込の4状態の版。稼ぎ方が自社出資の案件ごとに稟議の番号（approval_no。1から）を振り、稟議ごとに版の連番
-- （version_no。1から）を足す。いまの状態は列に持たず、読むたびに最新の版から導く。案件の段階（project_stage_events）で代用せず、
-- D-005 の承認ログにも結ばない（K2-17）。
-- 版の流れ: 版1は申請。申請 → 申請（出し直し）・承認・却下、却下 → 申請（出し直し）、承認 → 払込、払込 → 払込（分けて払う）。
-- 承認と却下の額は直前の申請の額と同じ。払込は払った日（paid_on）と額を持ち、払込の額の累計は承認の額まで。承認の前に払込を入れられない。
-- 申請は根拠の参照（企画書・試算など）、却下は理由（同じ列）が要る。申請と承認は同じ人でよく（J-10 (a)）、誰が申請し誰が承認したかは
-- 各版の created_by と created_at（日時）に残る。人が増えたら承認待ちで止める形は、受け口の決まり（src/planning/investment-approval/）で切り替える。
-- 額は自社出資の払込の額で、消費税の不課税の額（税の区分の列を持たない）。1円〜1兆円（作品の費用の版の出資額・0016 の制作費の版と同じ上限）。
-- 払込は会社への利益額（src/accounting/profit/）が払った月に引き（J-11b (a)）、出資の回収の出資額になる（FR-REV-KPI-039）。
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす。core の runbooks/07-cd.md 3-5）。
-- 決まりごとに WHEN 句のトリガーを1本ずつ作り、後ろの決まりの WHEN に「前の決まりに当たらない」を足して、D1 と PostgreSQL で同じ文で断る
-- （0012・0013・0016 と同じ。決まりの順: 案件の稼ぎ方 → 番号〈稟議・版〉→ 承認の前の払込 → 版の流れ → 承認・却下の額 → 払込の累計）。
-- 手元の SQLite（src/db.mjs の LocalDatabase）は、作るだけの文なので毎回当てる（0018 のあと）。

CREATE TABLE IF NOT EXISTS investment_approval_versions (
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 approval_no INTEGER NOT NULL CHECK(typeof(approval_no)='integer' AND approval_no>0),
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 status TEXT NOT NULL CHECK(status IN ('applied','approved','rejected','paid')),
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 1000000000000),
 basis_reference TEXT CHECK(basis_reference IS NULL OR length(trim(basis_reference)) BETWEEN 1 AND 500),
 paid_on TEXT CHECK(paid_on IS NULL OR (length(paid_on)=10 AND substr(paid_on,5,1)='-' AND substr(paid_on,8,1)='-'
  AND ltrim(substr(paid_on,1,4)||substr(paid_on,6,2)||substr(paid_on,9,2),'0123456789')=''
  AND substr(paid_on,6,2) BETWEEN '01' AND '12' AND substr(paid_on,9,2) BETWEEN '01' AND '31')),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,project_id,approval_no,version_no),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 -- 版1は申請
 CHECK(version_no>1 OR status='applied'),
 -- 払った日を持つのは払込の版だけ
 CHECK((status='paid' AND paid_on IS NOT NULL) OR (status<>'paid' AND paid_on IS NULL)),
 -- 申請は根拠の参照、却下は理由が要る
 CHECK(status NOT IN ('applied','rejected') OR basis_reference IS NOT NULL)
);
-- 稟議は稼ぎ方が自社出資の案件だけに持つ（J-2 (a)。製作委員会の出資は委員会への払込の記録で持つ）。無い案件・別の組織の案件もここで断る
CREATE TRIGGER IF NOT EXISTS investment_approval_versions_own_investment BEFORE INSERT ON investment_approval_versions
 WHEN NOT EXISTS(SELECT 1 FROM projects p WHERE p.org_id=NEW.org_id AND p.id=NEW.project_id AND p.earning_type='own_investment')
 BEGIN SELECT RAISE(ABORT,'investment approval needs an own investment project'); END;
-- 版の番号は稟議ごとの最後の番号の次だけ。新しい稟議（版1）の番号は案件ごとの最後の稟議の番号の次だけ（古い画面からの書き込み・番号の飛ばし・
-- 同じ番号の入れ直しを断る）
CREATE TRIGGER IF NOT EXISTS investment_approval_versions_sequence BEFORE INSERT ON investment_approval_versions
 WHEN EXISTS(SELECT 1 FROM projects p WHERE p.org_id=NEW.org_id AND p.id=NEW.project_id AND p.earning_type='own_investment')
  AND (NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM investment_approval_versions v
    WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id AND v.approval_no=NEW.approval_no)
   OR (NEW.version_no=1 AND NEW.approval_no<>(SELECT COALESCE(MAX(a.approval_no),0)+1 FROM investment_approval_versions a
    WHERE a.org_id=NEW.org_id AND a.project_id=NEW.project_id)))
 BEGIN SELECT RAISE(ABORT,'stale investment approval version'); END;
-- 払込は、直前の版が承認か払込のときだけ（承認の前に払込を入れられない）
CREATE TRIGGER IF NOT EXISTS investment_approval_versions_paid_after_approval BEFORE INSERT ON investment_approval_versions
 WHEN EXISTS(SELECT 1 FROM projects p WHERE p.org_id=NEW.org_id AND p.id=NEW.project_id AND p.earning_type='own_investment')
  AND NEW.version_no=(SELECT COALESCE(MAX(v.version_no),0)+1 FROM investment_approval_versions v
    WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id AND v.approval_no=NEW.approval_no)
  AND NEW.status='paid' AND NEW.version_no>1
  AND NOT EXISTS(SELECT 1 FROM investment_approval_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id
   AND v.approval_no=NEW.approval_no AND v.version_no=NEW.version_no-1 AND v.status IN ('approved','paid'))
 BEGIN SELECT RAISE(ABORT,'investment approval must be approved before payment'); END;
-- 払込のほかの版の流れ: 申請・却下のあとの申請（出し直し）と、申請のあとの承認・却下だけ。承認と払込のあとは払込だけ
CREATE TRIGGER IF NOT EXISTS investment_approval_versions_step BEFORE INSERT ON investment_approval_versions
 WHEN EXISTS(SELECT 1 FROM projects p WHERE p.org_id=NEW.org_id AND p.id=NEW.project_id AND p.earning_type='own_investment')
  AND NEW.version_no=(SELECT COALESCE(MAX(v.version_no),0)+1 FROM investment_approval_versions v
    WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id AND v.approval_no=NEW.approval_no)
  AND NEW.status<>'paid' AND NEW.version_no>1
  AND NOT EXISTS(SELECT 1 FROM investment_approval_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id
   AND v.approval_no=NEW.approval_no AND v.version_no=NEW.version_no-1
   AND ((v.status IN ('applied','rejected') AND NEW.status='applied') OR (v.status='applied' AND NEW.status IN ('approved','rejected'))))
 BEGIN SELECT RAISE(ABORT,'investment approval step is not allowed'); END;
-- 承認と却下は、直前の申請の額のまま（申請していない額を承認しない）。直前の版が申請でない承認・却下は上の版の流れが断る
CREATE TRIGGER IF NOT EXISTS investment_approval_versions_decision_amount BEFORE INSERT ON investment_approval_versions
 WHEN EXISTS(SELECT 1 FROM projects p WHERE p.org_id=NEW.org_id AND p.id=NEW.project_id AND p.earning_type='own_investment')
  AND NEW.version_no=(SELECT COALESCE(MAX(v.version_no),0)+1 FROM investment_approval_versions v
    WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id AND v.approval_no=NEW.approval_no)
  AND NEW.status IN ('approved','rejected')
  AND EXISTS(SELECT 1 FROM investment_approval_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id
   AND v.approval_no=NEW.approval_no AND v.version_no=NEW.version_no-1 AND v.status='applied' AND v.amount_yen<>NEW.amount_yen)
 BEGIN SELECT RAISE(ABORT,'investment approval decision must keep the applied amount'); END;
-- 払込の額の累計（この版を含む）は承認の額まで（出資枠＝承認の額−払込の累計が負にならない）。承認の版は稟議に1つだけ（承認のあとは払込だけ）
CREATE TRIGGER IF NOT EXISTS investment_approval_versions_paid_total BEFORE INSERT ON investment_approval_versions
 WHEN EXISTS(SELECT 1 FROM projects p WHERE p.org_id=NEW.org_id AND p.id=NEW.project_id AND p.earning_type='own_investment')
  AND NEW.version_no=(SELECT COALESCE(MAX(v.version_no),0)+1 FROM investment_approval_versions v
    WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id AND v.approval_no=NEW.approval_no)
  AND NEW.status='paid'
  AND EXISTS(SELECT 1 FROM investment_approval_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id
   AND v.approval_no=NEW.approval_no AND v.version_no=NEW.version_no-1 AND v.status IN ('approved','paid'))
  AND NEW.amount_yen+(SELECT COALESCE(SUM(s.amount_yen),0) FROM investment_approval_versions s
    WHERE s.org_id=NEW.org_id AND s.project_id=NEW.project_id AND s.approval_no=NEW.approval_no AND s.status='paid')
   >(SELECT MAX(a.amount_yen) FROM investment_approval_versions a
    WHERE a.org_id=NEW.org_id AND a.project_id=NEW.project_id AND a.approval_no=NEW.approval_no AND a.status='approved')
 BEGIN SELECT RAISE(ABORT,'investment approval payments exceed the approved amount'); END;
CREATE TRIGGER IF NOT EXISTS investment_approval_versions_no_update BEFORE UPDATE ON investment_approval_versions BEGIN SELECT RAISE(ABORT,'investment approval version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS investment_approval_versions_no_delete BEFORE DELETE ON investment_approval_versions BEGIN SELECT RAISE(ABORT,'investment approval version is append-only'); END;
