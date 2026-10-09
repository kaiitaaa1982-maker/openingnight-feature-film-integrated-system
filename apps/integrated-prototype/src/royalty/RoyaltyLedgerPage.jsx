// ロイヤリティ集計シート（画面）。帳票センターの部品（RoyaltyLedgerReport）と同じ中身を、組織の年度設定で開く。
import React from 'react';
import {useShell} from '../shell/context.mjs';
import {useFiscal} from '../reports/use-fiscal.mjs';
import {RoyaltyLedgerReport} from './RoyaltyLedgerReport.jsx';

export function RoyaltyLedgerPage({data, onNavigate}) {
  const shell = useShell();
  const [fiscal] = useFiscal(shell.request);
  return <RoyaltyLedgerReport data={data} fiscal={fiscal} onNavigate={onNavigate} />;
}

export default RoyaltyLedgerPage;
