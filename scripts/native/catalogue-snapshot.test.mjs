import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const sql=readFileSync(new URL('../../supabase/migrations/20261009235809_native_catalogue_snapshot_v1.sql',import.meta.url),'utf8');
test('broker validates a newly generated manifest at receive time, not pre-request time',()=>{
 const source=readFileSync(new URL('../../apps/pos/src-tauri/src/access.rs',import.meta.url),'utf8');
 const start=source.indexOf('"native_catalogue_begin_v1"');const end=source.indexOf('manifest\n',start);const capture=source.slice(start,end);
 assert.match(capture,/let received_at = time\(\)\?;/);
 assert.ok(capture.indexOf('serde_json::from_value')<capture.indexOf('let received_at = time()'));
 assert.match(capture,/catalogue::begin\(\s*conn,\s*&stored_ctx,\s*&stored,\s*received_at\s*,?\s*\)/);
 assert.doesNotMatch(capture,/catalogue::begin\(\s*conn,\s*&stored_ctx,\s*&stored,\s*now\s*,?\s*\)/);
});
test('snapshot SQL has frozen pages, exact byte hashes and no business writes',()=>{
 for(const token of ['native_catalogue_begin_v1','native_catalogue_page_v1','sha256','convert_to','CATALOGUE_PREVIEW_V1','MISSING_BRANCH_AUTHORITY','native_member_role_v1','writer_epoch','enable row level security','revoke all','materialized','10000'])assert.ok(sql.includes(token),token);
 assert.doesNotMatch(sql,/\b(?:insert\s+into|update|delete\s+from)\s+public\.(?:productos|inventario_sucursales|ventas|cajas|movimientos_stock)\b/i);
 assert.doesNotMatch(sql,/\b(?:alter|drop)\s+table\s+public\.(?:productos|inventario_sucursales|ventas|cajas|movimientos_stock)\b/i);
 assert.match(sql,/security definer set search_path=''/i);
});
