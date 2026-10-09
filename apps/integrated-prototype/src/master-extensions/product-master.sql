-- 商品固有の仕様の版。products と product_works は変更しない。
CREATE TABLE IF NOT EXISTS product_master_profile_versions (
 org_id INTEGER NOT NULL, product_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 product_number TEXT,
 jan_code TEXT,
 product_type TEXT,
 media TEXT,
 release_on TEXT,
 sales_end_on TEXT,
 publisher_partner_id INTEGER,
 distributor_partner_id INTEGER,
 label TEXT,
 series TEXT,
 sales_class TEXT,
 disc_count INTEGER CHECK(disc_count>=0),
 disc_layer TEXT,
 case_color TEXT,
 pressing_company TEXT,
 audio TEXT,
 subtitles TEXT,
 video_quality TEXT,
 runtime_minutes INTEGER CHECK(runtime_minutes>=0),
 design TEXT,
 video_production_company TEXT,
 rights_holder TEXT,
 original_rights_holder TEXT,
 system_product_name TEXT,
 notes TEXT,
 other1 TEXT,
 other2 TEXT,
 price_yen INTEGER CHECK(price_yen BETWEEN 0 AND 1000000000000),
 price_tax_basis TEXT NOT NULL CHECK(price_tax_basis IN ('unknown','ex_tax','inc_tax')),
 price_status TEXT NOT NULL CHECK(price_status IN ('unknown','estimated','confirmed')),
 price_as_of TEXT, price_evidence TEXT,

 price_ex_tax_yen INTEGER CHECK(price_ex_tax_yen BETWEEN 0 AND 1000000000000),
 price_ex_tax_tax_basis TEXT NOT NULL CHECK(price_ex_tax_tax_basis IN ('unknown','ex_tax','inc_tax')) CHECK(price_ex_tax_tax_basis='ex_tax'),
 price_ex_tax_status TEXT NOT NULL CHECK(price_ex_tax_status IN ('unknown','estimated','confirmed')),
 price_ex_tax_as_of TEXT, price_ex_tax_evidence TEXT,

 price_inc_tax_yen INTEGER CHECK(price_inc_tax_yen BETWEEN 0 AND 1000000000000),
 price_inc_tax_tax_basis TEXT NOT NULL CHECK(price_inc_tax_tax_basis IN ('unknown','ex_tax','inc_tax')) CHECK(price_inc_tax_tax_basis='inc_tax'),
 price_inc_tax_status TEXT NOT NULL CHECK(price_inc_tax_status IN ('unknown','estimated','confirmed')),
 price_inc_tax_as_of TEXT, price_inc_tax_evidence TEXT,

 source_reference TEXT NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 1000),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,product_id,revision), FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),CHECK((price_yen IS NULL AND price_status='unknown') OR (price_yen IS NOT NULL AND price_status<>'unknown' AND price_as_of IS NOT NULL AND price_evidence IS NOT NULL AND length(trim(price_evidence))>0)),CHECK((price_ex_tax_yen IS NULL AND price_ex_tax_status='unknown') OR (price_ex_tax_yen IS NOT NULL AND price_ex_tax_status<>'unknown' AND price_ex_tax_as_of IS NOT NULL AND price_ex_tax_evidence IS NOT NULL AND length(trim(price_ex_tax_evidence))>0)),CHECK((price_inc_tax_yen IS NULL AND price_inc_tax_status='unknown') OR (price_inc_tax_yen IS NOT NULL AND price_inc_tax_status<>'unknown' AND price_inc_tax_as_of IS NOT NULL AND price_inc_tax_evidence IS NOT NULL AND length(trim(price_inc_tax_evidence))>0)),
 FOREIGN KEY(org_id,publisher_partner_id) REFERENCES partners(org_id,id), FOREIGN KEY(org_id,distributor_partner_id) REFERENCES partners(org_id,id),
 CHECK(jan_code IS NULL OR (length(jan_code) IN (8,13) AND jan_code NOT GLOB '*[^0-9]*')),
 CHECK(release_on IS NULL OR sales_end_on IS NULL OR release_on<=sales_end_on)
);
CREATE TRIGGER IF NOT EXISTS product_master_profile_versions_sequence BEFORE INSERT ON product_master_profile_versions
 WHEN NEW.revision<>(SELECT COALESCE(MAX(revision),0)+1 FROM product_master_profile_versions WHERE org_id=NEW.org_id AND product_id=NEW.product_id)
 BEGIN SELECT RAISE(ABORT,'stale master revision'); END;
CREATE TRIGGER IF NOT EXISTS product_master_profile_versions_no_update BEFORE UPDATE ON product_master_profile_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TRIGGER IF NOT EXISTS product_master_profile_versions_no_delete BEFORE DELETE ON product_master_profile_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
