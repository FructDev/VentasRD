import {test} from 'node:test';import assert from 'node:assert/strict';import {publicProductionEnvironment} from './build-production-local.mjs';
test('selects only public production configuration; never substitutes private credentials or another project',()=>{
 assert.equal(publicProductionEnvironment('NEXT_PUBLIC_SUPABASE_URL=https://oxbekqoecunsbjheqgqg.supabase.co\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_fixture\nSUPABASE_SERVICE_ROLE_KEY=ignored-fixture\n'),'sb_publishable_fixture');
 assert.throws(()=>publicProductionEnvironment('NEXT_PUBLIC_SUPABASE_URL=https://stage.example.test\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_fixture'));
 assert.throws(()=>publicProductionEnvironment('NEXT_PUBLIC_SUPABASE_URL=https://oxbekqoecunsbjheqgqg.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=ignored-fixture'));
});
