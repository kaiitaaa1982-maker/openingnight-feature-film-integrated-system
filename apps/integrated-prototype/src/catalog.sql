CREATE TABLE IF NOT EXISTS catalog_profiles (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 synopsis_long TEXT, synopsis_short TEXT, catch_long TEXT, catch_short TEXT,
 production_year INTEGER CHECK(production_year BETWEEN 1880 AND 2200), creation_year INTEGER CHECK(creation_year BETWEEN 1880 AND 2200),
 source_reference TEXT NOT NULL CHECK(length(trim(source_reference))>0), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,work_id,revision), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS catalog_credits (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL, position INTEGER NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('director','writer','cast','staff')), name TEXT NOT NULL CHECK(length(trim(name))>0), detail TEXT,
 PRIMARY KEY(org_id,work_id,revision,position), FOREIGN KEY(org_id,work_id,revision) REFERENCES catalog_profiles(org_id,work_id,revision)
);
CREATE TABLE IF NOT EXISTS catalog_editions (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL, edition_key TEXT NOT NULL, name TEXT NOT NULL CHECK(length(trim(name))>0),
 runtime_seconds INTEGER CHECK(runtime_seconds>0 AND runtime_seconds<360000), aspect_ratio TEXT, rating_authority TEXT, rating_code TEXT,
 PRIMARY KEY(org_id,work_id,revision,edition_key), FOREIGN KEY(org_id,work_id,revision) REFERENCES catalog_profiles(org_id,work_id,revision)
);
CREATE TABLE IF NOT EXISTS catalog_edition_tags (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL, edition_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('country','language','music_society')), value TEXT NOT NULL CHECK(length(trim(value))>0),
 PRIMARY KEY(org_id,work_id,revision,edition_key,kind,value), FOREIGN KEY(org_id,work_id,revision,edition_key) REFERENCES catalog_editions(org_id,work_id,revision,edition_key)
);
CREATE TABLE IF NOT EXISTS catalog_product_editions (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL, product_id INTEGER NOT NULL, edition_key TEXT NOT NULL,
 PRIMARY KEY(org_id,work_id,revision,product_id), FOREIGN KEY(org_id,product_id,work_id) REFERENCES product_works(org_id,product_id,work_id),
 FOREIGN KEY(org_id,work_id,revision,edition_key) REFERENCES catalog_editions(org_id,work_id,revision,edition_key)
);
CREATE TABLE IF NOT EXISTS catalog_product_windows (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
 distribution_code TEXT NOT NULL REFERENCES distribution_types(code), territory TEXT NOT NULL CHECK(length(trim(territory))>0), window_key TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), release_on TEXT, sales_end_on TEXT, terms_text TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','confirmed','withdrawn')), source_reference TEXT NOT NULL CHECK(length(trim(source_reference))>0),
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,work_id,product_id,distribution_code,territory,window_key,revision),
 FOREIGN KEY(org_id,product_id,work_id) REFERENCES product_works(org_id,product_id,work_id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(sales_end_on IS NULL OR release_on IS NULL OR sales_end_on>=release_on),
 CHECK(status<>'confirmed' OR (release_on IS NOT NULL AND sales_end_on IS NOT NULL AND length(trim(terms_text))>0))
);
CREATE TRIGGER IF NOT EXISTS catalog_profiles_immutable_update BEFORE UPDATE ON catalog_profiles BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_profiles_immutable_delete BEFORE DELETE ON catalog_profiles BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_credits_immutable_update BEFORE UPDATE ON catalog_credits BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_credits_immutable_delete BEFORE DELETE ON catalog_credits BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_editions_immutable_update BEFORE UPDATE ON catalog_editions BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_editions_immutable_delete BEFORE DELETE ON catalog_editions BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_edition_tags_immutable_update BEFORE UPDATE ON catalog_edition_tags BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_edition_tags_immutable_delete BEFORE DELETE ON catalog_edition_tags BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_product_editions_immutable_update BEFORE UPDATE ON catalog_product_editions BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_product_editions_immutable_delete BEFORE DELETE ON catalog_product_editions BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_product_windows_immutable_update BEFORE UPDATE ON catalog_product_windows BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_product_windows_immutable_delete BEFORE DELETE ON catalog_product_windows BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;
