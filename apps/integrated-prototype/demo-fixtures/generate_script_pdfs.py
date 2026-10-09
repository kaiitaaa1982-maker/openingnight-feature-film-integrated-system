"""架空の連続ドラマ台本（縦書きPDF）を kouban/kouban-demo.json から作る。

- 決定稿（style=numbered）: A5縦・縦書きフォントで1行ずつ置く。シーン番号は柱の上に横書きで置く（印刷台本の組み方）
- 準備稿（style=glyph）: A4横・1文字ずつ置く。見出しは ◯。フォントの対応が壊れた字（っ→]）を3行だけまぜ、取込の「文字化けの疑い」を試せるようにする
どちらも本文の位置から列を組み直さないと読めないPDFで、台本取込の縦書き対応を確かめる材料にする。
使い方: python demo-fixtures/generate_script_pdfs.py [出力先フォルダ]（既定は public/demo-fixtures/scripts）
"""
import io, json, os, sys
from reportlab.lib.pagesizes import A4, A5, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, 'kouban', 'kouban-demo.json')
VERTICAL, HORIZONTAL = 'HeiseiMin-W3', 'HeiseiKakuGo-W5'
pdfmetrics.registerFont(UnicodeCIDFont(VERTICAL, isVertical=True))
pdfmetrics.registerFont(UnicodeCIDFont(HORIZONTAL))

# 準備稿だけに入れる、フォントの対応が壊れた字の行（シーン番号 → 置き換える字）
GARBLED = {2: ('ー', '.'), 9: ('っ', ']'), 21: ('の', ']')}


class Layout:
    def __init__(self, kind):
        if kind == 'numbered':
            self.size, self.pitch, self.page = 11, 22, A5
            self.right, self.left, self.top, self.bottom = 372, 40, 520, 60
            self.per_char = False
        else:
            self.size, self.pitch, self.page = 10.5, 20, landscape(A4)
            self.right, self.left, self.top, self.bottom = 760, 80, 420, 64
            self.per_char = True
        self.rows = int((self.top - self.bottom) // self.size) + 1


class Writer:
    def __init__(self, layout, footer, page_label):
        self.l, self.footer, self.page_label = layout, footer, page_label
        self.buf = io.BytesIO()
        self.c = canvas.Canvas(self.buf, pagesize=layout.page, invariant=1)
        self.page_no, self.x = 0, None

    def new_page(self, numbered=True):
        if self.x is not None:
            self.c.showPage()
        self.page_no += 1
        self.x = self.l.right
        if numbered:
            label = self.page_label(self.page_no)
            self.c.setFont(HORIZONTAL, 9)
            width = self.l.page[0]
            self.c.drawCentredString(width / 2, 30, f'― {label} ―')
            if self.l.per_char:
                self.c.drawString(85, 53, self.footer)
                self.c.drawString(418, 53, str(self.page_no - 1))
            else:
                self.c.setFont(HORIZONTAL, 6)
                self.c.drawRightString(width - 18, self.l.page[1] - 22, label)

    def column(self, text, indent=0):
        if self.x < self.l.left:
            self.new_page()
        y = self.l.top - indent * self.l.size
        if self.l.per_char:
            self.c.setFont(HORIZONTAL, self.l.size)
            for i, ch in enumerate(text):
                if ch != '　':
                    self.c.drawString(self.x - self.l.size / 2, y - i * self.l.size, ch)
        else:
            self.c.setFont(VERTICAL, self.l.size)
            self.c.drawString(self.x, y, text)
        x = self.x
        self.x -= self.l.pitch
        return x

    def blank(self):
        if self.x >= self.l.left:
            self.x -= self.l.pitch

    def block(self, text, indent=0, hang=0):
        """1行を列に流す。はみ出した分は次の列へ（2列目以降は hang 字下げ）"""
        room = self.l.rows - indent
        first = True
        while text:
            width = room if first else self.l.rows - indent - hang
            self.column(text[:width], indent if first else indent + hang)
            text, first = text[width:], False

    def save(self):
        self.c.showPage()
        self.c.save()
        return self.buf.getvalue()


def cast_list(data, episode):
    used = set()
    for scene in episode['scenes']:
        used.update(scene.get('cast', []))
        used.update(scene.get('extras', []))
    return [c['name'] for c in data['characters'] if c['key'] in used]


def render(data, episode, draft):
    layout = Layout(draft['style'])
    ep = episode['no']
    footer = f"{data['series']['seriesTitle'].replace('（架空）', '')} 第{ep}話 {draft['kind']}"
    w = Writer(layout, footer, lambda n: f'{ep}-{n - 1}')
    # 表紙（題名・話数・稿・脚本・登場人物）。ページ番号は付けない
    w.new_page(numbered=False)
    w.block(data['series']['seriesTitle'].replace('（架空）', ''), 2)
    w.block(f"第{ep}話「{episode['subtitle']}」", 4)
    w.block(draft['kind'], 8)
    w.blank()
    w.block(f"脚本　{data['series']['writer'].split('（')[0]}", 12)
    w.block('（この台本は架空のデモ資料です）', 12)
    w.blank()
    w.block('登場人物', 2)
    for name in cast_list(data, episode):
        w.block(name, 4)
    w.new_page()
    scenes = [s for s in episode['scenes'] if not (draft['kind'] == '準備稿' and s['no'] in (22, 23))]
    for index, scene in enumerate(scenes):
        head = scene['head']
        if draft['style'] == 'numbered':
            x = w.column(head, 0)
            w.c.setFont(HORIZONTAL, layout.size)
            w.c.drawString(x - 3, layout.top + 2.3 * layout.size, f"{scene['no']}\t")
        else:
            w.column('◯' + head, 0)
        for line in scene['lines']:
            kind = line[0]
            if kind == 'ト':
                text = line[1]
                if draft['kind'] == '準備稿' and scene['no'] in GARBLED:
                    a, b = GARBLED[scene['no']]
                    text = text.replace(a, b, 1)
                w.block(text, 4)
            elif kind == '台':
                w.block(f"{line[1]}「{line[2]}」", 0, hang=len(line[1]) + 1)
            elif kind == 'M':
                w.block(f"{line[1]}M『{line[2]}』", 0, hang=len(line[1]) + 2)
            elif kind == '×':
                w.column('×　　×　　×', 6)
        w.blank()
        if draft['kind'] == '準備稿' and index == 0:
            w.column('◯メインタイトル', 0)
            w.blank()
    return w.save()


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', 'public', 'demo-fixtures', 'scripts')
    os.makedirs(out, exist_ok=True)
    data = json.load(io.open(SOURCE, encoding='utf-8'))
    for episode in data['episodes']:
        for draft in episode['drafts']:
            pdf = render(data, episode, draft)
            path = os.path.join(out, draft['file'])
            with open(path, 'wb') as f:
                f.write(pdf)
            print(draft['file'], len(pdf), 'bytes')


if __name__ == '__main__':
    main()
