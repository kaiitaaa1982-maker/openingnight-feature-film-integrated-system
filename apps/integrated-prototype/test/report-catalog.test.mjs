import test from 'node:test';
import assert from 'node:assert/strict';
import {REPORT_CATALOG, REPORT_CATEGORIES, reportById, featuredReports, reportsByCategory} from '../src/reports/report-catalog.mjs';
import {LEGACY_REPORT_MODES} from '../src/shell/url-state.mjs';

test('report catalog ids are unique, every report has a way to open, and legacy modes resolve', () => {
  const ids = REPORT_CATALOG.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  const categories = new Set(REPORT_CATEGORIES.map((c) => c.id));
  for (const entry of REPORT_CATALOG) {
    assert.ok(categories.has(entry.category), entry.id);
    assert.ok(entry.description.length > 5, entry.id);
    if (entry.component === 'legacy') assert.ok(entry.legacyMode, entry.id);
    if (entry.component === 'link') assert.ok(entry.page, entry.id);
    if (entry.component === 'annual') assert.ok(entry.axis, entry.id);
  }
  for (const target of Object.values(LEGACY_REPORT_MODES)) assert.ok(ids.includes(target), `legacy mode target ${target}`);
  assert.deepEqual(featuredReports().map((e) => e.id), ['annual-sales', 'mg-sales', 'royalty', 'royalty-ledger', 'sales-sheet', 'committee-monthly']);
  assert.equal(reportById('no-such').id, 'annual-sales');
  assert.equal(reportsByCategory().reduce((n, c) => n + c.reports.length, 0), REPORT_CATALOG.length);
});
