import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('ventas usa adaptador IPC oficial Tauri 2, sin DB/key/red en presentación',()=>{
 const bridge=read('apps/pos/src/platform/qa.ts');
 assert.match(bridge,/@tauri-apps\/api\/core/);
 assert.match(bridge,/ventard\.qa\.ipc\.1/);
 assert.doesNotMatch(bridge,/dexie|supabase|localStorage|indexedDB|fetch\(|CipherKey/);
 const ui=read('apps/pos/src/features/sales/sales-page.tsx');
 const adapter=read('apps/pos/src/platform/pos-adapter.ts');
 assert.match(adapter,/qa_sell/);assert.match(adapter,/qa_result/);assert.match(adapter,/qa_quote/);
 assert.doesNotMatch(ui,/localStorage|indexedDB|fetch\(/);
});
test('permisos QA y acceso individualizados; handler exige feature/contexto',()=>{
 const cap=JSON.parse(read('apps/pos/src-tauri/capabilities/pos.json'));
 assert.deepEqual(cap.permissions,['allow-qa-read','allow-qa-create','allow-qa-sell','allow-qa-result','allow-qa-quote','allow-qa-sale-abandon','allow-qa-sale-ticket','allow-qa-history-read','allow-qa-product-save','allow-qa-stock-adjust','allow-qa-cart-save','allow-qa-cart-action','allow-native-access-status','allow-native-access-login','allow-native-access-provision','allow-native-access-pin','allow-native-access-lock','allow-native-catalogue-download','allow-native-catalogue-read','allow-native-cart-read','allow-native-cart-save','allow-native-cart-action','allow-native-catalogue-quote','allow-native-cash-read','allow-native-history-read','allow-native-history-ticket','allow-native-fiscal-read','allow-native-fiscal-prepare','allow-native-sales']);
 assert.deepEqual(cap.windows,['main']);assert.equal(cap.remote,undefined);
 assert.match(read('apps/pos/src-tauri/src/lib.rs'),/feature\s*=\s*"qa-spike"/);
 assert.match(read('apps/pos/src-tauri/src/qa.rs'),/debug_assertions/);
 assert.match(read('apps/pos/src-tauri/build.rs'),/AppManifest/);
});
test('Historial es lectura acotada, tenant/scope nativos y no reconstruye tickets ni despacha sync',()=>{
 const core=read('crates/ventard-core/src/application/history.rs');
 assert.match(core,/PAGE_SIZE:\s*u32\s*=\s*10/);
 assert.match(core,/s\.tenant_id=\?1 AND s\.scope_key=\?2/);
 assert.doesNotMatch(core,/\b(?:INSERT|UPDATE|DELETE|UPSERT)\b|\.execute\(|transaction_with|reqwest|SystemTime|worker|dispatcher/);
 const ui=read('apps/pos/src/features/sales/history-page.tsx');assert.doesNotMatch(ui,/indexedDB|localStorage|supabase|fetch\(|qaInvoke|SELECT /);
 const access=read('apps/pos/src-tauri/src/access.rs');assert.match(access,/native_history_read[\s\S]*?s\.draft_call/);assert.match(access,/native_history_ticket[\s\S]*?s\.draft_call/);
 const ticket=read('apps/pos/src/features/sales/ticket-dialog.tsx');assert.doesNotMatch(ticket,/calculate_totals|precio_venta|nativePosPort|fetch\(/);
});

test('Historial distingue recibo verificado por fila sin atribuir aceptación o validez fiscal al snapshot',()=>{
 const history=read('apps/pos/src/features/sales/history-page.tsx');
 assert.match(history,/row\.remoteStatus === "APPLIED"/);
 assert.match(history,/Recibo remoto verificado/);
 assert.match(history,/Sin recibo remoto verificado/);
 assert.doesNotMatch(history,/La\s+aceptación remota no está verificada/);
 const ticket=read('apps/pos/src/features/sales/ticket-dialog.tsx');
 assert.doesNotMatch(ticket,/aceptación remota y validez fiscal no verificadas/);
 assert.match(ticket,/validez fiscal no verificada/);
});
