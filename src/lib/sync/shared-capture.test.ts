import 'fake-indexeddb/auto';import {afterEach,describe,it,expect} from 'vitest';
import {VentaRDDatabase} from '@/lib/db/dexie';
import {setSharedCaptureContext,markSharedProjection} from './shared-capture';
import type {SharedContext} from './shared-journal';
const id=(n:number)=>`96300000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context:SharedContext={tenantId:id(1),actorId:id(2),installationId:id(3),deviceId:id(4),writerEpoch:'1',scopeType:'BRANCH',branchId:id(5),permissionGrantId:id(6)};
const databases:VentaRDDatabase[]=[];const fixture=()=>{const db=new VentaRDDatabase('shared-capture-fixture-'+crypto.randomUUID());databases.push(db);return db};
const customer=()=>({id:id(10),negocio_id:id(1),nombre:'QA',telefono:null,limite_credito:0,estado_sincronizacion:0 as const,fecha_actualizacion:1});
afterEach(async()=>{for(const db of databases.splice(0)){db.close();await db.delete()}});
describe('same-transaction browser custody, original definitive domain stores',()=>{
 it('is inert before explicit browser enrollment, including production defaults',async()=>{const db=fixture();await db.clientes.add(customer());expect(await db.shared_mutations.count()).toBe(0)});
 it('captures multiple mutations once, retaining first before and final after',async()=>{
  const db=fixture();await db.clientes.add({...customer(),estado_sincronizacion:1});setSharedCaptureContext(db,context);
  await db.transaction('rw',db.clientes,async()=>{await db.clientes.update(id(10),{nombre:'QA first',estado_sincronizacion:0});await db.clientes.update(id(10),{nombre:'QA final'})});
  const rows=await db.shared_mutations.toArray();expect(rows).toHaveLength(1);expect(rows[0].changes).toHaveLength(1);expect(rows[0].changes[0].before?.nombre).toBe('QA');expect(rows[0].changes[0].after?.nombre).toBe('QA final');expect(rows[0].context).toEqual(context);
 });
 it('a failed domain transaction leaves neither business facts nor orphan capture',async()=>{
  const db=fixture();setSharedCaptureContext(db,context);await expect(db.transaction('rw',db.clientes,async()=>{await db.clientes.add(customer());throw Error('fixture failed command')})).rejects.toThrow();expect(await db.clientes.count()).toBe(0);expect(await db.shared_mutations.count()).toBe(0);expect(await db.shared_state.count()).toBe(0);
 });
 it('failed capture persistence also rolls back the business mutation',async()=>{
  const db=fixture();setSharedCaptureContext(db,context);db.shared_mutations.hook('creating',()=>{throw Error('fixture capture disk full')});
  await expect(db.clientes.add(customer())).rejects.toThrow();expect(await db.clientes.count()).toBe(0);expect(await db.shared_mutations.count()).toBe(0);
 });
 it('receipt projections and synced rows do not become new business operations',async()=>{
  const db=fixture();setSharedCaptureContext(db,context);await db.clientes.add({...customer(),estado_sincronizacion:1});expect(await db.shared_mutations.count()).toBe(0);
  await db.transaction('rw',db.clientes,async()=>{markSharedProjection();await db.clientes.update(id(10),{nombre:'verified remote',estado_sincronizacion:0})});expect(await db.shared_mutations.count()).toBe(0);
 });
 it('captures explicit deletion but refuses an unreviewed range clear',async()=>{
  const db=fixture();await db.clientes.add({...customer(),estado_sincronizacion:1});setSharedCaptureContext(db,context);
  await expect(db.clientes.clear()).rejects.toThrow('SHARED_RANGE_DELETE_REQUIRES_REVIEW');expect(await db.clientes.count()).toBe(1);
  await db.clientes.delete(id(10));const row=(await db.shared_mutations.toArray())[0];expect(row.changes[0].before?.id).toBe(id(10));expect(row.changes[0].after).toBeNull();
 });
 it('identity is captured at the transaction boundary and foreign business writes abort',async()=>{
  const db=fixture();setSharedCaptureContext(db,context);
  await expect(db.clientes.add({...customer(),negocio_id:id(99)})).rejects.toThrow('SHARED_CAPTURE_SCOPE_MISMATCH');expect(await db.clientes.count()).toBe(0);
 });
});
