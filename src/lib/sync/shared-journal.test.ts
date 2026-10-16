import 'fake-indexeddb/auto';
import {afterEach,describe,it,expect} from 'vitest';
import {VentaRDDatabase} from '@/lib/db/dexie';
import {canonicalNative,freezeSharedOperation,flushSharedOperations,receiveSharedPage,sharedContextKey,type SharedContext,type SharedWire} from './shared-journal';
import {sha256Hex} from './inventory/canonical-payload';
const id=(n:number)=>`96300000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ctx:SharedContext={tenantId:id(1),actorId:id(2),installationId:id(3),deviceId:id(4),writerEpoch:'1',scopeType:'BRANCH',branchId:id(5),permissionGrantId:id(6)};
const databases:VentaRDDatabase[]=[];
const database=()=>{const db=new VentaRDDatabase('shared-journal-fixture-'+crypto.randomUUID());databases.push(db);return db};
afterEach(async()=>{for(const db of databases.splice(0)){db.close();await db.delete()}});
function wire(n=10):SharedWire{const intent=canonicalNative({protocol:'ventard.native.v1',canonicalizationVersion:'C-N1',contractVersion:1,kind:'TURN_OPEN',operationId:id(n),negocioId:ctx.tenantId,actorId:ctx.actorId,installationId:ctx.installationId,originDeviceId:ctx.deviceId,writerEpoch:'1',permissionGrantId:ctx.permissionGrantId,scope:{type:'BRANCH',sucursalId:ctx.branchId},originAtUtcMs:'1792169000000',payload:{openingCents:'10000'}});return{intent,intentHash:sha256Hex(intent),snapshot:null,snapshotHash:null}}
function receipt(w:SharedWire,sequence='1'){return{protocol:'ventard.native.receipt.1',namespace:'NATIVE1',status:'APPLIED',tenantId:ctx.tenantId,actorId:ctx.actorId,installationId:ctx.installationId,deviceId:ctx.deviceId,writerEpoch:'1',scope:{type:'BRANCH',branchId:ctx.branchId},operationId:JSON.parse(w.intent).operationId,intentHash:w.intentHash,snapshotHash:null,remoteSequence:sequence,stock:[],effects:[{id:JSON.parse(w.intent).operationId,kind:'TURN_OPEN',amountCents:'10000'}],ticket:null,ncf:null}}
const page=(w:SharedWire,sequence='1')=>({namespace:'NATIVE1',tenantId:ctx.tenantId,scope:{type:'BRANCH',branchId:ctx.branchId},coverage:'COMPLETE',scannedThrough:sequence,watermark:sequence,events:[{intent:w.intent,snapshot:null,receipt:receipt(w,sequence)}]});
describe('shared native/web journal, durable bytes and atomic inbox',()=>{
 it('rejects non C-N1 money, malformed Unicode and unstable context before persistence',async()=>{
  const db=database();for(const bad of [0.1,-1,undefined,'\ud800'])expect(()=>canonicalNative(bad)).toThrow();
  const w=wire();await expect(freezeSharedOperation(db,{...ctx,actorId:id(99)},w)).rejects.toThrow();expect(await db.shared_outbox.count()).toBe(0);
 });
 it('freezes identical bytes once and refuses reuse of an ID with changed contents',async()=>{
  const db=database(),w=wire();const a=await freezeSharedOperation(db,ctx,w);w.intent='mutated by caller';
  expect((await db.shared_outbox.get(a.id))?.wire.intent).toBe(wire().intent);
  expect((await freezeSharedOperation(db,ctx,wire())).id).toBe(a.id);
  const changed=JSON.parse(wire().intent);changed.payload.openingCents='20000';const text=canonicalNative(changed);
  await expect(freezeSharedOperation(db,ctx,{...wire(),intent:text,intentHash:sha256Hex(text)})).rejects.toThrow('SHARED_OPERATION_ID_CONFLICT');
 });
 it('lost response is recovered by lookup after reopen without a new submit or ID',async()=>{
  const db=database(),w=wire();await freezeSharedOperation(db,ctx,w);let submits=0,applied=false;
  const remote={lookup:async()=>applied?receipt(w):{status:'NOT_FOUND',operationId:id(10),intentHash:w.intentHash},submit:async(_c:SharedContext,bytes:SharedWire)=>{submits++;expect(bytes).toEqual(w);applied=true;throw Error('lost response')}};
  await flushSharedOperations(db,ctx,remote);db.close();await db.open();expect((await db.shared_outbox.toArray())[0].state).toBe('UNCERTAIN');
  await flushSharedOperations(db,ctx,remote);expect(submits).toBe(1);expect((await db.shared_outbox.toArray())[0].state).toBe('APPLIED');
 });
 it('wrong receipt cannot acknowledge or discard pending data',async()=>{
  const db=database(),w=wire();await freezeSharedOperation(db,ctx,w);
  await flushSharedOperations(db,ctx,{lookup:async()=>({...receipt(w),tenantId:id(99)}),submit:async()=>{throw Error('MUST_NOT_SEND')}});
  const row=(await db.shared_outbox.toArray())[0];expect(row.state).toBe('BLOCKED');expect(row.wire).toEqual(w);expect(row.receipt).toBeUndefined();
 });
 it('a matching identity and hash cannot conceal missing or altered effects',async()=>{
  for(const change of [(r:ReturnType<typeof receipt>)=>{r.effects=[]},(r:ReturnType<typeof receipt>)=>{r.effects[0].amountCents='999'}]){const db=database(),w=wire(),r=receipt(w);change(r);await freezeSharedOperation(db,ctx,w);await flushSharedOperations(db,ctx,{lookup:async()=>r,submit:async()=>{throw Error('must not resend')}});expect((await db.shared_outbox.toArray())[0]).toMatchObject({state:'BLOCKED',lastCode:'SHARED_RECEIPT_MISMATCH'});expect((await db.shared_outbox.toArray())[0].wire).toEqual(w)}
 });
 it('inbox and cursor roll back together when a projector fails, then replay once',async()=>{
  const db=database(),w=wire();let projections=0;
  await expect(receiveSharedPage(db,ctx,'0',page(w),async()=>{throw Error('fixture disk failure')})).rejects.toThrow();
  expect(await db.shared_inbox.count()).toBe(0);expect((await db.shared_state.get(sharedContextKey(ctx)))?.cursor??'0').toBe('0');
  await receiveSharedPage(db,ctx,'0',page(w),async()=>{projections++});expect(projections).toBe(1);
  await receiveSharedPage(db,ctx,'1',page(w),async()=>{projections++});expect(projections).toBe(1);expect((await db.shared_state.get(sharedContextKey(ctx)))?.cursor).toBe('1');
 });
 it('malformed later event cannot partially apply the earlier event or advance a cursor',async()=>{
  const db=database(),w=wire(),p=page(w,'2');p.events.push({...p.events[0],intent:'wrong'});
  await expect(receiveSharedPage(db,ctx,'0',p)).rejects.toThrow();expect(await db.shared_inbox.count()).toBe(0);expect(await db.shared_state.count()).toBe(0);
 });
 it('two tabs cannot send the same frozen pending operation simultaneously',async()=>{
  const db=database(),w=wire();await freezeSharedOperation(db,ctx,w);let sends=0;let release!:()=>void;
  const gate=new Promise<void>(r=>release=r),remote={lookup:async()=>({status:'NOT_FOUND',operationId:id(10),intentHash:w.intentHash}),submit:async()=>{sends++;await gate;return receipt(w)}};
  const first=flushSharedOperations(db,ctx,remote);while(!sends)await new Promise(r=>setTimeout(r,1));await flushSharedOperations(db,ctx,remote);release();await first;expect(sends).toBe(1);
 });
});
