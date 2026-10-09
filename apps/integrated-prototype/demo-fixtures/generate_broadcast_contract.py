from pathlib import Path
import sys
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER,TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet,ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,Table,TableStyle,PageBreak

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'tmp'/'python'))
from fontTools.ttLib import TTCollection
OUT=ROOT/'output'; OUT.mkdir(parents=True,exist_ok=True)
PDF=OUT/'broadcast-license-demo-contract.pdf'
TMP=ROOT/'tmp'/'pdfs';TMP.mkdir(parents=True,exist_ok=True)
regular=TMP/'meiryo-regular.ttf';bold=TMP/'meiryo-bold.ttf'
if not regular.exists(): TTCollection(r'C:\Windows\Fonts\meiryo.ttc').fonts[0].save(regular)
if not bold.exists(): TTCollection(r'C:\Windows\Fonts\meiryob.ttc').fonts[0].save(bold)
pdfmetrics.registerFont(TTFont('JP',str(regular)));pdfmetrics.registerFont(TTFont('JPB',str(bold)))
JP='JP'; JPB='JPB'
styles=getSampleStyleSheet(); body=ParagraphStyle('body',fontName=JP,fontSize=9.5,leading=16,spaceAfter=7); title=ParagraphStyle('title',fontName=JPB,fontSize=18,leading=24,alignment=TA_CENTER,spaceAfter=12); h=ParagraphStyle('h',fontName=JPB,fontSize=11,leading=16,spaceBefore=7,spaceAfter=4,textColor=colors.HexColor('#17365D')); note=ParagraphStyle('note',fontName=JPB,fontSize=10,leading=15,alignment=TA_CENTER,textColor=colors.HexColor('#9C2A22'),backColor=colors.HexColor('#FCE8E6'),borderPadding=7,spaceAfter=12); right=ParagraphStyle('right',fontName=JP,fontSize=9,alignment=TA_RIGHT)
def footer(canvas,doc):
 canvas.saveState();canvas.setFont(JP,7.5);canvas.setFillColor(colors.HexColor('#667085'));canvas.drawString(20*mm,12*mm,'抽出・画面テスト用 fixture / 外部利用禁止');canvas.drawRightString(190*mm,12*mm,f'{doc.page} / 2');canvas.restoreState()
doc=SimpleDocTemplate(str(PDF),pagesize=A4,rightMargin=22*mm,leftMargin=22*mm,topMargin=18*mm,bottomMargin=20*mm,title='架空 放送許諾契約書（デモ）',author='OpeningNight demo fixture')
story=[Paragraph('放送許諾契約書（デモ）',title),Paragraph('非公式・架空データ・実在企業の発行書式ではありません。本書は契約抽出テスト専用で、法的効力を持たず、法務アドバイスでもありません。',note),Paragraph('作成日：2026年9月22日',right)]
parts=[
('第1条（当事者）','許諾者を「オープニングナイト・デモ制作室」（以下「甲」）、被許諾者を架空の放送事業者「青空テレビジョン株式会社 デモ局」（以下「乙」）とする。住所、代表者、実連絡先、押印および署名は設定しない。'),
('第2条（対象作品）','作品コード：WRK-DEMO<br/>作品名：風のあとさき<br/>種別：長編映画（架空作品）<br/>本編尺：98分（デモ設定）'),
('第3条（許諾権利）','甲は乙に対し、本契約の条件内で対象作品を放送する非独占的かつ譲渡不能の権利を許諾する。二次利用、商品化、公衆送信の再許諾、素材の改変および第三者への再提供は含まない。'),
('第4条（許諾期間）','2026年10月1日から2027年3月31日まで。期間外の放送または見逃し配信は許諾対象外とする。'),
('第5条（放送回数・地域・媒体）','放送回数：地上波本放送1回、再放送1回の合計2回。<br/>対象地域：関東広域圏（デモ設定）。<br/>対象媒体：乙が運営する架空の地上波チャンネルのみ。BS、CS、CATV、インターネット同時配信、見逃し配信、海外送信を含まない。'),
('第6条（対価）','許諾対価は税抜1,200,000円、消費税相当額120,000円、税込合計1,320,000円とする。これは抽出テスト用の架空金額である。'),
('第7条（支払期日）','乙は、2026年10月31日までに甲が別途指定する方法で支払うものとする。本fixtureには口座情報を記載しない。'),
('第8条（素材・クレジット）','甲は放送用映像素材および指定クレジット情報を別途提供する想定とする。乙は作品の同一性を損なう編集を行わない。'),
('第9条（報告）','乙は各放送後10営業日以内に、放送日時、放送地域、放送回数および障害の有無を記載した放送実績報告を甲へ提出する想定とする。'),
('第10条（デモ限定）','本書はシステムの文字抽出、項目認識、画面表示および監査経路の確認だけに使用する。実際の権利許諾、債権債務、保証、補償、秘密保持その他の法律関係を成立させない。')]
for head,text in parts:
 story.extend([Paragraph(head,h),Paragraph(text,body)])
 if head=='第5条（放送回数・地域・媒体）': story.append(PageBreak())
story.extend([Spacer(1,8*mm),Table([[Paragraph('甲（架空）',h),Paragraph('乙（架空）',h)],[Paragraph('オープニングナイト・デモ制作室<br/>署名・押印なし',body),Paragraph('青空テレビジョン株式会社 デモ局<br/>署名・押印なし',body)]],colWidths=[80*mm,80*mm],style=TableStyle([('BOX',(0,0),(-1,-1),0.7,colors.HexColor('#98A2B3')),('INNERGRID',(0,0),(-1,-1),0.4,colors.HexColor('#D0D5DD')),('BACKGROUND',(0,0),(-1,0),colors.HexColor('#EAF0F8')),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]))])
doc.build(story,onFirstPage=footer,onLaterPages=footer)
print(PDF)
