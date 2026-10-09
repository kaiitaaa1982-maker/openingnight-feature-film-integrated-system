import base64, io, unittest
import openpyxl
from workbench_extract import extract

class ExtractTests(unittest.TestCase):
    def test_preserves_csv_codes_and_encoding(self):
        result=extract({'name':'架空.csv','base64':base64.b64encode('コード,名称\r\n0012,架空\r\n'.encode('cp932')).decode()})
        self.assertEqual(result['sourceEncoding'],'cp932')
        self.assertEqual(result['sheets'][0]['rows'][1],['0012','架空'])

    def test_formula_without_cached_value_is_explicit(self):
        book=openpyxl.Workbook();book.active.append(['コード','金額']);book.active.append(['0012','=1+2'])
        stream=io.BytesIO();book.save(stream)
        result=extract({'name':'架空.xlsx','base64':base64.b64encode(stream.getvalue()).decode()})
        self.assertEqual(result['sheets'][0]['rows'][1][0],'0012')
        self.assertEqual(result['sheets'][0]['formulaIssues'][0]['cell'],'B2')

    def test_empty_unsupported_and_malformed_are_rejected(self):
        for name,data in [('empty.csv',b''),('macro.xlsm',b'not a workbook'),('bad.xlsx',b'not a zip')]:
            with self.subTest(name=name),self.assertRaises(Exception):
                extract({'name':name,'base64':base64.b64encode(data).decode()})

if __name__=='__main__': unittest.main()
