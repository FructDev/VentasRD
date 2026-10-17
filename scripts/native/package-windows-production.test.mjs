import {test} from 'node:test';import assert from 'node:assert/strict';
import {productionPublicConfig,productionInstallerConfiguration,productionTarget} from './package-windows-production.mjs';
import {readFileSync} from 'node:fs';import {resolve} from 'node:path';
const config={publishableKey:'sb_publishable_fixture',keyId:'production-fixture',publicHex:'d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',issuerUrl:productionTarget.issuerUrl,webOrigin:productionTarget.webOrigin};
const updates={channel:'production',endpoint:'https://ventard.vercel.app/api/native/releases/windows-x86_64',downloadOrigin:'https://ventard.vercel.app',publicKey:Buffer.from('untrusted comment: fixture public key\nfixture').toString('base64')};

test('the internal verifier is excluded from the end-user updater feature set',()=>{
 const cargo=readFileSync(resolve(import.meta.dirname,'../../apps/pos/src-tauri/Cargo.toml'),'utf8');
 const verifier=cargo.split('[[bin]]').slice(1).find(section=>section.includes('name = "ventard-release-verify"'));
 assert.ok(verifier);const required=JSON.parse(verifier.match(/required-features\s*=\s*(\[[^\]]+\])/)?.[1]??'[]');
 assert.ok(required.length>0);assert.ok(required.some(feature=>!['production-pilot','custom-protocol','signed-updates'].includes(feature)),'Tauri must not bundle the release verification tool with VentaRD');
});
test('production packaging pins the real project, public trust and official website; QA, private settings and loose URLs fail closed',()=>{
 assert.deepEqual(productionPublicConfig(config),config);
 for(const v of [{...config,keyId:'qa-key'},{...config,webOrigin:'https://another.test'},{...config,issuerUrl:'http://127.0.0.1:3107/api/native/provision'},{...config,privateKey:'never include'},{...config,publishableKey:'sb_secret_fixture'},{...config,publicHex:'0'.repeat(64)}])assert.throws(()=>productionPublicConfig(v));
 const token=c=>'header.'+Buffer.from(JSON.stringify(c)).toString('base64url')+'.signature';
 assert.throws(()=>productionPublicConfig({...config,publishableKey:token({role:'anon',ref:'blzzinivvzadqjbnpsre'})}));
 assert.throws(()=>productionPublicConfig({...config,publishableKey:token({role:'service_role',ref:productionTarget.projectRef})}));
});
test('production upgrades keep their own data identity; no QA/fiscal IPC or downgrade, signed updater required',()=>{
 const capability={windows:['main'],local:true,permissions:['allow-qa-read','allow-native-sales','allow-native-backup','allow-native-fiscal-read','allow-native-update']};
 const a=productionInstallerConfiguration('0.1.9',updates,capability),b=productionInstallerConfiguration('0.2.0',updates,capability);
 assert.equal(a.identifier,'com.ventard.pos');assert.equal(a.identifier,b.identifier);assert.equal(a.mainBinaryName,b.mainBinaryName);
 assert.deepEqual(a.app.security.capabilities[0].permissions,['allow-native-sales','allow-native-backup','allow-native-update']);
 assert.equal(a.bundle.createUpdaterArtifacts,true);assert.equal(a.bundle.windows.allowDowngrades,false);assert.deepEqual(a.bundle.resources,[]);assert.equal(a.plugins.updater.requireSignedVersion,true);
 assert.throws(()=>productionInstallerConfiguration('0.1.9',{...updates,channel:'staging'},capability));
 assert.throws(()=>productionInstallerConfiguration('0.1.9',{...updates,endpoint:'https://another.test/api/native/releases/windows-x86_64'},capability));
});
