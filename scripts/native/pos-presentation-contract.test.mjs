import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
test('la ruta de ventas usa presentación definitiva, no otra caja QA',()=>{
 const router=read('apps/pos/src/app/router.tsx');
 assert.match(router,/SalesPage/);assert.doesNotMatch(router,/QaCheckoutView|function Catalogue|Array\.from/);
 assert.ok(!existsSync(fileURLToPath(new URL('apps/pos/src/features/qa-checkout.tsx',root))));
 const page=read('apps/pos/src/features/sales/sales-page.tsx');
 assert.match(page,/@ventard\/ui\/pos/);assert.doesNotMatch(page,/qaInvoke|QaProduct|qa_sell|dexie|supabase|localStorage|indexedDB/);
});
test('presentación tomada del POS original y separada del adaptador',()=>{
 const ui=read('packages/ui/src/pos.tsx');
 for (const label of ['Ticket','Cobrar Venta','Completar Pago','Subtotal','ITBIS','Efectivo','Transfer.','Fiado','Mixto']) assert.ok(ui.includes(label));
 assert.match(ui,/h-24 sm:h-28/);assert.match(ui,/lg:w-96/);
 assert.doesNotMatch(ui,/next\/|dexie|supabase|qa_|invoke\(/);
 const adapter=read('apps/pos/src/platform/pos-adapter.ts');
 assert.match(adapter,/PosPort/);assert.match(adapter,/qa_quote/);
});
