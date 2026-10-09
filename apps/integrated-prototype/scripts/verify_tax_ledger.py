"""Read-only independent replay of the synthetic persisted tax ledger."""
from fractions import Fraction
from pathlib import Path
import json
import sqlite3

database = Path(__file__).resolve().parents[3] / 'analytics-poc/.runtime/year-demo.sqlite'
connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
connection.row_factory = sqlite3.Row

def rounded(value, mode):
    sign = -1 if value < 0 else 1
    quotient, remainder = divmod(abs(value.numerator), value.denominator)
    if mode == 'half_up' and remainder * 2 >= value.denominator:
        quotient += 1
    elif mode == 'ceil' and remainder:
        quotient += 1
    return sign * quotient

snapshots = connection.execute('SELECT * FROM tax_calculation_snapshots').fetchall()
assert len(snapshots) >= 2
for snapshot in snapshots:
    rule = connection.execute('SELECT * FROM tax_rule_versions WHERE id=?', (snapshot['rule_version_id'],)).fetchone()
    lines = connection.execute('SELECT * FROM tax_calculation_lines WHERE snapshot_id=?', (snapshot['id'],)).fetchall()
    grouped = {}
    for line in lines:
        original = connection.execute('SELECT * FROM sale_lines WHERE id=?', (line['sale_id'],)).fetchone()
        assert line['amount_ex_tax'] == original['amount_ex_tax']
        assert line['source_tax'] == original['tax_amount']
        assert line['amount_inc_tax'] == original['amount_inc_tax']
        key = (line['category'], line['rate_bps'])
        grouped.setdefault(key, []).append(line)
    expected_tax = expected_base = 0
    for (category, rate), group in grouped.items():
        source_base = sum(x['amount_ex_tax'] for x in group)
        source_gross = sum(x['amount_inc_tax'] for x in group)
        tax = Fraction((source_base if rule['basis'] == 'exclusive' else source_gross) * rate,
                       10000 if rule['basis'] == 'exclusive' else 10000 + rate)
        expected = rounded(tax, rule['rounding_mode'])
        expected_tax += expected
        expected_base += source_base if rule['basis'] == 'exclusive' else source_gross - expected
        stored = connection.execute('SELECT * FROM tax_invoice_rate_totals WHERE snapshot_id=? AND category=? AND rate_bps=?', (snapshot['id'], category, rate)).fetchone()
        assert Fraction(int(stored['exact_numerator']), int(stored['exact_denominator'])) == tax
        assert stored['billed_tax'] == expected
        assert stored['source_tax'] == sum(x['source_tax'] for x in group)
    invoice = connection.execute('SELECT * FROM billing_invoices WHERE id=?', (snapshot['invoice_id'],)).fetchone()
    assert invoice['tax_amount'] == snapshot['billed_tax'] == expected_tax
    assert invoice['amount_ex_tax'] == snapshot['amount_ex_tax'] == expected_base
    assert invoice['amount_inc_tax'] == expected_base + expected_tax
    assert snapshot['delta'] == expected_tax - sum(x['source_tax'] for x in lines)
assert not connection.execute('PRAGMA foreign_key_check').fetchall()
annual = connection.execute("SELECT count(*) n,sum(s.amount_ex_tax) amount FROM sale_lines s JOIN works w ON w.org_id=s.org_id AND w.id=s.work_id WHERE w.code LIKE 'DEMO25-%'").fetchone()
assert annual['n'] == 4284 and annual['amount'] == 356488600
connection.close()
print(json.dumps({'ok': True, 'persistedSnapshotsRecomputed': len(snapshots), 'annualDemoUnchanged': True, 'foreignKeyViolations': 0}))
