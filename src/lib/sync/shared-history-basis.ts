import type {VentaRDDatabase} from '@/lib/db/dexie';
import {getSharedCaptureContext} from './shared-capture';
import {sharedEntityKey} from './shared-bootstrap';
import {canonicalNative} from './shared-journal';
import {sha256Hex} from './inventory/canonical-payload';
import {sharedEffectId} from './shared-sale';
type Obj=Record<string,unknown>;
/** Read the original native recipe, never today's combo recipe. This is a
 * historical basis for the existing return domain, not a reconstructed sale. */
export async function sharedReturnStockBasis(db:VentaRDDatabase,saleId:string){
 const c=getSharedCaptureContext(db);if(!c)return;
 const row=await db.shared_entities.get(sharedEntityKey(c,'RETURN_BASIS',saleId));if(!row)return;
 const snapshot=row.value.snapshot as Obj;
 if(sha256Hex(canonicalNative(snapshot))!==row.value.snapshotHash||snapshot.operationId!==saleId||snapshot.tenantId!==c.tenantId)throw Error('refund_stock_basis_unavailable');
 const groups=new Map<string,{productoId:string;cantidadVendida:number;consumos:{productoId:string;cantidad:number}[];recipe:string}>();
 const lines=(snapshot.sale as Obj).lines as Obj[];
 for(let index=0;index<lines.length;index++){const line=lines[index],quantity=line.quantity as Obj;if(quantity.denominator!=='1')throw Error('refund_stock_basis_unavailable');const qty=BigInt(String(quantity.numerator)),pid=String(line.productId??sharedEffectId(saleId,'line/'+index)),recipe=(line.recipe as Obj[])??[],fingerprint=canonicalNative(recipe),consumos:{productoId:string;cantidad:number}[]=[];
  if(line.productId){if(!recipe.length)consumos.push({productoId:pid,cantidad:Number(qty)});else for(const part of recipe){const ratio=part.perUnit as Obj,n=qty*BigInt(String(ratio.numerator)),d=BigInt(String(ratio.denominator));if(d<=BigInt(0)||n%d!==BigInt(0)||!Number.isSafeInteger(Number(n/d)))throw Error('refund_stock_basis_unavailable');consumos.push({productoId:String(part.productId),cantidad:Number(n/d)})}}
  const old=groups.get(pid);if(old){if(old.recipe!==fingerprint)throw Error('refund_stock_basis_unavailable');old.cantidadVendida+=Number(qty);for(const p of consumos){const target=old.consumos.find(x=>x.productoId===p.productoId);if(target)target.cantidad+=p.cantidad;else old.consumos.push(p)}}else groups.set(pid,{productoId:pid,cantidadVendida:Number(qty),consumos,recipe:fingerprint});
 }
 return[...groups.values()].map(({recipe,...basis})=>{void recipe;return basis});
}
