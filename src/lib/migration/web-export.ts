import type {VentaRDDatabase} from '@/lib/db/dexie';

// A portable preservation package, not an operational cutover or a remote receipt.
export const TABLES = ['apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','inventario_sync_cursors','movimientos_stock','operaciones_locales','productos','reparaciones','secuencias','seriales','sucursales','transacciones_fiado','venta_detalles','ventas'] as const;
export const MAX_BYTES = 32 * 1024 * 1024;
export function tablesForSchema(version:number){
    if(![21,22,23].includes(version))fail('WEB_EXPORT_SCHEMA');
    return TABLES.filter(name=>name!=='operaciones_locales'||version>=23).filter(name=>name!=='inventario_sync_cursors'||version>=22);
}
const CONFIG_FIELDS = ['dispositivoId','ultimoTicket','negocioId','usuarioCacheId','negocioNombre','sucursalId','rolUsuario','nombreUsuario','negocioWhatsapp','negocioTelefono','negocioRnc','negocioDireccion','negocioMensajeTicket','negocioLogo','ncf','impresion','garantiaDiasDefault','tema','colorMarca','fuenteMarca','catalogoPublico','datosPago','cobrarRepuestosAparte'];
const SECRET_KEYS = /^(pinAdmin|pin|access_token|refresh_token|password|secret|session|firmaAcc|recoverySecret)$/i;
export interface WebExport {
    migrationVersion:1; exportId:string; tenantId:string; origin:string; profileAlias:string;
    generatedAtMs:string; databaseName:string; schemaVersion:number; sourceBuild:string;
    boundary:'IDB_ATOMIC_STORAGE_OBSERVED'; writersStopped:false;
    tables:{name:string;count:number;rowsJson:string;sha256:string}[];
    storageJson:string; storageSha256:string;
}
type StorageReader=Pick<Storage,'getItem'|'key'|'length'>;
function fail(code:string):never{throw new Error(code);}
function readStorage(storage:StorageReader){
    const keys=['ventard-config','ventard-cart','vrd_logo_cache'];
    for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key?.startsWith('vrd_sync_'))keys.push(key);}
    return Object.fromEntries([...new Set(keys)].sort().map(k=>[k,storage.getItem(k)]));
}
function json(value:unknown):string{
    return JSON.stringify(value,(_key,v)=>{
        if(SECRET_KEYS.test(_key))fail('WEB_EXPORT_SECRET');
        if(typeof v==='number'&&(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v)))fail('WEB_EXPORT_VALUE');
        if(v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype)fail('WEB_EXPORT_VALUE');
        if(['bigint','function','symbol'].includes(typeof v))fail('WEB_EXPORT_VALUE');
        return v;
    });
}
async function digest(value:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
export async function captureWebData(db:VentaRDDatabase,storage:StorageReader,options:Pick<WebExport,'tenantId'|'origin'|'profileAlias'|'exportId'|'generatedAtMs'>&{sourceBuild?:string}):Promise<WebExport>{
    const url=new URL(options.origin);
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if(!uuid.test(options.tenantId)||!uuid.test(options.exportId)||!/^\d+$/.test(options.generatedAtMs)||!Number.isSafeInteger(Number(options.generatedAtMs))||url.origin!==options.origin||!['https:','http:'].includes(url.protocol)||!options.profileAlias.trim()||options.profileAlias.length>80)fail('WEB_EXPORT_CONTEXT');
    await db.open();
    const expected=tablesForSchema(db.verno);
    if(db.tables.map(t=>t.name).sort().join('|')!==expected.join('|'))fail('WEB_EXPORT_SCHEMA');
    const before=readStorage(storage);
    let config:Record<string,unknown>;
    try{config=JSON.parse(before['ventard-config']??'null')?.state;}catch{fail('WEB_EXPORT_CONTEXT');}
    if(!config||config.negocioId!==options.tenantId)fail('WEB_EXPORT_CONTEXT');
    const selected=Object.fromEntries(CONFIG_FIELDS.filter(k=>Object.hasOwn(config,k)).map(k=>[k,config[k]]));
    const saved:Record<string,unknown>={config:selected};
    // Keep exact persisted strings for carts, assets and cursors; no auth storage.
    for(const [key,value] of Object.entries(before))if(key!=='ventard-config'&&value!==null){
        if(key==='ventard-cart'||key==='vrd_logo_cache'){let parsed:unknown;try{parsed=JSON.parse(value);}catch{fail('WEB_EXPORT_VALUE');}json(parsed);}
        saved[key]=value;
    }
    const captured=await db.transaction('r',db.tables,async()=>{
        const result=[];
        let bytes=0;
        for(const name of expected){if(await db.table(name).count()>200_000)fail('WEB_EXPORT_TOO_LARGE');const rows=await db.table(name).toArray();const rowsJson=json(rows);bytes+=new TextEncoder().encode(rowsJson).length;if(bytes>MAX_BYTES)fail('WEB_EXPORT_TOO_LARGE');result.push({name,count:rows.length,rowsJson});}
        // IndexedDB is atomic. localStorage isn't; change => retry, never claim writer quiescence.
        if(JSON.stringify(before)!==JSON.stringify(readStorage(storage)))fail('WEB_EXPORT_SOURCE_CHANGED');
        return result;
    });
    const tables=[];
    for(const table of captured)tables.push({...table,sha256:await digest(table.rowsJson)});
    const storageJson=json(saved);
    const data:WebExport={...options,sourceBuild:options.sourceBuild??'unknown',migrationVersion:1,databaseName:db.name,schemaVersion:db.verno,boundary:'IDB_ATOMIC_STORAGE_OBSERVED',writersStopped:false,tables,storageJson,storageSha256:await digest(storageJson)};
    if(new TextEncoder().encode(json(data)).length>MAX_BYTES)fail('WEB_EXPORT_TOO_LARGE');
    return data;
}
export async function sealWebData(data:WebExport,fixture?:{key:Uint8Array<ArrayBuffer>;iv:Uint8Array<ArrayBuffer>}){
    const raw=fixture?.key.slice()??crypto.getRandomValues(new Uint8Array(32));
    const iv=fixture?.iv??crypto.getRandomValues(new Uint8Array(12));
    const plaintext=new TextEncoder().encode(json(data));
    if(plaintext.length>MAX_BYTES)fail('WEB_EXPORT_TOO_LARGE');
    const magic=new TextEncoder().encode('VRWEB001');
    const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);
    const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:magic},key,plaintext));
    const file=new Uint8Array(20+encrypted.length);file.set(magic);file.set(iv,8);file.set(encrypted,20);
    const keyFile=new Uint8Array(40);keyFile.set(new TextEncoder().encode('VRWKY001'));keyFile.set(raw,8);
    raw.fill(0);plaintext.fill(0);
    return {file,keyFile};
}
