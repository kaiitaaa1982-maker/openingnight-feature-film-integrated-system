-- Additive channel facts. sale_lines is the only booked sales amount; these tables
-- describe its source and must never be summed alongside it.
CREATE TABLE IF NOT EXISTS theatrical_sale_details (
  org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL,
  model TEXT NOT NULL CHECK(model IN ('theatrical_rs','theatrical_flat','non_theatrical_rs','non_theatrical_flat')),
  ticket_type_code TEXT, purchase_channel TEXT,
  admissions_count INTEGER CHECK(admissions_count IS NULL OR admissions_count>=0),
  gross_box_office_ex_tax TEXT,
  reported_actual_ex_tax TEXT, reported_recognized_ex_tax TEXT, calculated_actual_ex_tax TEXT,
  PRIMARY KEY(org_id,sale_id),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id)
);
CREATE TABLE IF NOT EXISTS package_sale_details (
  org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL,
  model TEXT NOT NULL CHECK(model IN ('rental','sell_through','license')),
  turns_count INTEGER CHECK(turns_count IS NULL OR turns_count>=0),
  average_rental_price_ex_tax TEXT, holder_unit_price_ex_tax TEXT,
  reported_actual_ex_tax TEXT, reported_recognized_ex_tax TEXT, calculated_actual_ex_tax TEXT,
  PRIMARY KEY(org_id,sale_id),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
  CHECK(model='rental' OR (turns_count IS NULL AND average_rental_price_ex_tax IS NULL))
);
CREATE TABLE IF NOT EXISTS digital_sale_details (
  org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL,
  model TEXT NOT NULL CHECK(model IN ('est','tvod','svod','avod','flat','mg')),
  service_code TEXT NOT NULL CHECK(length(trim(service_code))>0),
  sales_count INTEGER CHECK(sales_count IS NULL OR sales_count>=0),
  view_count INTEGER CHECK(view_count IS NULL OR view_count>=0),
  view_seconds INTEGER CHECK(view_seconds IS NULL OR view_seconds>=0),
  unit_price_ex_tax TEXT, holder_unit_price_ex_tax TEXT,
  contract_amount_ex_tax TEXT, contract_period_from TEXT, contract_period_to TEXT,
  reported_actual_ex_tax TEXT, reported_recognized_ex_tax TEXT, calculated_actual_ex_tax TEXT,
  PRIMARY KEY(org_id,sale_id),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
  CHECK((model IN ('est','tvod') AND view_count IS NULL AND view_seconds IS NULL AND contract_amount_ex_tax IS NULL)
     OR (model IN ('svod','avod') AND sales_count IS NULL AND unit_price_ex_tax IS NULL AND contract_amount_ex_tax IS NULL)
     OR (model IN ('flat','mg') AND sales_count IS NULL AND view_count IS NULL AND view_seconds IS NULL AND unit_price_ex_tax IS NULL)),
  CHECK(model='flat' OR (contract_amount_ex_tax IS NULL AND contract_period_from IS NULL AND contract_period_to IS NULL)),
  CHECK(contract_amount_ex_tax IS NULL OR (contract_period_from IS NOT NULL AND contract_period_to IS NOT NULL AND contract_period_to>=contract_period_from))
);

-- Delivery, operation, stock and return are report observations, not sales.
-- One metric per source row prevents stock being duplicated across price/MG lines.
CREATE TABLE IF NOT EXISTS package_report_observations (
  org_id INTEGER NOT NULL, report_id INTEGER NOT NULL, source_row INTEGER NOT NULL CHECK(source_row>=1),
  metric TEXT NOT NULL CHECK(metric IN ('delivered','active','inventory','returned')),
  count INTEGER NOT NULL CHECK(count>=0),
  unit TEXT NOT NULL CHECK(length(trim(unit))>0),
  scope TEXT NOT NULL CHECK(length(trim(scope))>0),
  basis TEXT NOT NULL CHECK(length(trim(basis))>0),
  observed_on TEXT,
  PRIMARY KEY(org_id,report_id,source_row,metric),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
  CHECK(metric<>'inventory' OR observed_on IS NOT NULL)
);

-- A package observation may be work-wide or attributable to a validated product.
-- The separate link keeps existing observation records migratable without rewriting them.
CREATE TABLE IF NOT EXISTS package_observation_products (
  org_id INTEGER NOT NULL, report_id INTEGER NOT NULL, source_row INTEGER NOT NULL,
  metric TEXT NOT NULL, product_id INTEGER NOT NULL,
  PRIMARY KEY(org_id,report_id,source_row,metric),
  FOREIGN KEY(org_id,report_id,source_row,metric) REFERENCES package_report_observations(org_id,report_id,source_row,metric),
  FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS package_observation_product_immutable_update BEFORE UPDATE ON package_observation_products BEGIN SELECT RAISE(ABORT,'package observation product is immutable'); END;
CREATE TRIGGER IF NOT EXISTS package_observation_product_immutable_delete BEFORE DELETE ON package_observation_products BEGIN SELECT RAISE(ABORT,'package observation product is immutable'); END;

-- Every completed report is sealed after its channel facts are inserted. Reports
-- that predate this additive migration are already complete and are sealed now.
CREATE TABLE IF NOT EXISTS report_channel_fact_seals (
  org_id INTEGER NOT NULL, report_id INTEGER NOT NULL,
  sealed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,report_id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id)
);
INSERT OR IGNORE INTO report_channel_fact_seals(org_id,report_id)
SELECT org_id,id FROM report_imports;
CREATE TRIGGER IF NOT EXISTS report_channel_fact_seal_immutable_update BEFORE UPDATE ON report_channel_fact_seals BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;
CREATE TRIGGER IF NOT EXISTS report_channel_fact_seal_immutable_delete BEFORE DELETE ON report_channel_fact_seals BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;
CREATE TRIGGER IF NOT EXISTS theatrical_detail_sealed BEFORE INSERT ON theatrical_sale_details
WHEN EXISTS (SELECT 1 FROM sale_lines s JOIN report_channel_fact_seals f ON f.org_id=s.org_id AND f.report_id=s.report_id WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id)
BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;
CREATE TRIGGER IF NOT EXISTS package_detail_sealed BEFORE INSERT ON package_sale_details
WHEN EXISTS (SELECT 1 FROM sale_lines s JOIN report_channel_fact_seals f ON f.org_id=s.org_id AND f.report_id=s.report_id WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id)
BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;
CREATE TRIGGER IF NOT EXISTS digital_detail_sealed BEFORE INSERT ON digital_sale_details
WHEN EXISTS (SELECT 1 FROM sale_lines s JOIN report_channel_fact_seals f ON f.org_id=s.org_id AND f.report_id=s.report_id WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id)
BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;
CREATE TRIGGER IF NOT EXISTS package_observation_sealed BEFORE INSERT ON package_report_observations
WHEN EXISTS (SELECT 1 FROM report_channel_fact_seals f WHERE f.org_id=NEW.org_id AND f.report_id=NEW.report_id)
BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;
CREATE TRIGGER IF NOT EXISTS package_observation_product_sealed BEFORE INSERT ON package_observation_products
WHEN EXISTS (SELECT 1 FROM report_channel_fact_seals f WHERE f.org_id=NEW.org_id AND f.report_id=NEW.report_id)
BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;

CREATE TRIGGER IF NOT EXISTS theatrical_detail_scope BEFORE INSERT ON theatrical_sale_details BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id AND r.kind='theatrical'
  ) THEN RAISE(ABORT,'theatrical detail requires theatrical report sale') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM package_sale_details d WHERE d.org_id=NEW.org_id AND d.sale_id=NEW.sale_id)
    OR EXISTS (SELECT 1 FROM digital_sale_details d WHERE d.org_id=NEW.org_id AND d.sale_id=NEW.sale_id)
    THEN RAISE(ABORT,'sale already has another channel detail') END;
END;
CREATE TRIGGER IF NOT EXISTS package_detail_scope BEFORE INSERT ON package_sale_details BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id AND r.kind='package'
  ) THEN RAISE(ABORT,'package detail requires package report sale') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM theatrical_sale_details d WHERE d.org_id=NEW.org_id AND d.sale_id=NEW.sale_id)
    OR EXISTS (SELECT 1 FROM digital_sale_details d WHERE d.org_id=NEW.org_id AND d.sale_id=NEW.sale_id)
    THEN RAISE(ABORT,'sale already has another channel detail') END;
END;
CREATE TRIGGER IF NOT EXISTS digital_detail_scope BEFORE INSERT ON digital_sale_details BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id AND r.kind='digital'
  ) THEN RAISE(ABORT,'digital detail requires digital report sale') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM theatrical_sale_details d WHERE d.org_id=NEW.org_id AND d.sale_id=NEW.sale_id)
    OR EXISTS (SELECT 1 FROM package_sale_details d WHERE d.org_id=NEW.org_id AND d.sale_id=NEW.sale_id)
    THEN RAISE(ABORT,'sale already has another channel detail') END;
END;
CREATE TRIGGER IF NOT EXISTS package_observation_scope BEFORE INSERT ON package_report_observations BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM report_imports r WHERE r.org_id=NEW.org_id AND r.id=NEW.report_id AND r.kind='package')
    THEN RAISE(ABORT,'package observation requires package report') END;
END;
CREATE TRIGGER IF NOT EXISTS channel_sale_parent_locked BEFORE UPDATE OF org_id,report_id ON sale_lines
WHEN EXISTS (SELECT 1 FROM theatrical_sale_details d WHERE d.org_id=OLD.org_id AND d.sale_id=OLD.id)
  OR EXISTS (SELECT 1 FROM package_sale_details d WHERE d.org_id=OLD.org_id AND d.sale_id=OLD.id)
  OR EXISTS (SELECT 1 FROM digital_sale_details d WHERE d.org_id=OLD.org_id AND d.sale_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'channel detail parent is immutable'); END;
CREATE TRIGGER IF NOT EXISTS channel_report_kind_locked BEFORE UPDATE OF kind ON report_imports
WHEN EXISTS (SELECT 1 FROM package_report_observations o WHERE o.org_id=OLD.org_id AND o.report_id=OLD.id)
  OR EXISTS (SELECT 1 FROM sale_lines s JOIN theatrical_sale_details d ON d.org_id=s.org_id AND d.sale_id=s.id WHERE s.org_id=OLD.org_id AND s.report_id=OLD.id)
  OR EXISTS (SELECT 1 FROM sale_lines s JOIN package_sale_details d ON d.org_id=s.org_id AND d.sale_id=s.id WHERE s.org_id=OLD.org_id AND s.report_id=OLD.id)
  OR EXISTS (SELECT 1 FROM sale_lines s JOIN digital_sale_details d ON d.org_id=s.org_id AND d.sale_id=s.id WHERE s.org_id=OLD.org_id AND s.report_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'channel report kind is immutable'); END;

CREATE TRIGGER IF NOT EXISTS theatrical_detail_immutable_update BEFORE UPDATE ON theatrical_sale_details BEGIN SELECT RAISE(ABORT,'channel detail is immutable'); END;
CREATE TRIGGER IF NOT EXISTS theatrical_detail_immutable_delete BEFORE DELETE ON theatrical_sale_details BEGIN SELECT RAISE(ABORT,'channel detail is immutable'); END;
CREATE TRIGGER IF NOT EXISTS package_detail_immutable_update BEFORE UPDATE ON package_sale_details BEGIN SELECT RAISE(ABORT,'channel detail is immutable'); END;
CREATE TRIGGER IF NOT EXISTS package_detail_immutable_delete BEFORE DELETE ON package_sale_details BEGIN SELECT RAISE(ABORT,'channel detail is immutable'); END;
CREATE TRIGGER IF NOT EXISTS digital_detail_immutable_update BEFORE UPDATE ON digital_sale_details BEGIN SELECT RAISE(ABORT,'channel detail is immutable'); END;
CREATE TRIGGER IF NOT EXISTS digital_detail_immutable_delete BEFORE DELETE ON digital_sale_details BEGIN SELECT RAISE(ABORT,'channel detail is immutable'); END;
CREATE TRIGGER IF NOT EXISTS package_observation_immutable_update BEFORE UPDATE ON package_report_observations BEGIN SELECT RAISE(ABORT,'package observation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS package_observation_immutable_delete BEFORE DELETE ON package_report_observations BEGIN SELECT RAISE(ABORT,'package observation is immutable'); END;
