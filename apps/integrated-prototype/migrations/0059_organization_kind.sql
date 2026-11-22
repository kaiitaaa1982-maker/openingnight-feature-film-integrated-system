-- 組織の本番・デモの印（会社ルートの plans/2026-11-06-real-demo-split.md の手順2）。番号0059は依頼で指定された番号。
-- real は本番の組織、demo は丸ごと消してよい組織。既存の行は全部 demo になる。本番の組織は1つずつ明示して real にする
-- （既定を demo にするのは、印を付け忘れた組織が本番として守られてしまうのを防ぐため）。
-- デモの seed（scripts/seed-sales-demo.mjs・seed-all-demo.mjs）と消す道具（scripts/purge-demo-org.mjs）は、real の組織を指すと何も書かずに止まる。
ALTER TABLE organizations ADD COLUMN kind TEXT NOT NULL DEFAULT 'demo' CHECK(kind IN ('real','demo'));
