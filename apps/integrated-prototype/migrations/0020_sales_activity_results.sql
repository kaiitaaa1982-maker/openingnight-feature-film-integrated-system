-- 2026-10-15代表裁定。既存の営業活動の結果は推定せずNULLで残す。
-- 活動は追記のみ。結果を記録した行だけを活動記録へ取り込む。
ALTER TABLE sales_activities ADD COLUMN result TEXT
  CHECK(result IS NULL OR result IN ('advanced','on_hold','lost'));
