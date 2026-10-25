-- 制作費の版（フェーズ1の仕様書 #5。要件 docs/requirements/expenses/production-cost.md の FR-EXP-PCOST-001〜006・015・018〜025・039）。
-- 足すだけの移行: 作品ごとの連番の版の表1つ（production_cost_versions）を作る。追記だけで、変更・削除・同じ番号の入れ直しは DB が断る。
-- 版の額は成功報酬の線（閾値）にする制作費で、税抜の整数円（FR-EXP-PCOST-021）。最新の version_no の版がその時点の制作費（読むたびに導く）。
-- 根拠の種類は3つ。どれも版の行に根拠を持ち、根拠の無い行は表の CHECK が断る。
--   investment          出資額から作る最初の版（FR-EXP-PCOST-002・003）。作品の費用の最新の版の確定した自社の出資額（work_finance_versions）か、
--                       作品の委員会の契約の最新の条件版の出資額の合計（committee_term_investments。製作費総額 committee_term_funding と同じ額）を、
--                       トリガーが参照先の額と照らす（額を手で写させない）。委員会の条件版は税の区分を持たないので、版の税の区分は「不明」（FR-EXP-PCOST-022）
--   contract            出資の記録が無い作品の最初の版を、契約書の参照・締結日・相手・額から手で入れる（FR-EXP-PCOST-039）。税込の契約は
--                       税抜に戻した額を版の額にし、戻し方を残す（FR-EXP-PCOST-023）。出資の記録がある作品で断るのは受け口（DB は出資の記録の
--                       あとからの追加を見張れないため）
--   additional_contract 超過分を結び直した追加の契約で、委員会・自社の払う額が増えたときに足す版（FR-EXP-PCOST-006・024・025）。前の版の額＋追加額で、
--                       負担の種別は出資者の追加出資か借入だけ（制作会社の自己負担では版を足さない）。この版を足す受け口はまだ無い（表の形だけ先に持つ）
-- 内訳（制作費・P&A。FR-EXP-PCOST-019）は、出資が P&A を含む作品だけが持ち、2つの和が版の額（P&A を含む出資の総額。FR-EXP-PCOST-020）。
-- 登録できる人（プロデューサーの役目を持つ人と管理者。FR-EXP-PCOST-008・039）は受け口が確かめる（src/expenses/production-cost/production-cost-routes.mjs）。
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす。core の runbooks/07-cd.md 3-5）。
-- 決まりごとに WHEN 句のトリガーを1本ずつ作り、後ろの決まりの WHEN に「前の決まりに当たらない」を足して、D1 と PostgreSQL で同じ文で断る
-- （0013 と同じ。決まりの順: 版の番号 → 出資額の照合〈自社の出資・委員会〉→ 追加の版の額）。
-- 手元の SQLite（src/db.mjs の LocalDatabase）は、作るだけの文なので毎回当てる（0015 のあと）。

-- 金額の列は 1円〜1兆円（work_finance_versions の出資額・0013 の総製作費と同じ上限）。内訳は 0円〜1兆円（片方が 0 の内訳を許す）。
-- 契約書の額（contract_amount_yen）は契約書に書かれた額で、税込なら版の額（contract）か追加額（additional_contract）はそれ以下の税抜の額
CREATE TABLE IF NOT EXISTS production_cost_versions (
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('investment','contract','additional_contract')),
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 1000000000000),
 tax_basis TEXT NOT NULL CHECK(tax_basis IN ('ex_tax','unknown')),
 production_part_yen INTEGER CHECK(production_part_yen IS NULL OR (typeof(production_part_yen)='integer' AND production_part_yen BETWEEN 0 AND 1000000000000)),
 pa_part_yen INTEGER CHECK(pa_part_yen IS NULL OR (typeof(pa_part_yen)='integer' AND pa_part_yen BETWEEN 0 AND 1000000000000)),
 work_finance_revision INTEGER,
 committee_term_version_id INTEGER,
 contract_reference TEXT CHECK(contract_reference IS NULL OR length(trim(contract_reference)) BETWEEN 1 AND 500),
 contract_signed_on TEXT CHECK(contract_signed_on IS NULL OR (length(contract_signed_on)=10 AND substr(contract_signed_on,5,1)='-' AND substr(contract_signed_on,8,1)='-'
  AND ltrim(substr(contract_signed_on,1,4)||substr(contract_signed_on,6,2)||substr(contract_signed_on,9,2),'0123456789')=''
  AND substr(contract_signed_on,6,2) BETWEEN '01' AND '12' AND substr(contract_signed_on,9,2) BETWEEN '01' AND '31')),
 counterparty_partner_id INTEGER,
 contract_amount_yen INTEGER CHECK(contract_amount_yen IS NULL OR (typeof(contract_amount_yen)='integer' AND contract_amount_yen BETWEEN 1 AND 1000000000000)),
 contract_tax_basis TEXT CHECK(contract_tax_basis IS NULL OR contract_tax_basis IN ('ex_tax','inc_tax')),
 tax_conversion TEXT CHECK(tax_conversion IS NULL OR length(trim(tax_conversion)) BETWEEN 1 AND 500),
 added_yen INTEGER CHECK(added_yen IS NULL OR (typeof(added_yen)='integer' AND added_yen BETWEEN 1 AND 1000000000000)),
 burden_type TEXT CHECK(burden_type IS NULL OR burden_type IN ('investor_additional','borrowing')),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,work_id,version_no),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,work_id,work_finance_revision) REFERENCES work_finance_versions(org_id,work_id,revision),
 FOREIGN KEY(org_id,committee_term_version_id) REFERENCES committee_term_versions(org_id,id),
 FOREIGN KEY(org_id,counterparty_partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 -- 内訳は2つとも無いか、2つとも持って和が版の額
 CHECK((production_part_yen IS NULL AND pa_part_yen IS NULL)
  OR (production_part_yen IS NOT NULL AND pa_part_yen IS NOT NULL AND production_part_yen+pa_part_yen=amount_yen)),
 -- 契約書の額の税の区分: 税抜なら戻し方を持たず、税込なら戻し方が要る
 CHECK((contract_tax_basis IS NULL AND tax_conversion IS NULL)
  OR (contract_tax_basis='ex_tax' AND tax_conversion IS NULL)
  OR (contract_tax_basis='inc_tax' AND tax_conversion IS NOT NULL)),
 -- 根拠の形（種類ごとに要る列と、持たない列）
 CHECK(
  (source_kind='investment' AND version_no=1
   AND ((work_finance_revision IS NOT NULL AND committee_term_version_id IS NULL) OR (work_finance_revision IS NULL AND committee_term_version_id IS NOT NULL))
   AND contract_reference IS NULL AND contract_signed_on IS NULL AND counterparty_partner_id IS NULL AND contract_amount_yen IS NULL AND contract_tax_basis IS NULL
   AND added_yen IS NULL AND burden_type IS NULL)
  OR (source_kind='contract' AND version_no=1 AND tax_basis='ex_tax'
   AND work_finance_revision IS NULL AND committee_term_version_id IS NULL
   AND contract_reference IS NOT NULL AND contract_signed_on IS NOT NULL AND counterparty_partner_id IS NOT NULL AND contract_amount_yen IS NOT NULL AND contract_tax_basis IS NOT NULL
   AND added_yen IS NULL AND burden_type IS NULL
   AND ((contract_tax_basis='ex_tax' AND amount_yen=contract_amount_yen) OR (contract_tax_basis='inc_tax' AND amount_yen<=contract_amount_yen)))
  OR (source_kind='additional_contract' AND version_no>1
   AND work_finance_revision IS NULL AND committee_term_version_id IS NULL
   AND contract_reference IS NOT NULL AND contract_signed_on IS NOT NULL AND counterparty_partner_id IS NOT NULL AND contract_amount_yen IS NOT NULL AND contract_tax_basis IS NOT NULL
   AND added_yen IS NOT NULL AND burden_type IS NOT NULL
   AND ((contract_tax_basis='ex_tax' AND added_yen=contract_amount_yen) OR (contract_tax_basis='inc_tax' AND added_yen<=contract_amount_yen)))
 )
);
-- 版の番号は作品ごとの最後の番号の次だけ（古い画面からの書き込み・番号の飛ばし・同じ番号の入れ直しを断る。FR-EXP-PCOST-004）
CREATE TRIGGER IF NOT EXISTS production_cost_versions_sequence BEFORE INSERT ON production_cost_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM production_cost_versions v WHERE v.org_id=NEW.org_id AND v.work_id=NEW.work_id)
 BEGIN SELECT RAISE(ABORT,'stale production cost version'); END;
-- 自社の出資額から作る版は、作品の費用の最新の版の、確定した自社の出資額と同じ額・同じ税の区分（FR-EXP-PCOST-002・003）。
-- 根拠の列が両方ある行・種類の違う行は、ここで断らず表の CHECK で断る
CREATE TRIGGER IF NOT EXISTS production_cost_versions_own_investment BEFORE INSERT ON production_cost_versions
 WHEN NEW.version_no=(SELECT COALESCE(MAX(v.version_no),0)+1 FROM production_cost_versions v WHERE v.org_id=NEW.org_id AND v.work_id=NEW.work_id)
  AND NEW.source_kind='investment' AND NEW.work_finance_revision IS NOT NULL AND NEW.committee_term_version_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM work_finance_versions f WHERE f.org_id=NEW.org_id AND f.work_id=NEW.work_id AND f.revision=NEW.work_finance_revision
   AND f.revision=(SELECT MAX(x.revision) FROM work_finance_versions x WHERE x.org_id=NEW.org_id AND x.work_id=NEW.work_id)
   AND f.own_investment_status='confirmed' AND f.own_investment_yen=NEW.amount_yen AND f.own_investment_tax_basis=NEW.tax_basis)
 BEGIN SELECT RAISE(ABORT,'production cost version must match the latest confirmed own investment'); END;
-- 委員会の出資額から作る版は、作品の委員会の契約の最新の条件版で、出資額の合計と製作費総額がどちらも版の額と同じもの。税の区分は「不明」
-- （条件版は区分を持たない。FR-EXP-PCOST-015・022）
CREATE TRIGGER IF NOT EXISTS production_cost_versions_committee_investment BEFORE INSERT ON production_cost_versions
 WHEN NEW.version_no=(SELECT COALESCE(MAX(v.version_no),0)+1 FROM production_cost_versions v WHERE v.org_id=NEW.org_id AND v.work_id=NEW.work_id)
  AND NEW.source_kind='investment' AND NEW.committee_term_version_id IS NOT NULL AND NEW.work_finance_revision IS NULL
  AND (NEW.tax_basis<>'unknown'
   OR NOT EXISTS(SELECT 1 FROM committee_term_versions t JOIN committee_contracts c ON c.org_id=t.org_id AND c.id=t.contract_id
    JOIN committee_term_funding f ON f.org_id=t.org_id AND f.term_version_id=t.id
    WHERE t.org_id=NEW.org_id AND t.id=NEW.committee_term_version_id AND c.work_id=NEW.work_id AND f.production_cost_yen=NEW.amount_yen
     AND t.version_no=(SELECT MAX(x.version_no) FROM committee_term_versions x WHERE x.org_id=t.org_id AND x.contract_id=t.contract_id))
   OR NEW.amount_yen<>(SELECT COALESCE(SUM(i.amount_yen),0) FROM committee_term_investments i WHERE i.org_id=NEW.org_id AND i.term_version_id=NEW.committee_term_version_id))
 BEGIN SELECT RAISE(ABORT,'production cost version must match the latest committee investment'); END;
-- 追加の版は、前の版の額＋追加額で、税の区分は前の版と同じ（「不明」の版に足した額も「不明」。FR-EXP-PCOST-006・015）
CREATE TRIGGER IF NOT EXISTS production_cost_versions_additional_amount BEFORE INSERT ON production_cost_versions
 WHEN NEW.version_no=(SELECT COALESCE(MAX(v.version_no),0)+1 FROM production_cost_versions v WHERE v.org_id=NEW.org_id AND v.work_id=NEW.work_id)
  AND NEW.source_kind='additional_contract'
  AND EXISTS(SELECT 1 FROM production_cost_versions p WHERE p.org_id=NEW.org_id AND p.work_id=NEW.work_id AND p.version_no=NEW.version_no-1
   AND (p.amount_yen+NEW.added_yen<>NEW.amount_yen OR p.tax_basis<>NEW.tax_basis))
 BEGIN SELECT RAISE(ABORT,'production cost version must add the additional contract to the previous version'); END;
CREATE TRIGGER IF NOT EXISTS production_cost_versions_no_update BEFORE UPDATE ON production_cost_versions BEGIN SELECT RAISE(ABORT,'production cost version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS production_cost_versions_no_delete BEFORE DELETE ON production_cost_versions BEGIN SELECT RAISE(ABORT,'production cost version is append-only'); END;
