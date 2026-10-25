// 「（額×係数 − 引く額）× 料率 × 後の係数」を、途中で丸めずに計算して最後に1回だけ truncate する（0に向かって切り捨て）。
// 製作委員会の二次使用料の式（例: （事業収入×80% − 事業経費）× 3.35%、事業収入 × 3.35% × 90%）。係数と料率は bp。
export function factorRateAmount({amount, grossFactorBps = 10000, minusYen = 0, rateBps, afterFactorBps = 10000}) {
 for (const [v, label] of [[amount, '額'], [minusYen, '引く額']]) if (!Number.isSafeInteger(v)) throw new Error(`${label}を整数の円として確認できません`);
 for (const [v, label] of [[grossFactorBps, '係数'], [rateBps, '料率'], [afterFactorBps, '後の係数']]) if (!Number.isInteger(v) || v < 0) throw new Error(`${label}を 0 以上の整数の bp として確認できません`);
 const numerator = (BigInt(amount) * BigInt(grossFactorBps) - BigInt(minusYen) * 10000n) * BigInt(rateBps) * BigInt(afterFactorBps);
 const sign = numerator < 0n ? -1n : 1n;
 const result = sign * ((sign * numerator) / 1000000000000n);
 const out = Number(result);
 if (!Number.isSafeInteger(out)) throw new Error('計算した額が安全な整数を超えました');
 return out;
}

// Shared by sales and MG reporting: largest remainder, work ID as tie breaker.
export function splitByAllocation(value,shares){
 if(!Number.isSafeInteger(value)||!shares.length||shares.some(x=>!Number.isSafeInteger(x.work_id)||!Number.isInteger(x.allocation_bps)||x.allocation_bps<0)||shares.reduce((n,x)=>n+x.allocation_bps,0)!==10000||new Set(shares.map(x=>x.work_id)).size!==shares.length)throw new Error('金額または作品配賦を確認してください');
 const sign=value<0?-1:1,v=BigInt(Math.abs(value));
 const parts=shares.map(x=>({workId:x.work_id,base:v*BigInt(x.allocation_bps)/10000n,rem:v*BigInt(x.allocation_bps)%10000n}));
 let left=v-parts.reduce((n,x)=>n+x.base,0n);parts.sort((a,b)=>a.rem===b.rem?a.workId-b.workId:a.rem>b.rem?-1:1);
 for(let j=0;left>0n;j++,left--)parts[j%parts.length].base++;
 return new Map(parts.map(x=>[x.workId,sign*Number(x.base)]));
}

// 分子÷分母を円に四捨五入（half_up。ちょうど0.5は0から遠ざける。docs/rules/money.md の名前）。数量×単価・税抜×税率に使う
export function divideHalfUp(numerator,denominator){const n=BigInt(numerator),d=BigInt(denominator);if(d<=0n)throw new Error('分母は正の整数が必要です');const sign=n<0n?-1n:1n,a=n<0n?-n:n;let q=a/d;if((a%d)*2n>=d)q+=1n;const v=sign*q;if(v>BigInt(Number.MAX_SAFE_INTEGER)||v<-BigInt(Number.MAX_SAFE_INTEGER))throw new Error('金額が安全な整数の範囲を超えます');return Number(v);}
