// Owned signing fixture only. No commercial key, installation or publication.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';import {execFileSync,spawnSync} from 'node:child_process';import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';import {prepareRelease} from './desktop-release.mjs';
const root=resolve(import.meta.dirname,'../..'),scratch=join(root,'scratch');
test('official Tauri signature: original bytes/version accepted; modified bytes, wrong version and wrong key rejected',async()=>{
 const dir=await mkdtemp(join(scratch,'desktop-signature-fixture-'));
 try{
  const cli=join(root,'node_modules/@tauri-apps/cli/tauri.js'),privatePath=join(dir,'fixture.key'),artifact=join(dir,'fixture.bin');
  execFileSync(process.execPath,[cli,'signer','generate','--ci','-p','fixture-only-password','-w',privatePath],{stdio:'ignore',windowsHide:true});
  await writeFile(artifact,'Explicit synthetic updater artifact; never installed.');
  execFileSync(process.execPath,[cli,'signer','sign','-f',privatePath,'--app-version','0.1.9',artifact],{env:{...process.env,TAURI_SIGNING_PRIVATE_KEY_PASSWORD:'fixture-only-password'},stdio:'ignore',windowsHide:true});
  const verifier=join(root,'target/debug/ventard-release-verify.exe'),signature=artifact+'.sig',publicPath=privatePath+'.pub';
  const verify=version=>spawnSync(verifier,[publicPath,signature,artifact,version],{stdio:'pipe',windowsHide:true}).status;
  assert.equal(verify('0.1.9'),0);assert.notEqual(verify('9.9.9'),0);
  const manifestPath=join(dir,'manifest.json'),updateConfigPath=join(dir,'updates.json');
  const originalBytes=await readFile(artifact);
  await writeFile(manifestPath,JSON.stringify({protocol:'ventard.windows.qa.package.1',version:'0.1.9',channel:'STAGING_BOUNDED_PILOT',identifier:'com.ventard.pos.qa',installer:{bytes:originalBytes.length,sha256:createHash('sha256').update(originalBytes).digest('hex')}}));
  await writeFile(updateConfigPath,JSON.stringify({channel:'staging',endpoint:'https://fixture.test/api/native/releases/windows-x86_64',downloadOrigin:'https://fixture.test',publicKey:(await readFile(publicPath,'utf8')).trim()}));
  for(const filename of ['release-one.json','release-two.json']){
   const metadata=await prepareRelease({manifestPath,installerPath:artifact,signaturePath:signature,updateConfigPath,url:'https://fixture.test/fixture.exe',outputPath:join(dir,filename)});
   assert.equal(metadata.version,'0.1.9');
   const again=await prepareRelease({manifestPath,installerPath:artifact,signaturePath:signature,updateConfigPath,url:'https://fixture.test/fixture.exe',outputPath:join(dir,filename)});assert.deepEqual(again,metadata);
  }
  const original=await readFile(artifact);await writeFile(artifact,Buffer.concat([original,Buffer.from('altered')]));assert.notEqual(verify('0.1.9'),0);await writeFile(artifact,original);
  const other=join(dir,'other.key');execFileSync(process.execPath,[cli,'signer','generate','--ci','-p','fixture-only-password','-w',other],{stdio:'ignore',windowsHide:true});
  assert.notEqual(spawnSync(verifier,[other+'.pub',signature,artifact,'0.1.9'],{stdio:'pipe',windowsHide:true}).status,0);
 }finally{
  const actual=await realpath(dir),allowed=await realpath(scratch);
  assert.ok(actual.toLowerCase().startsWith(allowed.toLowerCase()+'\\'));assert.match(actual,/desktop-signature-fixture-/);
  await rm(actual,{recursive:true,force:true});
 }
});
