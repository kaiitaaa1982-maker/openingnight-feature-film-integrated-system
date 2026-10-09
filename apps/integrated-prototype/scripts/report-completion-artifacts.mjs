import {mkdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {LocalDatabase} from '../src/db.mjs';
import {reportCompletionFixture,completionExpected} from '../test/report-completion-fixture.mjs';
import {committeeReportSheets} from '../src/rights-report-output.mjs';
import {salesReportSheets} from '../src/report-center-model.mjs';
import {encodeXlsx,decodeXlsx} from '../src/xlsx.mjs';
import {printableReport,csvDocument} from '../src/report-output.mjs';
import {flattenCommitteeSnapshots} from '../src/report-analytics-facts.mjs';
import assert from 'node:assert/strict';

const out=resolve(process.argv[2]||'data/report-completion-review');
mkdirSync(out,{recursive:true});
const databasePath=join(out,'synthetic-reports.sqlite');
if(existsSync(databasePath))throw Error('架空実演DBが既にあります。新しい出力ディレクトリを指定してください');
const db=new LocalDatabase(databasePath);
try{
 const f=await reportCompletionFixture({db}),report=f.good(await f.req(`/rights-reports/committee?workId=1&snapshotId=${f.snapshots[2]}`)).report,annual=f.good(await f.req('/report-center?start=2026-01'));
 const outputs=[{name:'committee-income',title:'架空・製作委員会収支報告',sheets:committeeReportSheets(report,id=>['架空出資者A','架空出資者B','架空出資者C'][id-1])},{name:'annual-banpan',title:'架空・年間番販集計',sheets:salesReportSheets(annual,'banpan')},{name:'work-income',title:'架空・作品別収支',sheets:salesReportSheets(annual,'pnl')}];
 for(const output of outputs){const bytes=encodeXlsx(output.sheets);writeFileSync(join(out,output.name+'.xlsx'),bytes);assert.deepEqual(decodeXlsx(readFileSync(join(out,output.name+'.xlsx'))).map(s=>s.name),output.sheets.map(s=>s.name));writeFileSync(join(out,output.name+'.html'),printableReport({title:output.title,subtitle:'架空の検証用入力 ／ JPY・税抜 ／ 下書き・未確認',sheets:output.sheets}));writeFileSync(join(out,output.name+'.csv'),csvDocument(output.sheets[0].rows))}
 const snapshots=await db.all('SELECT * FROM committee_report_snapshots ORDER BY id');
 writeFileSync(join(out,'analytics-facts.json'),JSON.stringify(flattenCommitteeSnapshots(snapshots),null,2));
 assert.equal(report.totals.current.distributionPool,completionExpected.current.distributionPool);assert.equal(report.totals.cumulative.distributionPool,completionExpected.cumulative);
 writeFileSync(join(out,'verification.json'),JSON.stringify({synthetic:true,databasePath,workId:1,snapshotIds:f.snapshots,expected:completionExpected,actual:report.totals,sourceLineCount:report.sourceLines.length,foreignKeyViolations:await db.all('PRAGMA foreign_key_check'),outputs:outputs.map(o=>o.name)},null,2));
 console.log(JSON.stringify({outputDirectory:out,snapshotIds:f.snapshots,outputs:outputs.map(o=>o.name),currentPool:report.totals.current.distributionPool,cumulativePool:report.totals.cumulative.distributionPool}));
}finally{db.close()}
