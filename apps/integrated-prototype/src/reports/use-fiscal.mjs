// 組織の年度設定を読む（帳票センター・売上明細など）。読めないときは既定（期首5月・未確認）。
import {useEffect, useState} from 'react';
import {fiscalSettingFrom, DEFAULT_FISCAL_START_MONTH} from '../ui/condition-model.mjs';

export function useFiscal(request) {
  const [fiscal, setFiscal] = useState({fiscalStartMonth: DEFAULT_FISCAL_START_MONTH, confirmed: false, loaded: false});
  useEffect(() => {
    let live = true;
    request('/settings/fiscal').then((body) => live && setFiscal({...fiscalSettingFrom(body), loaded: true})).catch(() => live && setFiscal((previous) => ({...previous, loaded: true})));
    return () => { live = false; };
  }, [request]);
  return [fiscal, setFiscal];
}
