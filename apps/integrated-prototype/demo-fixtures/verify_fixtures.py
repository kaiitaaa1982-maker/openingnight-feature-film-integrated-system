import csv,json
from pathlib import Path
from pypdf import PdfReader

p=Path(__file__).resolve().parent/'output'
def rows(name):
    with open(p/name,encoding='utf-8-sig',newline='') as f:return list(csv.reader(f))
s=rows('streaming-platform-sample.csv')[2:5]
assert sum(int(r[6]) for r in s)==1389000
assert sum(int(r[7]) for r in s)==234300
assert sum(int(r[8]) for r in s)==1154700
g=rows('videogram-rental-sample.csv')[2:5]
assert sum(int(r[6]) for r in g)==1158
assert sum(int(r[8]) for r in g)==726140
pdf=PdfReader(p/'broadcast-license-demo-contract.pdf')
text='\n'.join(x.extract_text() or '' for x in pdf.pages)
assert len(pdf.pages)==2
if True:
    for token in ['非公式・架空データ','WRK-DEMO','風のあとさき','2026年10月1日','2回','関東広域圏','1,320,000円','2026年10月31日']:
        assert token in text,token
print(json.dumps({'csvIndependentTotals':True,'pdfPages':2,'pdfJapaneseText':True},ensure_ascii=False))
