#!/usr/bin/env python3
"""企画の試算の写し（trials_snapshot.json の形）の架空版と、その取り込みの期待値（trials-expected.json）を作る。

会社ルート plans/2026-10-08-phase1-five-second-yojitsu.md の香盤表 #13（試算の取り込み。FR-REV-YOJITSU-026）の試験が読む。

- 架空の写しは3つ: trials-snapshot.json（架空の企画A の古い冊と新しい冊・架空の企画B）、trials-snapshot-revised.json（企画A を改めた冊と、
  前と同じ企画B の冊）、trials-snapshot-mismatch.json（窓口の売上と入金の行が2円合わない冊）。形は build_yojitsu.py の trial_books・
  trial_rows が読む形（入金サイト（月）の行・見出しの行・シナリオ×項目の行）で、値は乱数の種から作る架空の額。実名・実額・ORG の試算は使わない
- 期待値は、会社ルート ORG/事業計画/_build/build_yojitsu.py（#23b）の trial_rows に架空の写しと架空の「試算の案件」を渡して流した行と照合の結果。
  1回目の取り込み → 改めた写しの取り込み（前の写しの行が「予測に使う＝いいえ」になる）→ 合わない写しの照合、の3段。
  統合システムの読み方（src/revenue/yojitsu/trial-import-model.mjs）がこの行と同じになることを test/yojitsu-trial-import.test.mjs が確かめる
- 窓口を外す印（build_yojitsu.py の EXCLUDED_ITEMS）の理由の文は ORG の判断の文なので写さず、状態を「除いた窓口」と書く
- ORG の予実管理表.xlsx・expected.json・trials_snapshot.json は開かない（golden.py と同じく、実行の前後で大きさと更新時刻が変わらないことを確かめる）。
  書く前に、出力に ORG の案件コード・名前・金額・試算のファイル名が無いことを確かめる（golden.py の fab_leaks）

使い方: python trials.py [--build-yojitsu <build_yojitsu.py>] [--check]
  --build-yojitsu を省くと、環境変数 ON_BUILD_YOJITSU、無ければこのファイルから上へたどって ORG/事業計画/_build/build_yojitsu.py
  --check は作り直して、置いてある4つのファイルと同じバイト列かを確かめる（違えば終了コード 1。書かない）
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import random
import sys
import tempfile
from decimal import Decimal, ROUND_HALF_EVEN
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
NOTICE = "架空データ。企画の試算の取り込みの試験専用で、実在の企画・案件・取引先・金額ではない"
PLAN = "会社ルート plans/2026-10-08-phase1-five-second-yojitsu.md の #13"
SEED = 20261020
# 架空の「試算の案件」（試算のファイル名の頭 → 案件コード）。案件は試験が作る架空の案件
PROJECT_MAP = {"売上試算_架空企画A": "TR-P01", "売上試算_架空企画B": "TR-P02"}
EXCLUDED_MARK = "除いた窓口（build_yojitsu.py の EXCLUDED_ITEMS）"
FIRST_MONTH = dt.date(2026, 10, 1)
MONTH_COUNT = 12
SITE = 2
CHANNEL_UNIT = "円（本数×単価）"
CHANNELS = ["配信", "パッケージ", "放送"]
SCENARIO_FACTOR = {"even": Decimal("1.00"), "good": Decimal("1.20"), "MAX": Decimal("1.50")}
FILES = {"first": "trials-snapshot.json", "revised": "trials-snapshot-revised.json", "mismatch": "trials-snapshot-mismatch.json",
         "expected": "trials-expected.json"}


def load_golden():
    spec = importlib.util.spec_from_file_location("yojitsu_golden", HERE / "golden.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def month_add(d: dt.date, n: int) -> dt.date:
    m = d.month - 1 + n
    return dt.date(d.year + m // 12, m % 12 + 1, 1)


def serial(d: dt.date) -> int:
    return (d - dt.date(1899, 12, 30)).days


def fictional_sha(path: str, version: str) -> str:
    return hashlib.sha256(f"架空の試算 {path} {version}".encode("utf-8")).hexdigest().upper()


def cents(rng: random.Random, low: int, high: int) -> Decimal:
    """不規則な桁の架空の額（小数2桁）。小数がちょうど 0.50 にならないようにする（足すと Python の浮動小数と10進の丸めがずれるため）。"""
    return Decimal(rng.randint(low, high)) + Decimal(rng.choice([13, 27, 41, 68, 84, 92])) / 100


def as_number(v: Decimal):
    return int(v) if v == v.to_integral_value() else float(v)


def book(rng: random.Random, path: str, version: str, scale: Decimal, *, paid_in_offset: Decimal = Decimal(0), offset_month: int = 3,
         halves: dict | None = None) -> dict:
    """1冊の架空の試算。halves は (シナリオ, 窓口, 月の番号) → ちょうど .5 の額（偶数への丸めを確かめる）。"""
    months = [month_add(FIRST_MONTH, i) for i in range(MONTH_COUNT)]
    rows = [["架空の売上試算（回収スケジュール）", None, None] + [None] * MONTH_COUNT,
            ["入金サイト（月）", SITE, None] + [None] * MONTH_COUNT,
            [None] * (3 + MONTH_COUNT),
            ["シナリオ", "項目", "単位"] + [serial(m) for m in months]]
    for sc, factor in SCENARIO_FACTOR.items():
        channel_values = {}
        for ci, ch in enumerate(CHANNELS):
            vals = []
            for i in range(MONTH_COUNT):
                if halves and (sc, ch, i) in halves:
                    v = halves[(sc, ch, i)]
                elif (i + ci) % 5 == 4:
                    v = None  # 売上の無い月（空のセル）
                elif (i + ci) % 7 == 6:
                    v = Decimal("0.4")  # 0.5 以下の値は読まない
                else:
                    v = (cents(rng, 40_000, 900_000) * factor * scale).quantize(Decimal("0.01"))
                    if v == v.to_integral_value() + Decimal("0.5"):
                        v += Decimal("0.01")
                vals.append(v)
            channel_values[ch] = vals
            rows.append([sc, ch, CHANNEL_UNIT] + [None if v is None else as_number(v) for v in vals])
        # 入金の行: 窓口の売上を入金サイトだけ後ろへずらした月ごとの合計（0.5 以下の値は読まないので入れない）
        paid = []
        for i in range(MONTH_COUNT):
            src = i - SITE
            total = Decimal(0)
            if src >= 0:
                for ch in CHANNELS:
                    v = channel_values[ch][src]
                    if v is not None and abs(v) > Decimal("0.5"):
                        total += v
            if i == offset_month:
                total += paid_in_offset
            paid.append(None if total == 0 else as_number(total))
        rows.append([sc, "入金", "円"] + paid)
        invest = [None] * MONTH_COUNT
        invest[0] = as_number(-(Decimal(rng.randint(2_000_000, 4_000_000)) * scale).quantize(Decimal("1")))
        invest[2] = as_number(-(Decimal(rng.randint(500_000, 1_500_000)) + Decimal("0.5")))  # 出資の偶数への丸め
        rows.append([sc, "出資", "円"] + invest)
        rows.append([sc, "経費の見込み", "円"] + [as_number(cents(rng, 10_000, 90_000)) for _ in range(MONTH_COUNT)])  # 窓口でない行は読まない
    return {"path": path, "sha256": fictional_sha(path, version), "rows": rows}


def snapshots():
    rng = random.Random(SEED)
    halves = {("good", "パッケージ", 3): Decimal("123456.5"), ("good", "パッケージ", 4): Decimal("98765.5")}
    a_old = book(rng, "ORG/企画/架空企画A/30_提出版/売上試算_架空企画A_20260901.xlsx", "A1", Decimal("0.9"))
    a = book(rng, "ORG/企画/架空企画A/30_提出版/売上試算_架空企画A_20261001.xlsx", "A2", Decimal("1"), halves=halves)
    b = book(rng, "ORG/企画/架空企画B/30_提出版/売上試算_架空企画B_20261005.xlsx", "B1", Decimal("0.7"), paid_in_offset=Decimal("0.30"))
    a_revised = book(rng, "ORG/企画/架空企画A/30_提出版/売上試算_架空企画A_20261020.xlsx", "A3", Decimal("1.1"))
    a_bad = book(rng, "ORG/企画/架空企画A/30_提出版/売上試算_架空企画A_20261101.xlsx", "A4", Decimal("1"), paid_in_offset=Decimal("2.00"))
    return {"first": [a_old, a, b], "revised": [a_revised, copy.deepcopy(b)], "mismatch": [a_bad]}


def check_float_rounding(snaps):
    """窓口の売上の足し方（build_yojitsu.py は浮動小数で足す）と、10進で足して偶数へ丸める統合システムの額が同じになることを確かめる。"""
    for name, books in snaps.items():
        for bk in books:
            grid = bk["rows"]
            hdr = next(i for i, r in enumerate(grid) if r[0] == "シナリオ")
            for r in grid[hdr + 1:]:
                for v in r[3:]:
                    if isinstance(v, float):
                        exact = Decimal(repr(v))
                        if exact.quantize(Decimal(1), rounding=ROUND_HALF_EVEN) != round(v):
                            raise SystemExit(f"{name}: {v} の丸めが10進と浮動小数で違う")


def rows_out(rows):
    out = []
    for r in rows:
        status = r[10]
        if r[12] == "いいえ" and not str(status).startswith("試算"):
            status = EXCLUDED_MARK  # ORG の判断の文は写さない
        out.append({"予測ID": r[0], "版": r[1], "作った日": r[2].isoformat(), "案件コード": r[3], "シナリオ": r[4], "月": r[5].isoformat(), "区分": r[6],
                    "項目": r[7], "相手": r[8], "金額（円・税別）": r[9], "状態": status, "出所": r[11], "予測に使う": r[12]})
    return out


def lf_dumps(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, indent=1) + "\n").encode("utf-8")


def make(build_path: Path) -> dict[str, bytes]:
    golden = load_golden()
    bm = golden.load_build_yojitsu(build_path)
    for name in ("trial_rows", "trial_books", "EXCLUDED_ITEMS", "IMPORT_PREFIX"):
        if not hasattr(bm, name):
            raise SystemExit(f"build_yojitsu.py に {name} が無い")
    guard = golden.protected_files(bm)
    before = golden.stat_of(guard)
    snaps = snapshots()
    check_float_rounding(snaps)
    files = {key: lf_dumps(snaps[key]) for key in ("first", "revised", "mismatch")}
    work = Path(tempfile.mkdtemp(prefix="yojitsu-trials-"))
    try:
        paths = {}
        for key, data in files.items():
            paths[key] = work / FILES[key]
            paths[key].write_bytes(data)
        today1, today2 = dt.date(2026, 10, 20), dt.date(2026, 10, 21)
        rows1, checks1 = bm.trial_rows([], 1, today1, snapshot=paths["first"], trial_project=PROJECT_MAP)
        pred = copy.deepcopy(rows1)
        rows2, checks2 = bm.trial_rows(pred, len(rows1) + 1, today2, snapshot=paths["revised"], trial_project=PROJECT_MAP)
        rows3, checks3 = bm.trial_rows([], 1, today1, snapshot=paths["mismatch"], trial_project=PROJECT_MAP)
    finally:
        for p in work.glob("*"):
            p.unlink()
        work.rmdir()
    if golden.stat_of(guard) != before:
        raise SystemExit("ORG の予実管理表.xlsx・expected.json・trials_snapshot.json の大きさか更新時刻が変わった")
    if any(c["入金の行との差"] > 1 for c in checks1 + checks2) or not any(c["入金の行との差"] > 1 for c in checks3):
        raise SystemExit("照合の差が想定と違う（1回目と改めた写しは1円以内、合わない写しは1円を超える）")
    expected = {
        "fictional": True,
        "notice": NOTICE,
        "generator": "trials.py",
        "plan": PLAN,
        "sources": {FILES[k]: hashlib.sha256(v).hexdigest() for k, v in files.items()},
        "build_yojitsu": {"ファイル": "会社ルート ORG/事業計画/_build/build_yojitsu.py（#23b）",
                          "走らせ方": "trial_rows(予測の行, 最初の番号, 取り込んだ日, snapshot=架空の写し, trial_project=架空の試算の案件)"},
        "試算の案件": PROJECT_MAP,
        "除いた窓口": sorted(bm.EXCLUDED_ITEMS),
        "notes": [
            "1回目は trials-snapshot.json を空の予測に、2回目は trials-snapshot-revised.json を1回目の行に流した。2回目の 前の行 は、1回目の行のうち"
            "改めた写しで「予測に使う＝いいえ」になった行の予測ID",
            "合わない は trials-snapshot-mismatch.json の照合だけ（build_yojitsu.py は差が1円を超えると取り込まずに止まる）",
            "状態の「試算（監督申告を含む）」は build_yojitsu.py の文のまま。除いた窓口の状態の文は写さず、除いた印に置き換えた",
        ],
        "1回目": {"取り込んだ日": today1.isoformat(), "行": rows_out(rows1), "照合": checks1},
        "2回目": {"取り込んだ日": today2.isoformat(), "行": rows_out(rows2), "照合": checks2,
                 "前の行": [r[0] for r in pred if r[12] == "いいえ" and r[0] in {x[0] for x in rows1 if x[12] == "はい"}]},
        "合わない": {"照合": checks3},
    }
    out = dict(files)
    out["expected"] = lf_dumps(expected)
    text = "".join(v.decode("utf-8") for v in out.values())
    leaks = golden.fab_leaks(bm, text, [json.loads(v) for v in out.values()])
    if leaks:
        raise SystemExit(f"出力に ORG の値がある（書かない）: {leaks}")
    return out


def main():
    ap = argparse.ArgumentParser(description="企画の試算の写しの架空版と取り込みの期待値を作る")
    ap.add_argument("--build-yojitsu", help="会社ルートの ORG/事業計画/_build/build_yojitsu.py")
    ap.add_argument("--check", action="store_true", help="作り直して、置いてあるファイルと同じかを確かめる（書かない）")
    args = ap.parse_args()
    golden = load_golden()
    out = make(golden.find_build_yojitsu(args.build_yojitsu))
    if args.check:
        bad = [FILES[k] for k, v in out.items() if not (HERE / FILES[k]).exists() or (HERE / FILES[k]).read_bytes().replace(b"\r\n", b"\n") != v]
        print("試算の架空の写しと期待値は作り直したものと同じ" if not bad else f"作り直したものと違う: {bad}")
        sys.exit(1 if bad else 0)
    for key, data in out.items():
        (HERE / FILES[key]).write_bytes(data)
        print(f"{FILES[key]}={hashlib.sha256(data).hexdigest()[:12]} bytes={len(data)}")


if __name__ == "__main__":
    main()
