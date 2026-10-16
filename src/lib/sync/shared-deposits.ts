type Obj=Record<string,unknown>;
export function sharedDepositBasis(service:Obj,family:'repair'|'layaway'):bigint{
 const paid=BigInt(String(service.paidCents)),state=String(service.state);
 if(!['cancelado','no_reparado','abandonado'].includes(state))return BigInt(0);
 const basis=service.settlementPendingCents!==undefined?BigInt(String(service.settlementPendingCents)):state==='cancelado'?paid:family==='repair'?paid-BigInt(String(service.totalCents)):BigInt(0);
 if(basis>paid)throw Error('SHARED_DEPOSIT_REVIEW_REQUIRED');return basis>BigInt(0)?basis:BigInt(0);
}
