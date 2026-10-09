-- 流通マスタに後から足した流通ID。元の流通マスタ（fixtures/distribution-master.csv、distribution-master.sql）は書き換えず、
-- 足した理由と日付を notes と source_sha256 に残す。source_row は元の CSV の行ではないので 0。
-- 2026-09-25 代表の判断: PVOD は TVOD とは別の流通IDとして持つ（配信・RS・PVOD）。
INSERT OR IGNORE INTO distribution_types(code,family,label,utilization,sort_order) VALUES('D007','unverified','D007',NULL,139);
INSERT OR IGNORE INTO distribution_master VALUES('D007','配信','RS','PVOD','2026-09-25 代表の判断で追加（元の流通マスタには無い）','added-2026-09-25',0);
INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM distribution_master WHERE code='D007' AND distribution_name='配信' AND transaction_method='RS' AND sales_type='PVOD');
