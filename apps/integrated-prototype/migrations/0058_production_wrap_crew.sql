-- 日々スケの矛盾の確かめと食事の数（会社ルートの plans/2026-10-31-call-sheet-check.md）。番号0058は調整役の指定。
-- キャストごとのバラし（解散）の時刻と、撮影日ごとのスタッフの数。既存の行は推定せず NULL のまま残す。
-- 書くのは制作の保存（PUT /api/production）だけ。撮影日の更新（PATCH /api/field/days）は crew_count に触れない。
ALTER TABLE production_calls ADD COLUMN wrap_time TEXT
  CHECK(wrap_time IS NULL OR call_time IS NULL OR wrap_time>call_time);
ALTER TABLE shooting_days ADD COLUMN crew_count INTEGER
  CHECK(crew_count IS NULL OR crew_count BETWEEN 0 AND 9999);
