import type {Table} from 'dexie';
import type {VentaRDDatabase} from '@/lib/db/dexie';
import type {ProductoLocal,ReparacionLocal,ApartadoLocal,ClienteLocal} from '@/types/database';
import {withScopeStock} from './inventory/scope-stock';
import {commandHash,moneyCents} from '@/lib/domain/local/command';
import {markSharedProjection,type SharedMutation} from './shared-capture';
import {sharedContextKey,type SharedContext,type SharedEvent} from './shared-journal';
import {projectSharedEntities,storeSharedPageMetadata,storeSharedEntity,type SharedEntity} from './shared-bootstrap';
import {sharedEffectId} from './shared-sale';
import {sharedBalanceCents} from './shared-balance';
import {sharedHistoryValue} from './shared-history';
import {emptySharedDrawer,applySharedDrawer} from './shared-drawer';
export {sharedBalanceCents} from './shared-balance';

type Obj=Record<string,unknown>;
const object=(v:unknown):Obj=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('SHARED_PROJECTION_INVALID');return v as Obj};
const list=(v:unknown):Obj[]=>{if(!Array.isArray(v))throw Error('SHARED_PROJECTION_INVALID');return v.map(object)};
const number=(v:unknown):number=>{if(typeof v!=='string'||!(/^-?(0|[1-9][0-9]{0,15})$/).test(v)||!Number.isSafeInteger(Number(v)))throw Error('SHARED_PROJECTION_INVALID');return Number(v)};
const money=(v:unknown)=>number(v)/100;
const ratio=(v:unknown)=>{const r=object(v),d=number(r.denominator);if(d<=0)throw Error('SHARED_PROJECTION_INVALID');return number(r.numerator)/d};
const method=(v:unknown)=>{const m={EFECTIVO:'efectivo',TARJETA:'tarjeta',TRANSFERENCIA:'transferencia',FIADO:'fiado',MIXTO:'mixto'}[String(v)];if(!m)throw Error('SHARED_PROJECTION_INVALID');return m};
const scoped=(c:SharedContext)=>({negocio_id:c.tenantId,...(c.branchId?{sucursal_id:c.branchId}:{})});
const table=(db:VentaRDDatabase,name:string)=>db.table(name) as Table<Obj,string>;

/** Keep an initial authoritative balance separately from historical transactions.
 * It is not a fabricated cargo/abono and never enters cash or sales reports. */

/** A receipt acknowledges the original local transaction only after ALL its
 * commands are verified and covered by the received cursor. Row hashes prevent
 * an older acknowledgement from clearing a newer local edit. */
async function acknowledgeSources(db:VentaRDDatabase,c:SharedContext){
 const key=sharedContextKey(c),cursor=(await db.shared_state.get(key))?.cursor??'0';
 const mutations=(await db.shared_mutations.where('scopeKey').equals(key).toArray()).sort((a,b)=>a.order-b.order);
 for(const raw of mutations){if(raw.state!=='PREPARED'||!raw.operationIds?.length||raw.private&&raw.private.state!=='APPLIED')continue;
  const ops=await db.shared_outbox.bulkGet(raw.operationIds.map(id=>key+'/'+id));
  if(ops.some(op=>op?.state!=='APPLIED'||!op.receipt||BigInt(String(op.receipt.remoteSequence))>BigInt(cursor)))continue;
  for(const change of raw.changes){if(!change.after||['operaciones_locales','shared_configuration'].includes(change.table))continue;const target=table(db,change.table),current=await target.get(change.key);if(current&&commandHash(current)===commandHash(change.after))await target.update(change.key,{estado_sincronizacion:1})}
  await db.shared_mutations.update(raw.id,{state:'APPLIED',code:undefined});
 }
}

function service(c:SharedContext,e:SharedEntity):ReparacionLocal|ApartadoLocal{
 const s=e.value,d=object(s.definition),payments=list(s.payments).map(p=>({caja_id:typeof p.turnId==='string'?p.turnId:undefined,monto:money(p.amountCents),metodo:method(p.method) as 'efectivo'|'tarjeta'|'transferencia',fecha:number(p.dateMs),...(p.type?{tipo:p.type as 'abono'|'final'|'revision'}:{})}));
 const common={id:String(s.id),...scoped(c),folio:String(s.folio),cliente_id:typeof d.customerId==='string'?d.customerId:undefined,cliente_nombre:String(d.customerName),cliente_telefono:String(d.phone??''),total:money(s.totalCents),estado:String(s.state),notas:String(d.notes??''),fecha_creacion:number(s.createdAtMs),fecha_actualizacion:number(s.updatedAtMs),estado_sincronizacion:1 as const};
 if(e.kind==='LAYAWAY')return{...common,estado:s.state as ApartadoLocal['estado'],abonado:money(s.paidCents),abonos:payments,items:list(d.items).map(item=>({producto_id:String(item.productId),nombre:String(item.name),cantidad:number(item.quantity),precio_unitario:money(item.priceCents),...(item.serial?{serial_id:sharedEffectId(String(item.productId),'serial/'+item.serial),serial_numero:String(item.serial)}:{})})),...(s.completedAtMs?{fecha_completado:number(s.completedAtMs)}:{}),...(s.cancelledAtMs?{fecha_cancelado:number(s.cancelledAtMs)}:{})};
 return{...common,estado:s.state as ReparacionLocal['estado'],equipo_marca:String(d.brand??''),equipo_modelo:String(d.model),equipo_imei:String(d.imei??''),equipo_color:String(d.color??''),condicion_checklist:d.conditionChecks as string[]??[],condicion_entrada:String(d.conditionNotes??''),accesorios:String(d.accessories??''),problema_reportado:String(d.problem??''),diagnostico:String(d.diagnosis??''),tecnico_nombre:String(d.technician??''),mano_obra:money(d.labourCents),abono:money(s.paidCents),pagos:payments,repuestos:list(d.parts).map(part=>({producto_id:typeof part.productId==='string'?part.productId:undefined,nombre:String(part.name),cantidad:number(part.quantity),costo:money(part.costCents),precio:money(part.priceCents),desde_inventario:!!part.productId,stock_aplicado:!!part.productId})),bitacora:list(s.log).map(log=>({estado:log.state as ReparacionLocal['estado'],fecha:number(log.dateMs),usuario:String(log.actorId)})),garantia_dias:number(s.warrantyDays),garantia_hasta:s.warrantyUntilMs?number(s.warrantyUntilMs):undefined,fecha_entrega:s.deliveredAtMs?number(s.deliveredAtMs):undefined};
}

/** Materialize original web pages from immutable journal facts. Never call the
 * web checkout, stock adjustment or debt mutation functions while receiving. */
async function eventRows(db:VentaRDDatabase,c:SharedContext,event:SharedEvent,own:boolean){
 const v=object(JSON.parse(event.intent)),p=object(v.payload),d=p.document?object(p.document):{},id=String(v.operationId),at=number(v.originAtUtcMs),base={id,...scoped(c),fecha_creacion:at,fecha_actualizacion:at,estado_sincronizacion:1};
 if(v.kind==='SALE_CONFIRM'){
  if(!event.snapshot)throw Error('SHARED_SNAPSHOT_REQUIRED');const snapshot=object(JSON.parse(event.snapshot)),sale=object(snapshot.sale),payment=object(sale.payment),totals=object(sale.totals),ticket=/^(N[a-f0-9]{32})-(\d+)$/.exec(String(snapshot.ticket));if(!ticket)throw Error('SHARED_TICKET_INVALID');
  if(!own||!await db.ventas.get(id)){
   await table(db,'ventas').put({...base,caja_id:v.originalTurnId??undefined,numero_ticket:Number(ticket[2]),caja_codigo:ticket[1],total:money(totals.totalCents),metodo_pago:method(payment.method),monto_efectivo:money(payment.cashNetCents),monto_transferencia:money(payment.transferCents),cliente_id:object(sale.customer??{}).id??payment.customerId??undefined,cliente_nombre:snapshot.customerName??undefined});
   let index=0;for(const line of list(sale.lines)){const detail=sharedEffectId(id,'line/'+index++),quantity=ratio(line.quantity),price=money(line.unitPriceCents);await table(db,'venta_detalles').put({...base,id:detail,venta_id:id,producto_id:line.productId??detail,...(line.productId?{}:{sin_stock:true}),nombre:line.name,cantidad:quantity,precio_unitario:price,subtotal:price*quantity})}
   if(payment.method==='FIADO')await table(db,'transacciones_fiado').put({...base,id:sharedEffectId(id,'credit'),caja_id:v.originalTurnId??null,cliente_id:payment.customerId,venta_id:id,tipo:'cargo',monto:money(payment.creditChargeCents),concepto:'Venta '+snapshot.ticket});
   for(const stock of list(sale.inventory))await table(db,'movimientos_stock').put({...base,id:sharedEffectId(id,'stock/'+stock.productId),producto_id:stock.productId,delta:number(stock.delta),tipo:'venta',referencia_id:id});
  }
 }
 if(v.kind==='CREDIT_PAYMENT'&&(!own||!await db.transacciones_fiado.get(id)))await table(db,'transacciones_fiado').put({...base,caja_id:v.originalTurnId??null,cliente_id:d.customerId,venta_id:null,tipo:'abono',monto:money(d.amountCents),metodo_pago:method(d.method),concepto:d.concept});
 if(v.kind==='EXPENSE_RECORD'&&(!own||!await db.gastos.get(id)))await table(db,'gastos').put({...base,caja_id:v.originalTurnId??null,categoria:d.category,descripcion:d.concept,monto:money(d.amountCents),metodo:method(d.method)});
 if(v.kind==='TURN_OPEN'&&(!own||!await db.cajas.get(id)))await table(db,'cajas').put({...base,estado:'abierta',monto_apertura:money(p.openingCents),fecha_apertura:at});
 if(v.kind==='SALE_RETURN'&&(!own||!await db.devoluciones.get(id))){const refund=object(d.refund),original=await db.shared_entities.get(sharedContextKey(c)+'/SALE/'+d.saleId),sale=object(original?.value.sale),lines=list(sale.lines);await table(db,'devoluciones').put({...base,venta_id:d.saleId,caja_id:v.originalTurnId,items_devueltos:list(refund.items).map(item=>{const line=item.key&&String(item.key).startsWith('free/')?lines[Number(String(item.key).slice(5))]:lines.find(line=>line.productId===item.key);if(!line)throw Error('SHARED_RETURN_BASIS_REQUIRED');return{producto_id:line.productId??sharedEffectId(String(d.saleId),'line/'+String(item.key).slice(5)),cantidad:number(item.quantity),precio_unitario:money(line.unitPriceCents)}}),monto_devuelto:money(d.amountCents),razon:d.concept});if(d.credit){const credit=object(d.credit);await table(db,'transacciones_fiado').put({...base,id:sharedEffectId(id,'credit'),cliente_id:credit.customerId,venta_id:d.saleId,tipo:'abono',monto:money(d.amountCents),concepto:d.concept})}}
 if(v.kind==='TURN_CLOSE'){const turn=String(v.originalTurnId),row=await db.cajas.get(turn);if(row)await db.cajas.update(turn,{estado:'cerrada',fecha_cierre:at,monto_cierre:money(d.countedCents),monto_esperado:money(object(d.drawer).expectedCents),diferencia:money(d.differenceCents),estado_sincronizacion:1,fecha_actualizacion:at})}
 if(['CUT_X','TURN_CLOSE'].includes(String(v.kind))&&(!own||!await db.cortes_caja.get(id))){const drawer=object(d.drawer),s=object(drawer.summary);await table(db,'cortes_caja').put({...base,caja_id:v.originalTurnId,tipo:v.kind==='TURN_CLOSE'?'Z':'X',efectivo:money(s.cashSalesCents),tarjeta:money(s.cardCents),transferencia:money(s.transferCents),fiado:money(s.creditCents),mixto:money(s.mixedCents),total_ventas:money(s.totalCents),cantidad_transacciones:number(s.salesCount),monto_apertura:money(drawer.openingCents),monto_esperado:money(drawer.expectedCents),monto_contado:money(d.countedCents),diferencia:money(d.differenceCents)})}
}

export async function projectSharedWebEvent(db:VentaRDDatabase,c:SharedContext,event:SharedEvent){
 await projectSharedEntities(db,c,event);
}

/** Rebuild absolute views plus still-local pending effects under the SAME lock
 * as inbox/cursor. Native balances and stock already contain confirmed effects. */
export async function reconcileSharedWeb(db:VentaRDDatabase,c:SharedContext,options:{adoptReviewedHistory?:boolean}={}){
 markSharedProjection();const key=sharedContextKey(c);await acknowledgeSources(db,c);
 const pending=(await db.shared_mutations.where('scopeKey').equals(key).toArray()).filter(raw=>raw.state!=='APPLIED').sort((a,b)=>a.order-b.order),entities=await db.shared_entities.where('scopeKey').equals(key).toArray();
 let prior:Record<string,unknown[]>|undefined;
 if(options.adoptReviewedHistory){
  if(pending.length)throw Error('SHARED_OPERATION_REVIEW_REQUIRED');
  prior=(await db.shared_captures.where('scopeKey').equals(key).toArray()).find(row=>row.state==='STAGING'&&row.prior)?.prior;
  if(!prior)throw Error('SHARED_CAPTURE_REQUIRED');
 }
 const locked=(name:string,id:string)=>pending.some(raw=>raw.changes.some(change=>change.table===name&&change.key===id));
 const acknowledged=(op:string)=>db.shared_outbox.get(key+'/'+op);
 for(const e of entities.filter(e=>e.kind==='LEGACY_HISTORY')){
  const marker=key+'/WEB_HISTORY/'+e.entityId;if(await db.shared_entities.get(marker))continue;
  const history=object(e.value.history);
  for(const t of list(history.tables)){
   const name=String(t.name);if(!['ventas','venta_detalles','transacciones_fiado','cajas','cortes_caja','devoluciones','gastos','reparaciones','apartados','seriales'].includes(name))continue;
   for(const r of list(t.rows)){
    if(r.negocio_id!==c.tenantId||typeof r.id!=='string'||r.sucursal_id!==undefined&&(r.sucursal_id??null)!==c.branchId)continue;
    const old=await table(db,name).get(r.id);
    if(old&&prior){
     const saved=list(prior[name]??[]).find(row=>row.id===r.id);
     if(old.negocio_id!==c.tenantId||!saved||commandHash(old)!==commandHash(saved))throw Error('SHARED_LOCAL_SOURCE_CHANGED');
    }
    // Only the initial reviewed preparation may replace a stale browser row.
    // Its exact original remains in capture.prior; later feeds never replay it.
    if(!old||prior)await table(db,name).put({...object(sharedHistoryValue(r)),estado_sincronizacion:1});
   }
  }
  await storeSharedEntity(db,c,'WEB_HISTORY',e.entityId,{preserved:true},e.sequence);
 }
 for(const e of entities.filter(e=>e.kind==='EVENT').sort((a,b)=>Number(BigInt(a.sequence)-BigInt(b.sequence)))){const marker=key+'/WEB_EVENT/'+e.entityId;if(await db.shared_entities.get(marker))continue;const event=object(e.value.event) as unknown as SharedEvent;await eventRows(db,c,event,!!await acknowledged(e.entityId));await storeSharedEntity(db,c,'WEB_EVENT',e.entityId,{projected:true},e.sequence)}
 for(const e of entities){const r=e.value,id=e.entityId;
  if(e.kind==='PRODUCT'){
   const old=await db.productos.get(id);if(old&&old.negocio_id!==c.tenantId)throw Error('SHARED_VISIBLE_TENANT_CONFLICT');const meta=object(r.metadata),prices=object(r.priceTiers),stock=object(r.stock??{quantity:'0',authority:'UNKNOWN'});
   let quantity=number(stock.quantity);for(const raw of pending)for(const change of raw.changes)if(change.table==='movimientos_stock'&&change.after?.producto_id===id){const opIds=raw.operationIds??[],already=await db.shared_outbox.bulkGet(opIds.map(op=>key+'/'+op));if(already.some(op=>op?.receipt&&BigInt(String(op.receipt.remoteSequence))<=BigInt(String(stock.version??'0'))&&JSON.parse(op.wire.intent).kind!=='PRODUCT_CREATE'&&(op.receipt.stock as Obj[]??[]).some(row=>row.productId===id)))continue;quantity=change.after.valor_absoluto===undefined?quantity+Number(change.after.delta):Number(change.after.valor_absoluto)}
   if(quantity<0||!Number.isSafeInteger(quantity))throw Error('SHARED_PENDING_STOCK_CONFLICT');
   const product:ProductoLocal={id,...scoped(c),nombre:String(r.name),codigo_barras:String(r.code??''),precio_venta:money(prices.retailCents),precio_2:prices.tier2Cents==null?undefined:money(prices.tier2Cents),precio_3:prices.tier3Cents==null?undefined:money(prices.tier3Cents),costo:meta.costCents==null?0:money(meta.costCents),stock_actual:quantity,stock_minimo:meta.minimum==null?0:number(meta.minimum),tasa_itbis:ratio(meta.taxRate),tipo:meta.productType as ProductoLocal['tipo']??'simple',ubicacion:String(meta.location??''),imagen_url:typeof object(meta.photo??{}).data==='string'?String(object(meta.photo).data):typeof object(meta.photo??{}).source==='string'?String(object(meta.photo).source):undefined,serializable:meta.serialRequired===true,eliminado:r.deleted===true,estado_sincronizacion:1,fecha_actualizacion:Number(e.sequence)};
   const visible=locked('productos',id)&&old?{...old,stock_actual:quantity}:{...product,inventory_stock_by_scope:old?.inventory_stock_by_scope};
   await db.productos.put(withScopeStock(visible,{negocioId:c.tenantId,sucursalId:c.branchId},quantity));
   if(!locked('productos',id)){const recipe=list(meta.recipe??[]),rows=await db.composiciones.where('producto_padre_id').equals(id).toArray();await db.composiciones.bulkDelete(rows.map(row=>row.id));for(const part of recipe)await db.composiciones.put({id:sharedEffectId(id,'recipe/'+part.productId),producto_padre_id:id,insumo_id:String(part.productId),cantidad_necesaria:ratio(part.perUnit),estado_sincronizacion:1})}
  }
  if(e.kind==='CUSTOMER'){
   const old=await db.clientes.get(id);if(old&&old.negocio_id!==c.tenantId)throw Error('SHARED_VISIBLE_TENANT_CONFLICT');
   let balance=BigInt(String(r.balanceCents));for(const raw of pending)for(const change of raw.changes)if(change.table==='transacciones_fiado'&&change.after?.cliente_id===id){const ops=await db.shared_outbox.bulkGet((raw.operationIds??[]).map(op=>key+'/'+op));if(ops.some(op=>op?.receipt&&BigInt(String(op.receipt.remoteSequence))<=BigInt(e.sequence)))continue;balance+=BigInt(moneyCents(Number(change.after.monto)))*(change.after.tipo==='cargo'?BigInt(1):BigInt(-1))}
   const history=await db.transacciones_fiado.where('cliente_id').equals(id).filter(row=>row.negocio_id===c.tenantId).toArray(),historyCents=sharedBalanceCents({id,negocio_id:c.tenantId},history),offset=(balance-BigInt(historyCents)).toString();
   const row:ClienteLocal={id,negocio_id:c.tenantId,nombre:String(r.name),telefono:typeof r.phone==='string'?r.phone:null,limite_credito:money(r.limitCents),tipo_precio:Number(r.priceTier??1) as 1|2|3,al_por_mayor:r.wholesale===true,eliminado:r.active===false,estado_sincronizacion:1,fecha_actualizacion:Number(e.sequence)};
   await table(db,'clientes').put({...locked('clientes',id)&&old?old:row,shared_balance_offset_cents:offset});
  }
  if((e.kind==='REPAIR'||e.kind==='LAYAWAY')&&!locked(e.kind==='REPAIR'?'reparaciones':'apartados',id)){
   const target=e.kind==='REPAIR'?db.reparaciones:db.apartados,old=await target.get(id);if(old&&old.negocio_id!==c.tenantId)throw Error('SHARED_VISIBLE_TENANT_CONFLICT');const projected=service(c,e);if('items'in projected)await db.apartados.put(projected);else await db.reparaciones.put({...projected,...(old&&'patron_clave'in old?{patron_clave:old.patron_clave}:{})});
  }
  if(e.kind==='TURN'&&r.status==='OPEN'&&!locked('cajas',id)&&!await db.cajas.get(id))await db.cajas.put({id,...scoped(c),estado:'abierta',monto_apertura:money(r.openingCents),fecha_apertura:number(r.openedAtMs),fecha_actualizacion:number(r.openedAtMs),estado_sincronizacion:1});
  if(e.kind==='SERIAL'){const w=object(r.warranty??{}),old=await db.seriales.where('negocio_id').equals(c.tenantId).filter(s=>s.producto_id===r.productId&&s.numero_serial===r.text).first(),serialId=old?.id??sharedEffectId(String(r.productId),'serial/'+r.text);if(!locked('seriales',serialId))await table(db,'seriales').put({id:serialId,...scoped(c),producto_id:r.productId,numero_serial:r.text,estado:{AVAILABLE:'disponible',RESERVED:'apartado',SOLD:'vendido',LOST:'merma'}[String(r.state)]??'merma',venta_id:r.saleOperationId??w.sourceOperationId??null,fecha_venta:(r.soldAtMs??w.soldAtMs)?number(r.soldAtMs??w.soldAtMs):null,garantia_dias:(r.warrantyDays??w.days)!=null?number(r.warrantyDays??w.days):null,garantia_hasta:(r.warrantyUntilMs??w.untilMs)?number(r.warrantyUntilMs??w.untilMs):null,cliente_nombre:r.customerName??w.customerName??null,precio_venta:w.priceCents!=null?money(w.priceCents):old?.precio_venta,estado_sincronizacion:1,fecha_actualizacion:Number(e.sequence)})}
 }
 const events=entities.filter(e=>e.kind==='EVENT').map(e=>({entity:e,v:object(JSON.parse(String(object(e.value.event).intent)))}));
 const depositSummaries=new Map<string,{revision:string;refundedCents:string}>();for(const {v}of events.filter(({v})=>v.kind==='SERVICE_REFUND')){const d=object(object(v.payload).document),service=object(d.service),id=service.family+'/'+service.id,previous=depositSummaries.get(id)??{revision:'0',refundedCents:'0'};previous.revision=(BigInt(previous.revision)+BigInt(1)).toString();previous.refundedCents=(BigInt(previous.refundedCents)+BigInt(String(d.amountCents))).toString();depositSummaries.set(id,previous)}for(const [id,summary]of depositSummaries)await storeSharedEntity(db,c,'SERVICE_REFUNDS',id,summary,(await db.shared_state.get(key))?.cursor??'0');
 const defaults=events.filter(({v})=>object(object(v.payload).document??{}).warrantyDefault).sort((a,b)=>Number(BigInt(a.entity.sequence)-BigInt(b.entity.sequence))).at(-1);if(defaults){const state=await db.shared_state.get(key);if(state){state.bootstrap={...state.bootstrap,warrantyDefault:object(object(defaults.v.payload).document).warrantyDefault};await db.shared_state.put(state)}}
 for(const {entity:e,v} of events.filter(({v})=>v.kind==='SALE_CONFIRM')){const event=object(e.value.event),returns=events.filter(({v:r})=>r.kind==='SALE_RETURN'&&object(object(r.payload).document).saleId===e.entityId).map(({v:r})=>({operationId:r.operationId,document:object(object(r.payload).document)})).sort((a,b)=>String(a.operationId).localeCompare(String(b.operationId)));await storeSharedEntity(db,c,'RETURN_BASIS',e.entityId,{snapshot:object(JSON.parse(String(event.snapshot))),snapshotHash:object(event.receipt).snapshotHash,returns},(await db.shared_state.get(key))?.cursor??e.sequence);void v}
 const turn=(await db.shared_state.get(key))?.activeTurnId,turnEntity=entities.find(e=>e.kind==='TURN'&&e.entityId===turn);
 if(turn&&turnEntity){const d=emptySharedDrawer(turn,String(turnEntity.value.openingCents),String(turnEntity.value.openedAtMs));for(const e of entities.filter(e=>e.kind==='EVENT').sort((a,b)=>Number(BigInt(a.sequence)-BigInt(b.sequence))))applySharedDrawer(d,object(JSON.parse(String(object(e.value.event).intent))));const cash=entities.find(e=>e.kind==='CASH_BASE'&&e.entityId===turn);if(cash){d.netCashCents=String(cash.value.netCents);d.expectedCents=(BigInt(d.openingCents)+BigInt(d.netCashCents)).toString()}await storeSharedEntity(db,c,'DRAWER',turn,d,(await db.shared_state.get(key))?.cursor??'0')}
}

export async function projectSharedMetadata(db:VentaRDDatabase,c:SharedContext,page:Obj){
 await storeSharedPageMetadata(db,c,page,String(page.scannedThrough));
 const state=await db.shared_state.get(sharedContextKey(c));if(state){state.bootstrap={...state.bootstrap,...(page.business!==undefined?{business:page.business}:{}),...(page.cashBase!==undefined?{cashBase:page.cashBase}:{})};await db.shared_state.put(state)}
}

export type {SharedMutation};
