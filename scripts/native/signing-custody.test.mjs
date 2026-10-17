import {test} from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {protectSecret,prepareSigningCustody,readSecret} from './signing-custody.mjs';
import {mkdtemp,readFile,writeFile,rm,rmdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('Windows DPAPI preserves only this new fixture secret; wrong purpose or tampering fails closed',async()=>{
 const secret=randomBytes(48),encrypted=await protectSecret(secret,'fixture-grant');
 try{
  assert.equal(encrypted.includes(secret),false);
  const decrypted=await protectSecret(encrypted,'fixture-grant','unprotect');try{assert.deepEqual(decrypted,secret)}finally{decrypted.fill(0)}
  await assert.rejects(protectSecret(encrypted,'fixture-updater','unprotect'),/CUSTODY_FAILED/);
  const changed=Buffer.from(encrypted);changed[Math.floor(changed.length/2)]^=1;await assert.rejects(protectSecret(changed,'fixture-grant','unprotect'),/CUSTODY_FAILED/);
  await assert.rejects(protectSecret(secret,'untrusted-purpose'),/INPUT_INVALID/);
 }finally{secret.fill(0)}
});
test('new local keys are sealed, survive reopening without rotation and reject corrupt metadata',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'ventard-signing-custody-test-')),directory=join(parent,'keys');
 try{
  const first=await prepareSigningCustody(directory),again=await prepareSigningCustody(directory);assert.deepEqual(again,first);
  const grant=await readSecret(directory,'production-grant');try{assert.match(grant.toString(),/^-----BEGIN PRIVATE KEY-----/);const file=await readFile(join(directory,'production-grant.dpapi.json'));assert.equal(file.includes(grant),false)}finally{grant.fill(0)}
  const updater=await readSecret(directory,'production-updater');try{assert.ok(updater.length>50)}finally{updater.fill(0)}
  assert.equal(first.remoteUploadPerformed,false);assert.match(first.grantPublicHex,/^[a-f0-9]{64}$/);
  await writeFile(join(directory,'public.json'),JSON.stringify({...first,grantPublicHex:'0'.repeat(64)}));await assert.rejects(prepareSigningCustody(directory),/CUSTODY_MISMATCH/);
 }finally{
  for(const name of ['production-grant.dpapi.json','production-updater.dpapi.json','public.json'])await rm(join(directory,name),{force:true});await rmdir(directory);await rmdir(parent);
 }
});
