// 帳票カタログの component 名 → 部品。登録が無い帳票は、従来の帳票パネル（ReportSalesPanel）を legacyMode で表示する。
import {MgSalesReport} from './MgSalesReport.jsx';
import {RoyaltyStatement} from './RoyaltyStatement.jsx';
import {PartnerBalanceReport, ReceivablesReport} from './ReceivableReports.jsx';
import {WorkPnlReport} from './WorkPnlReport.jsx';
import {AnnualDashboard} from './AnnualDashboard.jsx';
import {ProgressMatrix} from './ProgressMatrix.jsx';
import {DistributionMaster} from '../ReportCenter.jsx';
import {RoyaltyLedgerReport} from '../royalty/RoyaltyLedgerReport.jsx';
import {RoyaltyCycleReport} from '../royalty/RoyaltyCycleReport.jsx';
import {CommitteeMonthlyReport} from '../committee/CommitteeMonthlyPage.jsx';
import {SalesSheet} from '../sales-sheet/SalesSheet.jsx';
import {WorkPlReport as PlBsWorkPl, CompanyPlReport, CompanyBsReport} from '../pl-bs/PlBsPage.jsx';

export const REPORT_COMPONENTS = {
  'mg-sales': MgSalesReport,
  royalty: RoyaltyStatement,
  'partner-balance': PartnerBalanceReport,
  receivables: ReceivablesReport,
  'work-pnl': WorkPnlReport,
  'annual-dashboard': AnnualDashboard,
  progress: ProgressMatrix,
  'distribution-master': DistributionMaster,
  'royalty-ledger': RoyaltyLedgerReport,
  'royalty-cycle': RoyaltyCycleReport,
  'committee-monthly': CommitteeMonthlyReport,
  'sales-sheet': SalesSheet,
  'work-pl': PlBsWorkPl,
  'company-pl': CompanyPlReport,
  'company-bs': CompanyBsReport,
};
