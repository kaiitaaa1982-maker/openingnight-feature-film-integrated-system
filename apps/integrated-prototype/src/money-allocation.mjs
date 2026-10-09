// Shared by sales and MG reporting: largest remainder, work ID as tie breaker.
export function splitByAllocation(value,shares){
 if(!Number.isSafeInteger(value)||!shares.length||shares.some(x=>!Number.isSafeInteger(x.work_id)||!Number.isInteger(x.allocation_bps)||x.allocation_bps<0)||shares.reduce((n,x)=>n+x.allocation_bps,0)!==10000||new Set(shares.map(x=>x.work_id)).size!==shares.length)throw new Error('金額または作品配賦を確認してください');
 const sign=value<0?-1:1,v=BigInt(Math.abs(value));
 const parts=shares.map(x=>({workId:x.work_id,base:v*BigInt(x.allocation_bps)/10000n,rem:v*BigInt(x.allocation_bps)%10000n}));
 let left=v-parts.reduce((n,x)=>n+x.base,0n);parts.sort((a,b)=>a.rem===b.rem?a.workId-b.workId:a.rem>b.rem?-1:1);
 for(let j=0;left>0n;j++,left--)parts[j%parts.length].base++;
 return new Map(parts.map(x=>[x.workId,sign*Number(x.base)]));
}
