-- 製作委員会の追加表（0003）。窓口手数料を複数社で分けるときの取り分（例: 配信・放送の窓口手数料を2社で半分ずつ）。
-- 窓口（committee_term_windows）は条件版に付く変更不可の行なので、取り分も窓口ごとに1回だけ登録する（変える時は新しい条件版）。
-- 行が無い窓口は、窓口の受取先（window_partner_id）1社が手数料をすべて受け取る。合計は 10000bp（アプリで検査、超過はトリガーで拒否）。
CREATE TABLE IF NOT EXISTS committee_term_window_fee_shares (
  org_id INTEGER NOT NULL, window_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  share_bps INTEGER NOT NULL CHECK(share_bps BETWEEN 1 AND 10000),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id, window_id, partner_id),
  FOREIGN KEY(org_id, window_id) REFERENCES committee_term_windows(org_id, id),
  FOREIGN KEY(org_id, partner_id) REFERENCES partners(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);
CREATE TRIGGER IF NOT EXISTS committee_window_fee_shares_no_update BEFORE UPDATE ON committee_term_window_fee_shares
BEGIN SELECT RAISE(ABORT, '窓口手数料の取り分は変更できません。新しい条件版で登録してください'); END;
CREATE TRIGGER IF NOT EXISTS committee_window_fee_shares_no_delete BEFORE DELETE ON committee_term_window_fee_shares
BEGIN SELECT RAISE(ABORT, '窓口手数料の取り分は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS committee_window_fee_shares_total BEFORE INSERT ON committee_term_window_fee_shares
WHEN (SELECT COALESCE(SUM(share_bps), 0) FROM committee_term_window_fee_shares WHERE org_id=NEW.org_id AND window_id=NEW.window_id) + NEW.share_bps > 10000
BEGIN SELECT RAISE(ABORT, '窓口手数料の取り分の合計は100%以内にしてください'); END;

-- 条件版の適用開始月（計上月 YYYY-MM）。条件版（committee_term_versions）に列を足せないため別の表に持つ（1条件版に1行、変更・削除不可）。
-- 計上月ごとに「適用開始月がその月以前の条件版のうち、版番号が最大のもの」を使う。行の無い条件版は最初の月から適用する
-- （この表を足す前の条件版と、契約の版1）。新しい版は適用開始月から後のすべての月で前の版に代わり、それより前の月は前の版のまま。
-- 適用開始月を決めずに作った版（最初の月から）が確定済みのロイヤリティ報告書の計上月にかかるときは、画面・APIで確認を取ってから作る。
CREATE TABLE IF NOT EXISTS committee_term_version_effective (
  org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL,
  effective_from TEXT NOT NULL CHECK(effective_from GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(effective_from,6,2) BETWEEN '01' AND '12'),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id, term_version_id),
  FOREIGN KEY(org_id, term_version_id) REFERENCES committee_term_versions(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);
CREATE TRIGGER IF NOT EXISTS committee_term_version_effective_no_update BEFORE UPDATE ON committee_term_version_effective
BEGIN SELECT RAISE(ABORT, '条件版の適用開始月は変更できません。新しい条件版で登録してください'); END;
CREATE TRIGGER IF NOT EXISTS committee_term_version_effective_no_delete BEFORE DELETE ON committee_term_version_effective
BEGIN SELECT RAISE(ABORT, '条件版の適用開始月は削除できません'); END;

-- 作品で絞って売上明細を読むための索引（sales/channel-group.mjs の workSaleLines。組織全体を読まない）
CREATE INDEX IF NOT EXISTS committee_sale_lines_product_month_idx ON sale_lines(org_id, product_id, accounting_month);
CREATE INDEX IF NOT EXISTS committee_sale_lines_work_month_idx ON sale_lines(org_id, work_id, accounting_month);
CREATE INDEX IF NOT EXISTS committee_product_works_work_idx ON product_works(org_id, work_id, product_id);
