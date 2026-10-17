import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import ignore from 'ignore';
test('deployment excludes private root folders while preserving nested Supabase clients and the public installer',async()=>{
 const rules=ignore().add(await readFile(new URL('./production-web.vercelignore',import.meta.url),'utf8'));
 for(const path of ['src/lib/supabase/admin.ts','src/lib/supabase/client.ts','public/downloads/windows-x86_64/0.1.9/VentaRD_0.1.9_x64-setup.exe'])assert.equal(rules.ignores(path),false,path);
 for(const path of ['.env.local','scratch/production-signing/production-grant.dpapi.json','supabase/.temp/pooler-url','target/release/VentaRD.exe','.claude/worktrees/unused/file'])assert.equal(rules.ignores(path),true,path);
});
