import {describe,it,expect} from 'vitest';
import {sharedRemote,sharedStagingEnabled} from './shared-remote';
const tenant='96000000-0000-4000-8000-000000000001',stage='https://blzzinivvzadqjbnpsre.supabase.co';
describe('shared channel boundary',()=>{
 it('never enables production, foreign tenants or implicit rollout',()=>{
  expect(sharedStagingEnabled(stage,'staging',tenant)).toBe(true);
  expect(sharedStagingEnabled(stage,'staging','96000000-0000-4000-8000-000000000003')).toBe(true);
  expect(sharedStagingEnabled(stage,'staging','96000000-0000-4000-8000-000000000004')).toBe(false);
  for(const args of [[stage,undefined,tenant],['https://oxbekqoecunsbjheqgqg.supabase.co','staging',tenant],[stage,'staging','other']])expect(sharedStagingEnabled(...args as [string,string,string])).toBe(false);
  expect(()=>sharedRemote({rpc:async()=>({data:null,error:null})},'https://production.test',tenant)).toThrow('SHARED_STAGING_ONLY');
 });
 it('a missing or malformed mode never authorizes fallback to legacy row writes',async()=>{
  const remote=sharedRemote({rpc:async()=>({data:null,error:{code:'42883'}})},stage,tenant);await expect(remote.mode(null)).rejects.toThrow('SHARED_TRANSPORT_UNCERTAIN');
  const wrong=sharedRemote({rpc:async()=>({data:{protocol:'ventard.web.mode.1',tenantId:'another',branchId:null,mode:'LEGACY'},error:null})},stage,tenant);await expect(wrong.mode(null)).rejects.toThrow('SHARED_RESPONSE_INVALID');
 });
 it('does not forward server details into UI or stored errors',async()=>{
  const remote=sharedRemote({rpc:async()=>({data:null,error:{code:'42501',message:'sensitive membership details'}})},stage,tenant);await expect(remote.mode(null)).rejects.toThrow('SHARED_AUTH_REQUIRED');
 });
});
