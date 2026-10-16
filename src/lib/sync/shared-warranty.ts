import {canonicalNative} from './shared-journal';
import {sha256Hex} from './inventory/canonical-payload';
type Obj=Record<string,unknown>;
export function warrantyRevision(value:Obj):Obj{const {revision,...body}=value;void revision;return{...body,revision:sha256Hex(canonicalNative(body))}}
export function warrantyFromSale(v:Obj,serial:Obj){
 const sale=(v.payload as Obj).sale as Obj,line=(sale.lines as Obj[]).find(line=>line.productId===serial.productId&&line.serial===serial.text);if(!line)throw Error('SHARED_WARRANTY_BASIS_REQUIRED');const customer=sale.customer as Obj|undefined,days=String(serial.warrantyDays??'0');
 const source={productId:serial.productId,serial:serial.text,sourceOperationId:v.operationId,soldAtMs:v.originAtUtcMs,priceCents:line.unitPriceCents,customerName:customer?.name??null};
 return warrantyRevision({...source,name:line.name,state:'SOLD',days,untilMs:BigInt(days)>BigInt(0)?(BigInt(String(v.originAtUtcMs))+BigInt(days)*BigInt(86400000)).toString():null,sourceHash:sha256Hex(canonicalNative(source)),version:'0'});
}
