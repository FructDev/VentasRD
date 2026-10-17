import {test} from 'node:test';import assert from 'node:assert/strict';import {randomBytes,createHash} from 'node:crypto';
import {encryptRecovery,decryptRecovery,verifyPublicRestore,recoveryScope,tenantId} from './production-recovery.mjs';
test('backup export is bound only to Pica Chicken; unscoped tables fail and fiscal sequences stay excluded',()=>{
 assert.equal(recoveryScope('ncf_secuencias',['negocio_id']),null);assert.equal(recoveryScope('negocios',['id']),`t.id='${tenantId}'`);
 assert.equal(recoveryScope('productos',['negocio_id']),`t.negocio_id='${tenantId}'`);
 assert.match(recoveryScope('inventario_sucursales',['sucursal_id']),/public.sucursales/);
 assert.match(recoveryScope('venta_detalles',['venta_id','negocio_id']),/t.negocio_id is null/);
 assert.throws(()=>recoveryScope('unknown',['id']),/UNSCOPED_TABLE_REJECTED/);
});
test('portable recovery authenticates exact bytes, purpose, project and key; tampering fails closed',()=>{
 const key=randomBytes(32),bytes=Buffer.from('Synthetic only: 9007199254740993.25');const encrypted=encryptRecovery(bytes,key,'DATABASE');
 assert.deepEqual(decryptRecovery(encrypted,key,'DATABASE'),bytes);assert.equal(encrypted.ciphertext.includes(bytes.toString()),false);
 assert.throws(()=>decryptRecovery(encrypted,randomBytes(32),'DATABASE'));assert.throws(()=>decryptRecovery(encrypted,key,'SIGNING'));
 assert.throws(()=>decryptRecovery({...encrypted,projectRef:'other'},key,'DATABASE'));const changed=Buffer.from(encrypted.ciphertext,'base64');changed[0]^=1;assert.throws(()=>decryptRecovery({...encrypted,ciphertext:changed.toString('base64')},key,'DATABASE'));key.fill(0);
});
test('isolated data recovery preserves exact money, big integers, JSON and explicit nulls',async()=>{
 const snapshot={columns:[{table:'fixture',name:'id',type:'bigint',notNull:true},{table:'fixture',name:'money',type:'numeric(20,2)',notNull:true},{table:'fixture',name:'payload',type:'jsonb',notNull:false}],tables:[{name:'fixture',count:2,rows:['{"id":9007199254740993,"money":9007199254740993.25,"payload":{"a":null,"value":9007199254740993}}','{"id":1,"money":1.00,"payload":null}']}]};
 assert.deepEqual(await verifyPublicRestore(snapshot),{engine:'ISOLATED_POSTGRESQL_RAM',tables:1,rows:2,exactNumericComparison:true,remoteWrites:false});
 snapshot.tables[0].sourceSha256=createHash('sha256').update(snapshot.tables[0].rows.join('\n')).digest('hex');assert.equal((await verifyPublicRestore(snapshot)).rows,2);
 await assert.rejects(verifyPublicRestore({...snapshot,tables:[{...snapshot.tables[0],sourceSha256:'0'.repeat(64)}]}),/SOURCE_BYTES_MISMATCH/);
 await assert.rejects(verifyPublicRestore({...snapshot,tables:[{...snapshot.tables[0],count:3}]}),/RESTORE_MISMATCH/);
});
test('recovery preserves PostgreSQL text arrays and UTF-8',async()=>{
 const result=await verifyPublicRestore({columns:[{table:'fixture',name:'values',type:'text[]',notNull:false}],tables:[{name:'fixture',count:2,rows:['{"values":["áéíóú","comillas \\\"",null]}','{"values":null}']}]});assert.equal(result.rows,2);
});
