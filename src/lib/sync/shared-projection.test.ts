import 'fake-indexeddb/auto';
import {afterEach,expect,it} from 'vitest';
import {VentaRDDatabase} from '@/lib/db/dexie';
import {setSharedCaptureContext} from './shared-capture';
import {canonicalNative,sharedContextKey,type SharedContext} from './shared-journal';
import {storeSharedEntity} from './shared-bootstrap';
import {reconcileSharedWeb,sharedBalanceCents} from './shared-projection';
import {commandHash} from '@/lib/domain/local/command';
const id=(n:number)=>`96300000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const c:SharedContext={tenantId:id(1),actorId:id(2),installationId:id(3),deviceId:id(4),writerEpoch:'1',scopeType:'BRANCH',branchId:id(5),permissionGrantId:id(6)};
const dbs:VentaRDDatabase[]=[];afterEach(async()=>{for(const db of dbs.splice(0)){setSharedCaptureContext(db,null);db.close();await db.delete()}});
async function fixture(){const db=new VentaRDDatabase('shared-projection-fixture-'+crypto.randomUUID());dbs.push(db);await db.shared_state.put({id:sharedContextKey(c),cursor:'2',nextOrder:0,activatedAt:'1000',context:c,bootstrap:{}});await storeSharedEntity(db,c,'PRODUCT',id(10),{id:id(10),name:'QA',code:'0001',revision:'1',deleted:false,priceTiers:{retailCents:'10000'},metadata:{costCents:'6000',taxRate:{numerator:'9',denominator:'50'},serialRequired:false,recipe:[]},stock:{quantity:'98',version:'2',authority:'VERIFIED'}},'2');setSharedCaptureContext(db,c);return db}
const project=(db:VentaRDDatabase)=>db.transaction('rw',db.tables,()=>reconcileSharedWeb(db,c));
it('absolute stock plus pending web delta survives repeated projection and is not recaptured',async()=>{
 const db=await fixture();await project(db);await db.transaction('rw',db.productos,db.movimientos_stock,async()=>{await db.productos.update(id(10),{stock_actual:97});await db.movimientos_stock.add({id:id(21),negocio_id:c.tenantId,sucursal_id:c.branchId!,producto_id:id(10),delta:-1,tipo:'venta',fecha_creacion:2000,estado_sincronizacion:0})});
 await project(db);await project(db);expect((await db.productos.get(id(10)))?.stock_actual).toBe(97);expect(await db.shared_mutations.count()).toBe(1);
});
it('native balance uses an explicit opening offset without fabricated debt or cash transactions',async()=>{
 const db=await fixture();await storeSharedEntity(db,c,'CUSTOMER',id(30),{id:id(30),name:'QA',balanceCents:'1025',limitCents:'0',priceTier:'1',revision:'1'},'2');await project(db);
 const customer=(await db.clientes.get(id(30)))!;expect(await db.transacciones_fiado.count()).toBe(0);expect(sharedBalanceCents(customer,[])).toBe(1025);
 await db.transacciones_fiado.add({id:id(31),negocio_id:c.tenantId,sucursal_id:c.branchId,caja_id:id(40),cliente_id:id(30),venta_id:null,tipo:'abono',monto:2.25,concepto:'QA',metodo_pago:'tarjeta',fecha_creacion:2000,fecha_actualizacion:2000,estado_sincronizacion:0});
 await project(db);expect(sharedBalanceCents((await db.clientes.get(id(30)))!,await db.transacciones_fiado.toArray())).toBe(800);
});
it('downloaded normalized legacy amounts become web numbers while the signed history stays intact',async()=>{
 const db=await fixture(),history={protocol:'ventard.web.resolution.history.1',tables:[{name:'transacciones_fiado',rows:[
  {id:id(91),negocio_id:c.tenantId,sucursal_id:c.branchId,cliente_id:id(30),tipo:'cargo',monto:{$number:'10.25'},fecha_creacion:{$number:'1792082416191'}},
  {id:id(92),negocio_id:c.tenantId,sucursal_id:c.branchId,cliente_id:id(30),tipo:'abono',monto:{$number:'2.25'},fecha_creacion:{$milliseconds:'1792082416191'}}
 ]},{name:'ventas',rows:[{id:id(93),negocio_id:c.tenantId,sucursal_id:c.branchId,total:{$number:'10.25'},fecha_creacion:{$number:'1792082416191'},items:[{cantidad:{$number:'1'},precio:{$number:'10.25'}}]}]}]},original=commandHash(history);
 await storeSharedEntity(db,c,'LEGACY_HISTORY',id(90),{history},'2');
 await storeSharedEntity(db,c,'CUSTOMER',id(30),{id:id(30),name:'QA',balanceCents:'800',limitCents:'10000',priceTier:'1',revision:'1'},'2');
 await project(db);await project(db);
 const rows=await db.transacciones_fiado.toArray();expect(rows.map(r=>r.monto)).toEqual([10.25,2.25]);expect(rows.map(r=>r.fecha_creacion)).toEqual([1792082416191,1792082416191]);
 expect(sharedBalanceCents((await db.clientes.get(id(30)))!,rows)).toBe(800);expect((await db.clientes.get(id(30)))?.shared_balance_offset_cents).toBe('0');
 expect((await db.ventas.get(id(93)))?.total).toBe(10.25);expect(commandHash((await db.shared_entities.get(sharedContextKey(c)+'/LEGACY_HISTORY/'+id(90)))!.value.history)).toBe(original);expect(await db.shared_mutations.count()).toBe(0);
});
it('initial preparation adopts reviewed history over stale branch metadata only after preserving the exact browser originals',async()=>{
 const db=await fixture(),sale={id:id(94),negocio_id:c.tenantId,sucursal_id:id(99),total:442.96000000000004,metodo_pago:'efectivo',fecha_creacion:1000,estado_sincronizacion:1};
 await db.ventas.put(sale);const prior={ventas:[structuredClone(sale)]};
 await db.shared_captures.put({id:'reviewed',scopeKey:sharedContextKey(c),state:'STAGING',manifest:{},pages:{},prior});
 await storeSharedEntity(db,c,'LEGACY_HISTORY',id(95),{history:{tables:[{name:'ventas',rows:[{...sale,sucursal_id:c.branchId,total:{$number:'442.96'}}]}]}},'2');
 await db.transaction('rw',db.tables,()=>reconcileSharedWeb(db,c,{adoptReviewedHistory:true}));
 expect((await db.ventas.get(id(94)))?.sucursal_id).toBe(c.branchId);expect((await db.ventas.get(id(94)))?.total).toBe(442.96);
 expect((await db.shared_captures.get('reviewed'))?.prior).toEqual(prior);expect(await db.ventas.count()).toBe(1);expect(await db.shared_mutations.count()).toBe(0);
 await project(db);expect(await db.ventas.count()).toBe(1);
});
it('cannot replace browser history without its preserved source or after a local source change',async()=>{
 const db=await fixture(),sale={id:id(94),negocio_id:c.tenantId,sucursal_id:id(99),total:10,metodo_pago:'efectivo',fecha_creacion:1000,estado_sincronizacion:1};await db.ventas.put(sale);
 await storeSharedEntity(db,c,'LEGACY_HISTORY',id(95),{history:{tables:[{name:'ventas',rows:[{...sale,sucursal_id:c.branchId}]}]}},'2');
 await expect(db.transaction('rw',db.tables,()=>reconcileSharedWeb(db,c,{adoptReviewedHistory:true}))).rejects.toThrow('SHARED_CAPTURE_REQUIRED');
 await db.shared_captures.put({id:'reviewed',scopeKey:sharedContextKey(c),state:'STAGING',manifest:{},pages:{},prior:{ventas:[{...sale,total:9}]}});
 await expect(db.transaction('rw',db.tables,()=>reconcileSharedWeb(db,c,{adoptReviewedHistory:true}))).rejects.toThrow('SHARED_LOCAL_SOURCE_CHANGED');
 expect(await db.ventas.get(id(94))).toEqual(sale);
});
it('a metadata receipt in a multi-command group never swallows its still-pending stock movement',async()=>{
 const db=await fixture();await project(db);await db.transaction('rw',db.productos,db.movimientos_stock,async()=>{await db.productos.update(id(10),{nombre:'EDIT QA',estado_sincronizacion:0});await db.movimientos_stock.add({id:id(51),negocio_id:c.tenantId,sucursal_id:c.branchId!,producto_id:id(10),delta:5,tipo:'entrada',fecha_creacion:2000,estado_sincronizacion:0})});
 const raw=(await db.shared_mutations.toArray())[0],key=sharedContextKey(c);await db.shared_mutations.update(raw.id,{state:'PREPARED',operationIds:[id(50),id(51)]});await db.shared_outbox.put({id:key+'/'+id(50),scopeKey:key,operationId:id(50),context:c,order:1,state:'APPLIED',wire:{intent:JSON.stringify({kind:'PRODUCT_PATCH'}),intentHash:'',snapshot:null,snapshotHash:null},receipt:{remoteSequence:'2',stock:[]}});
 await project(db);expect((await db.productos.get(id(10)))?.stock_actual).toBe(103);expect((await db.shared_mutations.get(raw.id))?.state).toBe('PREPARED');
});
it('all receipts of a captured group must be covered before clearing original row flags',async()=>{
 const db=await fixture();await project(db);await db.productos.update(id(10),{nombre:'EDIT QA',estado_sincronizacion:0});const raw=(await db.shared_mutations.toArray())[0],key=sharedContextKey(c);
 await db.shared_mutations.update(raw.id,{state:'PREPARED',operationIds:[id(40),id(41)]});
 for(const [op,seq] of [[id(40),'1'],[id(41),'3']])await db.shared_outbox.put({id:key+'/'+op,scopeKey:key,context:c,operationId:op,order:1,state:'APPLIED',wire:{intent:'',intentHash:'',snapshot:null,snapshotHash:null},receipt:{remoteSequence:seq}});
 await project(db);expect((await db.productos.get(id(10)))?.estado_sincronizacion).toBe(0);
 await db.shared_state.update(key,{cursor:'3'});await storeSharedEntity(db,c,'PRODUCT',id(10),{...(await db.shared_entities.get(key+'/PRODUCT/'+id(10)))!.value,name:'EDIT QA'},'3');await project(db);
 expect((await db.shared_mutations.get(raw.id))?.state).toBe('APPLIED');expect((await db.productos.get(id(10)))?.estado_sincronizacion).toBe(1);expect(commandHash(raw.changes)).toBe(commandHash((await db.shared_mutations.get(raw.id))!.changes));
});
it('receiving the same native sale twice preserves one sale and one set of detail rows',async()=>{
 const db=await fixture(),op=id(80),sale={inventory:[],lines:[{name:'QA',productId:id(10),quantity:{numerator:'1',denominator:'1'},unitPriceCents:'10000'}],payment:{method:'TARJETA',cashNetCents:'0',transferCents:'0'},totals:{totalCents:'11800'}};
 const event={intent:canonicalNative({operationId:op,originAtUtcMs:'2000',originalTurnId:null,kind:'SALE_CONFIRM',payload:{sale}}),snapshot:canonicalNative({sale,ticket:'N'+id(90).replaceAll('-','')+'-000001',customerName:null}),receipt:{remoteSequence:'2'}};
 await storeSharedEntity(db,c,'EVENT',op,{event},'2');await project(db);await project(db);expect(await db.ventas.count()).toBe(1);expect(await db.venta_detalles.count()).toBe(1);expect((await db.productos.get(id(10)))?.stock_actual).toBe(98);
});
