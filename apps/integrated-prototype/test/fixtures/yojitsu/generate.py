#!/usr/bin/env python3
"""案件収支の予実の架空の種（seed.json）を作る。

会社ルート plans/2026-10-08-phase1-five-second-yojitsu.md の香盤表 #23a。golden（同 #23c）・seed スクリプト（同 #23d）と、
行動指標の計画（plans/2026-10-09-sales-producer-kpi.md）の段B の種が読む。

- 統合システムの関数（src/）を使わず、Python の標準ライブラリだけで作る。金額は整数円、率は bps（入力の表の「売上率」だけ小数）
- 乱数は自前の splitmix64（入金の確認の fixtures/receipt-matching/generate.py と同じ型）。同じ種なら同じバイト列になる
- 入金は fixtures/receipt-matching/ の128件だけ。自動で一致した119件の消込を、請求明細の work_id → 種の作品 → 案件コードで
  入金の行（「実績」）にし、確認が要る9件は承認するまで登録しないので pending_receipts に置く。読んだ4つのファイルの
  SHA-256 を sources に書く（receipt-matching を作り直したら、この種も作り直す）
- 入力の表（目標・計画・案件・予測・実績・活動記録・行動・設定・試算の案件）は、会社ルート ORG/事業計画/_build/build_yojitsu.py の
  --seed の形（列の名前・日付は YYYY-MM-DD・予測の月は月初の日）。行には統合システムが使う英字の鍵を足してあり、
  --build-yojitsu-input で列の名前だけに絞った写しを書ける
- 語は brain の wiki/01_rules/ontology.md「業務フローの語彙」（稼ぎ方5つ・案件の型・行動の段）と D-039 の 2026-10-10 の追記、
  状態は計画の K-9（確認済み・監督申告・報道値・仮置き）、行動の率は K-19（面談→提案 50%・提案→契約 30%。仮置き）
- データはすべて架空。名前は「（架空）」付き、コードは YJ-*（入金の確認から来た行は RM-*）。目標・計画の行は fictional: true の
  不規則な桁の架空額で、持ち主は公開版の手順の利用者（demo-admin@openingnight.invalid）

使い方: python generate.py [--out <フォルダ>] [--seed <整数>] [--build-yojitsu-input <ファイル>]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RM_DIR = HERE.parent / "receipt-matching"
RM_FILES = ("invoices.json", "receipts.json", "answers.json", "yojitsu-actuals.json")
SEED = 20261116
NOTICE = "架空データ。案件収支の予実の試験とデモ専用で、実在の案件・作品・取引先・金額・目標ではない"
OWNER = "demo-admin@openingnight.invalid"
AS_OF = dt.date(2026, 11, 30)        # 種の時点（入金の確認で一括で承認した日と同じ）
CREATED = dt.date(2026, 11, 16)      # いまの予測の版・2回目の目標と計画を作った日
FIRST_PLAN = dt.date(2026, 10, 2)    # 最初の目標と計画を作った日

# ---------------------------------------------------------------- build_yojitsu.py の入力の形（列の名前と並び）
COLS = {
    "目標": ["目標ID", "版", "決めた日", "決めた人", "目標の種類", "期間", "稼ぎ方", "目標額（円）", "単位", "根拠", "状態"],
    "計画": ["計画ID", "版", "作った日", "期間", "稼ぎ方", "計画額（円・税別）", "根拠", "状態"],
    "案件": ["案件コード", "案件名", "稼ぎ方", "相手", "キーパーソン", "段階", "基準額（円・税別）", "基準額の中身", "売上率",
           "始めた日", "企画フォルダ", "メモ"],
    "予測": ["予測ID", "版", "作った日", "案件コード", "シナリオ", "月", "区分", "項目", "相手", "金額（円・税別）", "状態", "出所", "予測に使う"],
    "実績": ["実績ID", "日付", "案件コード", "区分", "項目", "相手", "金額（円・税別）", "証憑", "記録した日", "メモ"],
    "活動記録": ["日付", "案件コード", "稼ぎ方", "ステップ", "相手", "したこと", "成果物", "次の一手", "期日"],
}
ACTION_HEADS = ["稼ぎ方", "1件あたりの額（円・税別）", "提案→契約の率", "面談→提案の率", "状態", "1件あたりの中身"]
SETTING_KEYS = ["採用シナリオ", "締めた月", "着地確度", "案件数目標", "月別の予測範囲", "期間"]
PERIOD_NAMES = ["1年目", "2年目", "3年目", "4年目", "5年目"]

# ---------------------------------------------------------------- 語
# 稼ぎ方5つ（D-039 の 2026-10-10 の追記、J-2・J-3）→ (案件の型（仮の対応。型×稼ぎ方の対応表は計画の #4）, 入金の区分,
# 既定の売上率 bps, 率の状態（K-9）, 率の中身)。率の値は計画の U-8 の仮置き（窓口手数料・クラファンの率）と J-4 の既定
EARNINGS = ["買付", "販売委託", "自社出資", "製作委員会", "制作受託"]
EARNING_INFO = {
    "買付": ("買付", "流通売上", 2000, "仮置き", "MG つきの窓口手数料（J-9 (c)）"),
    "販売委託": ("受託配給", "販売委託の売上", 2000, "仮置き", "手数料の純額（J-11a (b)）"),
    "自社出資": ("製作", "流通売上", 10000, "仮置き", "権利を持つので入金の全額"),
    "製作委員会": ("製作", "流通売上", 3000, "仮置き", "自社の分配。委員会の作品は案件ごとに自社の出資比率で上書きする"),
    "制作受託": ("受託制作", "受託収益", 1000, "監督申告", "受託費率の既定（J-4 (a)。案件ごとに 10〜15%）"),
}
# 段階（10段階＋見送り）と確度 bps
STAGES = [("見送り", 0), ("企画メモ", 1000), ("面談済み", 2000), ("条件の探り", 3000), ("提案済み", 4000), ("担当の合意", 5000),
          ("決裁者の合意", 6000), ("条件の合意", 7000), ("内示", 8000), ("契約の調整", 9000), ("契約済み", 10000)]
PROB = dict(STAGES)
# 区分（入金4・出金5。K-9）→ (入出金, 売上の元)
KUBUN = [("流通売上", "入金", "はい"), ("販売委託の売上", "入金", "はい"), ("受託収益", "入金", "はい"),
         ("クラウドファンディングの支援金", "入金", "いいえ"), ("出資", "出金", "いいえ"), ("買付", "出金", "いいえ"),
         ("制作の実費", "出金", "いいえ"), ("作り手・権利元への分配", "出金", "いいえ"), ("クラウドファンディングの費用", "出金", "いいえ")]
STATUSES = ["確認済み", "監督申告", "報道値", "仮置き"]
STEPS = ["面談", "提案", "契約", "その他"]
# 行動の段（ontology「行動の段」2026-10-10）: (役, 稼ぎ方) → [(段, 畳む先のステップ)]
ACT_STAGES = {
    ("プロデューサー", "制作受託"): [("企画メモ", "面談"), ("予算割と見積", "提案"), ("提案", "提案"), ("契約", "契約")],
    ("プロデューサー", "自社出資"): [("企画書", "面談"), ("稟議の申請", "提案"), ("決裁", "契約"), ("出資の払込", "契約")],
    ("プロデューサー", "製作委員会"): [("打診", "面談"), ("内諾", "提案"), ("出資契約", "契約")],
    ("営業（仕入れ）", "買付"): [("権利元との面談", "面談"), ("条件書", "提案"), ("契約（MG）", "契約")],
    ("営業（仕入れ）", "販売委託"): [("権利元との面談", "面談"), ("条件書", "提案"), ("預かりの契約", "契約")],
    ("営業（売り）", "買付"): [("商品化", "面談"), ("取引先への提案", "提案"), ("採用", "契約")],
    ("営業（売り）", "販売委託"): [("商品化", "面談"), ("取引先への提案", "提案"), ("採用", "契約")],
}
BUY_ROLE = {"制作受託": "プロデューサー", "自社出資": "プロデューサー", "製作委員会": "プロデューサー",
            "買付": "営業（仕入れ）", "販売委託": "営業（仕入れ）"}
RESULTS = ["進んだ", "保留", "失注"]
PA_BEARERS = ["自社", "配給会社", "委員会", "出資"]            # K-12
EXPENSE_CATEGORIES = ["制作費", "宣伝費", "配給費"]           # 宣伝費・配給費が P&A
PCOST_BASES = ["出資額（作品の費用の版）", "出資額（委員会の条件版）", "契約書", "追加の契約"]  # FR-EXP-PCOST-001・002・005・039
BURDEN_KINDS = ["出資者の追加出資", "制作会社の負担", "借入"]      # FR-EXP-PCOST-024
SCENARIOS = ["even", "good", "MAX", "単一"]
ADOPTED = "good"

PERIODS = [(n, dt.date(2026 + i, 10, 1), dt.date(2027 + i, 9, 30)) for i, n in enumerate(PERIOD_NAMES)]

# ---------------------------------------------------------------- 新しい案件（YJ-P11〜P32）
# (コード, 稼ぎ方, 段階, 相手の役, 始めた日, 予測の形, 売上率の上書き bps, 基準額の状態, メモ)
# P31・P32 は作品の無い段（買付候補の面談・受託の引き合い）の活動記録を付ける企画メモの段階の案件（活動記録の案件は必須。
# FR-REV-YOJITSU-035・要件の要確認18）。予測の行は無く、基準額は未定
NEW_PROJECTS = [
    ("YJ-P11", "自社出資", "決裁者の合意", "主演の事務所", "2026-10-02", "crowdfunding", None, "仮置き",
     "製作費をクラウドファンディングで集める（自社出資の資金の出し方。J-2 (a)）"),
    ("YJ-P12", "自社出資", "企画メモ", "原作の代理人", "2026-11-09", "none", None, None, "基準額は未定（0円で埋めない）"),
    ("YJ-P13", "製作委員会", "契約済み", "幹事会社", "2026-07-14", "committee_new", 3000, "仮置き", "製作中。自社の出資は2回に分けて払い込む"),
    ("YJ-P14", "製作委員会", "条件の探り", "幹事会社", "2026-10-21", "committee_plan", 4500, "仮置き", "出資比率は打診中の案"),
    ("YJ-P15", "買付", "契約済み", "権利元", "2026-08-03", "buy_contracted", None, "仮置き", "MG つきの買付。MG は 2026-10 に払った"),
    ("YJ-P16", "買付", "内示", "権利元", "2026-09-08", "buy_plan", None, "報道値", "前作の報道された興行の数字から見積もった"),
    ("YJ-P17", "買付", "提案済み", "権利元", "2026-10-13", "buy_plan", 2500, "仮置き", "窓口手数料 25% で提案した"),
    ("YJ-P18", "買付", "見送り", "権利元", "2026-09-16", "dropped", None, "仮置き", "条件が合わず見送った（予測の行は残す）"),
    ("YJ-P19", "販売委託", "契約済み", "権利元", "2026-08-24", "consign_contracted", None, "仮置き", "委託作品を預かって販売中"),
    ("YJ-P20", "販売委託", "契約の調整", "権利元", "2026-09-29", "consign_plan", None, "仮置き", ""),
    ("YJ-P21", "販売委託", "担当の合意", "権利元", "2026-10-07", "consign_plan", None, "監督申告", ""),
    ("YJ-P22", "販売委託", "面談済み", "権利元", "2026-11-04", "default12", None, "仮置き", "施策で登録した案件（既定の予測行）"),
    ("YJ-P23", "販売委託", "条件の合意", "権利元", "2026-09-30", "consign_plan", None, "仮置き", ""),
    ("YJ-P24", "販売委託", "企画メモ", "権利元", "2026-11-18", "default12", None, "仮置き", "施策で登録した案件（既定の予測行）"),
    ("YJ-P25", "制作受託", "契約済み", "発注元", "2026-08-11", "contract_work", None, "確認済み", "受託の契約の版: 節目3回"),
    ("YJ-P26", "制作受託", "内示", "発注元", "2026-09-14", "contract_work", 1500, "監督申告", ""),
    ("YJ-P27", "制作受託", "条件の合意", "発注元", "2026-10-05", "contract_work", 1200, "仮置き", ""),
    ("YJ-P28", "制作受託", "提案済み", "発注元", "2026-10-27", "default12", None, "仮置き", "施策で登録した案件（既定の予測行）"),
    ("YJ-P29", "制作受託", "見送り", "発注元", "2026-09-02", "none", None, "仮置き", "予算が合わず見送った"),
    ("YJ-P30", "制作受託", "条件の探り", "発注元", "2026-11-12", "contract_work", None, "仮置き", ""),
    ("YJ-P31", "買付", "企画メモ", "権利元", "2026-10-15", "memo", None, "仮置き", "買付候補の作品の資料を待つ（作品の無い段）"),
    ("YJ-P32", "制作受託", "企画メモ", "発注元", "2026-11-19", "memo", None, "仮置き", "受託の引き合い。案件として進めるかを決める前"),
]
OLD_ROLE = {"自社出資": "主演の事務所", "製作委員会": "幹事会社", "買付": "権利元"}
# 既存の案件（YJ-P01〜P10。入金の確認の作品と案件）の委員会の自社の出資比率 bps
COMMITTEE_RATIO = {"YJ-P05": 3500, "YJ-P06": 4000, "YJ-P07": 2500}
NEW_WORKS = [("YJ-P13", "製作中"), ("YJ-P15", "流通前"), ("YJ-P19", "流通前")]  # 新しい作品（W17〜W19）
PA_INCLUDED = "YJ-W03"           # 出資に P&A を含む作品（制作費の版に内訳を持つ）
PCOST_ADDED = "YJ-W07"           # 追加の契約で第2版を足した作品
PCOST_OVER = "YJ-W04"            # 制作費の実費が版を超え、追加の契約がまだ無い作品
PA_OVER = "YJ-W02"               # 宣伝費の実費が P&A の予算を超える作品
# P&A の実費: (作品, 費用区分, 負担者, 行の数)
PA_ROWS = [("YJ-W01", "宣伝費", "自社", 2), ("YJ-W02", "宣伝費", "自社", 2), ("YJ-W03", "宣伝費", "出資", 2),
           ("YJ-W05", "宣伝費", "配給会社", 1), ("YJ-W07", "宣伝費", "委員会", 2), ("YJ-W09", "宣伝費", "委員会", 1),
           ("YJ-W11", "宣伝費", "自社", 1), ("YJ-W13", "宣伝費", "配給会社", 1), ("YJ-W17", "宣伝費", "自社", 1),
           ("YJ-W06", "配給費", "配給会社", 1), ("YJ-W10", "配給費", "委員会", 1), ("YJ-W12", "配給費", "自社", 1)]
# 行動の1件あたりの額の幅（架空）と中身
ACTION_RANGE = {"買付": (22_100_000, 33_900_000, "1作品の年間の入金（架空）"),
                "販売委託": (9_100_000, 14_900_000, "1作品の年間の入金（架空）"),
                "自社出資": (28_300_000, 45_700_000, "1作品の入金（架空）"),
                "製作委員会": (18_200_000, 31_800_000, "1作品の入金（架空）"),
                "制作受託": (24_100_000, 47_900_000, "1件の総製作費（架空）")}

MASK = (1 << 64) - 1


class Rng:
    """splitmix64。種は文字列の SHA-256 から取り、用途ごとに独立した列にする。"""

    def __init__(self, *parts):
        digest = hashlib.sha256(":".join(str(p) for p in parts).encode("utf-8")).digest()
        self.state = int.from_bytes(digest[:8], "big")

    def next64(self) -> int:
        self.state = (self.state + 0x9E3779B97F4A7C15) & MASK
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
        return z ^ (z >> 31)

    def below(self, n: int) -> int:
        limit = (1 << 64) - ((1 << 64) % n)
        while True:
            x = self.next64()
            if x < limit:
                return x % n

    def between(self, lo: int, hi: int) -> int:
        return lo + self.below(hi - lo + 1)

    def irregular(self, lo: int, hi: int) -> int:
        """不規則な桁の額（下2桁が 00 にならない）。実在の目標・計画の額（切りのよい額）と重ならないようにする。"""
        while True:
            n = self.between(lo, hi)
            if n % 100 and n % 1000 and n % 10:
                return n


# ---------------------------------------------------------------- 日付
def iso(d: dt.date) -> str:
    return d.isoformat()


def month_add(d: dt.date, n: int) -> dt.date:
    m = d.month - 1 + n
    return dt.date(d.year + m // 12, m % 12 + 1, 1)


def first(y: int, m: int) -> dt.date:
    return dt.date(y, m, 1)


def months_from(start: dt.date, n: int):
    return [month_add(start, i) for i in range(n)]


def tax10(ex: int) -> int:
    return ex // 10  # 消費税10%（切り捨て）


def split_even(total: int, n: int):
    """整数円を n か月に均等に分け、端数は最後の月に寄せる（計画の K-17 の既定の予測行）。"""
    each = total // n
    return [each] * (n - 1) + [total - each * (n - 1)]


def split_bps(total: int, shares):
    out = [total * s // 10000 for s in shares[:-1]]
    return out + [total - sum(out)]


# ---------------------------------------------------------------- 入金の確認の fixture を読む
def read_rm():
    raw = {name: (RM_DIR / name).read_bytes().replace(b"\r\n", b"\n") for name in RM_FILES}
    docs = {name: json.loads(raw[name].decode("utf-8")) for name in RM_FILES}
    sha = {f"receipt-matching/{name}": hashlib.sha256(raw[name]).hexdigest() for name in RM_FILES}
    return docs, sha


def actual_rows(inputs, receipts, answers, project_of, earning_of):
    """自動で一致した入金の消込 → 請求明細の work_id → 種の作品 → 案件コード。全額を消した請求なので、税別は請求明細の
    税抜額を案件ごとに足す。区分は案件の稼ぎ方の入金の区分。確認が要る入金は承認するまで登録しないので行にしない。"""
    inv = {v["invoice_number"]: v for v in inputs["invoices"]}
    rec = {r["receipt_id"]: r for r in receipts["receipts"]}
    names = {p["partner_code"]: p["name"] for p in inputs["partners"]}
    rows = []
    for a in answers["answers"]:
        if a["outcome"] != "自動で一致":
            continue
        r = rec[a["receipt_id"]]
        for al in a["allocations"]:
            v = inv[al["invoice_number"]]
            assert al["amount_yen"] == v["amount_inc_tax"] and al["balance_after_yen"] == 0
            by_project = {}
            for line in v["lines"]:
                code = project_of[line["work_id"]]
                by_project[code] = by_project.get(code, 0) + line["amount_ex_tax"]
            for code in sorted(by_project):
                rows.append({"日付": r["received_on"], "案件コード": code, "区分": EARNING_INFO[earning_of[code]][1],
                             "項目": f"入金の消込（請求 {v['invoice_number']}）", "相手": names[a["partner_code"]],
                             "金額（円・税別）": by_project[code], "証憑": f"入金 {r['reference']}・請求 {v['invoice_number']}",
                             "記録した日": iso(AS_OF), "メモ": "架空（入金の確認の正解表から）",
                             "receipt_id": r["receipt_id"], "invoice_number": v["invoice_number"]})
    rows.sort(key=lambda x: (x["日付"], x["証憑"], x["案件コード"]))
    for n, row in enumerate(rows, start=1):
        row["実績ID"] = f"RM-A-{n:04d}"
    return [{**{c: row[c] for c in COLS["実績"]}, "receipt_id": row["receipt_id"], "invoice_number": row["invoice_number"]}
            for row in rows]


# ---------------------------------------------------------------- 本体
def build(seed: int):
    docs, sources = read_rm()
    inputs = docs["invoices.json"]
    rng = lambda *parts: Rng(seed, *parts)

    # ---- 案件と作品（YJ-P01〜P10・W01〜W16 は入金の確認の作品と案件をそのまま持つ）
    projects = []
    for p in inputs["projects"]:
        e = p["earning_type"]
        projects.append({"code": p["project_code"], "title": p["title"], "earning": e, "stage": "契約済み",
                         "role": OLD_ROLE[e], "started": None, "shape": "running", "rate": COMMITTEE_RATIO.get(p["project_code"]),
                         "base_status": "仮置き", "memo": "流通中（入金の確認の作品）"})
    r_start = rng("started")
    for p in projects:
        p["started"] = iso(dt.date(2024, r_start.between(4, 12), r_start.between(1, 28)))  # 出資の払込・制作費の実費（2025）より前
    for code, e, stage, role, started, shape, rate, status, memo in NEW_PROJECTS:
        n = int(code[-2:])
        projects.append({"code": code, "title": f"架空案件{n:02d}（架空）", "earning": e, "stage": stage, "role": role,
                         "started": started, "shape": shape, "rate": rate, "base_status": status, "memo": memo})
    for p in projects:
        p["partner"] = f"{p['role']}{p['code'][-2:]}（架空）"
        p["rate_bps"] = p["rate"] if p["rate"] is not None else EARNING_INFO[p["earning"]][2]
        p["rate_status"] = EARNING_INFO[p["earning"]][3]
    proj = {p["code"]: p for p in projects}

    works = [{"work_id": w["work_id"], "work_code": w["work_code"], "title": w["title"], "project_code": w["project_code"],
              "status": "流通中"} for w in inputs["works"]]
    for i, (code, status) in enumerate(NEW_WORKS, start=len(works) + 1):
        works.append({"work_id": i, "work_code": f"YJ-W{i:02d}", "title": f"架空作品{i:02d}（架空）", "project_code": code,
                      "status": status})
    work = {w["work_code"]: w for w in works}
    project_of = {w["work_id"]: w["project_code"] for w in works}
    earning_of = {p["code"]: p["earning"] for p in projects}

    # ---- 入金の行（入金の確認の正解表から）と、入金の確認の fixture の入金の行が同じであること
    actuals = actual_rows(inputs, docs["receipts.json"], docs["answers.json"], project_of, earning_of)
    rm_rows = docs["yojitsu-actuals.json"]["実績"]
    assert [{c: r[c] for c in COLS["実績"]} for r in actuals] == rm_rows, "入金の確認の入金の行と、種の作品から作った行が違う"
    nov_in = {}
    for r in actuals:
        nov_in[r["案件コード"]] = nov_in.get(r["案件コード"], 0) + r["金額（円・税別）"]

    # ---- 出資の記録（自社出資＝作品の費用の版の自社の出資額、委員会＝条件版の出資者ごとの額）
    investments, r_inv = [], rng("investments")
    for w in works:
        e = proj[w["project_code"]]["earning"]
        if e not in ("自社出資", "製作委員会"):
            continue
        rec = {"investment_id": f"YJ-INV-{w['work_code'][3:]}", "work_code": w["work_code"], "kind": e, "status": "確定",
               "tax_basis": "税抜", "includes_pa": w["work_code"] == PA_INCLUDED, "pa_yen": None}
        if e == "自社出資":
            own = r_inv.between(12_000, 48_000) * 1000
            rec.update(total_yen=own, own_yen=own, own_ratio_bps=10000, members=[{"name": "自社", "amount_yen": own}])
            if rec["includes_pa"]:
                rec["pa_yen"] = own * r_inv.between(12, 20) // 100 // 1000 * 1000
        else:
            ratio = proj[w["project_code"]]["rate"]
            total = r_inv.between(200, 600) * 200_000
            own = total * ratio // 10000
            other = total - own
            first_member = other * r_inv.between(35, 65) // 100
            rec.update(total_yen=total, own_yen=own, own_ratio_bps=ratio,
                       members=[{"name": "自社", "amount_yen": own},
                                {"name": f"出資者{w['work_code'][-2:]}-1（架空）", "amount_yen": first_member},
                                {"name": f"出資者{w['work_code'][-2:]}-2（架空）", "amount_yen": other - first_member}])
        if w["status"] == "製作中":   # 製作中の委員会の作品: 2026-11 と 2027-01 に分けて払い込む
            p1 = own * 6 // 10
            rec["payments"] = [{"paid_on": "2026-11-16", "amount_yen": p1}, {"paid_on": "2027-01-15", "amount_yen": own - p1}]
        else:
            d = dt.date(2025, r_inv.between(3, 9), r_inv.between(1, 28))
            rec["payments"] = [{"paid_on": iso(d), "amount_yen": own}]
        investments.append(rec)
    inv_of = {x["work_code"]: x for x in investments}

    # ---- 制作費の版（作品ごとの連番・整数円・税抜。全作品に第1版）
    versions, r_pc = [], rng("production-cost")
    for w in works:
        x = inv_of.get(w["work_code"])
        if x:
            amount = x["total_yen"]
            v = {"work_code": w["work_code"], "version_no": 1, "amount_yen": amount, "tax_basis": "税抜",
                 "basis_kind": PCOST_BASES[0] if x["kind"] == "自社出資" else PCOST_BASES[1],
                 "investment_id": x["investment_id"], "contract_ref": None, "signed_on": None, "counterparty": None,
                 "added_yen": None, "burden_kind": None, "breakdown": None, "recorded_on": "2026-10-05", "status": "確認済み"}
            if x["includes_pa"]:
                v["breakdown"] = [{"part": "制作費", "amount_yen": amount - x["pa_yen"]}, {"part": "P&A", "amount_yen": x["pa_yen"]}]
        else:
            amount = r_pc.between(20_000, 90_000) * 1000
            if w["status"] == "流通中":
                signed = dt.date(2025, r_pc.between(1, 12), r_pc.between(1, 28))
            else:   # 新しい案件の作品: 案件を始めた日のあと
                signed = dt.date.fromisoformat(proj[w["project_code"]]["started"]) + dt.timedelta(days=r_pc.between(20, 40))
            v = {"work_code": w["work_code"], "version_no": 1, "amount_yen": amount, "tax_basis": "税抜", "basis_kind": PCOST_BASES[2],
                 "investment_id": None, "contract_ref": f"YJ-CT-{w['work_code'][3:]}", "signed_on": iso(signed),
                 "counterparty": proj[w["project_code"]]["partner"], "added_yen": None, "burden_kind": None, "breakdown": None,
                 "recorded_on": "2026-10-05", "status": "確認済み"}
        versions.append(v)
        if w["work_code"] == PCOST_ADDED:
            added = amount * r_pc.between(6, 12) // 100 // 1000 * 1000
            versions.append({"work_code": w["work_code"], "version_no": 2, "amount_yen": amount + added, "tax_basis": "税抜",
                             "basis_kind": PCOST_BASES[3], "investment_id": None, "contract_ref": f"YJ-CT-{w['work_code'][3:]}-2",
                             "signed_on": "2026-10-19", "counterparty": proj[w["project_code"]]["partner"], "added_yen": added,
                             "burden_kind": BURDEN_KINDS[0], "breakdown": None, "recorded_on": "2026-10-21", "status": "確認済み"})
    latest = {}
    for v in versions:
        latest[v["work_code"]] = v

    # ---- 経費（制作費の実費と P&A の実費。P&A には負担者）
    expenses, r_ex = [], rng("expenses")

    def expense(work_code, category, ex, month: dt.date, bearer, desc):
        paid = month_add(month, 1) + dt.timedelta(days=r_ex.between(4, 24))   # 計上月の翌月に払う
        expenses.append({"expense_id": None, "work_code": work_code, "project_code": work[work_code]["project_code"],
                         "category": category, "description": desc, "accounting_month": iso(month),
                         "paid_on": iso(paid) if paid <= AS_OF else None,   # 種の時点より後に払う経費は未払

                         "amount_ex_tax": ex, "tax_amount": tax10(ex), "amount_inc_tax": ex + tax10(ex), "bearer": bearer})

    for x in investments:
        wc = x["work_code"]
        v = latest[wc]
        base = v["breakdown"][0]["amount_yen"] if v["breakdown"] else v["amount_yen"]
        if wc == PCOST_OVER:
            total = base * r_ex.between(103, 106) // 100
        elif wc == PCOST_ADDED:
            total = next(u for u in versions if u["work_code"] == wc)["amount_yen"] * 103 // 100  # 第1版は超え、第2版で収まる
        elif work[wc]["status"] == "製作中":
            total = base * r_ex.between(35, 45) // 100
        else:
            total = base * r_ex.between(86, 97) // 100
        parts = split_bps(total, [r_ex.between(2500, 4000), r_ex.between(2500, 4000), 0])  # 端数は3行目
        start = first(2026, 9) if work[wc]["status"] == "製作中" else first(2025, r_ex.between(6, 10))
        for k, ex in enumerate(parts):
            expense(wc, "制作費", ex, month_add(start, k * (1 if work[wc]["status"] == "製作中" else 3)), None,
                    f"制作費の実費 {k + 1}（架空）")
    for wc, category, bearer, n in PA_ROWS:
        # 出資が負担する P&A は、出資に含む P&A の枠（制作費の版の内訳の P&A）に収める
        hi = inv_of[wc]["pa_yen"] // n // 1000 - 1 if bearer == "出資" else 4_000
        assert hi >= 300, (wc, hi)
        for k in range(n):
            month = first(2026, r_ex.between(3, 10)) if work[wc]["status"] == "流通中" else first(2026, 11)
            label = "宣伝の費用" if category == "宣伝費" else "配給の費用"
            expense(wc, category, r_ex.between(300, hi) * 1000 + r_ex.between(0, 999), month, bearer, f"{label} {k + 1}（架空）")
    expenses.sort(key=lambda x: (x["accounting_month"], x["work_code"], x["category"], x["description"]))
    for n, x in enumerate(expenses, start=1):
        x["expense_id"] = f"YJ-E-{n:04d}"

    # ---- P&A の予算（作品の費用の版の宣伝費の予算）。PA_OVER の作品だけ宣伝費の実費が予算を超える
    pa_budgets, r_pa = [], rng("pa-budget")
    for w in works:
        spent = sum(x["amount_ex_tax"] for x in expenses if x["work_code"] == w["work_code"] and x["category"] == "宣伝費")
        if w["work_code"] == PA_OVER:
            budget = spent * 85 // 100 // 10_000 * 10_000
        elif spent:
            budget = (spent * r_pa.between(110, 140) // 100 // 10_000 + 1) * 10_000
        else:
            budget = r_pa.between(80, 600) * 10_000
        pa_budgets.append({"work_code": w["work_code"], "promotion_budget_yen": budget, "tax_basis": "税抜", "status": "確認済み"})

    # ---- 予測（区分ごとの入金・出金の額。売上率を掛ける前）
    forecasts = []
    r_f = rng("forecast")

    def frow(code, version, created, scenario, month, kubun, item, amount, status, source, use=True):
        forecasts.append({"予測ID": None, "版": version, "作った日": iso(created), "案件コード": code, "シナリオ": scenario,
                          "月": iso(month), "区分": kubun, "項目": item, "相手": proj[code]["partner"], "金額（円・税別）": amount,
                          "状態": status, "出所": source, "予測に使う": "はい" if use else "いいえ"})

    def decay(first_amount, n):
        out, level = [], first_amount
        for _ in range(n):
            out.append(level)
            level = level * r_f.between(78, 93) // 100
        return out

    def scenario_rows(code, version, created, months, good, kubun, item, status, source, use=True, scenarios=("even", "good", "MAX")):
        for sc in scenarios:
            for m, g in zip(months, good):
                amount = {"even": g * 3 // 5, "good": g, "MAX": g * 3 // 2}[sc]
                frow(code, version, created, sc, m, kubun, item, amount, status, source, use)

    def payout_rows(code, version, created, months, good, rate_bps, status, source):
        """3か月ごとの入金から、権利元へ渡る額（入金×(1−手数料率)）を翌月に払う。"""
        for sc in ("even", "good", "MAX"):
            for q in range(0, len(months), 3):
                inflow = sum({"even": g * 3 // 5, "good": g, "MAX": g * 3 // 2}[sc] for g in good[q:q + 3])
                frow(code, version, created, sc, month_add(months[q + 2], 1), "作り手・権利元への分配", "権利元へ渡る額",
                     inflow * (10000 - rate_bps) // 10000, status, source)

    v_cur, v_old, v_init = "架空の試算 第2版", "架空の試算 第1版", "架空の試算 第1版"
    src_trial = "架空の試算（fixtures/yojitsu/generate.py）"
    src_k17 = "施策の既定の予測行（計画の K-17 の形）"
    bases, k17_start = {}, {}
    for p in projects:
        code, e, shape, status = p["code"], p["earning"], p["shape"], p["base_status"]
        inflow = EARNING_INFO[e][1]
        if shape == "running":
            months = months_from(first(2026, 12), 12)
            good = decay(nov_in[code] * r_f.between(70, 95) // 100, 12)
            if code in ("YJ-P01", "YJ-P05"):   # 前の版（予測に使わない）
                old = decay(nov_in[code] * r_f.between(100, 120) // 100, 12)
                scenario_rows(code, v_old, dt.date(2026, 9, 15), months_from(first(2026, 10), 12), old, inflow,
                              "流通の入金（架空）", status, src_trial, use=False)
            scenario_rows(code, v_cur, CREATED, months, good, inflow, "流通の入金（架空）", status, src_trial)
            if e == "買付":
                payout_rows(code, v_cur, CREATED, months, good, p["rate_bps"], status, src_trial)
            bases[code] = sum(good)
        elif shape in ("crowdfunding", "committee_new", "committee_plan", "buy_contracted", "buy_plan", "dropped",
                       "consign_contracted", "consign_plan"):
            created = max(dt.date.fromisoformat(p["started"]) + dt.timedelta(days=14), dt.date(2026, 10, 9))
            start = {"crowdfunding": first(2027, 7), "committee_new": first(2027, 4), "committee_plan": first(2027, 12),
                     "buy_contracted": first(2027, 1), "buy_plan": first(2027, 3) if code == "YJ-P16" else first(2027, 5),
                     "dropped": first(2027, 1), "consign_contracted": first(2026, 12),
                     "consign_plan": {"YJ-P20": first(2027, 2), "YJ-P21": first(2027, 3), "YJ-P23": first(2027, 1)}.get(code)}[shape]
            months = months_from(start, 12)
            good = decay(r_f.between(900, 4_800) * 1000 + r_f.between(0, 999), 12)
            scenarios = ("good",) if shape == "dropped" else ("even", "good", "MAX")
            scenario_rows(code, v_init, created, months, good, inflow, "流通の入金（架空）", status, src_trial, scenarios=scenarios)
            bases[code] = sum(good)
            if shape == "crowdfunding":
                support = [r_f.between(1_800, 5_600) * 1000 for _ in range(3)]
                for m, a in zip(months_from(first(2027, 1), 3), support):
                    frow(code, v_init, created, "単一", m, "クラウドファンディングの支援金", "支援金（架空）", a, status, src_trial)
                for m, a in zip(months_from(first(2027, 2), 3), support):
                    frow(code, v_init, created, "単一", m, "クラウドファンディングの費用", "リターンの製造と発送・手数料（架空）",
                         a * r_f.between(15, 25) // 100, status, src_trial)
                frow(code, v_init, created, "単一", first(2027, 2), "出資", "製作費の支払い（架空）", sum(support), status, src_trial)
            if shape == "committee_new":
                pay = inv_of[[w["work_code"] for w in works if w["project_code"] == code][0]]["payments"][1]
                frow(code, v_init, created, "単一", dt.date.fromisoformat(pay["paid_on"]).replace(day=1), "出資",
                     "委員会への出資（2回目）", pay["amount_yen"], "確認済み", src_trial)
            if shape == "committee_plan":
                frow(code, v_init, created, "単一", first(2027, 6), "出資", "委員会への出資（架空）",
                     r_f.between(8_000, 30_000) * 1000, status, src_trial)
            if shape == "buy_plan":
                frow(code, v_init, created, "単一", month_add(start, -2), "買付", "MG の支払い（架空）",
                     r_f.between(2_000, 7_000) * 1000, status, src_trial)
            if shape == "consign_contracted":
                payout_rows(code, v_init, created, months, good, p["rate_bps"], status, src_trial)
        elif shape == "contract_work":
            created = max(dt.date.fromisoformat(p["started"]) + dt.timedelta(days=10), dt.date(2026, 10, 9))
            start = {"YJ-P25": first(2026, 12), "YJ-P26": first(2027, 1), "YJ-P27": first(2027, 2), "YJ-P30": first(2027, 3)}[code]
            total = r_f.between(18_000, 60_000) * 1000
            for m, a, label in zip([start, month_add(start, 3), month_add(start, 6)], split_bps(total, [3000, 3000, 4000]),
                                   ["着手金", "中間金", "納品時の残金"]):
                frow(code, v_init, created, "単一", m, inflow, f"{label}（架空）", a, status, src_trial)
            n_cost = {"YJ-P25": 7, "YJ-P26": 6, "YJ-P27": 6, "YJ-P30": 5}[code]
            # 実費は総製作費から受託費（総製作費×率）を除いた分に収め、3% 以上を残す（率＋実費の割合 ≦ 97%）
            cost_hi = min(88, (9700 - p["rate_bps"]) // 100)
            for m, a in zip(months_from(start, n_cost), split_even(total * r_f.between(78, cost_hi) // 100, n_cost)):
                frow(code, v_init, created, "単一", m, "制作の実費", "制作の実費（架空）", a, "仮置き", src_trial)
            bases[code] = total
        elif shape == "default12":
            bases[code] = r_f.between(3_000, 15_000) * 1000 + r_f.between(1, 999)
        elif shape == "none":
            bases[code] = None if code == "YJ-P12" else r_f.between(10_000, 40_000) * 1000
        elif shape == "memo":   # 作品の無い段の案件（乱数を引かない。ほかの案件の値を変えない）
            bases[code] = None
        else:
            raise ValueError(shape)

    # ---- 活動記録（ontology の行動の段。最後の行の期日が、既定の予測行の始まりの月）
    activities, r_a = [], rng("activities")
    dues = {"YJ-P22": dt.date(2026, 12, 10), "YJ-P24": dt.date(2027, 1, 15), "YJ-P28": dt.date(2026, 12, 18),
            "YJ-P21": dt.date(2026, 11, 20), "YJ-P23": dt.date(2026, 11, 24)}  # P21・P23 は期日を過ぎた次の一手

    def act(date, code, earning, step, stage, partner, did, output, nxt, due, result, work_code=None):
        activities.append({"日付": iso(date), "案件コード": code, "稼ぎ方": earning, "ステップ": step, "相手": partner,
                           "したこと": did, "成果物": output, "次の一手": nxt, "期日": iso(due) if due else None,
                           "stage": stage, "result": result, "work_code": work_code})

    def done_count(e, stage, seq):
        prob = PROB[stage]
        if stage == "見送り" or prob <= 2000:
            return 1
        if prob <= 5000:
            return 2
        if prob < 10000:
            return max(i for i, (_, s) in enumerate(seq) if s != "契約") + 1
        return len(seq)

    for p in projects[10:]:
        if p["shape"] == "memo":   # 作品の無い段の行は下で1行ずつ足す
            continue
        code, e = p["code"], p["earning"]
        seq = ACT_STAGES[(BUY_ROLE[e], e)]
        k = done_count(e, p["stage"], seq)
        started = dt.date.fromisoformat(p["started"])
        if p["stage"] == "契約済み":   # 契約までの段は、払込・MG・実費の支払いより前（始めた日から60日のあいだ）
            lo, hi = started, started + dt.timedelta(days=60)
        else:
            lo = max(started, dt.date(2026, 10, 1))
            hi = min(dt.date(2026, 11, 27), dues[code] - dt.timedelta(days=1)) if code in dues else dt.date(2026, 11, 27)
        span = (hi - lo).days
        dates = sorted(lo + dt.timedelta(days=r_a.below(span + 1)) for _ in range(k))
        for i, ((stage_label, step), d) in enumerate(zip(seq[:k], dates)):
            last = i == k - 1
            if last:
                nxt_label = seq[k][0] if k < len(seq) else None
                if p["stage"] == "見送り":
                    nxt, due, result = None, None, "失注"
                elif nxt_label:
                    nxt, due, result = f"{nxt_label}に進める", dues.get(code, d + dt.timedelta(days=r_a.between(14, 40))), "保留"
                else:
                    nxt, due, result = "納品・流通の準備を進める", d + dt.timedelta(days=r_a.between(20, 45)), "進んだ"
            else:
                nxt, due, result = f"{seq[i + 1][0]}に進める", dates[i + 1], "進んだ"
            output = None if step == "面談" and r_a.below(3) == 0 else f"{stage_label}の記録（架空）"
            wc = next((w["work_code"] for w in works if w["project_code"] == code), None) if stage_label == "出資契約" else None
            act(d, code, None, step, stage_label, p["partner"], f"{stage_label}（架空）", output, nxt, due, result, wc)
        if e in ("買付", "販売委託") and p["stage"] == "契約済み":   # 売りの段（作品のある段）
            wc = next(w["work_code"] for w in works if w["project_code"] == code)
            sell = ACT_STAGES[("営業（売り）", e)][:1 if e == "買付" else 2]
            for i, (stage_label, step) in enumerate(sell):
                d = dt.date(2026, 11, 2 + 9 * i + r_a.below(5))
                act(d, code, None, step, stage_label, f"配信会社{code[-2:]}（架空）", f"{stage_label}（架空作品の売り）",
                    f"{stage_label}の記録（架空）", "取引先の返事を待つ", d + dt.timedelta(days=21), "進んだ", wc)
    for p in projects[7:10]:   # 既存の買付（P08〜P10）の売り
        wc = next(w["work_code"] for w in works if w["project_code"] == p["code"])
        for i, (stage_label, step) in enumerate(ACT_STAGES[("営業（売り）", "買付")]):
            d = dt.date(2026, 10, 6) + dt.timedelta(days=14 * i + r_a.below(6))
            act(d, p["code"], None, step, stage_label, f"配信会社{p['code'][-2:]}（架空）", f"{stage_label}（架空作品の売り）",
                f"{stage_label}の記録（架空）", "次の窓口を探す" if i == 2 else f"{ACT_STAGES[('営業（売り）', '買付')][i + 1][0]}に進める",
                d + dt.timedelta(days=14), "進んだ", wc)
    # 作品の無い段（買付候補の面談・受託の引き合い）は、企画メモの段階の案件（P31・P32。作品なし）に付ける。稼ぎ方は案件から
    act(dt.date(2026, 10, 15), "YJ-P31", None, "面談", "権利元との面談", proj["YJ-P31"]["partner"], "買付候補の面談（架空）", None,
        "候補の作品の資料を受け取る", dt.date(2026, 12, 8), "保留")
    act(dt.date(2026, 11, 19), "YJ-P32", None, "面談", "企画メモ", proj["YJ-P32"]["partner"], "受託の引き合い（架空）",
        "引き合いのメモ（架空）", "案件として進めるか決める", dt.date(2026, 12, 4), "保留")
    # その他（ステップに畳まない）
    act(dt.date(2026, 11, 30), "YJ-P01", None, "その他", None, "社内（架空）", "入金の確認の結果を整理した（架空）",
        "整理のメモ（架空）", None, None, "進んだ")
    act(dt.date(2026, 10, 30), "YJ-P05", None, "その他", None, "幹事会社05（架空）", "委員会の収支の報告を受けた（架空）",
        "報告のメモ（架空）", None, None, "進んだ")
    activities.sort(key=lambda a: (a["日付"], a["案件コード"] or "", a["stage"] or ""))
    # 期日を過ぎた次の一手（会社の入口の例外）は dues で決めた案件だけにする。ほかの案件の最後の行の期日は種の時点より後へ
    last_of = {}
    for a in activities:
        if a["案件コード"]:
            last_of[a["案件コード"]] = a
    for code, a in sorted(last_of.items()):
        if code not in dues and a["期日"] and a["期日"] < iso(AS_OF):
            a["期日"] = iso(AS_OF + dt.timedelta(days=r_a.between(3, 30)))

    # 既定の予測行（K-17 の形: 始まりの月＝最後の活動の期日の月、基準額を12か月に均等・端数は最後の月、シナリオ＝採用シナリオ）
    for p in projects:
        if p["shape"] != "default12":
            continue
        last = [a for a in activities if a["案件コード"] == p["code"]][-1]
        start = dt.date.fromisoformat(last["期日"]).replace(day=1)
        k17_start[p["code"]] = start
        created = dt.date.fromisoformat(last["日付"])
        for m, a in zip(months_from(start, 12), split_even(bases[p["code"]], 12)):
            frow(p["code"], "施策の既定の予測", created, ADOPTED, m, EARNING_INFO[p["earning"]][1], "既定の予測（架空）", a,
                 "仮置き", src_k17)
    forecasts.sort(key=lambda f: (f["案件コード"], f["版"], f["シナリオ"], f["月"], f["区分"]))
    for n, f in enumerate(forecasts, start=1):
        f["予測ID"] = f"YJ-F{n:04d}"

    # ---- 実績の出金（入金の確認の外。払った月に引く: J-11b (a)）
    p13_pay = inv_of[[w["work_code"] for w in works if w["project_code"] == "YJ-P13"][0]]["payments"][0]
    outflows = [
        ("2026-10-20", "YJ-P15", "買付", "MG の支払い（架空）", r_f.between(3_000, 8_000) * 1000),
        (p13_pay["paid_on"], "YJ-P13", "出資", "委員会への出資（1回目）", p13_pay["amount_yen"]),
        ("2026-11-25", "YJ-P25", "制作の実費", "制作の実費（架空）", r_f.between(1_500, 4_000) * 1000),
    ]
    for n, (d, code, kubun, item, amount) in enumerate(outflows, start=1):
        actuals.append({"実績ID": f"YJ-A-{n:04d}", "日付": d, "案件コード": code, "区分": kubun, "項目": item,
                        "相手": proj[code]["partner"], "金額（円・税別）": amount, "証憑": f"架空の振込記録 YJ-PAY-{n:04d}",
                        "記録した日": iso(AS_OF), "メモ": "架空", "receipt_id": None, "invoice_number": None})

    # ---- 案件の行（入力の表の形）
    base_text = {"running": "架空の試算 good の入金の合計（12か月）", "crowdfunding": "架空の試算 good の流通の入金の合計",
                 "committee_new": "架空の試算 good の入金の合計", "committee_plan": "架空の試算 good の入金の合計",
                 "buy_contracted": "架空の試算 good の入金の合計", "buy_plan": "架空の試算 good の入金の合計",
                 "dropped": "架空の試算 good の入金の合計", "consign_contracted": "架空の試算 good の入金の合計",
                 "consign_plan": "架空の試算 good の入金の合計", "contract_work": "受託の総製作費（架空）",
                 "default12": "施策で入れた基準額（架空）", "none": "見送る前の見積（架空）", "memo": "未定"}
    project_rows = []
    for p in projects:
        base = bases[p["code"]]
        text = "未定" if base is None else base_text[p["shape"]]
        project_rows.append({
            "案件コード": p["code"], "案件名": p["title"], "稼ぎ方": p["earning"], "相手": p["partner"], "キーパーソン": None,
            "段階": p["stage"], "基準額（円・税別）": base, "基準額の中身": text, "売上率": p["rate_bps"] / 10000,
            "始めた日": p["started"], "企画フォルダ": None, "メモ": p["memo"] or None,
            "project_type": EARNING_INFO[p["earning"]][0], "rate_bps": p["rate_bps"],
            "rate_status": "仮置き" if p["rate"] is not None else p["rate_status"],
            "base_status": None if base is None else p["base_status"]})

    # ---- 目標・計画（fictional: true・不規則な桁の架空額・持ち主は公開版の利用者）
    r_t = rng("targets")
    targets = []

    def target(tid, version, decided, by, kind, period, amount, status):
        targets.append({"目標ID": tid, "版": version, "決めた日": iso(decided), "決めた人": by, "目標の種類": kind, "期間": period,
                        "稼ぎ方": "全体", "目標額（円）": amount, "単位": "期間の合計", "根拠": "架空の目標（不規則な桁の架空額）",
                        "状態": status, "fictional": True, "owner_user_email": OWNER, "target_basis": "額"})

    # 額の桁は種の入金・予測の規模に合わせる（1年目の着地が計画の前後になる）
    self_amounts = [r_t.irregular(268_000_000, 286_000_000)]
    for _ in range(4):
        self_amounts.append(self_amounts[-1] * r_t.between(104, 118) // 100 + r_t.between(1, 99))
    target("YJ-T01", 1, FIRST_PLAN, "架空の代表", "本人", "1年目", r_t.irregular(292_000_000, 309_000_000), "改めた")
    target("YJ-T02", 2, CREATED, "架空の代表", "本人", "1年目", self_amounts[0], "有効")
    for i in range(1, 5):
        target(f"YJ-T{i + 2:02d}", 1, FIRST_PLAN, "架空の代表", "本人", PERIOD_NAMES[i], self_amounts[i], "有効")
    # 目標（会社）は同じ期間の有効な目標（本人）の約 2/3（行動指標の計画: 本人＝人件費×3、会社＝人件費×2）
    for i in range(5):
        target(f"YJ-T{i + 7:02d}", 1, FIRST_PLAN, "架空の会社", "会社", PERIOD_NAMES[i],
               self_amounts[i] * 2 // 3 + r_t.between(11, 89), "有効")
    for t in targets:
        while t["目標額（円）"] % 100 == 0 or t["目標額（円）"] % 10 == 0:
            t["目標額（円）"] += 7

    r_p = rng("plans")
    plans, adoptions = [], []
    plan_range = {"買付": (41_000_000, 58_000_000), "販売委託": (9_200_000, 14_800_000), "自社出資": (142_000_000, 186_000_000),
                  "製作委員会": (31_000_000, 44_000_000), "制作受託": (8_100_000, 13_900_000)}
    pid = 0
    for i, period in enumerate(PERIOD_NAMES):
        versions_here = [(1, FIRST_PLAN, "改めた"), (2, CREATED, "有効")] if i == 0 else [(1, FIRST_PLAN, "有効")]
        for version, made, status in versions_here:
            for e in EARNINGS:
                lo, hi = plan_range[e]
                grow = 100 + 13 * i
                pid += 1
                plans.append({"計画ID": f"YJ-L{pid:03d}", "版": version, "作った日": iso(made), "期間": period, "稼ぎ方": e,
                              "計画額（円・税別）": r_p.irregular(lo * grow // 100, hi * grow // 100),
                              "根拠": "架空の計画（不規則な桁の架空額）", "状態": status, "fictional": True, "owner_user_email": OWNER})
            adoptions.append({"period": period, "version_no": version, "adopted_on": iso(made), "owner_user_email": OWNER,
                              "fictional": True})

    # ---- 行動（K-19: 率 面談→提案 50%・提案→契約 30%、1件あたりの額は架空。どれも仮置き）
    r_act = rng("action")
    actions = [{"稼ぎ方": e, "1件あたりの額（円・税別）": r_act.irregular(*ACTION_RANGE[e][:2]), "提案→契約の率": 0.3,
                "面談→提案の率": 0.5, "状態": "仮置き", "1件あたりの中身": ACTION_RANGE[e][2]} for e in EARNINGS]

    settings = {"採用シナリオ": ADOPTED, "締めた月": "2026-11-01", "着地確度": 0.8, "案件数目標": 7, "月別の予測範囲": "企画中も含む",
                "期間": [{"期間": n, "始め": iso(s), "終わり": iso(e)} for n, s, e in PERIODS]}

    pending = docs["yojitsu-actuals.json"]["pending"]

    vocabulary = {
        "earning_types": [{"name": e, "project_type": EARNING_INFO[e][0], "inflow_kubun": EARNING_INFO[e][1],
                           "default_sales_rate_bps": EARNING_INFO[e][2], "rate_status": EARNING_INFO[e][3],
                           "rate_basis": EARNING_INFO[e][4]} for e in EARNINGS],
        "stages": [{"name": n, "probability_bps": b} for n, b in STAGES],
        "kubun": [{"name": k, "direction": d, "sales_source": s} for k, d, s in KUBUN],
        "statuses": STATUSES,
        "steps": STEPS,
        "activity_stages": [{"role": role, "earning_type": e, "stage": s, "step": step}
                            for (role, e), seq in ACT_STAGES.items() for s, step in seq],
        "activity_results": RESULTS,
        "pa_bearers": PA_BEARERS,
        "expense_categories": EXPENSE_CATEGORIES,
        "production_cost_basis_kinds": PCOST_BASES,
        "production_cost_burden_kinds": BURDEN_KINDS,
        "scenarios": SCENARIOS,
    }
    notes = [
        "入力の表（目標・計画・案件・予測・実績・活動記録・行動・設定・試算の案件）は build_yojitsu.py の --seed の形。行の英字の鍵"
        "（fictional・owner_user_email・target_basis・project_type・rate_bps・rate_status・base_status・receipt_id・invoice_number・"
        "stage・result・work_code）は統合システムが使い、generate.py --build-yojitsu-input が列の名前だけに絞った写しを書く",
        "稼ぎ方は5つ（D-039 の 2026-10-10 の追記）。build_yojitsu.py の稼ぎ方（EARN）は 2026-10-08 の4つのままで、--seed の行動は"
        "その4つちょうどを求める。build_yojitsu.py が5つになるまで、golden.py が読み込んだモジュールの稼ぎ方の語だけを種の5つに"
        "差し替えて流す（ファイルは書き換えない。差し替えたかどうかは golden の build_yojitsu に書く）",
        "案件の型（project_type）は稼ぎ方からの仮の対応。型×稼ぎ方×4区分の対応表は計画の #4 が決める",
        "製作委員会の案件の売上率は、自社の出資比率（investments の own_ratio_bps）と同じ値の仮置き",
        "予測の金額は区分の入金・出金の額で、売上率を掛ける前。施策の既定の予測行（K-17 の形）も基準額を12か月に分けた入金の額"
        "（12か月の合計＝基準額）。K-17 の文言は「売上見込（＝基準額×売上率）を12か月に均等」で、そのまま入れると予測の金額×売上率で"
        "率を二重に掛けるので、率を掛ける前の基準額を割る読みにした。#12a の PR で代表が K-17 を確かめるときにこの読みも確かめ、"
        "売上見込を割ると決まったら default12 と試験を作り直す",
        "P&A の実費は区分マスタ（入金4・出金5）に区分が無いので「実績」に入れず、expenses に負担者つきで持つ。負担者が出資の実費は、"
        "出資に含む P&A（制作費の版の内訳の P&A）の枠に収める",
        "経費の paid_on は計上月の翌月の支払日。種の時点より後に払う経費（計上月 2026-11）は未払で paid_on が null"
        "（expense_payments の行が無い。入金ベースでは出金に数えない）",
        "制作受託の案件の制作の実費の予測は、総製作費から受託費（総製作費×率）を除いた分に収める（率＋実費の割合 ≦ 100%）",
        "目標（会社）は同じ期間の有効な目標（本人）の約 2/3（行動指標の計画: 本人＝人件費×倍率（既定3）、会社＝人件費×2）",
        "入金は入金の確認の128件だけ。確認が要る9件は承認するまで登録しないので pending_receipts に置き、実績の行にしない",
    ]

    seed_doc = {
        "fictional": True, "notice": NOTICE, "generator": "generate.py", "seed": seed, "as_of": iso(AS_OF),
        "owner_user_email": OWNER, "sources": sources, "notes": notes, "vocabulary": vocabulary,
        "設定": settings, "行動": actions, "目標": targets, "計画": plans, "plan_adoptions": adoptions,
        "案件": project_rows, "works": works, "investments": investments, "production_cost_versions": versions,
        "pa_budgets": pa_budgets, "expenses": expenses, "予測": forecasts, "実績": actuals, "pending_receipts": pending,
        "活動記録": activities, "試算の案件": {},
    }
    self_check(seed_doc, k17_start)
    return seed_doc


def self_check(s, k17_start):
    """書く前の最小の確かめ（node の試験と同じ観点の一部。ここで落ちたら書かない）。"""
    assert len(s["案件"]) == 32 and {p["稼ぎ方"] for p in s["案件"]} == set(EARNINGS)
    assert all(a["案件コード"] for a in s["活動記録"]), "活動記録の案件は必須（FR-REV-YOJITSU-035）"
    assert len(s["予測"]) >= 735, len(s["予測"])
    assert len(s["活動記録"]) >= 30, len(s["活動記録"])
    assert {w["work_code"] for w in s["works"]} == {v["work_code"] for v in s["production_cost_versions"]}
    assert {x["bearer"] for x in s["expenses"] if x["bearer"]} == set(PA_BEARERS)
    for t in s["目標"] + s["計画"]:
        amount = t.get("目標額（円）", t.get("計画額（円・税別）"))
        assert t["fictional"] is True and amount % 100 and amount % 1000, t
    for code, start in k17_start.items():
        rows = [f for f in s["予測"] if f["案件コード"] == code]
        assert rows[0]["月"] == iso(start) and len(rows) == 12


# ---------------------------------------------------------------- 書き出し
def render(v, depth=0) -> str:
    """最上位と2段目までを開き、表の行は1行に1件で書く（差分を読みやすくする）。"""
    pad = "  " * depth
    if isinstance(v, dict) and v and depth < 2:
        body = ",\n".join(f"{pad}  {json.dumps(k, ensure_ascii=False)}: {render(x, depth + 1)}" for k, x in v.items())
        return "{\n" + body + "\n" + pad + "}"
    if isinstance(v, list) and v and depth < 2:
        body = ",\n".join(f"{pad}  {json.dumps(x, ensure_ascii=False)}" for x in v)
        return "[\n" + body + "\n" + pad + "]"
    return json.dumps(v, ensure_ascii=False)


def dump(obj) -> bytes:
    return (render(obj) + "\n").encode("utf-8")


def build_yojitsu_input(seed_doc):
    """build_yojitsu.py --seed に渡す写し（入力の表を列の名前だけに絞る）。"""
    out = {name: [{c: row[c] for c in cols} for row in seed_doc[name]] for name, cols in COLS.items()}
    out["行動"] = [{h: row[h] for h in ACTION_HEADS} for row in seed_doc["行動"]]
    out["設定"] = seed_doc["設定"]
    out["試算の案件"] = seed_doc["試算の案件"]
    return out


def main():
    ap = argparse.ArgumentParser(description="案件収支の予実の架空の種（seed.json）を作る")
    ap.add_argument("--out", type=Path, default=HERE)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--build-yojitsu-input", type=Path, help="build_yojitsu.py --seed に渡す写しを書くファイル")
    args = ap.parse_args()
    doc = build(args.seed)
    data = dump(doc)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "seed.json").write_bytes(data)
    if args.build_yojitsu_input:
        args.build_yojitsu_input.write_bytes(
            (json.dumps(build_yojitsu_input(doc), ensure_ascii=False, indent=1) + "\n").encode("utf-8"))
    print(f"seed.json={hashlib.sha256(data).hexdigest()[:12]} 予測={len(doc['予測'])} 活動記録={len(doc['活動記録'])} "
          f"実績={len(doc['実績'])}")


if __name__ == "__main__":
    main()
