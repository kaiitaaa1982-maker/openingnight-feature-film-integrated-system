-- 予算書の読み取りの定義の初期値を、既存の全組織に入れる（会社ルートの plans/2026-11-12-ingest-definitions.md の論点6。要件 FR-PLAN-BUDGET-040）。
-- 移行 0066 の表に、コードに直書きしていた2つの書式（「科目・金額(税抜)」の区画・Code・Detail・Description）を、同じ中身の定義2件として入れる。
-- 定義ごとに版1（source='seed'）と、初期値の承認（source='seed'・action='approve'。人の承認と区別する）を1行ずつ入れる。番号 0067 は仮（調整役が決める）。
-- 定義の JSON と指紋（SHA-256）は src/planning/budget/budget-read-seeds.mjs と同じ。食い違わないことを test/budget-read-definitions.test.mjs が確かめる。
-- 何度当てても同じ（同じ名前の定義・版・判定がある組織には入れない）。この移行のあとに作った組織には、受け口が初めて予算書を読むときに同じ種を入れる。
-- 手元の SQLite（src/db.mjs の LocalDatabase）には当てない（試作の組織は受け口が種から入れる。手元と PostgreSQL の試験の土台の行をそろえるため）。

-- 科目・金額(税抜)の区画
INSERT INTO budget_read_profiles(org_id,name,source)
 SELECT o.id,'科目・金額(税抜)の区画','seed' FROM organizations o
 WHERE NOT EXISTS(SELECT 1 FROM budget_read_profiles p WHERE p.org_id=o.id AND p.name='科目・金額(税抜)の区画')
 ORDER BY o.id;
INSERT INTO budget_read_versions(org_id,profile_id,version_no,definition_json,definition_hash,source,reason)
 SELECT p.org_id,p.id,1,'{"kind":"budget","name":"科目・金額(税抜)の区画","read":{"layout":"category_blocks","subtotal":"marker_row","category":"letter_prefix_then_order"},"header":{"roles":{"name":["科目","費目"],"unitPrice":["単価"],"qty":["数量"],"unit":["単位"],"amount":["金額(税抜)","金額","税抜"],"amountIncTax":["金額(税込)"],"actual":["実費"]}},"subtotalMarkers":["小計"],"totals":[{"to":"direct","equals":["直接制作費","直接制作費合計","直接制作費小計","直接制作費計"]},{"to":"managementFee","equals":["制作管理費"]},{"to":"contingency","equals":["予備費"]},{"to":"total","equals":["総合計","総合計税抜","総合計税抜き"]},{"to":"subtotalWithFee","equals":["小計"]}],"summary":[{"to":"estimate","equals":["制作費見積","制作費見積り","制作費見積税抜","制作費見積税抜き","制作費見積り税抜","制作費見積り税抜き"]},{"to":"tax","prefix":["消費税"]},{"to":"totalIncTax","equals":["合計金額","合計金額税込"]}],"headerFields":[{"to":"createdOn","equals":["作成日"]}],"notes":{"contains":["準備期間","撮影日数","完成","人数","スタッフ数"]},"ignore":[{"to":"cast_table","contains":["役名","役者名","所属"]}],"confirmedFills":["FFFF00"],"breakdown":{"amountHeader":{"contains":["金額","合計"]},"label":{"contains":["役名","名目","氏名","項目","内容"]},"qty":{"prefix":["数量","日数","人数"]},"unitPrice":{"prefix":["単価","日額"]}}}',
  'fef211950904aa48adc9c256d74db91d6b4f69046778e96851411d315a279900','seed','初期値: コードに直書きしていた「科目・金額(税抜)」の区画の書式を写した'
 FROM budget_read_profiles p
 WHERE p.name='科目・金額(税抜)の区画' AND p.source='seed' AND NOT EXISTS(SELECT 1 FROM budget_read_versions v WHERE v.org_id=p.org_id AND v.profile_id=p.id)
 ORDER BY p.org_id;
INSERT INTO budget_read_approvals(org_id,version_id,seq,action,source,reason)
 SELECT v.org_id,v.id,1,'approve','seed','初期値: コードに直書きしていた書式を写したもの（人の承認ではない）'
 FROM budget_read_versions v JOIN budget_read_profiles p ON p.org_id=v.org_id AND p.id=v.profile_id
 WHERE p.name='科目・金額(税抜)の区画' AND v.version_no=1 AND v.source='seed' AND NOT EXISTS(SELECT 1 FROM budget_read_approvals a WHERE a.org_id=v.org_id AND a.version_id=v.id)
 ORDER BY v.org_id;

-- Code・Detail・Description
INSERT INTO budget_read_profiles(org_id,name,source)
 SELECT o.id,'Code・Detail・Description','seed' FROM organizations o
 WHERE NOT EXISTS(SELECT 1 FROM budget_read_profiles p WHERE p.org_id=o.id AND p.name='Code・Detail・Description')
 ORDER BY o.id;
INSERT INTO budget_read_versions(org_id,profile_id,version_no,definition_json,definition_hash,source,reason)
 SELECT p.org_id,p.id,1,'{"kind":"budget","name":"Code・Detail・Description","read":{"layout":"code_detail","subtotal":"sum_range_of_amount_column","category":"words_then_line_majority"},"header":{"roles":{"code":["code"],"name":["detail"],"description":["description"],"qty":["数","数量"],"unitPrice":["単価"],"unit":["単位"],"amount":["合計(税抜)","金額(税抜)","金額"]}},"grandTotal":{"contains":["grand total","総合計"]},"categories":[{"to":"managementFee","words":["制作管理","production fee"]},{"to":"contingency","words":["予備費","contingency"]},{"to":"A","words":["企画","development"]},{"to":"B","words":["キャスト","俳優","出演","talent","cast"]},{"to":"C","words":["プロデューサー","producer","producers"]},{"to":"D","words":["監督","スタッフ","director","directors","staff","crew"]},{"to":"E","words":["準備","ロケハン","リハーサル","pre-production","preproduction"]},{"to":"F","words":["機材","equipment"]},{"to":"G","words":["美術","装飾","衣裳","衣装","ヘアメイク","メイク","wardrobe","set construction"]},{"to":"H","words":["ロケ","車両","location","locations","transportation"]},{"to":"I","words":["音楽","効果","音響","劇伴","楽曲","選曲","sound","music"]},{"to":"J","words":["編集","タイトル","テロップ","データ","メディア","グレーディング","vfx","cg","dit","editing","grading"]},{"to":"K","words":["保険","宣伝","ポスター","スチール","雑費","expense","expenses","insurance","publicity"]}],"summary":[{"to":"estimate","equals":["制作費見積","制作費見積り","制作費見積税抜","制作費見積税抜き","制作費見積り税抜","制作費見積り税抜き"]},{"to":"tax","prefix":["消費税"]},{"to":"totalIncTax","equals":["合計金額","合計金額税込"]}],"headerFields":[{"to":"createdOn","equals":["作成日"]}],"notes":{"contains":["準備期間","撮影日数","完成","人数","スタッフ数"]},"confirmedFills":["FFFF00"]}',
  'ff6f91e74bdf85d3f2c351d70dfda16c18ca42d5dead4fc521bfed7cc492a273','seed','初期値: コードに直書きしていた Code・Detail・Description の書式を写した'
 FROM budget_read_profiles p
 WHERE p.name='Code・Detail・Description' AND p.source='seed' AND NOT EXISTS(SELECT 1 FROM budget_read_versions v WHERE v.org_id=p.org_id AND v.profile_id=p.id)
 ORDER BY p.org_id;
INSERT INTO budget_read_approvals(org_id,version_id,seq,action,source,reason)
 SELECT v.org_id,v.id,1,'approve','seed','初期値: コードに直書きしていた書式を写したもの（人の承認ではない）'
 FROM budget_read_versions v JOIN budget_read_profiles p ON p.org_id=v.org_id AND p.id=v.profile_id
 WHERE p.name='Code・Detail・Description' AND v.version_no=1 AND v.source='seed' AND NOT EXISTS(SELECT 1 FROM budget_read_approvals a WHERE a.org_id=v.org_id AND a.version_id=v.id)
 ORDER BY v.org_id;
