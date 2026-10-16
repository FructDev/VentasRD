type Obj=Record<string,unknown>;
const obj=(v:unknown)=>v as Obj;
const keys=['totalCents','cashSalesCents','cardCents','transferCents','creditCents','mixedCents','cashExpensesCents','cashCreditPaymentsCents','cardCreditPaymentsCents','transferCreditPaymentsCents','refundCents','repairIncomeCents','repairCashCents','layawayIncomeCents','layawayCashCents'];
export interface SharedDrawer extends Obj {turnId:string;openingCents:string;openedAtMs:string;netCashCents:string;expectedCents:string;summary:Record<string,string>;seen:Record<string,string>;products:Obj[]}
export function emptySharedDrawer(id:string,opening:string,at:string):SharedDrawer{return{turnId:id,status:'OPEN',openingCents:opening,openedAtMs:at,netCashCents:'0',expectedCents:opening,coverage:'VERIFIED',summary:Object.fromEntries(['salesCount',...keys].map(k=>[k,'0'])),details:[],products:[],productsCoverage:'LOCAL_NATIVE_ONLY',seen:{}}}
export function applySharedDrawer(d:SharedDrawer,v:Obj){
 const p=obj(v.payload),doc=obj(p.document??{}),same=v.originalTurnId===d.turnId,summary=d.summary;
 const add=(key:string,n:unknown)=>{summary[key]=(BigInt(summary[key]??'0')+BigInt(String(n))).toString()};
 const cash=(n:unknown)=>{d.netCashCents=(BigInt(d.netCashCents)+BigInt(String(n))).toString();d.expectedCents=(BigInt(d.openingCents)+BigInt(d.netCashCents)).toString()};
 if(v.kind==='SALE_CONFIRM'&&same){const sale=obj(p.sale),pay=obj(sale.payment);add('salesCount','1');add('totalCents',obj(sale.totals).totalCents);for(const [key,field]of[['cashSalesCents','cashNetCents'],['cardCents','cardCents'],['transferCents','transferCents'],['creditCents','creditChargeCents']])add(key,pay[field]);if(pay.method==='MIXTO')add('mixedCents',obj(sale.totals).totalCents);cash(pay.cashNetCents);
  for(const raw of sale.lines as Obj[]){const q=obj(raw.quantity);if(q.denominator!=='1')throw Error('SHARED_CASH_FACTS_REVIEW_REQUIRED');let row=d.products.find(r=>r.name===raw.name);if(!row){row={name:raw.name,quantity:{numerator:'0',denominator:'1'},subtotalCents:'0'};d.products.push(row)}obj(row.quantity).numerator=(BigInt(String(obj(row.quantity).numerator))+BigInt(String(q.numerator))).toString();row.subtotalCents=(BigInt(String(row.subtotalCents))+BigInt(String(raw.unitPriceCents))*BigInt(String(q.numerator))).toString()}
 }
 if(same&&doc.cashDeltaCents!==undefined)cash(doc.cashDeltaCents);
 if(same&&v.kind==='EXPENSE_RECORD'&&doc.method==='EFECTIVO')add('cashExpensesCents',doc.amountCents);
 if(same&&v.kind==='CREDIT_PAYMENT'){const key={EFECTIVO:'cashCreditPaymentsCents',TARJETA:'cardCreditPaymentsCents',TRANSFERENCIA:'transferCreditPaymentsCents'}[String(doc.method)];if(key)add(key,doc.amountCents)}
 if(same&&v.kind==='SALE_RETURN'){const refund=obj(doc.refund),minus=(key:string,n:unknown)=>add(key,(-BigInt(String(n))).toString());minus('totalCents',refund.amountCents);minus('cashSalesCents',refund.cashRefundCents);const bank=refund.bankRefundCents;if(refund.method==='TARJETA')minus('cardCents',bank);if(['TRANSFERENCIA','MIXTO'].includes(String(refund.method)))minus('transferCents',bank);if(refund.method==='MIXTO')minus('mixedCents',refund.amountCents);if(refund.method==='FIADO')minus('creditCents',refund.amountCents);add('refundCents',refund.amountCents);d.productsCoverage='LOCAL_NATIVE_SALES_BEFORE_RETURNS'}
 for(const [field,prefix]of[['repair','repair'],['layaway','layaway']]){const service=doc[field]?obj(doc[field]):null;if(!service)continue;for(const payment of service.payments as Obj[]){if(payment.turnId!==d.turnId)continue;const key=field+'/'+payment.operationId,bytes=JSON.stringify(payment);if(d.seen[key]){if(d.seen[key]!==bytes)throw Error('SHARED_PAYMENT_CONFLICT');continue}d.seen[key]=bytes;add(prefix+'IncomeCents',payment.amountCents);if(payment.method==='EFECTIVO')add(prefix+'CashCents',payment.amountCents)}}
 if(v.kind==='TURN_CLOSE'&&same)d.status='CLOSED';
 return d;
}
export function drawerDocument(d:SharedDrawer){const {seen,...publicView}=d;void seen;return publicView}
