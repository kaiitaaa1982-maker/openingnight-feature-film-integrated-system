-- 支払う MG（買付分）の支払の記録（会社ルートの plans の 2026-10-22-folder-mg-buy、香盤表 #7）。
-- 要件は docs/requirements/planning/rights-acquisition.md の FR-PLAN-ACQ-015・019・042、計画の仮説 H4（MG の分割払い）。
-- 足すだけの移行: 1表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0027 は調整役から受け取った（2026-10-24 10:20 に 0028 から詰めた。予算書の型が 0028）。
--
-- 支払の記録を rights_payment_events に足す案はやめた（代表の決定 2026-10-24）。足すだけの移行の決まり（docs/rules/database.md）で
-- 既存の表の CHECK を変えられないため。出金_入金と予実は、権利元への支払としてこの表も読む（約束 F-1・Y-1 を直した）。
-- 調達案件の受け方「買付」も表を変えず、支払う MG の契約が指す調達案件を画面で「買付」と出す（同じ決定）。
--
-- 1行は、権利元へ払った MG の前払（mg_advance）か、超過の分配額（distribution）の支払1回。円の額は実際に払った額（FR-PLAN-ACQ-042）。
-- 外貨の支払は、通貨・外貨の額（通貨の最小単位の整数）・レート（100万倍の整数）・レートの日を一緒に持つ（FR-PLAN-ACQ-019）。
-- MG の前払は支払予定の回を、分配額は発行した分配報告書を指す。MG の前払と分配の支払は相殺しない（FR-PLAN-ACQ-015）。
-- 直しは取消の行（reverses_payment_id で元を指す。額は元と同じ正の数、理由つき）。変更と削除は DB が断る。
-- 会計の仕訳（約束 F-2）は、postJournal が core に入ったときに、この表への書き込みと同じ batch でつなぐ。
-- トリガーの本体に CASE を書かない。決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS acq_mg_payments (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 contract_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('mg_advance','distribution')),
 installment INTEGER CHECK(installment IS NULL OR (typeof(installment)='integer' AND installment BETWEEN 1 AND 50)),
 statement_id INTEGER,
 partner_id INTEGER NOT NULL,
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 9007199254740991),
 paid_on TEXT NOT NULL CHECK(length(paid_on)=10 AND paid_on BETWEEN '1900-01-01' AND '2999-12-31'),
 reference TEXT NOT NULL CHECK(length(trim(reference)) BETWEEN 1 AND 160),
 currency TEXT NOT NULL DEFAULT 'JPY' CHECK(length(currency)=3 AND upper(currency)=currency),
 foreign_amount INTEGER CHECK(foreign_amount IS NULL OR (typeof(foreign_amount)='integer' AND foreign_amount BETWEEN 1 AND 9007199254740991)),
 fx_rate_micro INTEGER CHECK(fx_rate_micro IS NULL OR (typeof(fx_rate_micro)='integer' AND fx_rate_micro BETWEEN 1 AND 9007199254740991)),
 fx_rate_on TEXT CHECK(fx_rate_on IS NULL OR (length(fx_rate_on)=10 AND fx_rate_on BETWEEN '1900-01-01' AND '2999-12-31')),
 reverses_payment_id INTEGER,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((currency='JPY' AND foreign_amount IS NULL AND fx_rate_micro IS NULL AND fx_rate_on IS NULL)
    OR (currency<>'JPY' AND foreign_amount IS NOT NULL AND fx_rate_micro IS NOT NULL AND fx_rate_on IS NOT NULL)),
 CHECK((kind='mg_advance' AND statement_id IS NULL) OR (kind='distribution' AND installment IS NULL AND statement_id IS NOT NULL)),
 CHECK(reverses_payment_id IS NULL OR reverses_payment_id<>id),
 UNIQUE(org_id,id), UNIQUE(org_id,reference), UNIQUE(org_id,reverses_payment_id),
 FOREIGN KEY(org_id,contract_id) REFERENCES acq_mg_contracts(org_id,id),
 FOREIGN KEY(org_id,term_version_id) REFERENCES acq_mg_term_versions(org_id,id),
 FOREIGN KEY(org_id,statement_id) REFERENCES acq_mg_statements(org_id,id),
 FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,reverses_payment_id) REFERENCES acq_mg_payments(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
-- 条件版は同じ契約のもの
CREATE TRIGGER IF NOT EXISTS acq_mg_payments_version_scope BEFORE INSERT ON acq_mg_payments
 WHEN NOT EXISTS(SELECT 1 FROM acq_mg_term_versions v WHERE v.org_id=NEW.org_id AND v.id=NEW.term_version_id AND v.contract_id=NEW.contract_id)
 BEGIN SELECT RAISE(ABORT,'支払が指す条件版は、同じ契約のものです'); END;
-- 払う相手は契約の権利元
CREATE TRIGGER IF NOT EXISTS acq_mg_payments_partner_match BEFORE INSERT ON acq_mg_payments
 WHEN NOT EXISTS(SELECT 1 FROM acq_mg_contracts k WHERE k.org_id=NEW.org_id AND k.id=NEW.contract_id AND k.partner_id=NEW.partner_id)
 BEGIN SELECT RAISE(ABORT,'支払の相手は、契約の権利元です'); END;
-- MG の前払の回は、その条件版の支払予定にある回（予定の無い版は回を空にする）
CREATE TRIGGER IF NOT EXISTS acq_mg_payments_installment_scope BEFORE INSERT ON acq_mg_payments
 WHEN NEW.installment IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM acq_mg_payment_schedule p WHERE p.org_id=NEW.org_id AND p.term_version_id=NEW.term_version_id AND p.installment=NEW.installment)
 BEGIN SELECT RAISE(ABORT,'支払予定に無い回です'); END;
-- 分配額の支払は、同じ契約の、取り消されていない発行の報告書を指す
CREATE TRIGGER IF NOT EXISTS acq_mg_payments_statement_scope BEFORE INSERT ON acq_mg_payments
 WHEN NEW.statement_id IS NOT NULL AND NEW.reverses_payment_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM acq_mg_statements s JOIN acq_mg_term_versions v ON v.org_id=s.org_id AND v.id=s.term_version_id
   WHERE s.org_id=NEW.org_id AND s.id=NEW.statement_id AND s.kind='issue' AND v.contract_id=NEW.contract_id
   AND NOT EXISTS(SELECT 1 FROM acq_mg_statements x WHERE x.org_id=s.org_id AND x.voids_statement_id=s.id))
 BEGIN SELECT RAISE(ABORT,'分配額の支払は、同じ契約の取り消されていない報告書を指してください'); END;
-- 取消の行は、同じ契約・種類・額・相手の、取消でない元の行を指す
CREATE TRIGGER IF NOT EXISTS acq_mg_payments_reverse_scope BEFORE INSERT ON acq_mg_payments
 WHEN NEW.reverses_payment_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM acq_mg_payments p WHERE p.org_id=NEW.org_id AND p.id=NEW.reverses_payment_id AND p.reverses_payment_id IS NULL
   AND p.contract_id=NEW.contract_id AND p.kind=NEW.kind AND p.amount_yen=NEW.amount_yen AND p.partner_id=NEW.partner_id)
 BEGIN SELECT RAISE(ABORT,'取消は、同じ契約・種類・額・相手の元の支払を指してください'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_payments_no_update BEFORE UPDATE ON acq_mg_payments
 BEGIN SELECT RAISE(ABORT,'支払の記録は変更できません。取消の行を足してください'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_payments_no_delete BEFORE DELETE ON acq_mg_payments
 BEGIN SELECT RAISE(ABORT,'支払の記録は削除できません'); END;
