import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('account drafts use explicit native ACL, fixed admission and native-bound account scope',()=>{
 const commands=['native_cart_read','native_cart_save','native_cart_action','native_catalogue_quote'];
 const access=read('apps/pos/src-tauri/src/access.rs');
 for(const c of commands){assert.ok(read('apps/pos/src-tauri/build.rs').includes(`"${c}"`));assert.ok(read('apps/pos/src-tauri/src/lib.rs').includes(`access::${c}`));assert.ok(JSON.parse(read('apps/pos/src-tauri/capabilities/pos.json')).permissions.includes('allow-'+c.replaceAll('_','-')));assert.ok(access.includes(`pub async fn ${c}`));}
 assert.match(access,/fn draft_call[\s\S]*?catalogue_authorize/);
 assert.match(read('apps/pos/src/platform/pos-adapter.ts'),/supportsDrafts:\s*true/);
});
test('draft module has no business effects, clock, network or fabricated tax total',()=>{
 const source=read('crates/ventard-core/src/application/drafts.rs');
 assert.doesNotMatch(source,/reqwest|SystemTime|outbox\s*\(|UPDATE stock|INSERT INTO operation_journal|qa_carts/);
 assert.match(source,/itbis_cents: None/);assert.match(source,/total_cents: None/);
});
