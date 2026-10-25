---
title: 並行する業務の PR（移行の番号・共通のファイル・CI の費用）
impact: HIGH（番号の挿入や共通ファイルの取り違えで、ほかの業務の PR が全部止まる。CI の回数で予算を使い切る）
tags: migrations, parallel, coordination, ci, cost
---

# 並行する業務の PR の決まり

複数の業務（AI のセッション）が同じ日に PR を出し、調整役がマージして staging に載せるときの決まり。2026-10-24〜25 に16業務を並行して入れたときに決めたことを、続けて使う形にした。
移行（`migrations/`）の書き方そのものは `database.md`、見た目は `../design/integrated-system-visual.md` が正本。

## 役割

| 誰 | すること |
|---|---|
| 調整役（1つのセッション） | 移行の番号を決める・PR をマージする・main の CI を見る・staging に移行を当てて配備する。マージは PR ごとに代表の許可を受ける |
| 各業務 | 自分の PR を main に追いつかせ、試験・見た目の検査を通して「準備できた」を送る。番号を自分で決めない・移行のある PR を自分でマージしない |

「準備できた」には、PR の番号・移行の番号（無ければ「移行なし」）・見た目の検査の違反の数・手元で通した試験を書く。

## 移行の番号

- 番号は調整役が決める。マージの順は番号の順
- **main の最大の番号より小さい移行は足せない。** CI の節の台帳の見張り（`scripts/pg-ddl.mjs --check-sections-base`）が、既存の節の変更・挿入を止める。先に入った PR があれば、後ろの PR を「main の最大＋1」から振り直す
- 番号を振り直すときに空いた番号は欠番のまま残し、`test/database-rules.test.mjs` の `RESERVED_MISSING` に入れる（詰めない）
- 準備のできていない番号が前にあると、後ろが全部止まる。準備の遅い PR は、早い PR と番号を入れ替える（調整役が決めて両方に知らせる）
- 前の PR が入るたびに、次の PR は main を取り込んで次を作り直し、1回だけ push する
  - pg の生成物（`node scripts/pg-ddl.mjs`。`pg/schema.sql`・`rls.sql`・`rls-off.sql`・`ddl-sections.json` ほか）
  - `migration-manifest.json` と表の数の直書き（`test/pg-catalog`・`pg-ddl`・`pg-export`・`ux-migration` の試験）。数は「main の値＋自分の移行の差」で、`pg-ddl.mjs` の出力と照らす
  - 指紋（`test/database-rules.test.mjs`）・`src/db.mjs`・和名（`src/admin/er-model.mjs`）・辞書（`docs/database/dictionary.json`。版の番号は main の最後の次）と `node scripts/build-db-docs.mjs`・`AGENTS.md` の地図
- 積み重ねた PR（B の base が A の枝）は、A が入ったら調整役が B の base を main に変え、**main の上で CI を通してから**マージする（前の枝の上の緑のままマージしない）

## 共通のファイル

- `src/app.mjs`・`src/navigation.mjs`・`src/shell/nav-model.mjs`・`src/main.jsx`・`test/shell-*.test.mjs` は、番号の順で後の PR が前の PR の上に寄せる。足すのは各自1〜2行
- **画面を足したら、`src/shell/folder-nav.mjs` の `FOLDER_GROUPS` の該当するフォルダ（F01〜F20）の行にページ ID を1つ足す。** 全ページがちょうど1つのフォルダか「共通」「管理・設計」に入ることを `test/shell-folder-nav.test.mjs` が見る
- 共通の画面部品（シェル・ナビ・共通の `styles.css`・`shell.css`）は調整役が1本で直す。各業務は触らない

## 見た目

- 自分の PR で足した・変えた css・jsx に、会社ルートの `ops/check_visual_rules.py` を当てて違反を0にする
- 文言はレイアウトに説明させる（`../design/integrated-system-visual.md` §5）。main に入った画面の言い換えは、移行のない小さな PR「UI リライト: <業務>」で出す

## CI の費用

- CI の走らせ先はリポジトリの変数 `CI_RUNS_ON`。ふだんは代表の PC の runner（`["self-hosted","Linux","openingnight-pc"]`）。急ぐ日だけ代表が GitHub Actions の予算を足して `"ubuntu-latest"` に切り替え、終わったら戻す（手順は `docs/platform/operations/runbooks/14-self-hosted-runner.md`）
- GitHub の runner は1回の CI（15ジョブ）が約54分の課金で、0.4〜0.6ドル。費用は回数で決まる（2026-10-24〜25 は core だけで574回走り、20ドルを1日で使い切った）。**手元で試験を通してから、区切りでまとめて1回 push する**。古い先端の CI は取り消す
- 上限に当たると、ジョブは runner が付かずに全部「失敗」になる（注記に spending limit）。中身の赤ではないので、走らせ先を切り替えて流し直す
- CI でだけ落ちる試験は、まず2回続けて落ちるかを見る。2回続けば中身の失敗として原因を探す（2026-10-25 の `test-npm --list` の出力切れ・PG の後片付けのロックの上限は、どちらもそうだった）
