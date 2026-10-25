#!/usr/bin/env python3
"""入金の消込の不変条件を Z3 で確かめる。

会社ルート plans/2026-10-08-loop-and-exception-ux.md の香盤表 #4。CI は core の .github/workflows/ci.yml の formal ジョブで流す。

模型: 請求 N 件と、登録した順に並べた入金 R 件。入金ごとに消込（請求と額）と控除（種類と額）の枠を持つ。
入金の取消（逆仕訳）は、取消日と「どの入金の登録より前に登録したか」を持つ。日付は日の番号、額は整数円で、上限を置かない。

- いまの実装の決まり（CURRENT）: POST /api/billing/receipts と POST /api/billing/receipts/:id/reverse（src/commercial.mjs）の検査と、
  DB のトリガー billing_receipt_allocation_validate・billing_receipt_allocation_complete・billing_receipt_reversal_validate
  （migrations/0001_initial.sql。pg/schema.sql も同じ条件）を写した。入金の控除の行はまだ無い
- 控除を足したときの決まり（PLANNED）: 入金の確認の計画 #6 で足す入金の控除の行（種類は語彙の CHECK）を入れた形。#6 の実装はこれに合わせる。
  ただし OPEN_DECISIONS の2点（控除の額の符号、一部入金を控除の種類に含めるか）は計画に書かれていない仮の置き方で、#6 の着手前に決める
- 不変条件（INVARIANTS）は決まりとは別に、計画の受け入れ基準の文から書く
  I1 消込の合計＝入金額＋控除（入金ごと）
  I2 各請求の消込≦未消込。どの日で見ても、請求ごとに、その日までに入って取り消されていない消込の合計が請求額を超えない
  I3 請求日≦入金日（消込ごと）
  I4 控除の種類が語彙の中（brain の wiki/01_rules/ontology.md「業務フローの語彙」の差額の原因5語）

確かめること（終了コード 0 のとき全部が成り立つ）:
1. CURRENT と PLANNED のそれぞれで、決まりを全部満たす入金の列がある（入金 1〜MAX_RECEIPTS 件の長さごと。PLANNED は控除の行を、
   2件以上は取消を含む列）。決まりが互いに矛盾して1件も通らない模型では、不変条件が自明に成り立ってしまうため
2. CURRENT と PLANNED のもとで、4つの不変条件に反例が無い（請求 MAX_INVOICES 件・入金 1〜MAX_RECEIPTS 件の全部の場合）
3. わざと壊した版（BROKEN）ごとに、狙った不変条件の反例が出る
4. 反例を写した試験の入力（receipt_matching_cases.json の cases）が、壊した版では最後まで通って不変条件を破り、正しい版では最後の
   入金で、書いた決まり（rejected_by）だけに断られる。同じ入力を実装の試験（test/billing.test.mjs の API、test/receipt-model.test.mjs
   の入金フォームの論理）が流す。replay.api.rejected_now は、いまの API が別の決まりで断るときの、その決まり（CURRENT で断ること）
5. 取消の登録順の入力（同じファイルの registration_order）で、取消を入金のあとに登録すると CURRENT はその入金を断り、先に登録すると
   通す。取消の登録順を見ない写しなら、あとに登録しても通る（この入力が登録順の条件を確かめていること）。同じ入力を
   test/billing.test.mjs が API へ流す。登録順の条件はどの不変条件にも効かない（released_at_receipt_date の説明）ので、ここで確かめる

I1・I3・I4 は決まりの1つとほぼ同じ文で、確かめるのは「その決まりがどの書き込みにもある」ことである。I2 は、登録の時点の検査
（その入金日に効いている取消だけを外して前の消込を数える）から、あとから取消や日付の前後する入金が入っても、どの日で見ても
成り立つことを確かめる。消込先の数の上限（10請求）と請求の取消（void）は模型に入れていない。

#6（入金の控除の表と承認の API）で、同じ PR で直すこと（計画の #6 の受け入れ基準に足す）:
- 着手前に OPEN_DECISIONS の2点を決める。変わるなら g_deduction_positive・DEDUCTION_KINDS・控除の反例の入力を直す
- 控除の反例2件（I4 の「控除の種類の検査なし」、I1 の「合計が控除を数えない」）を API で再現し、それぞれ語彙の CHECK・合計の検査の
  文言で断ることを確かめる。cases の replay.api.rejected_now と note、pending.api を外す（いまの API は控除を受けず、前者は
  消込の合計＝入金額の検査で断り、後者は控除を捨てた入金として通す）

1回の判定は TIMEOUT_MS、全体は BUDGET_S を上限にし、超えたら「判定できない」で終了コード 1 にする（CI の formal ジョブの
timeout-minutes 10 より先に止まり、どこで止まったかを出す）。

使い方（apps/integrated-prototype で。Python は requirements-test.txt を入れた venv）:
  python formal/receipt_matching.py [--json <書く先>] [--summary <追記する md>] [--show]
  --show は壊した版ごとに Z3 が見つけた反例を、receipt_matching_cases.json の1件の形で出す（試験の入力を足すときに写す）
終了コード: 0＝全部成り立つ、1＝どれかが外れた・判定できない、2＝引数・入力の誤り
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
from pathlib import Path

try:
    import z3
except ImportError:
    print("z3-solver が無い。requirements-test.txt を venv に入れてから流す（core の docs/platform/operations/ci-contract.md §2）",
          file=sys.stderr)
    sys.exit(2)

HERE = Path(__file__).resolve().parent
CASES = HERE / "receipt_matching_cases.json"

# 差額の原因の5語（brain wiki/01_rules/ontology.md「業務フローの語彙」2026-10-09）。控除の行の種類はこのどれか。
# 機械の写し src/ontology/flow.json（入金の確認の計画「オントロジーの取り込み方」）ができたら、そこから読む
DEDUCTION_KINDS = ("銀行手数料", "外国で源泉された額", "為替の確定", "返品の相殺", "一部入金")

# PLANNED の決まりのうち、計画に書かれていない仮の置き方（決まりの名前 → 決めること）。#6 の着手前に決め、変わるなら
# g_deduction_positive・DEDUCTION_KINDS・receipt_matching_cases.json の控除の反例を #6 と同じ PR で直す。結果の JSON と Summary に出す
OPEN_DECISIONS = {
    "控除額が正": "控除の額の符号。為替の確定は入金日のレートによる差で、正負どちらにもなる（いまの模型は正だけを通す）",
    "控除の種類が語彙の中": "一部入金を控除の種類に含めるか、承認済みの入金予定の変更として別に持つか。控除にすると、入っていない額まで"
                            "消込済みにして売掛を閉じる行を作れる（I1 は成り立ったまま）。ontology の一部入金は「残りは入金予定の変更として"
                            "承認する」（いまの模型は差額の原因の5語をすべて通す）。また、受託の発注元が源泉徴収した額"
                            "（FR-REV-CWORK-029・FR-ACCT-TAX-021。入金と別の行で持って売掛を消す）は5語に無い。"
                            "ontology の語彙に「源泉徴収された額」を足すか、控除とは別の行で持つかを決める（このまま語彙の CHECK を"
                            "作ると、その行を断る）",
}

# 判定の時間の上限。1回の判定（Solver・Optimize の check）と全体。いまは全体で数秒。超えたら「判定できない」
TIMEOUT_MS = 30_000
BUDGET_S = 300

# 全部の場合を確かめる範囲。入金は1件から MAX_RECEIPTS 件までの長さを1つずつ見る（短い列の反例を見落とさない）
MAX_INVOICES = 2
MAX_RECEIPTS = 3
ALLOCATIONS_PER_RECEIPT = 2
DEDUCTIONS_PER_RECEIPT = 2

# 反例を読みやすくする範囲（壊した版の反例探しだけに使い、反例が無いことの証明には使わない）
SHOW_FROM = dt.date(2026, 11, 1)
SHOW_DAYS = 60
SHOW_MAX_YEN = 999_999


# ---------------------------------------------------------------- 模型

def all_of(xs):
    return z3.And(xs) if xs else z3.BoolVal(True)


def any_of(xs):
    return z3.Or(xs) if xs else z3.BoolVal(False)


def total(xs):
    return z3.Sum(xs) if xs else z3.IntVal(0)


def pick(values, index):
    """記号の番号 index の値（index は facts が 0〜len-1 に絞る）。"""
    out = values[-1]
    for i in range(len(values) - 2, -1, -1):
        out = z3.If(index == i, values[i], out)
    return out


class Slot:
    def __init__(self, name):
        self.used = z3.Bool(f"{name}.used")
        self.amount = z3.Int(f"{name}.amount")


class Allocation(Slot):
    def __init__(self, name):
        super().__init__(name)
        self.invoice = z3.Int(f"{name}.invoice")


class Deduction(Slot):
    def __init__(self, name):
        super().__init__(name)
        self.kind = z3.String(f"{name}.kind")


class Trace:
    """請求 n_inv 件と、登録した順の入金 n_rcpt 件（取消を含む）。"""

    def __init__(self, n_inv, n_rcpt, n_alloc=ALLOCATIONS_PER_RECEIPT, n_ded=DEDUCTIONS_PER_RECEIPT):
        self.n_inv, self.n_rcpt = n_inv, n_rcpt
        self.inv_amount = [z3.Int(f"inv{i}.amount") for i in range(n_inv)]
        self.inv_date = [z3.Int(f"inv{i}.date") for i in range(n_inv)]
        self.inv_partner = [z3.Int(f"inv{i}.partner") for i in range(n_inv)]
        self.partner = [z3.Int(f"r{r}.partner") for r in range(n_rcpt)]
        self.received_on = [z3.Int(f"r{r}.received_on") for r in range(n_rcpt)]
        self.cash = [z3.Int(f"r{r}.cash") for r in range(n_rcpt)]
        self.alloc = [[Allocation(f"r{r}.a{k}") for k in range(n_alloc)] for r in range(n_rcpt)]
        self.ded = [[Deduction(f"r{r}.d{m}") for m in range(n_ded)] for r in range(n_rcpt)]
        self.reversed = [z3.Bool(f"r{r}.reversed") for r in range(n_rcpt)]
        self.reversed_on = [z3.Int(f"r{r}.reversed_on") for r in range(n_rcpt)]
        # 取消を登録した位置: 入金 reversed_before の登録より前（n_rcpt は全部の入金のあと）
        self.reversed_before = [z3.Int(f"r{r}.reversed_before") for r in range(n_rcpt)]

    def facts(self):
        """実装の検査ではなく、表の定義と模型の作りから決まること。"""
        out = [a > 0 for a in self.inv_amount]  # billing_invoices の CHECK(amount_inc_tax>0)
        for r in range(self.n_rcpt):
            out += [z3.And(s.invoice >= 0, s.invoice < self.n_inv) for s in self.alloc[r]]
            out.append(z3.Implies(self.reversed[r], z3.And(self.reversed_before[r] > r, self.reversed_before[r] <= self.n_rcpt)))
        return out

    def alloc_total(self, r):
        return total([z3.If(s.used, s.amount, 0) for s in self.alloc[r]])

    def ded_total(self, r):
        return total([z3.If(d.used, d.amount, 0) for d in self.ded[r]])

    def size(self):
        slots = [s.used for row in self.alloc for s in row] + [d.used for row in self.ded for d in row] + self.reversed
        return total([z3.If(u, 1, 0) for u in slots])

    def yen(self):
        return total(self.inv_amount + self.cash + [s.amount for row in self.alloc for s in row]
                     + [d.amount for row in self.ded for d in row])

    def readable(self):
        """反例を読みやすい日付・額・取引先1つに寄せる。"""
        lo = SHOW_FROM.toordinal()
        hi = lo + SHOW_DAYS - 1
        dates = self.inv_date + self.received_on + self.reversed_on
        yen = self.inv_amount + self.cash + [s.amount for row in self.alloc for s in row] + [d.amount for row in self.ded for d in row]
        out = [z3.And(d >= lo, d <= hi) for d in dates] + [z3.And(a >= 0, a <= SHOW_MAX_YEN) for a in yen]
        out += [p == 1 for p in self.inv_partner + self.partner]
        out += [z3.Implies(z3.Not(s.used), z3.And(s.amount == 0, s.invoice == 0)) for row in self.alloc for s in row]
        out += [z3.Implies(z3.Not(d.used), z3.And(d.amount == 0, d.kind == z3.StringVal(""))) for row in self.ded for d in row]
        out += [z3.Implies(z3.Not(self.reversed[r]), z3.And(self.reversed_on[r] == lo, self.reversed_before[r] == 0)) for r in range(self.n_rcpt)]
        return out


# ---------------------------------------------------------------- 決まり（入金 r の登録が通る条件）

def g_cash_positive(t, r):
    # POST /api/billing/receipts: amountYen<=0 は 400。billing_receipts の CHECK(amount_yen>0)
    return t.cash[r] > 0


def g_has_allocation(t, r):
    # POST: allocations が空なら 400。billing_receipts の CHECK(allocation_count>0)
    return any_of([s.used for s in t.alloc[r]])


def g_allocation_positive(t, r):
    # POST: 消込額<=0 は 400。billing_receipt_allocations の CHECK(amount_yen>0)
    return all_of([z3.Implies(s.used, s.amount > 0) for s in t.alloc[r]])


def g_distinct_invoices(t, r):
    # POST: 消込先の請求の重複は 400。billing_receipt_allocations の主キー (org_id, receipt_id, invoice_id)
    a = t.alloc[r]
    return all_of([z3.Implies(z3.And(a[k].used, a[n].used), a[k].invoice != a[n].invoice)
                   for k in range(len(a)) for n in range(k + 1, len(a))])


def g_sum_is_cash(t, r):
    # POST: 消込額の合計≠入金額は 400。トリガー billing_receipt_allocation_complete
    return t.alloc_total(r) == t.cash[r]


def g_sum_is_cash_plus_deductions(t, r):
    # #6 で足す: 消込の合計＝入金額＋控除（控除は入金と別の行。FR-REV-INTAKE-090）
    return t.alloc_total(r) == t.cash[r] + t.ded_total(r)


def g_same_partner(t, r):
    # POST の請求の検査（409）とトリガー billing_receipt_allocation_validate の1つ目
    return all_of([z3.Implies(s.used, pick(t.inv_partner, s.invoice) == t.partner[r]) for s in t.alloc[r]])


def g_invoice_date(t, r):
    # 同上（invoice_date<=received_on）
    return all_of([z3.Implies(s.used, pick(t.inv_date, s.invoice) <= t.received_on[r]) for s in t.alloc[r]])


def released_at_receipt_date(t, s, r):
    # トリガーの LEFT JOIN billing_receipt_reversals x ... AND x.reversed_on<=(新しい入金の received_on)。
    # reversed_before<=r は「入金 r の登録の時点で、取消がもう登録されている」（トリガーは登録済みの行しか見ない）。
    # この条件はどの不変条件にも効かない（外しても証明・壊した版・反例の入力の確かめはすべて通ることを欠陥注入で確かめた）。
    # 外すと登録の時点で通る入金が増えるが、外れる取消の取消日は入金 r の入金日以前なので、入金 r が効く日には取り消した入金は
    # もう効いておらず、最後の状態で見る I2 は破れない。写しの正しさは registration_order の入力（check_order）で確かめる
    return z3.And(t.reversed[s], t.reversed_before[s] <= r, t.reversed_on[s] <= t.received_on[r])


def released_unordered(t, s, r):
    # 確かめるための写し: 取消の登録順を見ない（あとで登録する取消も、取消日が入金日以前なら先に外す）
    return z3.And(t.reversed[s], t.reversed_on[s] <= t.received_on[r])


def released_whenever(t, s, r):
    # 壊した版: 取消の日付を見ない（取消があれば外す）
    return z3.And(t.reversed[s], t.reversed_before[s] <= r)


def open_balance(released):
    def guard(t, r):
        out = []
        for k, slot in enumerate(t.alloc[r]):
            before = [z3.If(z3.And(p.used, p.invoice == slot.invoice, z3.Not(released(t, s, r))), p.amount, 0)
                      for s in range(r + 1) for n, p in enumerate(t.alloc[s]) if s < r or n < k]
            out.append(z3.Implies(slot.used, total(before) + slot.amount <= pick(t.inv_amount, slot.invoice)))
        return all_of(out)
    return guard


# トリガー billing_receipt_allocation_validate の3つ目: その入金日に取り消されていない前の消込＋この消込≦請求額
g_open_balance = open_balance(released_at_receipt_date)
g_open_balance_unordered = open_balance(released_unordered)


def g_within_invoice_amount(t, r):
    # 壊した版: 前の消込を数えず、この消込だけを請求額と比べる
    return all_of([z3.Implies(s.used, s.amount <= pick(t.inv_amount, s.invoice)) for s in t.alloc[r]])


def g_reversal_date(t, r):
    # POST /api/billing/receipts/:id/reverse と トリガー billing_receipt_reversal_validate: 取消日>=入金日
    return z3.Implies(t.reversed[r], t.reversed_on[r] >= t.received_on[r])


def g_no_deductions(t, r):
    # いまの実装に入金の控除の表は無い（POST は控除を受けない）
    return all_of([z3.Not(d.used) for d in t.ded[r]])


def g_deduction_positive(t, r):
    # #6 で足す: 控除の額は正（仮の置き方。OPEN_DECISIONS）
    return all_of([z3.Implies(d.used, d.amount > 0) for d in t.ded[r]])


def in_vocabulary(kind):
    return any_of([kind == z3.StringVal(v) for v in DEDUCTION_KINDS])


def g_deduction_kind(t, r):
    # #6 で足す: 控除の種類の CHECK（語彙の5語。一部入金を含めるかは仮の置き方。OPEN_DECISIONS）
    return all_of([z3.Implies(d.used, in_vocabulary(d.kind)) for d in t.ded[r]])


CURRENT = {
    "入金額が正": g_cash_positive,
    "消込先が1件以上": g_has_allocation,
    "消込額が正": g_allocation_positive,
    "消込先の請求が重ならない": g_distinct_invoices,
    "消込の合計＝入金額": g_sum_is_cash,
    "同じ取引先の請求": g_same_partner,
    "請求日≦入金日": g_invoice_date,
    "消込≦その入金日の未消込": g_open_balance,
    "取消日≧入金日": g_reversal_date,
    "控除の行を持たない": g_no_deductions,
}
PLANNED = {k: g for k, g in CURRENT.items() if k not in ("消込の合計＝入金額", "控除の行を持たない")} | {
    "消込の合計＝入金額＋控除": g_sum_is_cash_plus_deductions,
    "控除額が正": g_deduction_positive,
    "控除の種類が語彙の中": g_deduction_kind,
}
GUARDS = {"CURRENT": CURRENT, "PLANNED": PLANNED}

# 壊した版: (もとの決まり, 差し替える決まり（None は外す）, 反例が出るはずの不変条件)
BROKEN = {
    "合計の検査なし": ("CURRENT", {"消込の合計＝入金額": None}, "I1"),
    "合計が控除を数えない": ("PLANNED", {"消込の合計＝入金額＋控除": g_sum_is_cash}, "I1"),
    "未消込の検査なし": ("CURRENT", {"消込≦その入金日の未消込": None}, "I2"),
    "前の消込を数えない": ("CURRENT", {"消込≦その入金日の未消込": g_within_invoice_amount}, "I2"),
    "取消日を見ずに取消済みを外す": ("CURRENT", {"消込≦その入金日の未消込": open_balance(released_whenever)}, "I2"),
    "請求日の検査なし": ("CURRENT", {"請求日≦入金日": None}, "I3"),
    "控除の種類の検査なし": ("PLANNED", {"控除の種類が語彙の中": None}, "I4"),
}


def broken_guards(name):
    base, change, _ = BROKEN[name]
    out = dict(GUARDS[base])
    for key, guard in change.items():
        if key not in out:
            raise KeyError(f"{name}: {base} に決まり「{key}」が無い")
        if guard is None:
            del out[key]
        else:
            out[key] = guard
    return out


def accepted(t, guards, receipts=None):
    rs = range(t.n_rcpt) if receipts is None else receipts
    return [g(t, r) for r in rs for g in guards.values()]


# ---------------------------------------------------------------- 不変条件（破れる条件を返す）

def v_sum(t):
    return any_of([t.alloc_total(r) != t.cash[r] + t.ded_total(r) for r in range(t.n_rcpt)])


def v_open(t):
    out = []
    for j in range(t.n_inv):
        day = z3.Int(f"I2.day.inv{j}")
        effective = [z3.If(z3.And(s.used, s.invoice == j, t.received_on[r] <= day,
                                  z3.Not(z3.And(t.reversed[r], t.reversed_on[r] <= day))), s.amount, 0)
                     for r in range(t.n_rcpt) for s in t.alloc[r]]
        out.append(total(effective) > t.inv_amount[j])
    return any_of(out)


def v_date(t):
    return any_of([z3.And(s.used, pick(t.inv_date, s.invoice) > t.received_on[r])
                   for r in range(t.n_rcpt) for s in t.alloc[r]])


def v_kind(t):
    return any_of([z3.And(d.used, z3.Not(in_vocabulary(d.kind))) for r in range(t.n_rcpt) for d in t.ded[r]])


INVARIANTS = {
    "I1": ("消込の合計＝入金額＋控除", v_sum),
    "I2": ("各請求の消込≦未消込（どの日で見ても）", v_open),
    "I3": ("請求日≦入金日", v_date),
    "I4": ("控除の種類が語彙の中", v_kind),
}


# ---------------------------------------------------------------- 解く

_deadline = None


def start_budget():
    global _deadline
    _deadline = time.monotonic() + BUDGET_S


def limit_ms():
    """この判定の上限（ミリ秒）。全体の残りが TIMEOUT_MS より短ければ残りまで（使い切ったら 1 で、すぐ unknown になる）。"""
    if _deadline is None:
        return TIMEOUT_MS
    return max(1, min(TIMEOUT_MS, int((_deadline - time.monotonic()) * 1000)))


class Undecided(RuntimeError):
    """時間の上限で判定できなかった（unknown）。"""


def solve(*constraints):
    s = z3.Solver()
    s.set("timeout", limit_ms())
    s.add(*constraints)
    result = s.check()
    return result, (s.model() if result == z3.sat else None)


def witness(guards_name):
    """決まりを全部満たす入金の列があるか。CURRENT は入金（2件以上は取消を含む）、控除の行を持てる決まりは控除の行も含む列。"""
    guards = GUARDS[guards_name]
    with_deductions = "控除の行を持たない" not in guards
    for n in range(1, MAX_RECEIPTS + 1):
        t = Trace(MAX_INVOICES, n)
        shape = []
        if with_deductions:
            shape.append(any_of([d.used for row in t.ded for d in row]))
        if n >= 2:
            shape.append(any_of([z3.And(t.reversed[r], t.reversed_before[r] < n) for r in range(n)]))
        result, _ = solve(*t.facts(), *accepted(t, guards), *shape)
        if result != z3.sat:
            return {"result": "無い" if result == z3.unsat else "判定できない", "receipts": n, "deductions": with_deductions}
    return {"result": "ある", "receipts": list(range(1, MAX_RECEIPTS + 1)), "deductions": with_deductions}


def prove(guards_name, invariant):
    """反例が無いことを、入金 1〜MAX_RECEIPTS 件の長さごとに確かめる。"""
    guards = GUARDS[guards_name]
    lengths = []
    for n in range(1, MAX_RECEIPTS + 1):
        t = Trace(MAX_INVOICES, n)
        result, model = solve(*t.facts(), *accepted(t, guards), INVARIANTS[invariant][1](t))
        lengths.append(str(result))
        if result != z3.unsat:
            ce = render(t, model) if model is not None else None
            return {"result": "反例あり" if result == z3.sat else "判定できない", "receipts": n, "counterexample": ce}
    return {"result": "反例なし", "receipts": list(range(1, MAX_RECEIPTS + 1))}


def search(name):
    """壊した版で、狙った不変条件の反例を短い列から探す。"""
    guards = broken_guards(name)
    invariant = BROKEN[name][2]
    for n in range(1, MAX_RECEIPTS + 1):
        t = Trace(MAX_INVOICES, n)
        o = z3.Optimize()
        o.set("timeout", limit_ms())
        o.add(*t.facts(), *t.readable(), *accepted(t, guards), INVARIANTS[invariant][1](t))
        o.minimize(t.size())    # 消込・控除の本数と取消の数が少ない反例を先に
        o.minimize(t.yen())     # 次に額の小さいもの
        result = o.check()
        model = o.model() if result == z3.sat else None
        if result == z3.sat:
            return {"result": "反例あり", "receipts": n, "counterexample": render(t, model)}
        if result != z3.unsat:
            return {"result": "判定できない", "receipts": n}
    return {"result": "反例なし", "receipts": list(range(1, MAX_RECEIPTS + 1))}


def render(t, model):
    """反例を receipt_matching_cases.json の1件の形（invoices と steps）にする。"""
    def num(x):
        return model.eval(x, model_completion=True).as_long()

    def day(x):
        n = num(x)
        try:
            return dt.date.fromordinal(n).isoformat()
        except (ValueError, OverflowError):
            return n

    def text(x):
        # Z3 は ASCII の外の文字を \u{...} の形で返す
        return re.sub(r"\\u\{([0-9a-fA-F]+)\}", lambda m: chr(int(m.group(1), 16)), model.eval(x, model_completion=True).as_string())

    keys = [chr(ord("A") + i) for i in range(t.n_inv)]
    referenced = {num(s.invoice) for row in t.alloc for s in row if z3.is_true(model.eval(s.used, model_completion=True))}
    invoices = [{"key": keys[i], "amount_yen": num(t.inv_amount[i]), "invoice_date": day(t.inv_date[i]),
                 "partner": num(t.inv_partner[i])} for i in range(t.n_inv) if i in referenced]
    reversals = {}
    for r in range(t.n_rcpt):
        if z3.is_true(model.eval(t.reversed[r], model_completion=True)):
            reversals.setdefault(num(t.reversed_before[r]), []).append(
                {"reverse": f"R{r + 1}", "reversed_on": day(t.reversed_on[r])})
    steps = []
    for r in range(t.n_rcpt + 1):
        steps += reversals.get(r, [])
        if r == t.n_rcpt:
            break
        used = lambda slot: z3.is_true(model.eval(slot.used, model_completion=True))
        step = {"receipt": f"R{r + 1}", "received_on": day(t.received_on[r]), "amount_yen": num(t.cash[r]),
                "partner": num(t.partner[r]),
                "allocations": [{"invoice": keys[num(s.invoice)], "amount_yen": num(s.amount)} for s in t.alloc[r] if used(s)]}
        deds = [{"kind": text(d.kind), "amount_yen": num(d.amount)}
                for d in t.ded[r] if used(d)]
        if deds:
            step["deductions"] = deds
        steps.append(step)
    return {"invoices": invoices, "steps": steps}


# ---------------------------------------------------------------- 試験の入力（反例を写したもの）

class CaseError(ValueError):
    pass


def iso_day(value, where):
    try:
        return dt.date.fromisoformat(value).toordinal()
    except (TypeError, ValueError):
        raise CaseError(f"{where}: 日付 {value!r} が YYYY-MM-DD でない") from None


def yen(value, where):
    if not isinstance(value, int) or isinstance(value, bool):
        raise CaseError(f"{where}: 額 {value!r} が整数円でない")
    return value


def case_trace(case, trailing_reversals=False):
    """1件を模型の値に固定する。返り値は (Trace, 固定の式, 最後の入金の番号)。
    trailing_reversals のときは、最後の入金のあとに登録した取消を置ける（取消の登録順の入力。check_order）。"""
    name = case.get("name", "?")
    invoices = case.get("invoices") or []
    steps = case.get("steps") or []
    keys = [inv.get("key") for inv in invoices]
    if not invoices or len(set(keys)) != len(keys):
        raise CaseError(f"{name}: invoices が空か key が重なる")
    receipts = [s for s in steps if "receipt" in s]
    if not receipts:
        raise CaseError(f"{name}: 入金が無い")
    if "receipt" not in steps[-1] and not trailing_reversals:
        raise CaseError(f"{name}: 最後の段が入金でない（正しい版は最後の入金を断る）")
    n_alloc = max(len(s.get("allocations") or []) for s in receipts)
    n_ded = max(len(s.get("deductions") or []) for s in receipts)
    t = Trace(len(invoices), len(receipts), max(n_alloc, 1), n_ded)
    fixed = []
    for i, inv in enumerate(invoices):
        where = f"{name} の請求 {inv.get('key')}"
        fixed += [t.inv_amount[i] == yen(inv.get("amount_yen"), where), t.inv_date[i] == iso_day(inv.get("invoice_date"), where),
                  t.inv_partner[i] == inv.get("partner", 1)]
    index = {}
    reversed_at = {}
    for step in steps:
        if "reverse" in step:
            key = step["reverse"]
            if key not in index or key in reversed_at:
                raise CaseError(f"{name}: 取消 {key} の前に入金 {key} が無いか、2回取り消している")
            reversed_at[key] = (len(index), iso_day(step.get("reversed_on"), f"{name} の取消 {key}"))
            continue
        r = len(index)
        key = step["receipt"]
        if key in index:
            raise CaseError(f"{name}: 入金 {key} が重なる")
        index[key] = r
        where = f"{name} の入金 {key}"
        fixed += [t.partner[r] == step.get("partner", 1), t.received_on[r] == iso_day(step.get("received_on"), where),
                  t.cash[r] == yen(step.get("amount_yen"), where)]
        allocs = step.get("allocations") or []
        for k, slot in enumerate(t.alloc[r]):
            if k < len(allocs):
                if allocs[k].get("invoice") not in keys:
                    raise CaseError(f"{where}: 消込先 {allocs[k].get('invoice')!r} が invoices に無い")
                fixed += [slot.used, slot.invoice == keys.index(allocs[k]["invoice"]), slot.amount == yen(allocs[k].get("amount_yen"), where)]
            else:
                fixed += [z3.Not(slot.used), slot.invoice == 0, slot.amount == 0]
        deds = step.get("deductions") or []
        for m, d in enumerate(t.ded[r]):
            if m < len(deds):
                fixed += [d.used, d.kind == z3.StringVal(str(deds[m].get("kind"))), d.amount == yen(deds[m].get("amount_yen"), where)]
            else:
                fixed += [z3.Not(d.used), d.kind == z3.StringVal(""), d.amount == 0]
    for key, r in index.items():
        if key in reversed_at:
            before, on = reversed_at[key]
            fixed += [t.reversed[r], t.reversed_on[r] == on, t.reversed_before[r] == before]
        else:
            fixed += [z3.Not(t.reversed[r]), t.reversed_on[r] == 0, t.reversed_before[r] == 0]
    return t, fixed, len(receipts) - 1


def holds(*constraints):
    result = solve(*constraints)[0]
    if result not in (z3.sat, z3.unsat):
        raise Undecided("判定できない（時間の上限）")
    return result == z3.sat


def check_case(case):
    """壊した版で通って不変条件を破り、正しい版では最後の入金だけが rejected_by の決まりに断られるか。"""
    name = case.get("name", "?")
    broken = case.get("broken")
    if broken not in BROKEN:
        raise CaseError(f"{name}: broken {broken!r} が壊した版の一覧に無い")
    base, _, target = BROKEN[broken]
    if case.get("invariant") != target:
        raise CaseError(f"{name}: invariant は {target}（{broken} が破るもの）にする")
    t, fixed, last = case_trace(case)
    facts = [*t.facts(), *fixed]
    problems = []
    if not holds(*facts, *accepted(t, broken_guards(broken))):
        problems.append(f"壊した版（{broken}）が最後まで通さない")
    if not holds(*facts, INVARIANTS[target][1](t)):
        problems.append(f"{target}（{INVARIANTS[target][0]}）を破っていない")
    guards = GUARDS[base]
    if not holds(*facts, *accepted(t, guards, range(last))):
        problems.append(f"{base} が最後の入金より前で断る")
    rejected_by = sorted(k for k, g in guards.items() if not holds(*facts, g(t, last)))
    if rejected_by != sorted(case.get("rejected_by") or []):
        problems.append(f"{base} で最後の入金を断る決まりが {rejected_by}（書いたのは {case.get('rejected_by')}）")
    # いまの API が別の決まりで断るとき（控除を受けない間）、その決まりが CURRENT で最後の入金を断ること
    now = ((case.get("replay") or {}).get("api") or {}).get("rejected_now")
    if now is not None:
        if now not in CURRENT:
            raise CaseError(f"{name}: replay.api.rejected_now {now!r} が CURRENT の決まりに無い")
        if holds(*facts, CURRENT[now](t, last)):
            problems.append(f"replay.api.rejected_now の「{now}」が CURRENT で最後の入金を断らない")
    return {"name": name, "broken": broken, "invariant": target, "result": "OK" if not problems else "NG",
            "rejected_by": rejected_by, "problems": problems}


def check_order(order):
    """取消を入金のあとに登録すると CURRENT はその入金を rejected_by で断り、先に登録すると通すか。
    登録順を見ない写しなら、あとに登録しても通ること（この入力が登録順の条件を確かめていること）も見る。"""
    name = order.get("name", "?")
    for key in ("before", "receipt", "reversal", "rejected_by"):
        if key not in order:
            raise CaseError(f"{name}: registration_order に {key} が無い")
    receipt, reversal = order["receipt"], order["reversal"]
    if "receipt" not in receipt or "reverse" not in reversal:
        raise CaseError(f"{name}: receipt は入金、reversal は取消の段にする")
    expected = sorted(order["rejected_by"])
    if not expected:
        raise CaseError(f"{name}: rejected_by が空（取消をあとに登録したときに断る決まりを書く）")
    problems = []
    variants = (("取消を入金のあとに登録", [*order["before"], receipt, reversal], expected),
                ("取消を入金の前に登録", [*order["before"], reversal, receipt], []))
    for label, steps, expect in variants:
        t, fixed, last = case_trace({"name": name, "invoices": order.get("invoices"), "steps": steps}, trailing_reversals=True)
        facts = [*t.facts(), *fixed]
        if not holds(*facts, *accepted(t, CURRENT, range(last))):
            problems.append(f"{label}: CURRENT が入金 {receipt['receipt']} より前で断る")
        got = sorted(k for k, g in CURRENT.items() if not holds(*facts, g(t, last)))
        if got != expect:
            problems.append(f"{label}: CURRENT で入金 {receipt['receipt']} を断る決まりが {got}（期待は {expect}）")
        if expect and not holds(*facts, g_open_balance_unordered(t, last)):
            problems.append(f"{label}: 取消の登録順を見ない写しでも断る（この入力では登録順の条件を確かめられない）")
    return {"name": name, "result": "OK" if not problems else "NG", "problems": problems}


def load_cases(path):
    """cases（反例を写した入力）と registration_order（取消の登録順の入力）を読む。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CaseError(f"{path.name} を読めない: {error}") from None
    cases = data.get("cases")
    if not isinstance(cases, list) or not cases:
        raise CaseError(f"{path.name}: cases が空")
    orders = data.get("registration_order")
    if not isinstance(orders, list) or not orders:
        raise CaseError(f"{path.name}: registration_order が空（取消の登録順は不変条件に効かないので、この入力で確かめる）")
    names = [c.get("name") for c in cases + orders]
    if len(set(names)) != len(names):
        raise CaseError(f"{path.name}: name が重なる")
    return cases, orders


# ---------------------------------------------------------------- 出力

def summary_md(report):
    def problems(row):
        return "：" + "・".join(row["problems"]) if row["problems"] else ""

    lines = ["### 決まりと不変条件（formal/receipt_matching.py）", "",
             f"z3 {report['z3']}。請求 {MAX_INVOICES} 件・入金 1〜{MAX_RECEIPTS} 件・消込 {ALLOCATIONS_PER_RECEIPT} 本・"
             f"控除 {DEDUCTIONS_PER_RECEIPT} 本までの全部の場合（日付と額は上限なし）。判定の上限は1回 {TIMEOUT_MS // 1000} 秒・"
             f"全体 {BUDGET_S} 秒", "",
             "| 決まり | 決まりを全部満たす入金の列 | " + " | ".join(f"{k} {v[0]}" for k, v in INVARIANTS.items()) + " |",
             "|---|---|" + "---|" * len(INVARIANTS)]
    for g in GUARDS:
        w = next(x for x in report["witnesses"] if x["guards"] == g)
        row = {p["invariant"]: p["result"] for p in report["proofs"] if p["guards"] == g}
        lines.append(f"| {g} | {w['result']}{'（控除つき）' if w['deductions'] else ''} | "
                     + " | ".join(row.get(k, "未実行") for k in INVARIANTS) + " |")
    lines += ["", "| わざと壊した版 | 破るはず | 結果 | 入金の件数 |", "|---|---|---|---|"]
    for b in report["broken"]:
        lines.append(f"| {b['name']}（{b['base']}） | {b['invariant']} | {b['result']} | {b['receipts']} |")
    lines += ["", "| 試験の入力（receipt_matching_cases.json） | 壊した版 | 結果 |", "|---|---|---|"]
    for c in report["cases"]:
        lines.append(f"| {c['name']} | {c['broken']} | {c['result']}{problems(c)} |")
    for o in report["registration_order"]:
        lines.append(f"| {o['name']} | （取消の登録順） | {o['result']}{problems(o)} |")
    lines += ["", "未決（PLANNED の仮の置き方。入金の確認の計画 #6 の着手前に決める）:", ""]
    lines += [f"- 「{rule}」: {question}" for rule, question in report["open_decisions"].items()]
    lines += ["", f"**{'OK' if report['ok'] else 'NG'}**", ""]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="入金の消込の不変条件を Z3 で確かめる")
    parser.add_argument("--json", type=Path, help="結果の JSON を書く先")
    parser.add_argument("--summary", type=Path, help="結果の表（Markdown）を追記する先（GitHub の Step Summary など）")
    parser.add_argument("--show", action="store_true", help="壊した版の反例を試験の入力の形で出す")
    parser.add_argument("--cases", type=Path, default=CASES, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    try:
        cases, orders = load_cases(args.cases)
    except CaseError as error:
        print(f"NG {error}", file=sys.stderr)
        return 2
    unknown = sorted(set(OPEN_DECISIONS) - set(PLANNED))
    if unknown:
        print(f"NG OPEN_DECISIONS の決まり {unknown} が PLANNED に無い", file=sys.stderr)
        return 2

    start_budget()
    report = {"z3": z3.get_version_string(), "bounds": {"invoices": MAX_INVOICES, "receipts": MAX_RECEIPTS,
              "allocations_per_receipt": ALLOCATIONS_PER_RECEIPT, "deductions_per_receipt": DEDUCTIONS_PER_RECEIPT},
              "limits": {"timeout_ms": TIMEOUT_MS, "budget_s": BUDGET_S},
              "vocabulary": list(DEDUCTION_KINDS), "open_decisions": dict(OPEN_DECISIONS),
              "witnesses": [], "proofs": [], "broken": [], "cases": [], "registration_order": []}
    ok = True
    for g in GUARDS:
        w = {"guards": g, **witness(g)}
        report["witnesses"].append(w)
        ok &= w["result"] == "ある"
        shape = "控除の行を含む" if w["deductions"] else "控除の行の無い"
        print(f"{'OK' if w['result'] == 'ある' else 'NG'} {g} の決まりを全部満たす、{shape}入金の列（2件以上は取消を含む）: "
              f"{w['result']}（入金 {w['receipts']} 件）")
    for g in GUARDS:
        for inv in INVARIANTS:
            p = {"guards": g, "invariant": inv, **prove(g, inv)}
            report["proofs"].append(p)
            ok &= p["result"] == "反例なし"
            print(f"{'OK' if p['result'] == '反例なし' else 'NG'} {g} の決まりで {inv} {INVARIANTS[inv][0]}: {p['result']}")
    for name, (base, _, inv) in BROKEN.items():
        b = {"name": name, "base": base, "invariant": inv, **search(name)}
        report["broken"].append(b)
        ok &= b["result"] == "反例あり"
        print(f"{'OK' if b['result'] == '反例あり' else 'NG'} 壊した版「{name}」で {inv} の反例: {b['result']}（入金 {b['receipts']} 件）")
        if args.show and "counterexample" in b:
            print(json.dumps({"broken": name, "invariant": inv, **b["counterexample"]}, ensure_ascii=False, indent=2))
    for case in cases:
        try:
            c = check_case(case)
        except CaseError as error:
            print(f"NG {error}", file=sys.stderr)
            return 2
        except Undecided as error:
            c = {"name": case.get("name", "?"), "broken": case.get("broken"), "invariant": case.get("invariant"),
                 "result": "NG", "rejected_by": None, "problems": [str(error)]}
        report["cases"].append(c)
        ok &= c["result"] == "OK"
        print(f"{c['result']} 試験の入力「{c['name']}」（{c['broken']}）" + (f": {'・'.join(c['problems'])}" if c["problems"] else ""))
    missing = sorted(set(BROKEN) - {c["broken"] for c in report["cases"]})
    if missing:
        ok = False
        print(f"NG 試験の入力が無い壊した版: {'・'.join(missing)}（反例を receipt_matching_cases.json に写す）")
    report["missing_cases"] = missing
    for order in orders:
        try:
            o = check_order(order)
        except CaseError as error:
            print(f"NG {error}", file=sys.stderr)
            return 2
        except Undecided as error:
            o = {"name": order.get("name", "?"), "result": "NG", "problems": [str(error)]}
        report["registration_order"].append(o)
        ok &= o["result"] == "OK"
        print(f"{o['result']} 取消の登録順の入力「{o['name']}」" + (f": {'・'.join(o['problems'])}" if o["problems"] else ""))
    for rule, question in OPEN_DECISIONS.items():
        print(f"未決 PLANNED の「{rule}」（#6 の着手前に決める）: {question}")
    report["ok"] = ok

    if args.json:
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.summary:
        with args.summary.open("a", encoding="utf-8") as f:
            f.write(summary_md(report) + "\n")
    print("OK 消込の不変条件はすべて成り立つ" if ok else "NG 外れたものがある（上の NG の行）")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
