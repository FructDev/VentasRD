import 'fake-indexeddb/auto';import {describe,it,expect,afterEach} from 'vitest';
import {VentaRDDatabase} from '@/lib/db/dexie';
import {downloadSharedBootstrap,sharedEntityKey,projectSharedEntities} from './shared-bootstrap';
import {canonicalNative,sharedContextKey,type SharedContext,type SharedEvent} from './shared-journal';
import {sha256Hex} from './inventory/canonical-payload';
const id=(n:number)=>`96300000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const c:SharedContext={tenantId:id(1),actorId:id(2),installationId:id(3),deviceId:id(4),writerEpoch:'1',scopeType:'BRANCH',branchId:id(5),permissionGrantId:id(6)};
const databases:VentaRDDatabase[]=[];afterEach(async()=>{for(const db of databases.splice(0)){db.close();await db.delete()}});
function fixture(){
 const db=new VentaRDDatabase('shared-bootstrap-fixture-'+crypto.randomUUID());databases.push(db);
 const row={kind:'PRODUCT',id:id(10),name:'QA',revision:'1',stock:{quantity:'100',version:'0',authority:'VERIFIED'}};
 const payload=canonicalNative([row]);let pageCalls=0;
 const manifest={version:'ventard.native.operational.1',namespace:'NATIVE1',snapshotId:id(20),context:{...c},capturedAtMs:String(Date.now()),expiresAtMs:String(Date.now()+60000),watermark:'2',totalCount:1,pages:[{index:0,count:1,byteLength:new TextEncoder().encode(payload).length,sha256:sha256Hex(payload)}]};
 delete (manifest.context as Partial<SharedContext>).permissionGrantId;
 const remote={bootstrap:async()=>manifest,page:async()=>{pageCalls++;return{snapshotId:id(20),index:0,payload}}};
 return{db,row,payload,manifest,remote,get pageCalls(){return pageCalls}};
}
describe('shared browser bootstrap, immutable pages and current entities',()=>{
 it('download failure leaves visible entities/cursor intact and resumes the same capture',async()=>{
  const f=fixture();let fail=true;const remote={...f.remote,page:async()=>{if(fail)throw Error('fixture offline');return f.remote.page()}};
  await expect(downloadSharedBootstrap(f.db,c,remote)).rejects.toThrow('fixture offline');expect(await f.db.shared_entities.count()).toBe(0);expect(await f.db.shared_state.count()).toBe(0);
  fail=false;await downloadSharedBootstrap(f.db,c,remote);expect((await f.db.shared_state.get(sharedContextKey(c)))?.cursor).toBe('2');expect((await f.db.shared_entities.get(sharedEntityKey(c,'PRODUCT',id(10))))?.value).toEqual(f.row);
 });
 it('retains an expired partial copy and starts a new verified capture',async()=>{
  const f=fixture();await f.db.shared_captures.add({id:'expired-fixture',scopeKey:sharedContextKey(c),state:'STAGING',pages:{},manifest:{...f.manifest,expiresAtMs:'1'}});
  await downloadSharedBootstrap(f.db,c,f.remote);expect((await f.db.shared_captures.get('expired-fixture'))?.state).toBe('EXPIRED');expect(await f.db.shared_captures.count()).toBe(2);expect((await f.db.shared_state.get(sharedContextKey(c)))?.cursor).toBe('2');
 });
 it('damaged page or wrong actor cannot activate a capture',async()=>{
  const f=fixture();await expect(downloadSharedBootstrap(f.db,c,{...f.remote,page:async()=>({snapshotId:id(20),index:0,payload:'[]'})})).rejects.toThrow('SHARED_BOOTSTRAP_INVALID');expect(await f.db.shared_entities.count()).toBe(0);
  const g=fixture();g.manifest.context.actorId=id(99);await expect(downloadSharedBootstrap(g.db,c,g.remote)).rejects.toThrow('SHARED_BOOTSTRAP_INVALID');expect(g.pageCalls).toBe(0);
 });
 it('projector failure rolls back activation and restarts from verified persisted pages',async()=>{
  const f=fixture();await expect(downloadSharedBootstrap(f.db,c,f.remote,async()=>{throw Error('fixture failed projection')})).rejects.toThrow();expect(await f.db.shared_entities.count()).toBe(0);
  await downloadSharedBootstrap(f.db,c,f.remote);expect(f.pageCalls).toBe(1);
 });
 it('current stock is assigned from the verified receipt rather than replaying its delta',async()=>{
  const f=fixture();await downloadSharedBootstrap(f.db,c,f.remote);
  const event:SharedEvent={intent:canonicalNative({kind:'INVENTORY_DELTA',operationId:id(30),payload:{}}),snapshot:null,receipt:{remoteSequence:'3',stock:[{productId:id(10),after:'99',version:'3'}]}};
  await f.db.transaction('rw',f.db.tables,()=>projectSharedEntities(f.db,c,event));
  await f.db.transaction('rw',f.db.tables,()=>projectSharedEntities(f.db,c,event));
  expect((await f.db.shared_entities.get(sharedEntityKey(c,'PRODUCT',id(10))))?.value.stock).toEqual({quantity:'99',version:'3',authority:'VERIFIED'});
 });
 it('bootstrap retains its current turn even when that opening is already in downloaded history',async()=>{
  const f=fixture(),intent=canonicalNative({protocol:'ventard.native.v1',contractVersion:1,canonicalizationVersion:'C-N1',kind:'TURN_OPEN',negocioId:c.tenantId,scope:{type:c.scopeType,sucursalId:c.branchId},installationId:c.installationId,originDeviceId:c.deviceId,writerEpoch:c.writerEpoch,permissionGrantId:c.permissionGrantId,operationId:id(90),originAtUtcMs:'1000',actorId:c.actorId,payload:{openingCents:'500'}});
  const event={intent,snapshot:null,receipt:{protocol:'ventard.native.receipt.1',namespace:'NATIVE1',status:'APPLIED',tenantId:c.tenantId,scope:{type:c.scopeType,branchId:c.branchId},operationId:id(90),actorId:c.actorId,installationId:c.installationId,deviceId:c.deviceId,writerEpoch:c.writerEpoch,intentHash:sha256Hex(intent),snapshotHash:null,remoteSequence:'1',stock:[],effects:[{id:id(90),kind:'TURN_OPEN',amountCents:'500'}]}};
  const payload=canonicalNative([{kind:'HISTORY_EVENT',id:id(90),event}]);
  Object.assign(f.manifest,{turn:event,totalCount:1,pages:[{index:0,count:1,byteLength:new TextEncoder().encode(payload).length,sha256:sha256Hex(payload)}]});
  await downloadSharedBootstrap(f.db,c,{...f.remote,page:async()=>({snapshotId:id(20),index:0,payload})});
  expect((await f.db.shared_entities.get(sharedEntityKey(c,'TURN',id(90))))?.value).toMatchObject({status:'OPEN',openingCents:'500'});
 });
});
