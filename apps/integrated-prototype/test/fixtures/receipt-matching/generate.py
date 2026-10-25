#!/usr/bin/env python3
"""入金の確認の架空データ（請求・入金128件・正解表）を作る。

会社ルート plans/2026-10-08-loop-and-exception-ux.md の香盤表 #3。突き合わせの純関数（同 #5）・Z3 の不変条件（同 #4）・
フェーズ1 の架空の種（plans/2026-10-08-phase1-five-second-yojitsu.md の #23a）が読む。

- 統合システムの関数（src/）を使わず、Python の標準ライブラリだけで独立に作る。金額は整数円と fractions.Fraction で計算し、
  浮動小数点を使わない（税の独立オラクル fixtures/tax-rounding-independent.json と同じ型）
- 乱数は自前の splitmix64。Python の版で random の結果が変わっても、同じ種なら同じバイト列になる
- 語は brain の wiki/01_rules/ontology.md「業務フローの語彙」（差額の原因の5語、語で説明できない残りの3語、名義が辞書に無い）
- 確認が要る9件は、計画で選んだ画面の案A（受信箱）のモックの9件の型（決定ログ 2026-10-08）。額はモックと違い、為替の表と
  契約の税率から1円まで説明できる値
- 自動で一致する119件は、その時点の取引先の未消込の請求のうち、金額が合う組がちょうど1つになるように作る（合わなければ作り直す）
- データはすべて架空。社名・作品名は「（架空）」付き、コードは RM-*・YJ-*。額は乱数で作り、実在の額を写していない

書くファイル（--out。既定はこのファイルのフォルダ）:
  invoices.json         取引先・名寄せの辞書・契約の条件・作品と案件（仮の対応）・請求（請求明細に work_id）・差額の根拠の表
  receipts.json         2026-11 の入金（銀行明細の行）128件
  answers.json          正解表（各入金がどの請求をいくら消し込むか、控除の種類と額、確認が要る9件とその理由）
  yojitsu-actuals.json  正解表の消込から取り出した、案件コード付きの入金の行（会社ルート ORG/事業計画/_build/build_yojitsu.py の
                        「実績」の10列。種の JSON の "実績" へそのまま入る形）

使い方: python generate.py [--out <フォルダ>] [--seed <整数>]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from fractions import Fraction
from itertools import combinations
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEED = 20261108
NOTICE = "架空データ。入金の確認の試験専用で、実在の取引先・作品・金額ではない"
FILES = ("invoices.json", "receipts.json", "answers.json", "yojitsu-actuals.json")

MONTH = (2026, 11)                 # 入金の月（1か月分）
AS_OF = dt.date(2026, 11, 30)      # 一括で承認した日（実績の「記録した日」）
# 2026-09〜11 の祝日（国民の休日を含む）。入金日・請求日は営業日だけにする
HOLIDAYS = {dt.date(2026, 9, 21), dt.date(2026, 9, 22), dt.date(2026, 9, 23), dt.date(2026, 10, 12),
            dt.date(2026, 11, 3), dt.date(2026, 11, 23)}

# 語（brain の ontology「業務フローの語彙」2026-10-09）
CAUSES = ("銀行手数料", "外国で源泉された額", "為替の確定", "返品の相殺", "一部入金")
LEFTOVERS = ("請求前の入金", "二重入金の疑い", "対応なし")
NAME_MISSING = "名義が辞書に無い"
AUTO, REVIEW = "自動で一致", "確認が要る"
RULE_EXACT, RULE_SUM, RULE_DIFF, RULE_NONE, RULE_NAME = (
    "金額の完全一致", "合計の一致（まとめ払い）", "差額の原因で説明", "対応する請求なし", "名義が辞書に無い")

# build_yojitsu.py の COLS["実績"]（列の名前と並び）と、入金の区分（KUBUN のうち入金で売上の元になるもの）
ACTUAL_COLS = ["実績ID", "日付", "案件コード", "区分", "項目", "相手", "金額（円・税別）", "証憑", "記録した日", "メモ"]
# 稼ぎ方 → 区分。稼ぎ方5つ（brain D-039 の 2026-10-10 の追記）のうち、作品のある自社出資・製作委員会・買付だけを置き、
# 販売委託・制作受託の案件と入金の行は持たない。型と区分（フェーズ1の計画の U-9）と委託の純額（行動指標の計画の J-11a）は決まっており、
# 残る未決は受託の予測の持ち方（FR-REV-CWORK-031）。作品の無い案件の入金は #14b が「未確定」と出す。
# 販売委託・制作受託の案件は #23a の種（fixtures/yojitsu/）が持ち、入金はこの128件だけなので、その2つの稼ぎ方の入金の行は無い
EARNING_KUBUN = {"自社出資": "流通売上", "製作委員会": "流通売上", "買付": "流通売上"}

# ---------------------------------------------------------------- 取引先
# (コード, 名前, 振込名義（名寄せの辞書に入れる。先頭を入金に使う）, 国, 通貨, 振込手数料の負担, 支払日（0 は末日）, 種類, 契約の条)
# 振込手数料の負担: payer＝先方負担（満額が届く）、payee＝当方負担（手数料を引いて届く）
PARTNERS = [
    ("RM-PF-A", "配信会社A（架空）", ["ﾊｲｼﾝｶｲｼﾔｴｰ"], "JP", "JPY", "payee", 0, "配信", "第5条"),
    ("RM-TH-B", "劇場チェーンB（架空）", ["ｹﾞｷｼﾞﾖｳﾁｴｰﾝﾋﾞｰ", "ｶ)ｹﾞｷｼﾞﾖｳﾁｴｰﾝﾋﾞｰ"], "JP", "JPY", "payer", 0, "劇場", "第6条"),
    ("RM-OS-C", "海外セールスC（架空・米国）", ["OVERSEAS SALES C"], "US", "USD", "payee", 25, "海外", "第8条"),
    ("RM-SEL-D", "パッケージ販売D（架空）", ["ﾊﾟﾂｹｰｼﾞﾊﾝﾊﾞｲﾃﾞｲｰ"], "JP", "JPY", "payer", 20, "パッケージ", "第7条"),
    ("RM-PF-E", "配信会社E（架空）", ["ﾊｲｼﾝｶｲｼﾔｲｰ"], "JP", "JPY", "payer", 10, "配信", "第5条"),
    ("RM-DS-F", "配給会社F（架空）", ["ﾊｲｷﾕｳｶﾞｲｼﾔｴﾌ"], "JP", "JPY", "payer", 25, "配給", "第9条"),
    ("RM-OS-G", "海外配給G（架空・ドイツ）", ["GLOBAL FILMS G"], "DE", "EUR", "payer", 20, "海外", "第8条"),
    ("RM-DS-H", "配給会社H（架空）", ["ﾊｲｷﾕｳｶﾞｲｼﾔｴｲﾁ"], "JP", "JPY", "payer", 15, "配給", "第6条"),
    ("RM-DS-J", "配給会社J（架空）", ["ﾊｲｷﾕｳｶﾞｲｼﾔｼﾞｴｲ"], "JP", "JPY", "payer", 0, "配給", "第6条"),
    ("RM-PF-K", "配信会社K（架空）", ["ﾊｲｼﾝｶｲｼﾔｹｲ", "ｶ)ﾊｲｼﾝｶｲｼﾔｹｲ"], "JP", "JPY", "payer", 0, "配信", "第5条"),
    ("RM-PF-L", "配信会社L（架空）", ["ﾊｲｼﾝｶｲｼﾔｴﾙ"], "JP", "JPY", "payer", 20, "配信", "第5条"),
    ("RM-PF-M", "配信会社M（架空）", ["ﾊｲｼﾝｶｲｼﾔｴﾑ"], "JP", "JPY", "payer", 25, "配信", "第5条"),
    ("RM-TV-N", "放送局N（架空）", ["ﾎｳｿｳｷﾖｸｴﾇ"], "JP", "JPY", "payer", 0, "放送", "第4条"),
    ("RM-TV-P", "放送局P（架空）", ["ﾎｳｿｳｷﾖｸﾋﾟｰ", "ｶ)ﾎｳｿｳｷﾖｸﾋﾟｰ"], "JP", "JPY", "payer", 15, "放送", "第4条"),
    ("RM-RNT-Q", "レンタルチェーンQ（架空）", ["ﾚﾝﾀﾙﾁｴｰﾝｷﾕｰ"], "JP", "JPY", "payer", 10, "レンタル", "第7条"),
    ("RM-RNT-R", "レンタルチェーンR（架空）", ["ﾚﾝﾀﾙﾁｴｰﾝｱｰﾙ"], "JP", "JPY", "payer", 20, "レンタル", "第7条"),
    ("RM-SEL-S", "パッケージ販売S（架空）", ["ﾊﾟﾂｹｰｼﾞﾊﾝﾊﾞｲｴｽ"], "JP", "JPY", "payer", 0, "パッケージ", "第7条"),
    ("RM-SEL-T", "パッケージ販売T（架空）", ["ﾊﾟﾂｹｰｼﾞﾊﾝﾊﾞｲﾃｲｰ"], "JP", "JPY", "payer", 25, "パッケージ", "第7条"),
    ("RM-TH-U", "劇場U（架空）", ["ｹﾞｷｼﾞﾖｳﾕｰ"], "JP", "JPY", "payer", 15, "劇場", "第6条"),
    ("RM-TH-V", "劇場V（架空）", ["ｹﾞｷｼﾞﾖｳﾌﾞｲ"], "JP", "JPY", "payer", 0, "劇場", "第6条"),
    ("RM-PF-W", "配信会社W（架空）", ["ﾊｲｼﾝｶｲｼﾔﾀﾞﾌﾞﾘﾕｰ"], "JP", "JPY", "payer", 10, "配信", "第5条"),
    ("RM-AIR-X", "機内上映X（架空）", ["ｷﾅｲｼﾞﾖｳｴｲｴﾂｸｽ"], "JP", "JPY", "payer", 25, "機内上映", "第6条"),
    ("RM-EDU-Y", "教育配給Y（架空）", ["ｷﾖｳｲｸﾊｲｷﾕｳﾜｲ"], "JP", "JPY", "payer", 20, "教育", "第6条"),
    ("RM-HTL-Z", "ホテル配信Z（架空）", ["ﾎﾃﾙﾊｲｼﾝｾﾞﾂﾄ"], "JP", "JPY", "payer", 0, "ホテル配信", "第5条"),
]
P = {row[0]: dict(zip(("code", "name", "payer_names", "country", "currency", "fee_borne_by", "pay_day", "kind", "clause"), row))
     for row in PARTNERS}
ORDER = {row[0]: i for i, row in enumerate(PARTNERS)}
UNKNOWN_PAYER = "ｶ)ｴｲｶﾞﾊｲｷﾕｳ"  # 辞書に無い名義（確認が要る9件の1つ）

# 自動で一致する入金: 取引先ごとに (1件ずつの入金の数, まとめ払いの入金ごとの請求の数)。合計 110 + 9 = 119 件
AUTO_PLAN = {
    "RM-TH-B": (6, []), "RM-SEL-D": (5, [2]), "RM-PF-E": (2, []), "RM-DS-F": (3, []), "RM-DS-H": (4, []),
    "RM-DS-J": (4, []), "RM-PF-K": (9, [2]), "RM-PF-L": (8, []), "RM-PF-M": (6, [3]), "RM-TV-N": (6, []),
    "RM-TV-P": (4, [2]), "RM-RNT-Q": (8, []), "RM-RNT-R": (6, [2]), "RM-SEL-S": (7, []), "RM-SEL-T": (5, [2]),
    "RM-TH-U": (5, []), "RM-TH-V": (5, [3]), "RM-PF-W": (7, []), "RM-AIR-X": (4, [2]), "RM-EDU-Y": (3, []),
    "RM-HTL-Z": (3, [2]),
}
# 月末に残る未入金の請求（2026-11 の請求日。突き合わせの紛れ）を持たない取引先
NO_OPEN = {"RM-PF-E"}
# 別の取引先の支払済みの請求と同じ明細（同じ額）の未入金の請求を持たせる（取引先を見ずに額だけで当てると誤る）
COPY_OPEN = {"RM-PF-L": ("RM-PF-K", 1), "RM-RNT-R": ("RM-SEL-D", 0)}

# 請求明細1行の税抜額の幅（架空の仮置き）
LINE_RANGE = {"配信": (28_000, 860_000), "劇場": (90_000, 1_400_000), "パッケージ": (35_000, 640_000),
              "放送": (180_000, 1_250_000), "レンタル": (18_000, 380_000), "配給": (60_000, 980_000),
              "機内上映": (45_000, 420_000), "教育": (16_000, 210_000), "ホテル配信": (9_000, 140_000)}

# ---------------------------------------------------------------- 作品と案件（#23a の種 fixtures/yojitsu/seed.json が同じ作品・案件を持つ。
# コードや対応を変えたら、ここを作り直してから種も作り直す）
PROJECTS = [
    ("YJ-P01", "架空案件01（架空）", "自社出資"), ("YJ-P02", "架空案件02（架空）", "自社出資"),
    ("YJ-P03", "架空案件03（架空）", "自社出資"), ("YJ-P04", "架空案件04（架空）", "自社出資"),
    ("YJ-P05", "架空案件05（架空）", "製作委員会"), ("YJ-P06", "架空案件06（架空）", "製作委員会"),
    ("YJ-P07", "架空案件07（架空）", "製作委員会"), ("YJ-P08", "架空案件08（架空）", "買付"),
    ("YJ-P09", "架空案件09（架空）", "買付"), ("YJ-P10", "架空案件10（架空）", "買付"),
]
WORK_PROJECT = ["YJ-P01", "YJ-P01", "YJ-P02", "YJ-P03", "YJ-P03", "YJ-P04", "YJ-P05", "YJ-P05",
                "YJ-P06", "YJ-P07", "YJ-P08", "YJ-P08", "YJ-P09", "YJ-P09", "YJ-P10", "YJ-P10"]
WORKS = [{"work_id": i + 1, "work_code": f"YJ-W{i + 1:02d}", "title": f"架空作品{i + 1:02d}（架空）", "project_code": p}
         for i, p in enumerate(WORK_PROJECT)]

# 為替の表（公表仲値。小数4桁の文字で持つ）。正解表は入金日の円もこの表から出す。要件 FR-REV-INTAKE-084・075 は入金日の
# レートを「円の入金額＋控除÷外貨の額、小数4桁で切り捨て」と定める。C（米国）はどちらでも 145.0400 で同じ値になるが、
# G（ドイツ）は逆算だと 812,025÷5,100＝159.2205 で、為替の確定は 18,003円・残り3円でなく 18,000円前後になる。
# 入金日のレートの出どころは、入金の確認の計画の #5 か #6 で決める（逆算にするなら G を作り直す）
RATES = [("USD", "2026-09-30", "147.0600"), ("USD", "2026-11-25", "145.0400"),
         ("EUR", "2026-09-30", "162.7500"), ("EUR", "2026-11-20", "159.2200")]

MASK = (1 << 64) - 1


class Rng:
    """splitmix64。種は文字列の SHA-256 から取り、取引先・作り直しの回ごとに独立した列にする。"""

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

    def pick(self, seq):
        return seq[self.below(len(seq))]

    def sample(self, seq, k: int):
        pool = list(seq)
        for i in range(k):
            j = i + self.below(len(pool) - i)
            pool[i], pool[j] = pool[j], pool[i]
        return pool[:k]


# ---------------------------------------------------------------- 日付
def is_business(d: dt.date) -> bool:
    return d.weekday() < 5 and d not in HOLIDAYS


def prev_business(d: dt.date) -> dt.date:
    while not is_business(d):
        d -= dt.timedelta(days=1)
    return d


def month_end(y: int, m: int) -> dt.date:
    nxt = dt.date(y + (m == 12), m % 12 + 1, 1)
    return nxt - dt.timedelta(days=1)


def nominal(y: int, m: int, day: int) -> dt.date:
    """支払日（0 は末日）の暦の日。期日に使う（営業日に寄せない）。"""
    return month_end(y, m) if day == 0 else dt.date(y, m, day)


def business_days(y: int, m: int, lo: int = 1, hi: int = 31):
    return [d for d in (dt.date(y, m, 1) + dt.timedelta(days=i) for i in range(31))
            if d.month == m and lo <= d.day <= hi and is_business(d)]


def pay_date(code: str) -> dt.date:
    """取引先の 2026-11 の支払日（休みなら前の営業日）。"""
    return prev_business(nominal(*MONTH, P[code]["pay_day"]))


def payer_name(code: str, seq: int) -> str:
    """辞書に名義が2つある取引先は、入金ごとに名義を替える。"""
    names = P[code]["payer_names"]
    return names[seq % len(names)]


def iso(d: dt.date) -> str:
    return d.isoformat()


def trunc_yen(x: Fraction) -> int:
    """0 に向かう切り捨て（要件 FR-REV-INTAKE-082）。"""
    return int(x)


# ---------------------------------------------------------------- 請求
def make_invoice(code, invoice_date, due_date, period, lines, *, currency="JPY", foreign=None, report_date=None, rate=None,
                 tag=""):
    """lines: [(work_id, 税抜額, 摘要)]。消費税は請求書ごとに税抜の合計の10%を切り捨て、行へは最大剰余法で配る。
    外貨の請求（国外の相手）は消費税0で、円は外貨×報告の日の公表仲値を切り捨てた額。"""
    if currency == "JPY":
        total_ex = sum(a for _, a, _ in lines)
        tax = trunc_yen(Fraction(total_ex, 10))
        exact = [Fraction(a, 10) for _, a, _ in lines]
        floors = [trunc_yen(x) for x in exact]
        rest = tax - sum(floors)
        order = sorted(range(len(lines)), key=lambda i: (-(exact[i] - floors[i]), i))
        taxes = floors[:]
        for i in order[:rest]:
            taxes[i] += 1
    else:
        taxes = [0] * len(lines)
    out_lines = []
    for n, ((work_id, ex, desc), t) in enumerate(zip(lines, taxes), start=1):
        out_lines.append({"line_no": n, "work_id": work_id, "work_code": WORKS[work_id - 1]["work_code"], "description": desc,
                          "accounting_month": period, "amount_ex_tax": ex, "tax_amount": t, "amount_inc_tax": ex + t})
    inv = {"partner_code": code, "invoice_date": iso(invoice_date), "due_date": iso(due_date), "period": period,
           "currency": currency, "foreign_amount": foreign, "report_date": report_date, "report_rate": rate,
           "amount_ex_tax": sum(x["amount_ex_tax"] for x in out_lines), "tax_amount": sum(x["tax_amount"] for x in out_lines),
           "amount_inc_tax": sum(x["amount_inc_tax"] for x in out_lines), "lines": out_lines, "_tag": tag}
    assert invoice_date <= due_date
    return inv


def random_lines(rng: Rng, code: str, period: str, n_lines: int):
    lo, hi = LINE_RANGE[P[code]["kind"]]
    works = rng.sample(range(1, len(WORKS) + 1), n_lines)
    return [(w, rng.between(lo, hi), f"{P[code]['kind']} {period}分（{WORKS[w - 1]['title']}）") for w in works]


def gen_partner(seed: int, code: str, attempt: int, copy_lines=None):
    """1つの取引先の請求と、自動で一致する入金（意図した消込つき）を作る。"""
    rng = Rng(seed, code, attempt)
    singles, bundles = AUTO_PLAN[code]
    pd = pay_date(code)
    pay_day = P[code]["pay_day"]
    invoices, receipts = [], []

    def oct_invoice(lines, tag):
        d = rng.pick(business_days(2026, 10, 1, 28))
        return make_invoice(code, d, nominal(2026, 11, pay_day), "2026-09", lines, tag=tag)

    for i in range(singles):
        if code == "RM-TV-N" and i == 0:
            # 毎月同じ額の放送権料。9月分（10/5 付）を 11/2 に払う。10月分（11/5 付・同じ額）はまだ請求日前なので当たらない
            lines = [(7, 418_000, "放送 定額の放送権料 2026-09分（架空作品07（架空））")]
            inv = make_invoice(code, dt.date(2026, 10, 5), nominal(2026, 11, pay_day), "2026-09", lines, tag="fixed-sep")
            date = dt.date(2026, 11, 2)
        elif rng.below(6) == 0:
            # 期日を過ぎた入金（8月分・9月付の請求）。月の途中の営業日に届く
            lines = random_lines(rng, code, "2026-08", 1 + rng.below(3))
            d = rng.pick(business_days(2026, 9, 1, 25))
            inv = make_invoice(code, d, nominal(2026, 10, pay_day), "2026-08", lines, tag="late")
            date = rng.pick(business_days(*MONTH, 2, 27))
        else:
            inv = oct_invoice(random_lines(rng, code, "2026-09", 1 + rng.below(3)), "single")
            date = pd
        invoices.append(inv)
        receipts.append({"partner_code": code, "date": date, "invoices": [inv], "kind": AUTO, "rule": RULE_EXACT})
    for k in bundles:
        group = [oct_invoice(random_lines(rng, code, "2026-09", 1 + rng.below(2)), "bundle") for _ in range(k)]
        invoices.extend(group)
        receipts.append({"partner_code": code, "date": pd, "invoices": group, "kind": AUTO, "rule": RULE_SUM})
    if code == "RM-TV-N":
        lines = [(7, 418_000, "放送 定額の放送権料 2026-10分（架空作品07（架空））")]
        invoices.append(make_invoice(code, dt.date(2026, 11, 5), nominal(2026, 12, pay_day), "2026-10", lines, tag="fixed-oct"))
    elif code not in NO_OPEN:
        d = rng.pick(business_days(*MONTH, 2, 12))
        if copy_lines:
            lines = [(w, a, f"{P[code]['kind']} 2026-10分（{WORKS[w - 1]['title']}）") for w, a, _ in copy_lines]
        else:
            lines = random_lines(rng, code, "2026-10", 1 + rng.below(3))
        invoices.append(make_invoice(code, d, nominal(2026, 12, pay_day), "2026-10", lines, tag="open"))
    return invoices, receipts


# ---------------------------------------------------------------- 確認が要る9件（案A のモックの型）
def rate_of(cur: str, date: str) -> Fraction:
    for c, d, r in RATES:
        if c == cur and d == date:
            return Fraction(r)
    raise KeyError((cur, date))


def review_cases():
    """確認が要る9件の請求と入金。answer の部分（消込・控除・内訳）は請求番号が決まってから埋める。"""
    inv, rec = {}, []
    # 1. 外国で源泉された額・為替の確定・銀行手数料（米国の相手。USD 14,000、源泉10%、被仕向送金の手数料 4,000円）
    usd, withheld = Fraction(14000), Fraction(1400)
    r_rep, r_rec = rate_of("USD", "2026-09-30"), rate_of("USD", "2026-11-25")
    inv["C"] = make_invoice("RM-OS-C", dt.date(2026, 10, 5), nominal(2026, 11, 30), "2026-09",
                            [(11, trunc_yen(usd * r_rep), "海外 2026-07〜09分（架空作品11（架空））")],
                            currency="USD", foreign="14000.00", report_date="2026-09-30", rate="147.0600", tag="review")
    fee_c = 4_000
    cash_c = trunc_yen((usd - withheld) * r_rec) - fee_c
    rec.append({"key": "C", "partner_code": "RM-OS-C", "date": dt.date(2026, 11, 25), "amount": cash_c,
                "currency": "USD", "foreign_amount": "12600.00"})
    # 2・3. 配信会社A（振込手数料は当方負担）の2件のまとめ払いから 660円。同じ日・同じ額・同じ名義の入金がもう1件（二重入金の疑い）
    inv["A1"] = make_invoice("RM-PF-A", dt.date(2026, 10, 9), nominal(2026, 11, 0), "2026-09",
                             [(1, 412_350, "配信 2026-09分（架空作品01（架空））")], tag="review")
    inv["A2"] = make_invoice("RM-PF-A", dt.date(2026, 10, 23), nominal(2026, 11, 0), "2026-09",
                             [(3, 587_650, "配信 2026-09分（架空作品03（架空））")], tag="review")
    cash_a = inv["A1"]["amount_inc_tax"] + inv["A2"]["amount_inc_tax"] - 660
    rec.append({"key": "A", "partner_code": "RM-PF-A", "date": dt.date(2026, 11, 30), "amount": cash_a})
    rec.append({"key": "A-dup", "partner_code": "RM-PF-A", "date": dt.date(2026, 11, 30), "amount": cash_a})
    # 4. 返品の相殺（売上報告に返品50本 × 税抜1,000円の行。請求には載っていない）
    inv["D"] = make_invoice("RM-SEL-D", dt.date(2026, 10, 20), nominal(2026, 11, 20), "2026-09",
                            [(4, 500_000, "パッケージ 2026-09分（架空作品04（架空））")], tag="review")
    rec.append({"key": "D", "partner_code": "RM-SEL-D", "date": dt.date(2026, 11, 20), "amount": inv["D"]["amount_inc_tax"] - 55_000})
    # 5. 請求前の入金（名義は辞書にある。10月分の売上報告がまだ届いていない）
    rec.append({"key": "E", "partner_code": "RM-PF-E", "date": dt.date(2026, 11, 27), "amount": 330_000})
    # 6. 名義が辞書に無い（同じ額の未消込が配給会社Hと配給会社Jにある）
    inv["H"] = make_invoice("RM-DS-H", dt.date(2026, 10, 15), nominal(2026, 11, 15), "2026-09",
                            [(13, 70_000, "配給 2026-09分（架空作品13（架空））")], tag="candidate")
    inv["J"] = make_invoice("RM-DS-J", dt.date(2026, 10, 23), nominal(2026, 11, 0), "2026-09",
                            [(14, 70_000, "配給 2026-09分（架空作品14（架空））")], tag="candidate")
    rec.append({"key": "NAME", "partner_code": None, "payer": UNKNOWN_PAYER, "date": dt.date(2026, 11, 13), "amount": 77_000})
    # 7. 一部入金（入金予定の変更が承認済み。1回目 1,000,000円）
    inv["F"] = make_invoice("RM-DS-F", dt.date(2026, 10, 15), nominal(2026, 11, 25), "2026-09",
                            [(9, 1_500_000, "配給 2026-09分（架空作品09（架空））")], tag="review")
    rec.append({"key": "F", "partner_code": "RM-DS-F", "date": dt.date(2026, 11, 25), "amount": 1_000_000})
    # 8. 為替の確定（ドイツの相手。EUR 5,100。入金日のレートで出した円より 3円多く届いた）
    eur = Fraction(5100)
    inv["G"] = make_invoice("RM-OS-G", dt.date(2026, 10, 5), nominal(2026, 11, 20), "2026-09",
                            [(15, trunc_yen(eur * rate_of("EUR", "2026-09-30")), "海外 2026-07〜09分（架空作品15（架空））")],
                            currency="EUR", foreign="5100.00", report_date="2026-09-30", rate="162.7500", tag="review")
    rec.append({"key": "G", "partner_code": "RM-OS-G", "date": dt.date(2026, 11, 20),
                "amount": trunc_yen(eur * rate_of("EUR", "2026-11-20")) + 3, "currency": "EUR", "foreign_amount": "5100.00"})
    # 9. 銀行手数料（契約と違う。劇場チェーンBは先方負担なのに 660円少ない）
    inv["B"] = make_invoice("RM-TH-B", dt.date(2026, 10, 20), nominal(2026, 11, 0), "2026-09",
                            [(2, 604_746, "劇場 2026-09分（架空作品02（架空））")], tag="review")
    rec.append({"key": "B", "partner_code": "RM-TH-B", "date": dt.date(2026, 11, 30), "amount": inv["B"]["amount_inc_tax"] - 660})
    return inv, rec


# ---------------------------------------------------------------- 一意性の確かめ
def matching_sets(open_invoices, balance, amount):
    """未消込の請求のうち、残高の合計が amount に一致する組をすべて返す（組の大きさに上限を置かない）。"""
    found = []
    items = [(inv["_uid"], balance[inv["_uid"]]) for inv in open_invoices]
    for k in range(1, len(items) + 1):
        for combo in combinations(items, k):
            if sum(b for _, b in combo) == amount:
                found.append(frozenset(u for u, _ in combo))
    return found


def check_partner(invoices, events):
    """取引先の入金を日付順に当て、自動で一致する入金は合う組がちょうど1つ、確認が要る入金は合う組が無いことを確かめる。"""
    balance = {inv["_uid"]: inv["amount_inc_tax"] for inv in invoices}
    for ev in sorted(events, key=lambda e: (e["date"], e["seq"])):
        open_ = [inv for inv in invoices if balance[inv["_uid"]] > 0 and inv["invoice_date"] <= iso(ev["date"])]
        sets = matching_sets(open_, balance, ev["amount"])
        if ev["kind"] == AUTO:
            if sets != [frozenset(i["_uid"] for i in ev["invoices"])]:
                return False
        elif sets:
            return False
        for uid, amount in ev["alloc"]:
            balance[uid] -= amount
            assert balance[uid] >= 0
    return True


# ---------------------------------------------------------------- 本体
def build(seed: int):
    r_inv, r_rec = review_cases()
    uid = 0

    def tag_uid(inv):
        nonlocal uid
        uid += 1
        inv["_uid"] = uid
        return inv

    for v in r_inv.values():
        tag_uid(v)
    # 確認が要る入金の消込（請求の uid で持つ）
    review_alloc = {
        "C": [(r_inv["C"]["_uid"], r_inv["C"]["amount_inc_tax"])],
        "A": [(r_inv["A1"]["_uid"], r_inv["A1"]["amount_inc_tax"]), (r_inv["A2"]["_uid"], r_inv["A2"]["amount_inc_tax"])],
        "A-dup": [], "E": [], "NAME": [],
        "D": [(r_inv["D"]["_uid"], r_inv["D"]["amount_inc_tax"])],
        "F": [(r_inv["F"]["_uid"], 1_000_000)],
        "G": [(r_inv["G"]["_uid"], r_inv["G"]["amount_inc_tax"])],
        "B": [(r_inv["B"]["_uid"], r_inv["B"]["amount_inc_tax"] - 660)],
    }
    review_invoices_of = {}
    for v in r_inv.values():
        review_invoices_of.setdefault(v["partner_code"], []).append(v)
    review_events_of = {}
    for i, r in enumerate(r_rec):
        if r["partner_code"]:
            review_events_of.setdefault(r["partner_code"], []).append(
                {"date": r["date"], "seq": 1000 + i, "kind": REVIEW, "amount": r["amount"], "alloc": review_alloc[r["key"]]})

    generated = {}
    all_invoices = list(r_inv.values())
    auto = []
    for code in [c for c, *_ in PARTNERS]:
        fixed_inv = review_invoices_of.get(code, [])
        fixed_ev = review_events_of.get(code, [])
        if code not in AUTO_PLAN:
            assert check_partner(fixed_inv, fixed_ev), code
            continue
        copy_lines = None
        if code in COPY_OPEN:
            src_code, idx = COPY_OPEN[code]
            src = generated[src_code][1][idx]["invoices"][0]
            copy_lines = [(x["work_id"], x["amount_ex_tax"], x["description"]) for x in src["lines"]]
        for attempt in range(200):
            invs, recs = gen_partner(seed, code, attempt, copy_lines)
            base = uid
            for inv in invs:
                tag_uid(inv)
            events = [{"date": r["date"], "seq": n, "kind": AUTO, "amount": sum(i["amount_inc_tax"] for i in r["invoices"]),
                       "invoices": r["invoices"], "alloc": [(i["_uid"], i["amount_inc_tax"]) for i in r["invoices"]]}
                      for n, r in enumerate(recs)]
            if check_partner(invs + fixed_inv, events + fixed_ev):
                break
            uid = base
        else:
            raise SystemExit(f"no unambiguous data for {code}")
        generated[code] = (invs, recs)
        all_invoices.extend(invs)
        for n, r in enumerate(recs):
            auto.append({**r, "seq": n, "amount": sum(i["amount_inc_tax"] for i in r["invoices"])})

    # 請求に番号を振る（請求日・取引先・作った順）
    all_invoices.sort(key=lambda v: (v["invoice_date"], ORDER[v["partner_code"]], v["_uid"]))
    per_month = {}
    for n, v in enumerate(all_invoices, start=1):
        ym = v["invoice_date"][:7].replace("-", "")
        per_month[ym] = per_month.get(ym, 0) + 1
        v["invoice_id"] = n
        v["invoice_number"] = f"RM-INV-{ym}-{per_month[ym]:03d}"
        v["report_ref"] = f"RM-R-{n:04d}"
        for line in v["lines"]:
            line["sale_ref"] = f"RM-S-{n:04d}-{line['line_no']}"

    # 入金を銀行明細の順に並べる（日付・取引先の順。同じ取引先の同じ日は自動で一致を先に、確認が要るを後に）
    rows = []
    for r in auto:
        rows.append({"date": r["date"], "order": ORDER[r["partner_code"]], "seq": r["seq"], "src": r})
    for i, r in enumerate(r_rec):
        rows.append({"date": r["date"], "order": ORDER[r["partner_code"]] if r["partner_code"] else len(ORDER),
                     "seq": 1000 + i, "src": r})
    rows.sort(key=lambda x: (x["date"], x["order"], x["seq"]))
    if len(rows) != 128:
        raise SystemExit(f"receipts={len(rows)}")

    receipts, answers = [], []
    key_to_id = {}
    for n, row in enumerate(rows, start=1):
        r = row["src"]
        code = r["partner_code"]
        receipts.append({"receipt_id": n, "bank_line": n, "received_on": iso(r["date"]),
                         "payer_name": r.get("payer") or payer_name(code, row["seq"]), "amount_yen": r["amount"],
                         "currency": r.get("currency", "JPY"), "foreign_amount": r.get("foreign_amount"),
                         "reference": f"RM-{MONTH[0]}{MONTH[1]:02d}-{n:03d}"})
        if "key" in r:
            key_to_id[r["key"]] = n
            answers.append({"receipt_id": n, "_key": r["key"]})
        else:
            answers.append({"receipt_id": n, "outcome": AUTO, "rule": r["rule"], "partner_code": code,
                            "allocations": [alloc(i, i["amount_inc_tax"], 0) for i in r["invoices"]],
                            "deductions": [], "unapplied_yen": 0, "review": None})

    rec_by_key = {r["key"]: r for r in r_rec}
    for a in answers:
        if "_key" in a:
            k = a.pop("_key")
            a.update(review_answer(k, rec_by_key[k], r_inv, key_to_id))
    keys = ("receipt_id", "outcome", "rule", "partner_code", "allocations", "deductions", "unapplied_yen", "review")
    answers = [{k: a[k] for k in keys} for a in answers]
    return all_invoices, receipts, answers, r_inv


def alloc(inv, amount, balance_after):
    return {"invoice_id": inv["invoice_id"], "invoice_number": inv["invoice_number"], "amount_yen": amount,
            "balance_after_yen": balance_after}


def evidence(mark, text, source):
    return {"mark": mark, "text": text, "source": source}


def review_answer(key, r, inv, key_to_id):
    """確認が要る入金の正解（突き合わせが出すべき提案と、確認が要る理由）。"""
    base = {"outcome": REVIEW, "partner_code": r["partner_code"], "deductions": [], "unapplied_yen": 0}
    if key == "C":
        c = inv["C"]
        r_rep, r_rec = rate_of("USD", "2026-09-30"), rate_of("USD", "2026-11-25")
        usd, withheld = Fraction(c["foreign_amount"]), Fraction("1400.00")
        yen_at_receipt = trunc_yen(usd * r_rec)
        fx = c["amount_inc_tax"] - yen_at_receipt
        wht = trunc_yen(withheld * r_rec)
        fee = yen_at_receipt - wht - r["amount"]
        assert (fx, wht, fee) == (c["amount_inc_tax"] - trunc_yen(usd * r_rec), 203_056, 4_000)
        deds = [
            {"kind": "外国で源泉された額", "amount_yen": wht, "invoice_number": c["invoice_number"], "country": "US",
             "rate_bps": 1000, "foreign_amount": "1400.00", "currency": "USD", "certificate_received": False},
            {"kind": "為替の確定", "amount_yen": fx, "invoice_number": c["invoice_number"], "currency": "USD",
             "foreign_amount": "14000.00", "rate_from": "147.0600", "rate_to": "145.0400"},
            {"kind": "銀行手数料", "amount_yen": fee, "invoice_number": None},
        ]
        diff = c["amount_inc_tax"] - r["amount"]
        return {**base, "rule": RULE_DIFF, "allocations": [alloc(c, c["amount_inc_tax"], 0)], "deductions": deds,
                "review": review(["外国で源泉された額", "為替の確定", "銀行手数料"], "warn", diff,
                                 [(d["kind"], d["amount_yen"]) for d in deds], [
                                     evidence("y", "契約の条件に「源泉税は相手国で控除・米国10%」がある", f"契約 C-RM-{ORDER['RM-OS-C'] + 1:02d} {P['RM-OS-C']['clause']}"),
                                     evidence("y", "取引先の国が米国で、租税条約の税率は10%", "取引先"),
                                     evidence("y", f"報告の日と入金日の公表仲値の差で {fx:,}円が説明できる", "為替の表"),
                                     evidence("q", "手数料 4,000円は過去3回と同じ額。今回の明細には内訳が無い", "入金の履歴"),
                                     evidence("n", "納税の証明書はまだ受け取っていない", "—")],
                                 alternative="手数料ではなく一部入金（残り4,000円が後日）。過去に分割の例は無い")}
    if key == "A":
        a1, a2 = inv["A1"], inv["A2"]
        fee = a1["amount_inc_tax"] + a2["amount_inc_tax"] - r["amount"]
        return {**base, "rule": RULE_DIFF,
                "allocations": [alloc(a1, a1["amount_inc_tax"], 0), alloc(a2, a2["amount_inc_tax"], 0)],
                "deductions": [{"kind": "銀行手数料", "amount_yen": fee, "invoice_number": None}],
                "review": review(["銀行手数料"], "ok", fee, [("銀行手数料", fee)], [
                    evidence("y", "2件の請求の合計が入金額＋660円で、期日が同じ月", "請求書"),
                    evidence("y", "契約に「振込手数料は当方負担」がある", f"契約 C-RM-{ORDER['RM-PF-A'] + 1:02d} {P['RM-PF-A']['clause']}"),
                    evidence("y", "同じ名義の過去6回の入金も 660円少ない", "入金の履歴")])}
    if key == "A-dup":
        return {**base, "rule": RULE_NONE, "allocations": [], "unapplied_yen": r["amount"],
                "review": review(["二重入金の疑い"], "bad", None, [], [
                    evidence("y", "同じ日に同じ額・同じ名義の入金が2件ある", f"銀行明細 {key_to_id['A']}行目・{key_to_id['A-dup']}行目"),
                    evidence("n", "2件目に当てる請求が無い", "請求書")],
                    alternative="返金するか、翌月分の前受けにするかを決める（理由が要る）", related_receipt_id=key_to_id["A"])}
    if key == "D":
        d = inv["D"]
        ret = d["amount_inc_tax"] - r["amount"]
        return {**base, "rule": RULE_DIFF, "allocations": [alloc(d, d["amount_inc_tax"], 0)],
                "deductions": [{"kind": "返品の相殺", "amount_yen": ret, "invoice_number": d["invoice_number"],
                                "report_ref": d["report_ref"], "report_row": 12}],
                "review": review(["返品の相殺"], "warn", ret, [("返品の相殺", ret)], [
                    evidence("y", "9月分の売上報告に返品50本・税込−55,000円の行がある", f"売上報告 {d['report_ref']} 12行目"),
                    evidence("q", "返品の行は請求に載っていない（相殺で処理された）", "請求書"),
                    evidence("y", "差額が返品の額と1円まで一致", "—")],
                    alternative="返品を売上の差額として計上し直すか、請求を訂正するかを決める")}
    if key == "E":
        return {**base, "rule": RULE_NONE, "allocations": [], "unapplied_yen": r["amount"],
                "review": review(["請求前の入金"], "bad", None, [], [
                    evidence("y", "名義は配信会社E（架空）として辞書にある", "名寄せの辞書"),
                    evidence("q", "10月分の売上報告がまだ届いていない（届くはずの報告）", "届くはずの報告"),
                    evidence("n", "この額の未消込の請求が無い", "請求書")],
                    alternative="売上報告が届くまで前受けとして保留できる")}
    if key == "NAME":
        h, j = inv["H"], inv["J"]
        return {**base, "rule": RULE_NAME, "partner_code": None, "allocations": [], "unapplied_yen": r["amount"],
                "review": review([NAME_MISSING], "bad", None, [], [
                    evidence("y", f"金額と期日が {h['invoice_number']}（配給会社H（架空））と一致", "請求書"),
                    evidence("q", f"名義「{UNKNOWN_PAYER}」は辞書に無い。候補は配給会社H・配給会社J", "名寄せの辞書"),
                    evidence("n", f"同じ額の未消込が配給会社J（架空）にもある（{j['invoice_number']}）", "請求書")],
                    alternative="選んだ取引先と名義の組は辞書に足す案として残し、次回からの候補に使う（採用は担当者）",
                    candidates=[{"partner_code": h["partner_code"], "invoice_number": h["invoice_number"]},
                                {"partner_code": j["partner_code"], "invoice_number": j["invoice_number"]}])}
    if key == "F":
        f = inv["F"]
        rest = f["amount_inc_tax"] - r["amount"]
        return {**base, "rule": RULE_DIFF, "allocations": [alloc(f, r["amount"], rest)],
                "review": review(["一部入金"], "warn", rest, [("一部入金", rest)], [
                    evidence("y", "入金予定の変更が承認済み（2回に分ける）", "入金予定の変更 RM-SC-0058"),
                    evidence("y", "1回目の予定額 1,000,000円と一致", "—")])}
    if key == "G":
        g = inv["G"]
        yen_at_receipt = trunc_yen(Fraction(g["foreign_amount"]) * rate_of("EUR", "2026-11-20"))
        fx = g["amount_inc_tax"] - yen_at_receipt
        over = r["amount"] - yen_at_receipt
        return {**base, "rule": RULE_DIFF, "allocations": [alloc(g, g["amount_inc_tax"], 0)],
                "deductions": [{"kind": "為替の確定", "amount_yen": fx, "invoice_number": g["invoice_number"], "currency": "EUR",
                                "foreign_amount": "5100.00", "rate_from": "162.7500", "rate_to": "159.2200"}],
                "unapplied_yen": over,
                "review": review(["為替の確定"], "warn", g["amount_inc_tax"] - r["amount"], [("為替の確定", fx)], [
                    evidence("y", f"報告の日と入金日のレートの差で {fx:,}円が説明できる", "為替の表"),
                    evidence("q", f"{over}円の差が残る（円の端数処理の違いと推定）", "—")],
                    alternative=f"{over}円を為替の確定に含めるか、不明として残すかを決める")}
    if key == "B":
        b = inv["B"]
        short = b["amount_inc_tax"] - r["amount"]
        return {**base, "rule": RULE_DIFF, "allocations": [alloc(b, r["amount"], short)],
                "review": review(["銀行手数料"], "bad", short, [], [
                    evidence("n", "契約では「振込手数料は先方負担」", f"契約 C-RM-{ORDER['RM-TH-B'] + 1:02d} {P['RM-TH-B']['clause']}"),
                    evidence("y", f"差額 {short}円は振込手数料の額と一致", "—")],
                    alternative=f"取引先に確かめる。消し込むと {short}円は未回収として請求に残る",
                    suspected=[{"cause": "銀行手数料", "amount_yen": short, "conflict": "契約では先方負担"}])}
    raise KeyError(key)


def review(reasons, level, difference, breakdown, ev, *, alternative=None, related_receipt_id=None, candidates=None,
           suspected=None):
    explained = sum(a for _, a in breakdown)
    return {"reasons": reasons, "level": level, "difference_yen": difference,
            "breakdown": [{"cause": c, "amount_yen": a} for c, a in breakdown], "explained_yen": explained,
            "remaining_yen": None if difference is None else difference - explained,
            "suspected": suspected or [], "candidates": candidates or [], "related_receipt_id": related_receipt_id,
            "evidence": ev, "alternative": alternative}


def actual_rows(invoices, receipts, answers):
    """自動で一致した消込を、請求明細の作品 → 案件で分けた入金の行にする（build_yojitsu.py の「実績」の10列）。
    自動で一致の消込は請求を全額消すので、税別は請求明細の税抜額をそのまま足す（比で割らない）。
    確認が要る入金は承認するまで登録しないので、行にしない。"""
    inv = {v["invoice_number"]: v for v in invoices}
    rec = {r["receipt_id"]: r for r in receipts}
    names = {c: P[c]["name"] for c in P}
    project_of = {w["work_id"]: w["project_code"] for w in WORKS}
    earning = {code: e for code, _, e in PROJECTS}
    rows = []
    for a in answers:
        if a["outcome"] != AUTO:
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
                rows.append({"日付": r["received_on"], "案件コード": code, "区分": EARNING_KUBUN[earning[code]],
                             "項目": f"入金の消込（請求 {v['invoice_number']}）", "相手": names[a["partner_code"]],
                             "金額（円・税別）": by_project[code], "証憑": f"入金 {r['reference']}・請求 {v['invoice_number']}",
                             "記録した日": iso(AS_OF), "メモ": "架空（入金の確認の正解表から）"})
    rows.sort(key=lambda x: (x["日付"], x["証憑"], x["案件コード"]))
    out = []
    for n, row in enumerate(rows, start=1):
        out.append({c: (f"RM-A-{n:04d}" if c == "実績ID" else row[c]) for c in ACTUAL_COLS})
    return out


def self_check(inputs, receipts, answers):
    """書く前に、正解表を入力だけから確かめ直す（node の試験と同じ観点。ここで落ちたら書かない）。"""
    inv = {v["invoice_number"]: v for v in inputs["invoices"]}
    dictionary = {d["payer_name"]: d["partner_code"] for d in inputs["payer_dictionary"]}
    balance = {n: v["amount_inc_tax"] for n, v in inv.items()}
    assert len(receipts) == 128 and [a["receipt_id"] for a in answers] == [r["receipt_id"] for r in receipts]
    assert sum(a["outcome"] == REVIEW for a in answers) == 9
    for r, a in zip(receipts, answers):
        partner = dictionary.get(r["payer_name"])
        assert a["partner_code"] == partner, r
        open_ = [v for n, v in inv.items() if balance[n] > 0 and v["invoice_date"] <= r["received_on"]]
        if partner is None:
            hits = sorted(v["invoice_number"] for v in open_ if balance[v["invoice_number"]] == r["amount_yen"])
            assert hits == sorted(c["invoice_number"] for c in a["review"]["candidates"]), (hits, a)
        else:
            mine = [dict(v, _uid=v["invoice_number"]) for v in open_ if v["partner_code"] == partner]
            sets = matching_sets(mine, balance, r["amount_yen"])
            want = [frozenset(x["invoice_number"] for x in a["allocations"])] if a["outcome"] == AUTO else []
            assert sets == want, (r, sets)
        alloc_sum = sum(x["amount_yen"] for x in a["allocations"])
        ded_sum = sum(x["amount_yen"] for x in a["deductions"])
        assert alloc_sum + a["unapplied_yen"] == r["amount_yen"] + ded_sum, a
        for x in a["deductions"]:
            assert x["kind"] in CAUSES and x["kind"] != "一部入金" and x["amount_yen"] > 0, x
        if a["review"]:
            assert a["review"]["reasons"] and all(x in CAUSES + LEFTOVERS + (NAME_MISSING,) for x in a["review"]["reasons"])
        for x in a["allocations"]:
            v = inv[x["invoice_number"]]
            assert v["partner_code"] == partner and v["invoice_date"] <= r["received_on"] and x["amount_yen"] > 0
            balance[x["invoice_number"]] -= x["amount_yen"]
            assert balance[x["invoice_number"]] == x["balance_after_yen"] >= 0, x


def dump(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def outputs(seed: int):
    invoices, receipts, answers, r_inv = build(seed)
    clean = [{k: v for k, v in inv.items() if not k.startswith("_")} for inv in invoices]
    inv_keys = ["invoice_id", "invoice_number", "partner_code", "invoice_date", "due_date", "period", "report_ref",
                "currency", "foreign_amount", "report_date", "report_rate", "amount_ex_tax", "tax_amount",
                "amount_inc_tax", "lines"]
    for inv in clean:
        assert set(inv) == set(inv_keys), set(inv) ^ set(inv_keys)
    clean = [{k: inv[k] for k in inv_keys} for inv in clean]
    for inv in clean:
        inv["lines"] = [{k: line[k] for k in ("line_no", "sale_ref", "work_id", "work_code", "description", "accounting_month",
                                              "amount_ex_tax", "tax_amount", "amount_inc_tax")} for line in inv["lines"]]
    partners = [{"partner_code": p["code"], "name": p["name"], "country": p["country"], "currency": p["currency"]}
                for p in P.values()]
    contracts = [{"contract_code": f"C-RM-{ORDER[p['code']] + 1:02d}", "partner_code": p["code"], "clause": p["clause"],
                  "bank_fee_borne_by": p["fee_borne_by"],
                  "foreign_withholding_bps": 1000 if p["code"] == "RM-OS-C" else (0 if p["currency"] != "JPY" else None)}
                 for p in P.values()]
    dictionary = [{"payer_name": name, "partner_code": p["code"]} for p in P.values() for name in p["payer_names"]]
    d = r_inv["D"]
    inputs = {
        "fictional": True, "notice": NOTICE, "month": f"{MONTH[0]}-{MONTH[1]:02d}", "as_of": iso(AS_OF),
        "dictionary_version": "RM-DICT-1",
        "partners": partners, "contracts": contracts, "payer_dictionary": dictionary,
        "projects": [{"project_code": c, "title": t, "earning_type": e} for c, t, e in PROJECTS],
        "works": WORKS,
        "work_projects_note": "作品→案件は仮の対応。フェーズ1 #23a が種の作品・案件として持つ（コードを変えるなら generate.py を直して作り直す）",
        "invoices": clean,
        "rates": [{"currency": c, "date": d_, "ttm": r} for c, d_, r in RATES],
        "receipt_history": (
            [{"partner_code": "RM-PF-A", "received_on": x, "bank_fee_yen": 660}
             for x in ("2026-05-29", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30", "2026-10-30")]
            + [{"partner_code": "RM-OS-C", "received_on": x, "bank_fee_yen": 4000}
               for x in ("2026-03-25", "2026-06-25", "2026-09-25")]),
        "expected_reports": [{"partner_code": "RM-PF-E", "period": "2026-10", "status": "未着"}],
        "schedule_changes": [{"change_ref": "RM-SC-0058", "invoice_number": r_inv["F"]["invoice_number"], "approved": True,
                              "approved_on": "2026-11-10",
                              "installments": [{"due_date": "2026-11-25", "amount_yen": 1_000_000},
                                               {"due_date": "2026-12-25", "amount_yen": r_inv["F"]["amount_inc_tax"] - 1_000_000}]}],
        "return_lines": [{"partner_code": "RM-SEL-D", "report_ref": d["report_ref"], "report_row": 12,
                          "work_code": d["lines"][0]["work_code"], "quantity": -50, "unit_price_ex_tax": 1000,
                          "amount_ex_tax": -50_000, "tax_amount": -5_000, "amount_inc_tax": -55_000}],
    }
    receipts_doc = {"fictional": True, "notice": NOTICE, "month": inputs["month"], "receipts": receipts}
    self_check(inputs, receipts, answers)
    b_inputs, b_receipts = dump(inputs), dump(receipts_doc)
    reasons = {}
    for a in answers:
        for x in (a["review"] or {}).get("reasons", []):
            reasons[x] = reasons.get(x, 0) + 1
    summary = {
        "receipts": len(answers),
        AUTO: sum(a["outcome"] == AUTO for a in answers),
        REVIEW: sum(a["outcome"] == REVIEW for a in answers),
        f"{AUTO}の入金額": sum(r["amount_yen"] for r, a in zip(receipts, answers) if a["outcome"] == AUTO),
        f"{REVIEW}の入金額": sum(r["amount_yen"] for r, a in zip(receipts, answers) if a["outcome"] == REVIEW),
        "理由ごとの件数": reasons,
    }
    answers_doc = {
        "fictional": True, "notice": NOTICE,
        "method": "Python の標準ライブラリだけで独立に作った正解表（整数円と fractions.Fraction。統合システムの関数を使わない）",
        "generator": "generate.py", "seed": seed, "dictionary_version": "RM-DICT-1",
        "vocabulary": "brain wiki/01_rules/ontology.md「業務フローの語彙」（2026-10-09）",
        "inputs_sha256": {"invoices.json": hashlib.sha256(b_inputs).hexdigest(),
                          "receipts.json": hashlib.sha256(b_receipts).hexdigest()},
        "summary": summary, "answers": answers,
    }
    b_answers = dump(answers_doc)
    actuals_doc = {
        "fictional": True, "notice": NOTICE,
        "method": ("自動で一致した入金の消込 → 請求明細の work_id → 作品の案件コード。全額を消した請求なので、税別は請求明細の"
                   "税抜額をそのまま足す。確認が要る入金は承認するまで登録しないので行にしない（下の pending）。"
                   "区分は作品のある稼ぎ方（自社出資・製作委員会・買付）の入金で「流通売上」"),
        "answers_sha256": hashlib.sha256(b_answers).hexdigest(),
        "columns": ACTUAL_COLS,
        "実績": actual_rows(clean, receipts, answers),
        "pending": [{"receipt_id": a["receipt_id"], "amount_yen": r["amount_yen"], "reasons": a["review"]["reasons"]}
                    for r, a in zip(receipts, answers) if a["outcome"] == REVIEW],
    }
    return {"invoices.json": b_inputs, "receipts.json": b_receipts, "answers.json": b_answers,
            "yojitsu-actuals.json": dump(actuals_doc)}


def main():
    ap = argparse.ArgumentParser(description="入金の確認の架空データ（請求・入金128件・正解表）を作る")
    ap.add_argument("--out", type=Path, default=HERE)
    ap.add_argument("--seed", type=int, default=SEED)
    args = ap.parse_args()
    files = outputs(args.seed)
    args.out.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        (args.out / name).write_bytes(files[name])
    print(" ".join(f"{name}={hashlib.sha256(files[name]).hexdigest()[:12]}" for name in FILES))


if __name__ == "__main__":
    main()
