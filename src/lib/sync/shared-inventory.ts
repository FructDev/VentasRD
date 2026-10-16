import type {VentaRDDatabase} from '@/lib/db/dexie';
import {registrarMovimientoStockEn} from '@/lib/db/stock';
import {getSharedCaptureContext} from './shared-capture';

/** The original inventory form commits selected serials and stock together. */
export async function adjustSharedInventory(db:VentaRDDatabase,input:{productId:string;mode:'IN'|'LOSS'|'COUNT';quantity:number;serials:string[];at:number;operationId:string}){
 const c=getSharedCaptureContext(db);if(!c)throw Error('SHARED_PREPARATION_REQUIRED');
 const selected=input.serials.map(s=>s.trim()).filter(Boolean);
 if(!Number.isSafeInteger(input.quantity)||input.quantity<0||selected.length>1000||selected.some(s=>s.length>128||/[\x00-\x1f\x7f]/.test(s))||new Set(selected).size!==selected.length)throw Error('serial_seleccion_invalida');
 return db.transaction('rw',db.productos,db.movimientos_stock,db.seriales,async()=>{
  const product=await db.productos.get(input.productId);if(!product||product.negocio_id!==c.tenantId)throw Error('SHARED_CAPTURE_SCOPE_MISMATCH');
  if(product.serializable?selected.length!==input.quantity:selected.length!==0)throw Error('serial_seleccion_invalida');
  const rows=await db.seriales.where('negocio_id').equals(c.tenantId).toArray();
  const update=async(text:string,available:boolean)=>{
   const matches=rows.filter(s=>s.numero_serial===text);if(matches.length>1)throw Error('serial_duplicado');const old=matches[0];
   if(old&&(old.producto_id!==product.id||!['disponible','merma'].includes(old.estado))||input.mode==='IN'&&old||input.mode==='LOSS'&&old?.estado!=='disponible')throw Error('serial_no_disponible');
   if(old)await db.seriales.update(old.id,{estado:available?'disponible':'merma',estado_sincronizacion:0,fecha_actualizacion:input.at});
   else {if(!available)throw Error('serial_no_disponible');await db.seriales.add({id:crypto.randomUUID(),negocio_id:c.tenantId,producto_id:product.id,numero_serial:text,estado:'disponible',estado_sincronizacion:0,fecha_actualizacion:input.at})}
  };
  if(product.serializable){
   if(input.mode==='COUNT')for(const row of rows.filter(s=>s.producto_id===product.id&&s.estado==='disponible'&&!selected.includes(s.numero_serial)))await update(row.numero_serial,false);
   for(const text of selected)await update(text,input.mode!=='LOSS');
  }
  return registrarMovimientoStockEn(db,{negocioId:c.tenantId,sucursalId:c.branchId,originDeviceId:c.deviceId,operationId:input.operationId,now:input.at},{productoId:product.id,tipo:input.mode==='IN'?'entrada':input.mode==='LOSS'?'merma':'conteo',...(input.mode==='COUNT'?{valorAbsoluto:input.quantity}:{delta:input.mode==='LOSS'?-input.quantity:input.quantity})});
 });
}
