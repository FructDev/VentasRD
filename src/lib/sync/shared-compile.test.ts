import 'fake-indexeddb/auto';import {afterEach,describe,it,expect} from 'vitest';
import {VentaRDDatabase} from '@/lib/db/dexie';
import {setSharedCaptureContext} from './shared-capture';
import {sharedContextKey,type SharedContext} from './shared-journal';
import {prepareSharedMutation} from './shared-compile';
import {sharedEntityKey} from './shared-bootstrap';
import {prepararCheckoutLocal,confirmarCheckoutLocal,type CheckoutEntrada} from '@/lib/domain/ventas/checkoutLocal';
import {mkdir,writeFile} from 'node:fs/promises';
const id=(n:number)=>`96300000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context:SharedContext={tenantId:id(1),actorId:id(2),installationId:id(3),deviceId:id(4),writerEpoch:'1',scopeType:'BRANCH',branchId:id(5),permissionGrantId:id(6)};
const dbs:VentaRDDatabase[]=[];afterEach(async()=>{for(const db of dbs.splice(0)){setSharedCaptureContext(db,null);db.close();await db.delete()}});
async function fixture(){
 const db=new VentaRDDatabase('shared-compile-fixture-'+crypto.randomUUID());dbs.push(db);
 await db.productos.add({id:id(10),negocio_id:id(1),nombre:'QA',codigo_barras:'0001',precio_venta:100,costo:60,stock_actual:100,stock_minimo:0,tasa_itbis:0.18,tipo:'simple',estado_sincronizacion:1,inventory_stock_by_scope:{[id(1)+':'+id(5)]:100}});
 await db.shared_state.put({id:sharedContextKey(context),cursor:'0',nextOrder:0,bootstrap:{freeTax:{numerator:'9',denominator:'50'}}});
 await db.shared_entities.add({id:sharedEntityKey(context,'PRODUCT',id(10)),scopeKey:sharedContextKey(context),kind:'PRODUCT',entityId:id(10),sequence:'0',value:{id:id(10),name:'QA',revision:'1',deleted:false,priceTiers:{retailCents:'10000',tier2Cents:null,tier3Cents:null},metadata:{costCents:'6000',taxRate:{numerator:'9',denominator:'50'},serialRequired:false,recipe:[]},stock:{quantity:'100',version:'0',authority:'VERIFIED'}}});
 setSharedCaptureContext(db,context);return db;
}
function checkout(n:number):CheckoutEntrada{const prefix='N'+context.installationId.replaceAll('-','');return{cartId:id(n),scope:{negocioId:id(1),sucursalId:id(5)},comando:{version:1,operacionId:id(n),negocioId:id(1),sucursalId:id(5),cajaCodigo:prefix,fecha:1792169000000+n,total:118,metodoPago:'tarjeta',garantiaDias:0,items:[{productoId:id(10),nombre:'QA',cantidad:1,precioUnitario:100}]},comprobante:{items:[],subtotal:100,itbis:18,descuento:0,total:118,montoRecibido:0,negocio:{nombre:'QA SINTETICO'}}}}
async function sell(db:VentaRDDatabase,n:number){const input=checkout(n);await prepararCheckoutLocal(db,input);await confirmarCheckoutLocal(db,input.scope,input.cartId);return input}
describe('definitive browser checkout -> durable custody -> native wire',()=>{
 it('captures the existing full checkout and compiles against its original catalog after a later change',async()=>{
  const db=await fixture();await sell(db,20);const captures=await db.shared_mutations.toArray();expect(captures).toHaveLength(1);expect(captures[0].facts['PRODUCT/'+id(10)]).toBeTruthy();
  await db.shared_entities.update(sharedEntityKey(context,'PRODUCT',id(10)),{'value.priceTiers.retailCents':'99999'});
  await prepareSharedMutation(db,captures[0].id);const rows=await db.shared_outbox.toArray();expect(rows).toHaveLength(1);const sale=JSON.parse(rows[0].wire.intent).payload.sale;expect(sale.lines[0].unitPriceCents).toBe('10000');expect(sale.totals.totalCents).toBe('11800');
  await prepareSharedMutation(db,captures[0].id);expect(await db.shared_outbox.count()).toBe(1);
 });
 it('two offline sales retain their own IDs, ticket sequence and causal stock evidence',async()=>{
  const db=await fixture();await sell(db,20);await sell(db,21);const captures=(await db.shared_mutations.toArray()).sort((a,b)=>a.order-b.order);
  for(const capture of captures)await prepareSharedMutation(db,capture.id);
  const rows=(await db.shared_outbox.toArray()).sort((a,b)=>a.order-b.order);expect(rows).toHaveLength(2);
  const second=JSON.parse(rows[1].wire.intent).payload.sale;expect(second.stockEvidence[0].effectiveQty).toBe('99');expect(second.stockEvidence[0].pending).toMatchObject([{operationId:id(20),delta:'-1'}]);
  expect(JSON.parse(rows[0].wire.snapshot!).ticket.endsWith('-000001')).toBe(true);expect(JSON.parse(rows[1].wire.snapshot!).ticket.endsWith('-000002')).toBe(true);
 });
 it('unrecognized legacy mutation stays blocked with its original data instead of falling back to row upload',async()=>{
  const db=await fixture();await db.reparaciones.add({id:id(70),negocio_id:id(1),sucursal_id:id(5),folio:'REP-QA',cliente_nombre:'QA',equipo_modelo:'QA',problema_reportado:'QA',estado:'recibido',repuestos:[],mano_obra:0,total:0,abono:0,fecha_creacion:1792169000000,fecha_actualizacion:1792169000000,estado_sincronizacion:0});
  const capture=(await db.shared_mutations.toArray())[0];await prepareSharedMutation(db,capture.id);expect((await db.shared_mutations.get(capture.id))?.state).toBe('BLOCKED');expect(await db.reparaciones.get(id(70))).toBeTruthy();expect(await db.shared_outbox.count()).toBe(0);
 });
 it('product creation and initial stock produce two frozen causal operations',async()=>{
  const db=await fixture();await db.transaction('rw',db.productos,db.movimientos_stock,async()=>{
   await db.productos.add({id:id(80),negocio_id:id(1),nombre:'Nuevo QA',codigo_barras:'00080',precio_venta:20,costo:10,stock_actual:5,stock_minimo:0,tasa_itbis:0,tipo:'simple',estado_sincronizacion:0,fecha_actualizacion:1792169000000});
   await db.movimientos_stock.add({id:id(81),negocio_id:id(1),sucursal_id:id(5),producto_id:id(80),delta:5,tipo:'entrada',fecha_creacion:1792169000000,estado_sincronizacion:0});
  });const capture=(await db.shared_mutations.toArray())[0];await prepareSharedMutation(db,capture.id);expect((await db.shared_mutations.get(capture.id))?.state).toBe('PREPARED');
  const rows=(await db.shared_outbox.toArray()).sort((a,b)=>a.order-b.order);expect(rows).toHaveLength(2);expect(JSON.parse(rows[0].wire.intent).kind).toBe('PRODUCT_CREATE');const stock=JSON.parse(rows[1].wire.intent);expect(stock.payload.document.after).toBe('5');expect(stock.payload.document.stockEvidence.pending[0].delta).toBe('0');
 });
 it('count remains a revision checked count, retaining the observed target',async()=>{
  const db=await fixture();await db.transaction('rw',db.productos,db.movimientos_stock,async()=>{
   await db.productos.update(id(10),{stock_actual:97,estado_sincronizacion:0,fecha_actualizacion:1792169000000});
   await db.movimientos_stock.add({id:id(82),negocio_id:id(1),sucursal_id:id(5),producto_id:id(10),delta:0,valor_absoluto:97,tipo:'conteo',fecha_creacion:1792169000000,estado_sincronizacion:0});
  });const capture=(await db.shared_mutations.toArray())[0];await prepareSharedMutation(db,capture.id);
  const row=(await db.shared_outbox.toArray())[0],wire=JSON.parse(row.wire.intent);expect(wire.kind).toBe('INVENTORY_COUNT');expect(wire.payload.request.quantity).toBe('97');expect(wire.payload.document.delta).toBe('-3');
 });
 it('exports actual product-form custody bytes for the isolated PostgreSQL interoperability check',async()=>{
  const db=new VentaRDDatabase('shared-inventory-roundtrip-fixture-'+crypto.randomUUID());dbs.push(db);
  const x=(n:number)=>`96200000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const c:SharedContext={tenantId:'96000000-0000-4000-8000-000000000001',actorId:x(1),installationId:x(8100),deviceId:x(8101),writerEpoch:'1',scopeType:'BRANCH',branchId:x(4),permissionGrantId:x(8102)};
  await db.shared_state.put({id:sharedContextKey(c),cursor:'0',nextOrder:0,bootstrap:{freeTax:{numerator:'9',denominator:'50'}}});setSharedCaptureContext(db,c);
  await db.transaction('rw',db.productos,db.movimientos_stock,async()=>{
   await db.productos.add({id:x(8180),negocio_id:c.tenantId,nombre:'INVENTARIO WEB SINTETICO',codigo_barras:'00008180',precio_venta:20,costo:10,stock_actual:5,stock_minimo:0,tasa_itbis:0,tipo:'simple',estado_sincronizacion:0,fecha_actualizacion:1792169000000});
   await db.movimientos_stock.add({id:x(8181),negocio_id:c.tenantId,sucursal_id:c.branchId!,producto_id:x(8180),delta:5,tipo:'entrada',fecha_creacion:1792169000000,estado_sincronizacion:0});
  });const raw=(await db.shared_mutations.toArray())[0];await prepareSharedMutation(db,raw.id);const packets=(await db.shared_outbox.toArray()).sort((a,b)=>a.order-b.order).map(r=>r.wire);expect(packets).toHaveLength(2);
  await mkdir('scratch',{recursive:true});await writeFile('scratch/shared-web-inventory-wire.json',JSON.stringify({context:c,packets}));
 });
});

it('excluded fiscal commands never commit local money or consume a range in shared mode',async()=>{
 const db=await fixture(),input=checkout(8999);input.solicitudFiscal={version:1,tipo:'B02',deviceId:context.deviceId};
 await expect(prepararCheckoutLocal(db,input)).rejects.toThrow('SHARED_FISCAL_EXCLUDED');expect(await db.operaciones_locales.count()).toBe(0);expect(await db.ventas.count()).toBe(0);expect((await db.productos.get(id(10)))?.stock_actual).toBe(100);
});
