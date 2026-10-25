-- 製造（会社ルートの plans/2026-10-24-folder-seizou.md の第1・第2版。最初の切れ）。
-- 足すだけの移行: 8表と、その表だけのトリガーと索引を作る。既存の表の列・制約・トリガーは変えない。番号 0046 は調整役から受け取った（0042〜0045 が先に入る）。
--
-- mfg_products: 製造する商品（SKU）の入れ物。作品と出どころ（調達・MG_買付分・自社の企画）だけを持ち、名前・形・発売日は版に持つ。
-- mfg_product_versions: 商品の版。発売日が動いたら版を足す（上書きしない）。逆算の型は 25日の型（day25）か発売日の n 日前（offset）。
-- mfg_step_events: 工程の記録（依頼した・承認された・済んだ・予定日を人が直した・取消）。逆算の予定日は記録せず、型と発売日から導く。
-- mfg_purchase_orders・mfg_purchase_order_lines: 発注書と明細。種類はオーサリング・デザイン・製造・印刷物・見本盤の発送の5つ。
--   直すときは発注書を取消して新しく作る（明細は変えない）。金額は予測（請求の実額は経費の明細の行が正本）。
-- mfg_po_events: 発注書の段（見積を依頼した・見積が来た・発注した・請求が来た・支払った・取消）。
-- mfg_receipts: 明細ごとの納品と検品。
-- mfg_po_expenses: 明細と経費の明細の行（expenses）の結び。外すときは理由つきの行を足す。
-- 人の名前・住所は持たない（取引先は partners を指すか、会社の名前だけを書く）。
--
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす）。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS mfg_products (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('procure','mg_buy','own')),
 source_ref TEXT CHECK(source_ref IS NULL OR length(trim(source_ref)) BETWEEN 1 AND 80),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS mfg_products_no_update BEFORE UPDATE ON mfg_products BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE TRIGGER IF NOT EXISTS mfg_products_no_delete BEFORE DELETE ON mfg_products BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE INDEX IF NOT EXISTS mfg_products_work_idx ON mfg_products(org_id,project_id,work_id);
CREATE INDEX IF NOT EXISTS mfg_products_author_idx ON mfg_products(org_id,created_by);

CREATE TABLE IF NOT EXISTS mfg_product_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 product_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 channel TEXT NOT NULL CHECK(channel IN ('sell','rental','print','other')),
 media TEXT NOT NULL CHECK(media IN ('dvd','bd','print','other')),
 edition_label TEXT CHECK(edition_label IS NULL OR length(trim(edition_label)) BETWEEN 1 AND 60),
 episode_from INTEGER CHECK(episode_from IS NULL OR (typeof(episode_from)='integer' AND episode_from BETWEEN 1 AND 9999)),
 episode_to INTEGER CHECK(episode_to IS NULL OR (typeof(episode_to)='integer' AND episode_to BETWEEN 1 AND 9999)),
 release_on TEXT NOT NULL CHECK(length(release_on)=10 AND substr(release_on,5,1)='-' AND substr(release_on,8,1)='-'
  AND ltrim(substr(release_on,1,4)||substr(release_on,6,2)||substr(release_on,9,2),'0123456789')=''),
 schedule_rule TEXT NOT NULL CHECK(schedule_rule IN ('day25','offset')),
 planned_qty INTEGER CHECK(planned_qty IS NULL OR (typeof(planned_qty)='integer' AND planned_qty BETWEEN 0 AND 100000000)),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,product_id,version_no),
 FOREIGN KEY(org_id,product_id) REFERENCES mfg_products(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(episode_from IS NULL OR episode_to IS NULL OR episode_from<=episode_to),
 CHECK(schedule_rule<>'day25' OR substr(release_on,9,2)='25')
);
CREATE TRIGGER IF NOT EXISTS mfg_product_versions_sequence BEFORE INSERT ON mfg_product_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM mfg_product_versions v WHERE v.org_id=NEW.org_id AND v.product_id=NEW.product_id)
 BEGIN SELECT RAISE(ABORT,'stale manufacturing version'); END;
CREATE TRIGGER IF NOT EXISTS mfg_product_versions_no_update BEFORE UPDATE ON mfg_product_versions BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE TRIGGER IF NOT EXISTS mfg_product_versions_no_delete BEFORE DELETE ON mfg_product_versions BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE INDEX IF NOT EXISTS mfg_product_versions_author_idx ON mfg_product_versions(org_id,created_by);

CREATE TABLE IF NOT EXISTS mfg_step_events (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 product_id INTEGER NOT NULL,
 step_key TEXT NOT NULL CHECK(length(trim(step_key)) BETWEEN 1 AND 40),
 kind TEXT NOT NULL CHECK(kind IN ('requested','approved','done','planned','void')),
 on_date TEXT CHECK(on_date IS NULL OR (length(on_date)=10 AND substr(on_date,5,1)='-' AND substr(on_date,8,1)='-'
  AND ltrim(substr(on_date,1,4)||substr(on_date,6,2)||substr(on_date,9,2),'0123456789')='')),
 voids_event_id INTEGER,
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,product_id) REFERENCES mfg_products(org_id,id),
 FOREIGN KEY(org_id,voids_event_id) REFERENCES mfg_step_events(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((kind='void' AND voids_event_id IS NOT NULL AND on_date IS NULL) OR (kind<>'void' AND voids_event_id IS NULL AND on_date IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS mfg_step_events_no_update BEFORE UPDATE ON mfg_step_events BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE TRIGGER IF NOT EXISTS mfg_step_events_no_delete BEFORE DELETE ON mfg_step_events BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE INDEX IF NOT EXISTS mfg_step_events_product_idx ON mfg_step_events(org_id,product_id);
CREATE INDEX IF NOT EXISTS mfg_step_events_author_idx ON mfg_step_events(org_id,created_by);

CREATE TABLE IF NOT EXISTS mfg_purchase_orders (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 product_id INTEGER NOT NULL,
 po_no TEXT NOT NULL CHECK(length(trim(po_no)) BETWEEN 1 AND 40),
 po_kind TEXT NOT NULL CHECK(po_kind IN ('authoring','design','manufacture','print','sample')),
 partner_id INTEGER,
 partner_label TEXT CHECK(partner_label IS NULL OR length(trim(partner_label)) BETWEEN 1 AND 120),
 deliver_to TEXT CHECK(deliver_to IS NULL OR length(trim(deliver_to)) BETWEEN 1 AND 120),
 due_on TEXT CHECK(due_on IS NULL OR (length(due_on)=10 AND substr(due_on,5,1)='-' AND substr(due_on,8,1)='-'
  AND ltrim(substr(due_on,1,4)||substr(due_on,6,2)||substr(due_on,9,2),'0123456789')='')),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,po_no),
 FOREIGN KEY(org_id,product_id) REFERENCES mfg_products(org_id,id),
 FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(partner_id IS NOT NULL OR partner_label IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS mfg_purchase_orders_no_update BEFORE UPDATE ON mfg_purchase_orders BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE TRIGGER IF NOT EXISTS mfg_purchase_orders_no_delete BEFORE DELETE ON mfg_purchase_orders BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE INDEX IF NOT EXISTS mfg_purchase_orders_product_idx ON mfg_purchase_orders(org_id,product_id);
CREATE INDEX IF NOT EXISTS mfg_purchase_orders_partner_idx ON mfg_purchase_orders(org_id,partner_id);
CREATE INDEX IF NOT EXISTS mfg_purchase_orders_author_idx ON mfg_purchase_orders(org_id,created_by);

CREATE TABLE IF NOT EXISTS mfg_purchase_order_lines (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 po_id INTEGER NOT NULL,
 line_no INTEGER NOT NULL CHECK(typeof(line_no)='integer' AND line_no BETWEEN 1 AND 200),
 item TEXT NOT NULL CHECK(length(trim(item)) BETWEEN 1 AND 120),
 spec TEXT CHECK(spec IS NULL OR length(trim(spec)) BETWEEN 1 AND 500),
 qty INTEGER NOT NULL CHECK(typeof(qty)='integer' AND qty BETWEEN 1 AND 100000000),
 unit_price_x100 INTEGER NOT NULL CHECK(typeof(unit_price_x100)='integer' AND unit_price_x100 BETWEEN 0 AND 100000000000),
 amount_ex_tax_yen INTEGER NOT NULL CHECK(typeof(amount_ex_tax_yen)='integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000),
 UNIQUE(org_id,id), UNIQUE(org_id,po_id,line_no),
 FOREIGN KEY(org_id,po_id) REFERENCES mfg_purchase_orders(org_id,id),
 CHECK(amount_ex_tax_yen*100=qty*unit_price_x100)
);
CREATE TRIGGER IF NOT EXISTS mfg_purchase_order_lines_no_update BEFORE UPDATE ON mfg_purchase_order_lines BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE TRIGGER IF NOT EXISTS mfg_purchase_order_lines_no_delete BEFORE DELETE ON mfg_purchase_order_lines BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;

CREATE TABLE IF NOT EXISTS mfg_po_events (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 po_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('quote_requested','quoted','ordered','invoiced','paid','void')),
 on_date TEXT NOT NULL CHECK(length(on_date)=10 AND substr(on_date,5,1)='-' AND substr(on_date,8,1)='-'
  AND ltrim(substr(on_date,1,4)||substr(on_date,6,2)||substr(on_date,9,2),'0123456789')=''),
 amount_ex_tax_yen INTEGER CHECK(amount_ex_tax_yen IS NULL OR (typeof(amount_ex_tax_yen)='integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000)),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,po_id) REFERENCES mfg_purchase_orders(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(kind<>'void' OR note IS NOT NULL)
);
-- 取消した発注書には段を足さない
CREATE TRIGGER IF NOT EXISTS mfg_po_events_after_void BEFORE INSERT ON mfg_po_events
 WHEN EXISTS(SELECT 1 FROM mfg_po_events e WHERE e.org_id=NEW.org_id AND e.po_id=NEW.po_id AND e.kind='void')
 BEGIN SELECT RAISE(ABORT,'purchase order voided'); END;
CREATE TRIGGER IF NOT EXISTS mfg_po_events_no_update BEFORE UPDATE ON mfg_po_events BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE TRIGGER IF NOT EXISTS mfg_po_events_no_delete BEFORE DELETE ON mfg_po_events BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE INDEX IF NOT EXISTS mfg_po_events_po_idx ON mfg_po_events(org_id,po_id);
CREATE INDEX IF NOT EXISTS mfg_po_events_author_idx ON mfg_po_events(org_id,created_by);

CREATE TABLE IF NOT EXISTS mfg_receipts (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 po_line_id INTEGER NOT NULL,
 received_on TEXT NOT NULL CHECK(length(received_on)=10 AND substr(received_on,5,1)='-' AND substr(received_on,8,1)='-'
  AND ltrim(substr(received_on,1,4)||substr(received_on,6,2)||substr(received_on,9,2),'0123456789')=''),
 qty INTEGER NOT NULL CHECK(typeof(qty)='integer' AND qty BETWEEN 0 AND 100000000),
 defect_qty INTEGER NOT NULL DEFAULT 0 CHECK(typeof(defect_qty)='integer' AND defect_qty BETWEEN 0 AND 100000000),
 result TEXT NOT NULL CHECK(result IN ('pass','fail')),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,po_line_id) REFERENCES mfg_purchase_order_lines(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(defect_qty<=qty),
 CHECK(result<>'fail' OR note IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS mfg_receipts_no_update BEFORE UPDATE ON mfg_receipts BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE TRIGGER IF NOT EXISTS mfg_receipts_no_delete BEFORE DELETE ON mfg_receipts BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE INDEX IF NOT EXISTS mfg_receipts_line_idx ON mfg_receipts(org_id,po_line_id);
CREATE INDEX IF NOT EXISTS mfg_receipts_author_idx ON mfg_receipts(org_id,created_by);

CREATE TABLE IF NOT EXISTS mfg_po_expenses (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 po_line_id INTEGER NOT NULL,
 expense_id INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('link','unlink')),
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,po_line_id) REFERENCES mfg_purchase_order_lines(org_id,id),
 FOREIGN KEY(org_id,expense_id) REFERENCES expenses(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(action<>'unlink' OR reason IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS mfg_po_expenses_no_update BEFORE UPDATE ON mfg_po_expenses BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE TRIGGER IF NOT EXISTS mfg_po_expenses_no_delete BEFORE DELETE ON mfg_po_expenses BEGIN SELECT RAISE(ABORT,'manufacturing record immutable'); END;
CREATE INDEX IF NOT EXISTS mfg_po_expenses_line_idx ON mfg_po_expenses(org_id,po_line_id);
CREATE INDEX IF NOT EXISTS mfg_po_expenses_expense_idx ON mfg_po_expenses(org_id,expense_id);
CREATE INDEX IF NOT EXISTS mfg_po_expenses_author_idx ON mfg_po_expenses(org_id,created_by);
