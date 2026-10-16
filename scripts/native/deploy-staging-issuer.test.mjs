import {test} from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {deploymentPlan,secretFileBody,verifyHostedIssuer,projectRef} from './deploy-staging-issuer.mjs';
const keys=generateKeyPairSync('ed25519');
const config={publishableKey:'sb_publishable_fixture',keyId:'fixture-only',publicHex:keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'),issuerUrl:'http://127.0.0.1:3107/api/native/provision'};
test('deployment plan fixes project, destination and source digest without signing material',()=>{
 const plan=deploymentPlan(config,{source:'a'});assert.equal(plan.projectRef,projectRef);assert.equal(plan.verifyJwt,false);
 assert.equal(plan.digest,deploymentPlan(config,{source:'a'}).digest);assert.notEqual(plan.digest,deploymentPlan(config,{source:'b'}).digest);
 assert.throws(()=>deploymentPlan(config,{},'production'));assert.doesNotMatch(JSON.stringify(plan),/BEGIN PRIVATE KEY/);
});
test('server secrets require exactly matching Ed25519 trust and preserve PEM newline escapes',()=>{
 const body=secretFileBody(config,keys.privateKey.export({type:'pkcs8',format:'der'}));
 const lines=body.trim().split('\n');assert.equal(lines.length,5);
 const pem=JSON.parse(lines.find(line=>line.startsWith('VENTARD_NATIVE_GRANT_PRIVATE_KEY_PEM=')).split('=').slice(1).join('='));
 assert.equal(pem,keys.privateKey.export({type:'pkcs8',format:'pem'}).toString());
 const other=generateKeyPairSync('ed25519');assert.throws(()=>secretFileBody(config,other.privateKey.export({type:'pkcs8',format:'der'})));
});
test('post-deploy verification sends no human credentials and requires both matching health and 401',async()=>{
 const plan=deploymentPlan(config,{}),calls=[];
 const http=async(url,init)=>{calls.push({url,init});return init.method==='POST'?Response.json({code:'NATIVE_AUTH_REQUIRED'},{status:401}):Response.json({protocol:'ventard.native.provision.health.v1',projectRef,keyId:config.keyId,publicHex:config.publicHex})};
 assert.equal((await verifyHostedIssuer(plan,config.publishableKey,http)).unauthenticatedPost,'REJECTED_WITHOUT_REGISTRATION');
 assert.equal(calls.length,2);assert(calls.every(c=>c.url===plan.issuerUrl&&!new Headers(c.init.headers).has('authorization')));
 await assert.rejects(()=>verifyHostedIssuer(plan,config.publishableKey,async()=>Response.json({projectRef:'another'})));
});
