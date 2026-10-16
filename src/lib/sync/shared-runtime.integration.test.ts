// Isolated real PostgreSQL and IndexedDB; no remote Auth, accounts or licenses.
import 'fake-indexeddb/auto';
import {expect,it} from 'vitest';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {inventorySetup,tenant,actor,branch,id,command,canon,hash,rpc,openTurn,context as nativeContext} from '../../../scripts/native/sales-fixtures.mjs';
import {confirmarDevolucionLocal} from '@/lib/domain/devoluciones/confirmarDevolucionLocal';
import {commitCorteLocal} from '@/lib/domain/caja/commitCorteLocal';
import {VentaRDDatabase} from '@/lib/db/dexie';
import {prepararCheckoutLocal,confirmarCheckoutLocal,type CheckoutEntrada} from '@/lib/domain/ventas/checkoutLocal';
import {prepareSharedBrowser,syncSharedBrowser,restoreSharedBrowser} from './shared-runtime';
import {sharedRemote} from './shared-remote';
import {SharedRemoteError,sharedContextKey,type SharedContext} from './shared-journal';
import {setSharedCaptureContext,setSharedWriteGuard,getSharedCaptureContext} from './shared-capture';
const url='https://blzzinivvzadqjbnpsre.supabase.co';
it('existing browser checkout, native sale, lost reply and reopened browser converge without duplicated effects',async()=>{
 const pg=await inventorySetup(),name='shared-runtime-roundtrip-'+crypto.randomUUID();let db=new VentaRDDatabase(name);
 try{
  await pg.exec('reset role');for(const file of ['20261012123311_native_returns_staging_v1.sql','20261016165440_native_web_shared_journal_staging_v1.sql'])await pg.exec(await readFile('supabase/migrations/'+file,'utf8'));await pg.exec('set role authenticated');await pg.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-ventard-journal':'stock-merge-1'})]);
  const receiver=[tenant,id(8301),id(8302),'1','BRANCH',branch];await rpc(pg,'native_registrar_instalacion_v1',[id(8303),tenant,receiver[1],receiver[2],'BRANCH',branch]);const manifest=await rpc(pg,'native_sales_bootstrap_v1',[...receiver,id(8304)]),pages:string[]=[];for(const descriptor of manifest.pages)pages.push((await rpc(pg,'native_sales_bootstrap_page_v1',[...receiver,id(8304),descriptor.index])).payload);
  const remote=sharedRemote({async rpc(name,args){try{return{data:((await pg.query(`select public.${name}(${Object.keys(args).map((key,i)=>key+' => $'+(i+1)).join(',')}) as value`,Object.values(args))).rows[0] as {value:unknown}).value,error:null}}catch(error){return{data:null,error}}}},url,tenant);
  const scope={tenantId:tenant,actorId:actor,branchId:branch},c=await prepareSharedBrowser(db,scope,remote,()=>true,async context=>{
   expect(getSharedCaptureContext(db)).toBeNull();expect((await db.shared_entities.get(sharedContextKey(context)+'/BUSINESS/current'))?.value.name).toBe('PRO00 QA A - SINTETICO');
   await expect(db.productos.update(id(20),{nombre:'NO DEBE GUARDARSE',estado_sincronizacion:0})).rejects.toThrow('SHARED_PREPARING');
  });
  expect((await db.productos.get(id(20)))?.stock_actual).toBe(100);expect(await db.shared_mutations.count()).toBe(0);
  const input:CheckoutEntrada={cartId:id(8104),scope:{negocioId:tenant,sucursalId:branch},comando:{version:1,operacionId:id(8104),negocioId:tenant,sucursalId:branch,cajaCodigo:'N'+c.installationId.replaceAll('-',''),fecha:1791712800000,total:118,metodoPago:'tarjeta',garantiaDias:0,items:[{productoId:id(20),nombre:'Producto sintético',cantidad:1,precioUnitario:100}]},comprobante:{items:[],subtotal:100,itbis:18,descuento:0,total:118,montoRecibido:0,negocio:{nombre:'PRO00 QA A - SINTETICO'}}};
  await prepararCheckoutLocal(db,input);await confirmarCheckoutLocal(db,input.scope,input.cartId);
  let calls=0;const flaky={...remote,submit:async(ctx:SharedContext,wire:Parameters<typeof remote.submit>[1])=>{calls++;await remote.submit(ctx,wire);throw new SharedRemoteError('SHARED_TRANSPORT_UNCERTAIN')}};
  await syncSharedBrowser(db,c,flaky,()=>true);expect(calls).toBe(1);expect((await db.shared_outbox.toArray())[0].state).toBe('APPLIED');expect((await db.shared_mutations.toArray())[0].state).toBe('APPLIED');expect((await db.productos.get(id(20)))?.stock_actual).toBe(99);expect(await db.venta_detalles.count()).toBe(1);
  const native=command(8105);
  await rpc(pg,'native_sales_submit_v1',[canon(native.intent),hash(native.intent),canon(native.snapshot),hash(native.snapshot)]);
  await syncSharedBrowser(db,c,remote,()=>true);expect((await db.productos.get(id(20)))?.stock_actual).toBe(98);expect(await db.ventas.count()).toBe(2);expect(await db.venta_detalles.count()).toBe(2);
  setSharedCaptureContext(db,null);db.close();db=new VentaRDDatabase(name);expect(await restoreSharedBrowser(db,scope)).toEqual(c);await syncSharedBrowser(db,c,remote,()=>true);
  expect(await db.ventas.count()).toBe(2);expect((await db.shared_state.get(sharedContextKey(c)))?.cursor).toBe('2');expect((await rpc(pg,'native_sales_feed_v1',[...nativeContext,'0'])).events).toHaveLength(2);
  await openTurn(pg);await syncSharedBrowser(db,c,remote,()=>true);expect((await db.cajas.get(id(90)))?.estado).toBe('abierta');
  await confirmarDevolucionLocal(db,{operationId:id(8110),negocioId:tenant,sucursalId:branch,originDeviceId:c.deviceId,fecha:1791712800100,ventaId:id(8105),razon:'DEVOLUCION SINTETICA'});
  await syncSharedBrowser(db,c,remote,()=>true);expect((await db.shared_outbox.toArray()).find(row=>row.operationId===id(8110))?.lastCode).toBeUndefined();expect((await db.shared_outbox.toArray()).find(row=>row.operationId===id(8110))?.state).toBe('APPLIED');expect((await db.productos.get(id(20)))?.stock_actual).toBe(99);expect(await db.devoluciones.count()).toBe(1);
  await mkdir('scratch',{recursive:true});await writeFile('scratch/shared-web-ui-fixture.json',JSON.stringify({context:c,schema:db.tables.map(t=>({name:t.name,keyPath:t.schema.primKey.keyPath,indexes:t.schema.indexes.map(i=>({name:i.name,keyPath:i.keyPath,unique:i.unique,multiEntry:i.multi}))})),tables:Object.fromEntries(await Promise.all(db.tables.map(async table=>[table.name,await table.toArray()])))}));
  const turn=(await db.cajas.get(id(90)))!;
  await commitCorteLocal(db,{operationId:id(8111),negocioId:tenant,sucursalId:branch,cajaId:turn.id,tipo:'Z',fecha:1791712800200,contado:turn.monto_apertura,denominaciones:{'1':turn.monto_apertura}});
  await syncSharedBrowser(db,c,remote,()=>true);const close=(await db.shared_outbox.toArray()).find(row=>row.operationId===id(8111));expect(close?.lastCode).toBeUndefined();expect(close?.state).toBe('APPLIED');expect((await db.cajas.get(turn.id))?.estado).toBe('cerrada');
  await syncSharedBrowser(db,c,remote,()=>true);expect(await db.cortes_caja.count()).toBe(1);expect(await db.devoluciones.count()).toBe(1);expect((await rpc(pg,'native_sales_feed_v1',[...nativeContext,'0'])).events).toHaveLength(5);
  await mkdir('scratch',{recursive:true});await writeFile('scratch/shared-web-native-roundtrip.json',JSON.stringify({manifest,pages,feed:await rpc(pg,'native_sales_feed_v1',[...receiver,'0']),productId:id(20),stock:'99',saleCount:2,returnId:id(8110),turnId:id(90)}));
 }finally{setSharedCaptureContext(db,null);setSharedWriteGuard(db,null);db.close();await db.delete();await pg.close()}
},30000);
it('old unsent facts block enrollment and remain unchanged; stale restore never selects another actor',async()=>{
 const db=new VentaRDDatabase('shared-runtime-pending-'+crypto.randomUUID());try{
  const row={id:id(55),negocio_id:tenant,total:10,metodo_pago:'tarjeta' as const,estado_sincronizacion:0 as const,fecha_creacion:1000};await db.ventas.add(row);
  let requests=0;const remote=sharedRemote({rpc:async()=>{requests++;return{data:null,error:null}}},url,tenant);
  await expect(prepareSharedBrowser(db,{tenantId:tenant,actorId:actor,branchId:branch},remote,()=>true)).rejects.toThrow('SHARED_LEGACY_PENDING');expect(requests).toBe(0);expect(await db.ventas.get(row.id)).toEqual(row);
  await restoreSharedBrowser(db,{tenantId:tenant,actorId:id(999),branchId:branch},()=>false);expect(getSharedCaptureContext(db)).toBeNull();
 }finally{setSharedCaptureContext(db,null);setSharedWriteGuard(db,null);db.close();await db.delete()}
});
