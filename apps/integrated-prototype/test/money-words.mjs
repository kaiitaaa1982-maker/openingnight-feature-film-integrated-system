// money-rules と selector が共有する金額の識別子の基準。total（件数も表す）は含めない。
export const MONEY_WORDS = new Set(['yen', 'amount', 'price', 'bp', 'bps', 'rate', 'tax', 'fee', 'cost', 'budget', 'advance', 'recoup', 'royalty', 'payable']);
export const mentionsMoney = text => (text.match(/[A-Za-z][A-Za-z0-9]*/g) || [])
  .flatMap(id => id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split('_')).some(word => MONEY_WORDS.has(word));
