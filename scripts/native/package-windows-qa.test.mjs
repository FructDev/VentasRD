import {test} from 'node:test';import assert from 'node:assert/strict';
import {installerConfiguration,validatePublicConfig} from './package-windows-qa.mjs';
const config={publishableKey:'sb_publishable_fixture',keyId:'fixture-only',publicHex:'d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',issuerUrl:'http://127.0.0.1:3107/api/native/provision'};
test('QA delivery: public-only configuration and fixed Staging issuer, never privileged credentials',()=>{
 assert.deepEqual(validatePublicConfig(config),config);
 assert.equal(validatePublicConfig({...config,issuerUrl:'https://blzzinivvzadqjbnpsre.supabase.co/functions/v1/native-provision-staging'}).issuerUrl.endsWith('/native-provision-staging'),true);
 for(const value of [{...config,password:'do-not-bundle'},{...config,privateKey:'do-not-bundle'},{...config,issuerUrl:'https://production.test'},{...config,publishableKey:'sb_secret_fixture'},{...config,webOrigin:'https://staging.test/path'},{...config,publicHex:'0'.repeat(64)}])assert.throws(()=>validatePublicConfig(value));
 const token=claims=>'header.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature';
 assert.throws(()=>validatePublicConfig({...config,publishableKey:token({role:'service_role',ref:'blzzinivvzadqjbnpsre'})}));
 assert.throws(()=>validatePublicConfig({...config,publishableKey:token({role:'anon',ref:'production-project'})}));
});
test('QA delivery: stable data identity and installed filename across upgrades, downgrade protection and only one public resource',()=>{
 const a=installerConfiguration('0.1.1','scratch/public.json'),b=installerConfiguration('0.1.2','scratch/public.json');
 assert.equal(a.identifier,'com.ventard.pos.qa');assert.equal(a.identifier,b.identifier);assert.equal(a.mainBinaryName,b.mainBinaryName);assert.equal(a.productName,b.productName);
 assert.equal(a.bundle.windows.allowDowngrades,false);assert.equal(a.bundle.windows.nsis.installMode,'currentUser');assert.deepEqual(a.bundle.windows.nsis.languages,['Spanish']);
 assert.equal(a.bundle.createUpdaterArtifacts,false);assert.deepEqual(Object.values(a.bundle.resources),['public-staging-config.json']);
 for(const bad of ['../0.1.1','0.1.1;execute','0.1.1-qa','1.2','01.2.3'])assert.throws(()=>installerConfiguration(bad,'scratch/public.json'));
});
