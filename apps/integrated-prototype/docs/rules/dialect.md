---
paths:
  - "src/**"
  - "migrations/**"
  - "test/dialect-*"
title: SQL の方言（D1 と PostgreSQL の両方で動く書き方）
impact: HIGH（SQLite だけの書き方が増えるほど、PostgreSQL へ移す書き直しと照合が増え、切り替え（段3、期限 2026-12 末）と実データの受け入れが遅れる）
tags: database, sql, dialect, d1, postgresql, migration
---

# SQL の方言

SQL・移行・DB を呼ぶコードを書くときに読む。正本の DB は D1（SQLite）から PostgreSQL へ移す（brain の D-033。
計画は会社ルートの `plans/2026-10-01-postgres-migration.md`）。移すまでに新しく書く SQL は、D1 と PostgreSQL の両方で動く形にする。
守れる部分は `test/dialect-rules.test.mjs` が検査し、いまの借りは `test/dialect-debt.json` にある。

## 新しく書かない形と代わり

| 書かない（SQLite だけの形） | 代わり |
|---|---|
| `INSERT OR IGNORE` | `INSERT … ON CONFLICT (一意の列) DO NOTHING` |
| `INSERT OR REPLACE`・`REPLACE INTO`・列の `ON CONFLICT REPLACE` | `INSERT … ON CONFLICT (一意の列) DO UPDATE SET 列 = excluded.列` |
| `ON CONFLICT … DO UPDATE SET version=version+1`（右辺に表の名前の無い同じ列） | `DO UPDATE SET version=production_revisions.version+1`（表の名前つき。PostgreSQL は既にある行の列と `excluded` の列を区別できず `column reference "version" is ambiguous` で断る。SQLite も同じ値） |
| トリガーの中の表の別名 `old`・`new`（`FROM mg_ledger_entries old`） | ほかの別名（`prev` など）。PostgreSQL の関数では `OLD`・`NEW` の行と区別できない。いまある1か所（`src/mg.sql`・移行 0001 の `mg_ledger_successor_scope`）は、DDL の変換（`scripts/pg-ddl.mjs` の renameRowAliases）が `old_row` に言い換える |
| `run()` の `lastInsertRowid`・D1 の `meta.last_row_id`・`last_insert_rowid()` | `db.get('INSERT … RETURNING id', 値)` で行を受け取る |
| `sqlite_master`・`sqlite_schema`・`sqlite_sequence` | 表の有無で分岐しない。表は移行で作り、アプリは表がある前提で書く。表の定義を読む所（管理画面の ER 図・データ一覧の `src/admin/er-routes.mjs`）は、PostgreSQL の入口（`db.dialect === 'postgres'`）では `pg_catalog` から同じ形で読む（下の「表の定義の読み方」） |
| `GLOB`（日付・月・コードの形の CHECK） | 形と範囲の CHECK は DB に残し、両方の DB で動く形で書く（下の「形の CHECK」） |
| `typeof(…)` で値の型を確かめる | 列の型を合わせ、値の型はアプリの読み取りで確かめる |
| SQLite のエラー文の照合（`/UNIQUE constraint failed/`・`/constraint\|UNIQUE/i`・`includes('UNIQUE')`・`SQLITE_CONSTRAINT`） | 下の「エラーの見分け方」 |

- `ON CONFLICT` の列には、表の UNIQUE か一意の索引と同じ列を書く。PostgreSQL は `DO UPDATE` の列を省けない。`DO NOTHING` は両方の DB で列を省けるので、一意の制約が2つ以上あり、`INSERT OR IGNORE` がどの衝突も飛ばしていた所は列を書かない（`src/production.mjs` の撮影の役。`(key)` と `(name)` の2つ）
- `INSERT OR IGNORE` は一意の衝突のほかに NOT NULL・CHECK の違反も黙って飛ばすが、`ON CONFLICT … DO NOTHING` が飛ばすのは一意の衝突だけで、ほかの違反はエラーになる。置き換えたら、入れる行がほかの制約に反していないかを試験で確かめる
- `REPLACE` は行を消して入れ直す（ID が変わり、削除のトリガーが動く）。`DO UPDATE` に置き換えるときは、意味が変わらないかを確かめる
- `ON CONFLICT … DO NOTHING RETURNING id` は、衝突したときに行を返さない。既にある行の ID が要るなら、続けて一意の列で読む
- 新しい行の ID は `db.get('INSERT … RETURNING id', 値)` で受け取る。入口の `run` は変わった行の数（`{changes}`）だけを返し、`lastInsertRowid` は返さない（2026-10-03 に入口の3つから外し、呼ぶ所22か所を RETURNING に置き換えた）。
  RETURNING は node:sqlite（LocalDatabase）と PostgreSQL の入口の試験（`test/pg-db.test.mjs`）で確かめた。D1 での確かめは、この PC で wrangler dev が動かないので LocalDatabase で代えた（記録 `docs/platform/operations/records/2026-10-03-pg-adapter.md`。D1 は SQLite 3.35 以降の RETURNING を受け付ける。一般知識）
- batch の中の `INSERT … RETURNING id` の行は、結果の `rows` で受け取れる（`out[0].rows[0].id`。3つの入口とも同じ形。D1 は結果の results）。同じ batch のあとの文で ID を使うときは、一意の列で引く（`(SELECT id FROM t WHERE org_id=? AND code=?)`）
- 書き込みの文の値（SET・VALUES・SELECT の並び）に、小数になる式（小数の定数 `1000.5`・`* 1.1`、`avg(`・`total(`、`CAST(… AS REAL)` など）を書かない。PostgreSQL は bigint の列へ黙って丸めて入れるので、PostgreSQL の入口はこれらを止める（値は整数のパラメータで渡す。パラメータの小数は bigint の列が断る）。WHERE などの条件の中の小数は止めない
- 読み取りでも小数になる式（`avg(`・`total(`・`* 1.0`・`/ 4.0`）を書かない。SQLite は倍精度の Number、PostgreSQL は numeric（入口は Decimal の文字列）を返し、DB によって型が分かれる（要件の要確認9）。計算はアプリの整数（円・bps）で行う（`money.md`）。`avg(`・`total(`・`AS REAL` は money.md の検査（`test/money-rules.test.mjs` の sqlFloat）が数える。`CAST(… AS REAL)` は、PostgreSQL の入口が double precision に読み替える（PostgreSQL の REAL は float4）
- 読み取りの一括（`readBatch`）には SELECT・WITH・VALUES の文だけを渡す。3つの入口とも書き込みの文を `read_only` で断る（SQLite・D1 は読み取りのトランザクションでも書き込みを通すため）
- 整数の強制（`money.md` の `typeof(列)='integer'`）は例外で、検査も数えない。SQLite の INTEGER の列は小数を黙って保存するので、PostgreSQL の BIGINT の型に置き換えるまで要る

## SQLite の関数を PostgreSQL の入口が読み替えるもの

次の形は、アプリの SQL に SQLite の形のまま書いてよい。PostgreSQL の入口（`src/data-platform/pg-db.mjs`）が、文字列・識別子・コメントの外にあるものだけを、
同じ値を返す補助の関数（`pg/schema.sql` の先頭の `lite_*`）へ読み替えて送る。対応は DDL の変換（`scripts/pg-ddl.mjs`）と同じ表
`src/data-platform/lite-sql.mjs` の1か所にある。D1・LocalDatabase には SQL をそのまま送るので、D1 での結果は変わらない。

| 書く形（SQLite） | PostgreSQL へ送る形 |
|---|---|
| `json_extract(x, '$.a')`・`json_each(x)`・`json_each(x, '$.a')`・`json_valid`・`json_type`・`json_array_length` | `lite_json_extract` など（`json_each(x)` は `lite_json_each(x, '$')`） |
| `CAST(x AS INTEGER)`・`CAST(x AS INT)` | `lite_cast_int(x)`（64ビット。文字は先頭の整数だけを読み、読めなければ 0、小数は 0 の方へ切り捨てる。SQLite と同じ） |
| `CURRENT_TIMESTAMP` | `'YYYY-MM-DD HH:MM:SS'`（UTC）の文字を作る式。PostgreSQL の CURRENT_TIMESTAMP を文字の列へ入れると、マイクロ秒と時差（`+00`）が付く |
| `x IS ?`・`x IS NOT ?`（NULL どうしを等しいとみる比べ方） | `x IS NOT DISTINCT FROM ?`・`x IS DISTINCT FROM ?`。PostgreSQL の IS は NULL・TRUE・FALSE・UNKNOWN・DISTINCT の語だけを受ける。DDL の変換と同じ規則（`lite-sql.mjs` の isComparison） |
| `? IS NULL`・`? IS NOT NULL`（値が無ければ絞らない、の形） | `CAST(? AS text) IS NULL`。PostgreSQL は値の置き場所の型を決められず `could not determine data type of parameter` で断る。NULL かどうかは型によらない |
| 別名の大文字（`EXISTS(…) isSuperseded`・`COUNT(*) AS N`） | 返す行の名前を SQL に書いたとおりに戻す（PostgreSQL は引用符の無い名前を小文字にして返す）。SQL の本文に大文字を含む書き方が1通りだけの名前に限る（同じ名前を小文字でも書いた文は小文字のまま。表と列の名前は小文字だけ） |

読み替えでは埋まらない違いがあるので、次のように書く（2026-10-03、香盤表 #11 の PR3。試験は `test/pg-src-dialect.test.mjs`）。

- `json_extract` の値と `json_each` の `value`・`key` は、PostgreSQL ではいつも text になる（SQLite は JSON の数を整数・小数で返す）。
  数の列と比べる・足す・`CASE` で数の列とまぜる・`IN (SELECT …)` で比べるときは、`CAST(json_extract(…) AS INTEGER)`・`CAST(value AS INTEGER)` と書く。
  JSON の値が整数なら、SQLite では CAST しても値は変わらない（アプリが作った JSON の取込の形はどれもこれ）
- `INSERT INTO 表(列…) SELECT …` の値が**そのまま** `json_extract(…)` のときは、入口が入れる先の列の型へ CAST する（SQLite が列の型へ直すのと同じ）。
  `json_extract(…)+1` のような式の中は CAST しないので、アプリの SQL で `CAST(json_extract(…) AS INTEGER)+1` と書く。
  整数の列へ小数（`1.5`）を入れる行は、SQLite は typeof の CHECK、PostgreSQL は bigint への CAST が断り、どちらも `check` の誤りになる
- `json_each` の配列の `key` は PostgreSQL では文字（`'10'` が `'2'` より前）。並べるときは `ORDER BY CAST(key AS INTEGER)` と書く
- `JOIN` には必ず `ON` を書く（`json_each` も。条件が無ければ `JOIN json_each(p.payload_json) j ON 1=1`）。SQLite は ON の無い JOIN を通すが、PostgreSQL は構文の誤り（`syntax error at or near "WHERE"`）で断る。`ON 1=1` は SQLite でも同じ行を返す
- `json_each` はオブジェクトのキーを文書の順に返し、スカラー（JSON の null を含む）は key が NULL の1行を返す（SQLite と同じ。補助の関数は jsonb でなく json で読む）
- 入れ子の値（配列・オブジェクト）を文字で受け取ると、PostgreSQL は元の JSON の文字のまま、SQLite は空白を除いた文字を返す。アプリが `JSON.stringify` で作った JSON なら同じ文字になる
- 残る違い（アプリの SQL は使っていない）: 読めない JSON（SQLite は誤り、PostgreSQL は NULL）、同じキーが2つある JSON の `json_extract`、引用つきの道筋（`'$."a.b"'`）、
  桁の大きい数・指数の書式（`1e3`）
- `json_extract` の値を SELECT でそのまま読んでアプリが数として使う形は書かない（PostgreSQL では文字で返る）。読むなら CAST するか、列ごと読んで `JSON.parse` する

`x IS ?` は D1 へもそのまま送る（アプリの SQL を `IS NOT DISTINCT FROM` に書き換えていない）。SQLite は 3.39 から `IS NOT DISTINCT FROM` を読む（一般知識。node:sqlite の 3.51.2 では確かめた）が、
D1 の SQLite の版をこの PC から確かめられない（wrangler dev が動かない・remote の D1 に触れない）ので、D1 へ送る SQL を変えない入口の読み替えにした（2026-10-03、香盤表 #11 の PR4）。

## 表の定義の読み方（管理画面の ER 図・データ一覧）

`src/admin/er-routes.mjs` の readTableSchema は、D1・LocalDatabase では `sqlite_master` と `pragma_table_info`・`pragma_foreign_key_list`（使えなければ表ごとの PRAGMA）、
PostgreSQL の入口では `pg_catalog`（pg_class・pg_attribute・pg_attrdef・pg_constraint）から、同じ項目名（列は cid・name・type・notnull・dflt_value・pk、
外部キーは id・seq・table・from・to・on_update・on_delete・match）で返す。PostgreSQL では次のとおり SQLite の書き方にそろえる（試験は `test/admin-er-model.test.mjs`）。

- type は DDL の変換の逆（bigint → INTEGER、text → TEXT、double precision → REAL、numeric → 空、bytea → BLOB）。画面の「整数」「文字」の表示を変えない
- dflt_value は `'draft'::text` を `'draft'` に、変換した時刻の式を `CURRENT_TIMESTAMP` に戻す
- 外部キーの id は SQLite と同じく表の中で宣言の逆の順（最後の外部キーが 0）。DDL の変換が宣言の順に足すので、制約の順で決まる
- 違ってよいのは主キーの列の notnull だけ。PostgreSQL は主キーの列を必ず NOT NULL にするので 1 を返す（SQLite は宣言どおりで、158列が 0）
- definitionSource は `pg-catalog`

## 形の CHECK（GLOB の代わり）

画面を通らない書き込み（一括取込・スクリプト）でも破れてはいけない形と範囲は、GLOB を外しても DB の CHECK で守る（`database.md` の「DB が守るもの」）。
アプリの読み取りへ移さない。

- 文字の種類は `ltrim(部分, '許す文字') = ''` で見る。`ltrim` は SQLite にも PostgreSQL にもあり、照合順に依らない
- 範囲は、数字だけと確かめた同じ桁数の部分に `BETWEEN` を使う（月なら `substr(m,6,2) BETWEEN '01' AND '12'`）
- 1文字の `BETWEEN '0' AND '9'`・`BETWEEN 'A' AND 'Z'` で文字の種類を見ない。PostgreSQL の照合順（ICU など）では全角数字や小文字も間に入り、SQLite と結果が変わる（2026-10-03 に PostgreSQL 17 の en-US の ICU の照合で、全角の数字の `'２０２６-01'` と小文字の `'b'` が通るのを確かめた）
- PostgreSQL へ移すときは、段1の変換で日付・月の列を型（`date` など）に置き換える。それまでは下の形で書く

```sql
-- 月（YYYY-MM）。'2026-13'・'2026-00'・'20a6-1x'・全角の数字を、SQLite でも PostgreSQL でも止める
CHECK(length(m) = 7 AND substr(m,5,1) = '-'
  AND ltrim(substr(m,1,4) || substr(m,6,2), '0123456789') = ''
  AND substr(m,6,2) BETWEEN '01' AND '12')
-- コード（英大文字1字＋数字3桁。例: H001）。小文字・全角・桁の違いを止める
CHECK(length(c) = 4 AND ltrim(substr(c,1,1), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') = ''
  AND ltrim(substr(c,2), '0123456789') = '')
```

## エラーの見分け方

SQLite のエラーの文（`UNIQUE constraint failed: 表.列`）は、PostgreSQL では別の文になる（`duplicate key value violates unique constraint`）。
新しいコードは、SQLite が出す文で分岐しない。

入口（`src/db.mjs`・`src/d1-db.mjs`・`src/data-platform/pg-db.mjs`）は、投げるエラーに共通のエラーの種類（`error.dbError`）を付ける。
種類は `src/data-platform/db-errors.mjs` が、SQLite の文（node:sqlite は拡張の結果コードも）と PostgreSQL の SQLSTATE から決める。エラーの文は変えない。

| 種類 | SQLite | PostgreSQL |
|---|---|---|
| `unique`（一意の違反） | `UNIQUE constraint failed`（主キーを含む） | 23505 |
| `check`（値の範囲の違反） | `CHECK constraint failed` | 23514。書き込みの文での読めない値（整数の列への小数。22P02）と範囲外（22003）も |
| `foreign_key`（参照先が無い） | `FOREIGN KEY constraint failed` | 23503 |
| `not_null`（必須の値が無い） | `NOT NULL constraint failed` | 23502 |
| `raise`（トリガーの拒否） | `RAISE(ABORT, '文')`（文は同じ） | P0001（文は同じ） |
| `out_of_range`（安全な整数を超えた） | node:sqlite が読み取りで止める | 入口が読み取りで止める |
| `invalid_input`（型に読めない値） | （SQLite は型を強制しないので起きない） | 読み取りの文での 22P02・22003（`WHERE id = 'abc'` など）。制約の違反にしない |
| `read_only`（読み取りの一括の中の書き込み） | 入口が文で断る。結果コード 8（query_only） | 入口が文で断る。25006 |
| `unsupported_type`（SQLite に無い型） | — | 配列の型（`int8[]` など）を入口が止める |

| 見分けたいこと | 書き方 |
|---|---|
| 衝突として 409 にするか（受け口の状態の番号） | `isDbConflict(error)`（制約の違反とトリガーの拒否）。置き換える前の照合 `/constraint/i` は、D1 がトリガーの拒否の文の後ろに付ける `: SQLITE_CONSTRAINT` に当たり、本番で 409 を返していたので、それを保つ |
| 制約の違反か | `isConstraintViolation(error)`（unique・check・foreign_key・not_null。トリガーの拒否は含めない） |
| 一意の衝突（同じコード・再送） | `isUniqueViolation(error, '表')`。新しく書くなら `INSERT … ON CONFLICT (列) DO NOTHING RETURNING id` で、行が返らなければ衝突 |
| 業務の約束の違反（確定済みの書き換えなど） | トリガーの `RAISE(ABORT, '文')` にアプリが決めた文を書き、その文で見分ける（PostgreSQL へは同じ文で移す） |
| 参照先が無い（外部キー） | 書く前に `org_id` で絞って参照先を読む（組織の境界の確かめと同じ読み取り）。後から見分けるなら `dbErrorKind(error) === 'foreign_key'` |
| 同時更新の止め（`transaction_guards`）の失敗 | `isGuardViolation(error)` |
| 画面での言い換え | 受け口は `bad(c, 文, 状態, details, error)` で応答に `dbError`（種類・表・列）を載せる。catch でエラーを受けて bad を返すときも、エラーを5番目の引数に渡す（渡さないと言い換えが黙って消える。`test/db-error-api.test.mjs`）。画面は `apiDbError(error)` の種類で分岐する（`MgLedger.jsx`・`rights/rights-ui-model.mjs` の translateError・problemText） |

SQLite の文を読むのは `db-errors.mjs` の2つの正規表現と1つの照合だけ（方言の借りの3）。ほかのファイルで SQLite・PostgreSQL のエラーの文を照合しない。

## 試験で DB の状態を確かめる

試験は SQLite と PostgreSQL の両方で流す（`test/test-db.mjs`・`test/pg-matrix.json`）。試験の中でも SQLite だけの形を書かず、次の道具と書き方を使う（2026-10-03、香盤表 #11 の PR4）。

| 確かめること | 書かない（SQLite だけ） | 書く |
|---|---|---|
| 外部キーの違反の行が無い | `db.all('PRAGMA foreign_key_check')` | `await foreignKeyViolations(db)`（PostgreSQL も、行のある子の表のすべての外部キーで表を読んで数える。強制を外していた間（止めたトリガー・session_replication_role・NOT VALID）に入った違反の行は、強制を戻すと強制にもカタログにも見えなくなるので、強制が効いているかをカタログで確かめるだけでは見落とす） |
| 読み取りが書き込まない | `db.get('SELECT total_changes() n')` | `await writeMark(db)` を前後で比べる（PostgreSQL は全部の表の行の `(ctid, xmin)` と順番の値の指紋。統計の `pg_stat_*` は遅れて数えるので使わない） |
| 制約の違反で断られる | `assert.rejects(…, /FOREIGN KEY/)` | `assert.rejects(…, (e) => e.dbError?.kind === 'foreign_key')` |
| 一意の衝突を飛ばして入れる | `INSERT OR IGNORE` | `INSERT … ON CONFLICT DO NOTHING` |
| 型なしの列（`sale_attribute_values.value_number`）の値 | `assert.equal(row.value_number, 9919)` | `assert.equal(Number(row.value_number), 9919)`（PostgreSQL は Decimal の文字列で返す。アプリの読み取りは `sales-sheet-routes.mjs` の attributeNumber で Number にそろえる） |

## 検査が数えるもの

- `src/` の `.mjs`・`.jsx`・`.js`・`.sql` と、`migrations/` の `.sql` を、形ごと・ファイルごとに数える。新しいファイル（次の番号の移行を含む）は借りが0なので、1つ書けば落ちる
- SQL の形は、`.sql` ではコメントと文字の中身を除いた本文で、JS では文字列とテンプレートの中（`${…}` の中を含む）で数える。JS のコメントと JS の `typeof x` は数えない
- エラー文の照合は、SQLite の制約の語（`constraint` と、大文字で書いた `UNIQUE`・`CHECK`・`FOREIGN KEY`・`NOT NULL`・`PRIMARY KEY`）を含む正規表現リテラルと、`includes`・`test`・`match` などに渡す文字列、SQLite の決まり文句（`constraint failed`・`SQLITE_`）を含む文字列を1つずつ数える。制約の名前は SQLite が大文字で出すので、`startsWith('/check')`・`/check/i`・`includes('unique')` のような小文字の照合は数えない
- `ON CONFLICT … DO UPDATE SET` の代入の右辺に、表の名前の無い同じ列があるもの（`version=version+1`）を、代入ごとに数える（upsertBare。2026-10-03 に2か所を直して0）
- ほかの方言（`json_extract`・`json_each`・`date()`・`PRAGMA`・`IS` での比べ方・ORDER BY の NULL の並び）は数えない。段1でまとめて直す（計画の「調べて分かったこと」）。
  `json_extract`・`json_each`・`CAST(… AS INTEGER)`・`CURRENT_TIMESTAMP`・`x IS ?`・`? IS NULL` は、2026-10-03 から PostgreSQL の入口が読み替える（上の「SQLite の関数を PostgreSQL の入口が読み替えるもの」）

## 借りの扱い

- 直して数が減ったら `node test/dialect-rules.test.mjs --write` で一覧を作り直す（減らし忘れも落ちる）
- 一覧に足さない。別のファイルへ動かしただけ（共通の関数へ寄せるなど）なら `--write` で作り直し、PR の本文に形ごとの合計が増えていないことを書く
- 生成したファイル（`scripts/` の生成器が書く `src/*.sql`）の借りが、元のデータを足しただけで増えたら、`--write` で足さずに生成器を両方の DB で動く形に直す（流通マスタの生成器 `scripts/build-distribution-master.mjs` は `ON CONFLICT(code) DO NOTHING` で書く）
- main に入った移行の数は変わらない（書き換えない。`database.md`）。PostgreSQL 用の DDL は段1の変換で作る
- この検査は、D1 を外したら（段4）役目を終える

## いまの借り（2026-10-03。一覧は `test/dialect-debt.json`）

| 形 | 数 | 主な所 |
|---|---|---|
| GLOB | 204（27ファイル） | 日付・月・コードの形の CHECK。`migrations/` に102、`src/*.sql` に102 |
| typeof | 4 | 売上の追加の項目の `typeof(value_number) IN ('integer','real')`（`src/sales-sheet/sales-sheet.sql` と移行 0004） |
| INSERT OR | 20 | 初期データ（`src/schema.sql` に12。認識の基準と試作用の組織・利用者など）と、流通 ID の追加（`src/sales-ops/distribution-additions.sql` に2）・移行 0004 に3。アプリの `.mjs` の3か所（分析の更新の状態・作品の契約・撮影の役）は 2026-10-03 に `ON CONFLICT … DO NOTHING` へ置き換えた（撮影の役は一意の制約が2つあるので、列を書かない `ON CONFLICT DO NOTHING`） |
| ON CONFLICT の右辺の表の名前の無い列 | 0 | 2026-10-03 に2か所（`production.mjs` の版・`app.mjs` の AI の利用回数）を表の名前つきにした（香盤表 #11 の PR4） |
| lastInsertRowid | 0 | 2026-10-03 に22（9ファイル）から0にした（入口から外し、受け口を RETURNING に置き換えた。PG 計画 香盤表 #8） |
| sqlite_master | 10 | ローカルの DB の作り直し（`local-migrations.mjs` など）と、管理画面の ER 図の SQLite の道（`admin/er-routes.mjs`。PostgreSQL では pg_catalog を読む） |
| エラー文の照合 | 3（1ファイル） | 共通のエラーの種類の部品 `src/data-platform/db-errors.mjs` が SQLite の文を読む所だけ。2026-10-03 に47（23ファイル）の受け口・画面の照合を、この部品の種類での分岐に置き換えた（香盤表 #8） |

計画の「調べて分かったこと」と数が違う所: エラー文の照合は計画の「9ファイル」ではなく47か所・23ファイル（2026-10-03 に全件を出して確かめた。どれも SQLite の制約の文を見る正規表現リテラルで、段1のアダプタで置き換える範囲）。
lastInsertRowid は計画の20か所に D1 の `meta.last_row_id` の2か所（`d1-db.mjs`）を足した22。GLOB の204は、計画の DDL の102（`migrations/`）に `src/*.sql` の102を足した数。
