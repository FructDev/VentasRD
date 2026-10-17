import {test} from 'node:test';import assert from 'node:assert/strict';
import {validateUpdateConfig,releaseMetadata} from './desktop-release.mjs';
const config={channel:'staging',endpoint:'https://web.example.test/api/native/releases/windows-x86_64',downloadOrigin:'https://downloads.example.test',publicKey:Buffer.from('untrusted comment: fixture public key\nfixture').toString('base64')};
const manifest={protocol:'ventard.windows.qa.package.1',version:'0.1.9',channel:'STAGING_BOUNDED_PILOT',identifier:'com.ventard.pos.qa',installer:{bytes:10,sha256:'a'.repeat(64)}};
const input={manifest,config,url:'https://downloads.example.test/0.1.9/VentaRD.exe',signature:Buffer.from('untrusted comment: fixture\nfixture\ntrusted comment: fixture\tversion:0.1.9\nfixture').toString('base64'),bytes:10,sha256:'a'.repeat(64),notes:'Fixture only',publishedAt:'2026-10-17T12:00:00Z'};
test('release preparation refuses a QA binary on the production channel or an altered artifact/version',()=>{
 assert.equal(releaseMetadata(input).version,'0.1.9');
 assert.throws(()=>releaseMetadata({...input,config:{...config,channel:'production'}}),/PRODUCTION_PACKAGE_REQUIRED/);
 assert.throws(()=>releaseMetadata({...input,sha256:'b'.repeat(64)}),/ARTIFACT_CHANGED/);
 assert.throws(()=>releaseMetadata({...input,manifest:{...manifest,version:'1.0.0'}}),/SIGNED_VERSION/);
 assert.throws(()=>releaseMetadata({...input,url:'https://other.example.test/app.exe'}));
});
test('update configuration accepts only public settings and an HTTPS endpoint',()=>{
 assert.deepEqual(validateUpdateConfig(config),config);
 for(const patch of [{privateKey:'forbidden'},{endpoint:'http://web.example.test/api/native/releases/windows-x86_64'},{endpoint:'https://web.example.test/arbitrary'},{publicKey:'bad'},{downloadOrigin:'https://user:password@downloads.example.test'}])assert.throws(()=>validateUpdateConfig({...config,...patch}));
});
