#!/usr/bin/env python3
"""公開デモ用の「撮影現場の記録」の架空データ（genba-showcase.json）を作る。

作品「七月の標本室（架空）」（DEMO-W02）に、日々スケ・香盤・ロケ地・小道具・許可申請を、実務で使っている画面と同じ形で入れる。
題名・人物・俳優・場所・住所・会社・担当はすべて架空で、実在の作品・人物・団体とは関係ない。実データからは何も写していない。
使い方: python demo-fixtures/genba-showcase/generate_genba_showcase.py（同じフォルダの genba-showcase.json を書き直す）
"""
import json
from pathlib import Path

OUT = Path(__file__).with_name('genba-showcase.json')

characters = [
    {"key": "mio", "name": "汐見澪", "short": "澪", "actor": "架空 美咲"},
    {"key": "kiryu", "name": "桐生刑事", "short": "桐", "actor": "架空 剛"},
    {"key": "kancho", "name": "館長・真壁", "short": "真", "actor": "架空 宗一"},
    {"key": "sota", "name": "颯太", "short": "颯", "actor": "架空 陽"},
    {"key": "nagisa", "name": "渚（7年前）", "short": "渚", "actor": "架空 小春"},
    {"key": "yui", "name": "結衣", "short": "結", "actor": "架空 栞"},
    {"key": "gakugei", "name": "学芸員・野々村", "short": "野", "actor": "架空 誠"},
    {"key": "ex_visitor", "name": "来館者（EX）", "short": "来館", "actor": None, "extra": True},
]
locations = [
    {"key": "museum", "name": "架空市立自然史博物館", "address": "架空県架空市森の台1-1", "green_room": "2階 会議室", "parking": "職員用駐車場 4台"},
    {"key": "storage", "name": "博物館・収蔵庫（同所地下）", "address": "架空県架空市森の台1-1", "note": "撮影は閉館後のみ"},
    {"key": "police", "name": "架空第三スタジオ（警察署セット）", "address": "架空県架空市港南3-8-2", "green_room": "控室A・B"},
    {"key": "house", "name": "汐見家（架空ハウススタジオ）", "address": "架空県架空市緑ヶ丘5-14", "green_room": "1階 和室", "note": "スリッパ用意は制作部"},
    {"key": "forest", "name": "架空県民の森 キャンプ場", "address": "架空県架空郡山里町1200", "parking": "第2駐車場"},
    {"key": "river", "name": "架空川 河川敷", "address": "架空県架空市川辺町 架空橋下"},
    {"key": "station", "name": "架空中央駅 北口", "note": "集合場所"},
]

def row(s, dn, pages, head, synopsis, cast, start=None, end=None, note=None):
    r = {"s": s, "dn": dn, "pages": pages, "head": head, "synopsis": synopsis, "cast": cast}
    if start: r["start"] = start
    if end: r["end"] = end
    if note: r["note"] = note
    return r
meal = lambda start, end, label="昼食休憩": {"slot": "meal", "label": label, "start": start, "end": end}

days = [
    ("2026-12-07", "月", "晴れ", "06:38", "16:29", "本隊", "6:30 架空中央駅北口発", ["博物館は開館前の撮影。9時までに搬入を終える", "収蔵庫は閉館後（17時〜）"], "museum", [
        row(["1"], "D", 1.5, "博物館・標本室", "七月、澪が標本ラベルの違和感に気づく", ["mio", "gakugei"], "07:30"),
        row(["2"], "D", 1, "博物館・展示室", "来館者に紛れる颯太", ["sota", "ex_visitor"]),
        row(["5"], "D", 2, "博物館・館長室", "真壁が7年前の寄贈記録を隠す", ["kancho", "mio"]),
        meal("12:00", "13:00"),
        row(["6", "7"], "D", 2.5, "博物館・標本室", "澪と颯太、ラベルの筆跡を比べる", ["mio", "sota"]),
        row(["12"], "N", 1.5, "博物館・収蔵庫", "閉館後、収蔵庫の奥に古い木箱", ["mio", "gakugei"], "17:30", "19:00", "照明部 先行"),
    ]),
    ("2026-12-08", "火", "曇り", "06:39", "16:29", "本隊", "7:00 架空中央駅北口発", ["スタジオ入り 8:00。警察署セットは終日"], "police", [
        row(["3"], "D", 1, "警察署・捜査一課", "桐生が7年前の失踪の資料を開く", ["kiryu"], "09:00"),
        row(["8"], "D", 2, "警察署・取調室", "颯太の聴取", ["kiryu", "sota"]),
        meal("12:30", "13:30"),
        row(["9", "10"], "D", 2, "警察署・捜査一課", "地図に赤い円を描く桐生", ["kiryu", "mio"]),
        row(["21"], "N", 1, "警察署・非常階段", "桐生が報告書を手渡す", ["kiryu", "mio"], None, "18:30"),
    ]),
    ("2026-12-09", "水", "晴れ", "06:40", "16:29", "本隊", "6:45 架空中央駅北口発", ["ハウススタジオは近隣への挨拶済み。車両は2台まで"], "house", [
        row(["4"], "D", 1, "汐見家・リビング（朝）", "澪と結衣の朝食", ["mio", "yui"], "08:30"),
        row(["11"], "D", 1.5, "汐見家・リビング", "渚の写真を見つめる結衣", ["yui"]),
        meal("12:00", "13:00"),
        row(["13", "14"], "D", 2, "汐見家・渚の部屋", "7年前の夏休みのノート", ["mio", "yui"]),
        row(["15"], "N", 1, "汐見家・玄関（夜）", "颯太が訪ねてくる", ["mio", "sota"], None, "19:30"),
    ]),
    ("2026-12-10", "木", "", "", "", "本隊", "", ["撮休（予備日）。雨天のとき 12/11 の河川敷をここへ移す"], None, []),
    ("2026-12-11", "金", "晴れ", "06:42", "16:30", "本隊", "6:00 架空中央駅北口発", ["山の天気が変わりやすい。雨具・暖房器具は制作部", "日没 16:30。夕景は 15:30 から"], "forest", [
        row(["16"], "D", 1.5, "県民の森・キャンプ場", "7年前のキャンプの回想（渚）", ["nagisa", "yui", "mio"], "08:00"),
        row(["17", "18"], "D", 2, "県民の森・観察小屋", "古びた小屋で見つかるリボン", ["mio", "sota", "kiryu"]),
        meal("12:00", "13:00", "昼食（ロケ弁）"),
        row(["19"], "D", 1, "架空川・河川敷", "標本の鳥が見ていたもの", ["mio", "sota"]),
        row(["20"], "D", 1, "県民の森・丘", "夕景、7年後の約束", ["mio", "yui", "sota"], "15:30", "16:30"),
    ]),
    ("2026-12-12", "土", "晴れ", "06:43", "16:30", "本隊", "7:00 架空中央駅北口発", ["展示室は来館者エキストラ 20名。受付 8:30"], "museum", [
        row(["22"], "D", 2, "博物館・展示室", "真壁の告白", ["kancho", "mio", "kiryu"], "09:00"),
        row(["23"], "D", 1, "博物館・標本室", "新しいラベルを書く澪", ["mio"]),
        meal("12:00", "13:00"),
        row(["24"], "D", 1.5, "博物館・展示室", "再開した特別展に集まる人々", ["mio", "yui", "sota", "ex_visitor"], None, "16:00"),
    ]),
]

sheets = []
for i, (date, wd, weather, sunrise, sunset, crew, dep, notes, place, rows) in enumerate(days, start=1):
    if not rows:
        continue
    cast = sorted({c for r in rows for c in r.get("cast", []) if not c.startswith("ex_")})
    calls = [{"who": [c], "time": "07:00" if c == "mio" else "08:00", "place": "station"} for c in cast]
    if any("ex_visitor" in r.get("cast", []) for r in rows):
        calls.append({"who": ["ex_visitor"], "time": "08:30", "place": place, "note": "受付で衣装確認"})
    sheets.append({"file": f"day{i}-final.pdf", "originPath": f"current/DEMO/F03_プリプロダクション/架空/day{i}-final.pdf", "stamp": "決", "state": "fixed",
        "date": date, "weekday": wd, "weather": weather, "sunrise": sunrise, "sunset": sunset, "crew": crew, "departure": dep, "notes": notes, "rows": rows, "calls": calls})

callsheets = {"note": "公開デモ用の日々スケ（架空）。題名・人物・俳優・場所はすべて架空。",
    "work": {"projectCode": "DEMO-W02", "projectTitle": "七月の標本室（架空）", "workCode": "DEMO-W02", "workTitle": "七月の標本室（架空）", "unit": "本隊"},
    "characters": characters, "groups": {}, "locations": locations, "sheets": sheets}

# 小道具（状態の分け方と担当の付け方は、現場の備品リストと同じ形。品目はすべて架空）
P = []
def prop(scene, date, place, name, qty, kind, dept, owner, state, source, note=None, action=None, memo=None):
    if state == "unassigned":  # 未割当は部署と担当をまだ決めていない（取込の決まり）
        dept, owner = None, None
    P.append({"key": f"genba-{len(P)+1:03d}", "sceneLabel": f"#{scene}", "shootOn": date, "place": place, "name": name, "quantity": qty, "kind": kind,
        **({"department": dept} if dept else {}), **({"ownerLabel": owner} if owner else {}), "state": state, "source": source,
        **({"scriptNote": note} if note else {}), **({"nextAction": action} if action else {}), **({"memo": memo} if memo else {})})
d1, d2, d3, d5, d6 = "2026-12-07", "2026-12-08", "2026-12-09", "2026-12-11", "2026-12-12"
prop(1, d1, "博物館・標本室", "鳥の剥製の標本（ラベル付き）", "3", "dressing", "art", "美術A", "ready", "both", "ラベルの字が一枚だけ違う")
prop(1, d1, "博物館・標本室", "標本ラベル（7年前の筆跡・AIで作成）", "1式", "hand", "direction", "演出B", "ready", "both", "筆跡の違いが分かるように", memo="AI で作成。実在の人物の筆跡・写真は使っていない（確認済み）")
prop(1, d1, "博物館・標本室", "ルーペ", "1", "hand", "art", "美術A", "ready", "script")
prop(2, d1, "博物館・展示室", "来館者のパンフレット", "20", "hand", "production", "制作C", "arranging", "meeting", action="印刷所へ入稿")
prop(5, d1, "博物館・館長室", "寄贈記録の台帳（7年前）", "1", "hand", "direction", "演出B", "arranging", "script", "頁をめくると一行だけ消されている", action="中身を AI で作る")
prop(5, d1, "博物館・館長室", "館長の万年筆", "1", "hand", "art", "美術A", "ready", "script")
prop(6, d1, "博物館・標本室", "比べる2枚のラベル（拡大コピー）", "2", "hand", "direction", "演出B", "adjust", "meeting", action="寄りの画で読める大きさか監督に確認")
prop(12, d1, "博物館・収蔵庫", "古い木箱（リボン入り）", "1", "dressing", "art", "美術A", "arranging", "both", "埃をかぶった木箱", action="汚しを入れる")
prop(12, d1, "博物館・収蔵庫", "懐中電灯", "2", "hand", "production", "制作C", "ready", "script")
prop(3, d2, "警察署・捜査一課", "7年前の捜査資料（ファイル）", "1式", "hand", "direction", "演出B", "ready", "both", "資料をめくる", memo="AI で作成。人物写真は架空の合成で、実在の俳優・人物の画像は使っていない")
prop(3, d2, "警察署・捜査一課", "失踪した少女の写真（AIで合成）", "1", "hand", "direction", "演出B", "adjust", "both", action="使用の可否を事務所と確認中", memo="ネットの画像を元にしない。確認が済むまで使わない")
prop(8, d2, "警察署・取調室", "湯呑み・お茶", "2", "consumable", "production", "制作C", "ready", "meeting")
prop(9, d2, "警察署・捜査一課", "地図（A3を貼り合わせる）と赤ペン", "1", "hand", "direction", "演出B", "ready", "both", "赤い円を描く")
prop(10, d2, "警察署・捜査一課", "レンタカーの貸出履歴（AIで作成）", "1式", "hand", "direction", "演出B", "arranging", "both", action="頁数を決める", memo="社名・人名は架空")
prop(21, d2, "警察署・非常階段", "報告書（黒バインダー）", "1", "hand", "art", "美術A", "unassigned", "script")
prop(4, d3, "汐見家・リビング（朝）", "朝食（トースト・サラダ）", "2人分", "consumable", "production", "制作C", "arranging", "both", action="当日朝に購入")
prop(11, d3, "汐見家・リビング", "渚の写真立て", "1", "dressing", "art", "美術A", "adjust", "both", action="写真の人物を決める（架空の合成か、出演者の撮り下ろし）")
prop(13, d3, "汐見家・渚の部屋", "夏休みのノート", "1", "hand", "art", "美術A", "arranging", "script", "最後の頁に地図")
prop(13, d3, "汐見家・渚の部屋", "ランドセル（赤）", "1", "hand", "costume", "衣装D", "ready", "script")
prop(15, d3, "汐見家・玄関（夜）", "玄関の靴（家族分）", "5足", "dressing", "production", "制作C", "ready", "meeting")
prop(16, d5, "県民の森・キャンプ場", "テント・タープ", "1式", "dressing", "art", "美術A", "arranging", "both", action="レンタル店へ予約")
prop(16, d5, "県民の森・キャンプ場", "ホットサンドの材料", "4人分", "consumable", "production", "制作C", "adjust", "meeting", action="焼き上がり用と食べる用を分ける")
prop(17, d5, "県民の森・観察小屋", "色あせたリボン", "1", "hand", "costume", "衣装D", "arranging", "script", "7年分の色あせ")
prop(17, d5, "県民の森・観察小屋", "古びた備品（小屋の中）", "1式", "dressing", "art", "美術A", "unassigned", "meeting", action="現地の備品で足りるか下見で確認")
prop(18, d5, "県民の森・観察小屋", "暗幕・ブルーシート（遮蔽）", "1式", "other", "production", "制作C", "ready", "meeting")
prop(19, d5, "架空川・河川敷", "双眼鏡", "1", "hand", "art", "美術A", "ready", "script")
prop(20, d5, "県民の森・丘", "タイムカプセル（お菓子の缶）とスコップ", "1", "hand", "art", "美術A", "arranging", "both", action="汚し用と新品の2つ")
prop(22, d6, "博物館・展示室", "特別展のポスター", "3", "dressing", "art", "美術A", "arranging", "meeting", action="デザインを AI で作り、監督確認")
prop(23, d6, "博物館・標本室", "新しい標本ラベル", "1", "hand", "direction", "演出B", "unassigned", "script")
prop(24, d6, "博物館・展示室", "来館者の手荷物", "20", "hand", "production", "制作C", "unneeded", "meeting", memo="エキストラの私物で足りる")
props = {"note": "公開デモ用の小道具（架空）。品目・担当はすべて架空。", "work": {"code": "DEMO-W02", "title": "七月の標本室（架空）"}, "items": P}

permits = {"note": "公開デモ用の許可申請（架空）。提出先・場所はすべて架空。",
  "offices": [
    {"name": "架空中央警察署", "leadBusinessDays": 3, "maxSpanDays": 7, "note": "道路使用。窓口は交通課"},
    {"name": "架空北警察署", "leadBusinessDays": 3, "maxSpanDays": 7},
    {"name": "架空県 県民の森管理事務所", "leadBusinessDays": 5, "maxSpanDays": 3, "note": "公園の使用"},
    {"name": "架空市 河川管理課", "leadBusinessDays": 7, "maxSpanDays": 5},
    {"name": "架空市立自然史博物館 総務課", "leadBusinessDays": 10, "maxSpanDays": 14, "note": "施設の撮影"},
  ],
  "applications": [
    {"office": "架空中央警察署", "kind": "road", "place": "架空市森の台1丁目 博物館前の歩道（機材車の停車）", "startsOn": d1, "state": "permitted", "appliedOn": "2026-11-27", "pickupOn": "2026-12-02", "receivedOn": "2026-12-02", "feeYen": 2100},
    {"office": "架空中央警察署", "kind": "road", "place": "架空市森の台1丁目 交差点付近（来館者の歩く画）", "startsOn": d6, "state": "submitted", "appliedOn": "2026-12-01", "pickupOn": "2026-12-08", "feeYen": 2100},
    {"office": "架空北警察署", "kind": "road", "place": "架空市緑ヶ丘5丁目 汐見家前の道路", "startsOn": d3, "state": "permitted", "appliedOn": "2026-11-30", "pickupOn": "2026-12-04", "receivedOn": "2026-12-04", "feeYen": 2100},
    {"office": "架空県 県民の森管理事務所", "kind": "park", "place": "県民の森 キャンプ場・観察小屋", "startsOn": d5, "state": "permitted", "appliedOn": "2026-11-20", "pickupOn": "2026-11-27", "receivedOn": "2026-11-28"},
    {"office": "架空県 県民の森管理事務所", "kind": "park", "place": "県民の森 丘の上（夕景）", "startsOn": d5, "state": "returned", "appliedOn": "2026-11-20", "note": "火気の使用は不可。焚き火の場面は差し替え"},
    {"office": "架空市 河川管理課", "kind": "park", "place": "架空川 河川敷（架空橋下）", "startsOn": d5, "state": "submitted", "appliedOn": "2026-11-28", "pickupOn": "2026-12-09"},
    {"office": "架空市立自然史博物館 総務課", "kind": "facility", "place": "博物館 標本室・展示室・館長室", "startsOn": d1, "endsOn": d6, "state": "permitted", "appliedOn": "2026-11-10", "pickupOn": "2026-11-24", "receivedOn": "2026-11-24", "feeYen": 30000},
    {"office": "架空市立自然史博物館 総務課", "kind": "facility", "place": "博物館 地下収蔵庫（閉館後）", "startsOn": d1, "state": "draft", "note": "閉館後の入室は学芸員の立ち会いが条件"},
  ]}

OUT.write_text(json.dumps({"note": "公開デモ用の撮影現場の記録（架空）。実在の作品・人物・団体・場所とは関係ない。", "callSheets": callsheets, "props": props, "permits": permits}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(OUT, len(sheets), "sheets,", len(P), "props,", len(permits["applications"]), "permits")
