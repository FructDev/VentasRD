// Isolated PostgreSQL engine. Never creates real users or sends invitations.
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';
import {inventorySetup,context,rpc,id,tenant,actor,installation,device,branch,canon,hash,command} from './sales-server.test.mjs';
const ctx={tenantId:tenant,actorId:actor,installationId:installation,deviceId:device,writerEpoch:'1',scopeType:'BRANCH',branchId:branch};
async function setup(){const db=await inventorySetup();await db.exec('reset role');await db.exec("create role service_role;alter table usuarios_negocio add nombre text not null default 'Fixture',add email text not null default 'fixture@example.test',add created_at timestamptz default now(),add invite_token uuid default gen_random_uuid();alter table auth.users add email text,add email_confirmed_at timestamptz;");const sql=await readFile(new URL('../../supabase/migrations/20261015013926_native_team_staging_v1.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);await db.exec('set role authenticated');return db}
async function admin(db,sql,args=[]){await db.exec('reset role');try{return(await db.query(sql,args)).rows}finally{await db.exec('set role authenticated')}}
const request=(op,command)=>({version:'ventard.team.request.1',operationId:id(op),context:ctx,command});
const submit=(db,v)=>rpc(db,'native_team_submit_v1',[canon(v),hash(v)]);
test('team: exact invitation replay, CAS role/deactivation, no self changes or financial journal',async()=>{const db=await setup();try{
 const v=request(2200,{kind:'INVITE',name:'Ana QA',email:'ana.qa@example.test',role:'vendedor'});
 await admin(db,"create function fixture_team_fail() returns trigger language plpgsql as $$begin raise exception 'fixture team rollback';end;$$");await admin(db,'create trigger fixture_team_fail before insert on native_team_operations_v1 for each row execute function fixture_team_fail()');await assert.rejects(submit(db,v),/fixture team rollback/);assert.equal((await admin(db,'select count(*) n from usuarios_negocio where id=$1',[id(2200)]))[0].n,0);await admin(db,'drop trigger fixture_team_fail on native_team_operations_v1');
 const first=await submit(db,v);assert.equal(first.status,'APPLIED');assert.ok(first.invitePath.startsWith('/unirse?token='));assert.deepEqual(await submit(db,v),first);
 if(process.env.VENTARD_TEAM_FIXTURE_OUTPUT)await writeFile(process.env.VENTARD_TEAM_FIXTURE_OUTPUT,JSON.stringify({request:v,receipt:first}));
 const changed=structuredClone(v);changed.command.name='Otra';await assert.rejects(submit(db,changed),/ID_CONFLICT/);
 const view=await rpc(db,'native_team_read_v1',context);const row=view.members.find(m=>m.id===first.member.id);assert.ok(row.pending);assert.ok(!JSON.stringify(view).includes('invite_token'));assert.ok(!JSON.stringify(view).includes(first.invitePath.split('=')[1]));
 const patch=request(2201,{kind:'PATCH',memberId:row.id,expectedVersion:row.version,role:'admin',active:true});const updated=await submit(db,patch);assert.equal(updated.member.role,'admin');await assert.rejects(submit(db,request(2202,{...patch.command,active:false})),/VERSION/);
 const removed=await submit(db,request(2203,{...patch.command,expectedVersion:updated.member.version,active:false}));assert.equal(removed.member.active,false);
 await assert.rejects(submit(db,request(2204,v.command)),/EMAIL_EXISTS/);assert.equal((await admin(db,'select count(*) n from native_sales_ledger_v1'))[0].n,0);
 const cancelled=request(2205,{kind:'INVITE',name:'Cancelled QA',email:'cancel@example.test',role:'vendedor'});const tombstone=await rpc(db,'native_team_cancel_v1',[canon(cancelled),hash(cancelled)]);assert.equal(tombstone.status,'CANCELLED');assert.deepEqual(await submit(db,cancelled),tombstone);assert.equal((await admin(db,'select count(*) n from usuarios_negocio where id=$1',[id(2205)]))[0].n,0);
 await assert.rejects(db.query('select * from native_team_operations_v1'),/permission denied/);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(7)]);await assert.rejects(rpc(db,'native_team_read_v1',context),/CONTEXT|DENIED/);
 }finally{await db.close()}});
test('team: cashier membership provisions POS access and server blocks management even with a valid context',async()=>{const db=await setup();try{
 const user=id(2230),registration=id(2231);const invitation=await submit(db,request(2232,{kind:'INVITE',name:'Cashier QA',email:'cashier.qa@example.test',role:'cajero'}));await admin(db,"insert into auth.users(id,email,email_confirmed_at) values($1,'cashier.qa@example.test',now())",[user]);await admin(db,'select native_team_invite_accept_v1($1,$2)',[invitation.invitePath.split('=')[1],user]);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);const receipt=await rpc(db,'native_registrar_instalacion_v1',[registration,tenant,installation,device,'BRANCH',branch]);assert.equal(receipt.role,'cajero');await assert.rejects(rpc(db,'native_team_read_v1',context),/TEAM_DENIED/);
 const sale=command(2233);sale.intent.actorId=user;sale.intent.permissionGrantId=registration;sale.snapshot.actorId=user;const result=await rpc(db,'native_sales_submit_v1',[canon(sale.intent),hash(sale.intent),canon(sale.snapshot),hash(sale.snapshot)]);assert.equal(result.status,'APPLIED');
 const management={...sale.intent,kind:'CREDIT_PAYMENT',operationId:id(2234)};await assert.rejects(rpc(db,'native_sales_submit_v1',[canon(management),hash(management),null,null]),/CASHIER_POS_ONLY/);
 await assert.rejects(rpc(db,'native_sales_submit_team_base_v1',[canon(management),hash(management),null,null]),/permission denied/);
 }finally{await db.close()}});
test('team: invitation is bounded, same-email verified account only, single use, atomic membership binding',async()=>{const db=await setup();try{
 const first=await submit(db,request(2210,{kind:'INVITE',name:'Eva QA',email:'eva.qa@example.test',role:'vendedor'}));const token=first.invitePath.split('=')[1];
 await assert.rejects(rpc(db,'native_team_invite_read_v1',[token]),/permission denied/);
 await admin(db,"insert into auth.users(id,email,email_confirmed_at) values($1,'eva.qa@example.test',now()),($2,'other@example.test',now())",[id(2220),id(2221)]);
 await assert.rejects(admin(db,'select native_team_invite_accept_v1($1,$2)',[token,id(2221)]),/INVITE_DENIED/);
 const accepted=(await admin(db,'select native_team_invite_accept_v1($1,$2) result',[token,id(2220)]))[0].result;assert.equal(accepted.status,'ACCEPTED');assert.deepEqual((await admin(db,'select native_team_invite_accept_v1($1,$2) result',[token,id(2220)]))[0].result,accepted);
 await assert.rejects(admin(db,'select native_team_invite_read_v1($1)',[token]),/INVITE_UNAVAILABLE/);
 assert.equal((await admin(db,'select user_id from usuarios_negocio where id=$1',[first.member.id]))[0].user_id,id(2220));
 const exp=await submit(db,request(2211,{kind:'INVITE',name:'Expired QA',email:'expired.qa@example.test',role:'admin'}));await admin(db,"update usuarios_negocio set invite_expires_at=now()-interval '1 second' where id=$1",[exp.member.id]);await assert.rejects(admin(db,'select native_team_invite_read_v1($1)',[exp.invitePath.split('=')[1]]),/INVITE_UNAVAILABLE/);
 }finally{await db.close()}});
