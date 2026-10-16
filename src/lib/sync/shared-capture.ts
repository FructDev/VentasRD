import Dexie,{type DBCoreTransaction,type DBCore,type DBCoreMutateRequest} from 'dexie';
import type {VentaRDDatabase} from '@/lib/db/dexie';
import {canonicalCommand,commandHash} from '@/lib/domain/local/command';
import {sharedContextKey,type SharedContext} from './shared-journal';
import {setSharedDeviceContext} from './shared-device';
export interface SharedChange {table:string;key:string;before:Record<string,unknown>|null;after:Record<string,unknown>|null}
export interface SharedMutation {id:string;scopeKey:string;context:SharedContext;order:number;changes:SharedChange[];facts:Record<string,unknown>;sourceHash:string;state:'CAPTURED'|'PREPARED'|'APPLIED'|'BLOCKED';code?:string;operationId?:string;operationIds?:string[];private?:{intent:string;hash:string;state:'PENDING'|'APPLIED';receipt?:Record<string,unknown>}}
const contexts=new WeakMap<VentaRDDatabase,SharedContext>();
const writeGuards=new WeakMap<VentaRDDatabase,string>();
export function setSharedWriteGuard(db:VentaRDDatabase,code:string|null){if(code)writeGuards.set(db,code);else writeGuards.delete(db)}
const projections=new WeakSet<object>();
const business=new Set(['ventas','venta_detalles','productos','composiciones','clientes','transacciones_fiado','cajas','devoluciones','cortes_caja','seriales','movimientos_stock','gastos','reparaciones','apartados','operaciones_locales']);
export const getSharedCaptureContext=(db:VentaRDDatabase)=>contexts.get(db)??null;
export function setSharedCaptureContext(db:VentaRDDatabase,c:SharedContext|null){if(c){sharedContextKey(c);contexts.set(db,structuredClone(c))}else contexts.delete(db);setSharedDeviceContext(c)}
/** Mark the EXISTING transaction as receipt projection, before any mutation.
 * No global async flag: another tab or concurrent user transaction stays captured. */
export function markSharedProjection(){const transaction=Dexie.currentTransaction?.idbtrans;if(!transaction)throw Error('SHARED_PROJECTION_TRANSACTION_REQUIRED');projections.add(transaction)}
export function attachSharedCapture(db:VentaRDDatabase){
 const captures=new WeakMap<DBCoreTransaction,{id:string;context:SharedContext;row?:SharedMutation}>();
 db.use({stack:'dbcore',name:'VentaRD shared operation custody',level:3,create(down:DBCore){return{...down,
  transaction(stores,mode,options){const c=contexts.get(db),capture=c&&mode==='readwrite'&&stores.some(s=>business.has(s));
   const expanded=capture?[...new Set([...stores,'shared_mutations','shared_state','shared_entities','productos'])]:stores;
   const transaction=down.transaction(expanded,mode,options);if(capture)captures.set(transaction,{id:crypto.randomUUID(),context:structuredClone(c)});return transaction;
  },
  table(name){const table=down.table(name);if(!business.has(name))return table;return{...table,
   async mutate(request:DBCoreMutateRequest){
    if(!projections.has(request.trans)&&writeGuards.has(db)){request.trans.abort();throw Error(writeGuards.get(db))}
    const capture=captures.get(request.trans);if(!capture||projections.has(request.trans))return table.mutate(request);
    if(request.type==='deleteRange'){request.trans.abort();throw Error('SHARED_RANGE_DELETE_REQUIRES_REVIEW')}
    const keys=request.type==='delete'?request.keys:request.keys??request.values.map(v=>table.schema.primaryKey.extractKey?.(v));
    const previous=await table.getMany({trans:request.trans,keys});
    const result=await table.mutate(request);
    try{
     let changed=false;const current=capture.row??{id:capture.id,scopeKey:sharedContextKey(capture.context),context:capture.context,order:0,changes:[],facts:{},sourceHash:'',state:'CAPTURED' as const};
     for(let index=0;index<keys.length;index++){
      if(result.failures[index])continue;
      const before=previous[index] as Record<string,unknown>|undefined;
      const after=request.type==='delete'?undefined:await table.get({trans:request.trans,key:keys[index]});
      // Server projections/acknowledgements always carry synced flags. A
      // financial capture is never reconstructed from a later database scan.
      if(after&&after.estado_sincronizacion!==0&&name!=='operaciones_locales')continue;
      if(!after&&!before)continue;
      if(name==='operaciones_locales'&&after?.estado_local!=='COMMITTED')continue;
      if(name==='operaciones_locales'&&before?.estado_local==='COMMITTED'&&after?.payload_hash===before.payload_hash)continue;
      const row=after??before;let tenant=row?.negocio_id;
      if(!tenant&&name==='composiciones'&&row?.producto_padre_id)tenant=(await down.table('productos').get({trans:request.trans,key:row.producto_padre_id}))?.negocio_id;
      if(tenant!==capture.context.tenantId)throw Error('SHARED_CAPTURE_SCOPE_MISMATCH');
      if(row.sucursal_id!==undefined&&(row.sucursal_id??null)!==capture.context.branchId)throw Error('SHARED_CAPTURE_SCOPE_MISMATCH');
      const key=String(keys[index]),old=current.changes.find(change=>change.table===name&&change.key===key);
      if(old)old.after=after?structuredClone(after):null;else current.changes.push({table:name,key,before:before?structuredClone(before):null,after:after?structuredClone(after):null});changed=true;
      const entityKeys=new Set<string>();
      for(const source of [before,after]){if(!source)continue;
       for(const key of ['producto_id','producto_padre_id','insumo_id'])if(source[key])entityKeys.add('PRODUCT/'+String(source[key]));
       if(source.cliente_id)entityKeys.add('CUSTOMER/'+String(source.cliente_id));if(source.caja_id)entityKeys.add('TURN/'+String(source.caja_id));
       if(source.venta_id){entityKeys.add('SALE/'+String(source.venta_id));entityKeys.add('RETURN_BASIS/'+String(source.venta_id))}
       if(name==='productos')entityKeys.add('PRODUCT/'+String(source.id));if(name==='clientes')entityKeys.add('CUSTOMER/'+String(source.id));if(name==='cajas')entityKeys.add('TURN/'+String(source.id));if(name==='reparaciones')entityKeys.add('REPAIR/'+String(source.id));if(name==='apartados')entityKeys.add('LAYAWAY/'+String(source.id));
       if(name==='seriales')entityKeys.add('SERIAL/'+String(source.producto_id)+'/'+String(source.numero_serial));
      }
      for(const entityKey of entityKeys)if(!(entityKey in current.facts)){const entity=await down.table('shared_entities').get({trans:request.trans,key:current.scopeKey+'/'+entityKey});current.facts[entityKey]=entity?structuredClone(entity):null}
     }
     if(changed){
      const stateTable=down.table('shared_state'),outbox=down.table('shared_mutations');
      if(!capture.row){const state=await stateTable.get({trans:request.trans,key:current.scopeKey})??{id:current.scopeKey,cursor:'0',nextOrder:0};if(!Number.isSafeInteger(state.nextOrder+1))throw Error('SHARED_ORDER_INVALID');current.facts.MANIFEST=structuredClone(state.bootstrap??null);const turn=state.activeTurnId;if(turn){for(const name of ['TURN','CASH_BASE','DRAWER']){const entity=await down.table('shared_entities').get({trans:request.trans,key:current.scopeKey+'/'+name+'/'+turn});current.facts[name+'/'+turn]=entity?structuredClone(entity):null}current.facts.ACTIVE_TURN_ID=turn}state.nextOrder++;current.order=state.nextOrder;const update=await stateTable.mutate({type:'put',trans:request.trans,values:[state]});if(update.numFailures)throw Error('SHARED_CAPTURE_STORAGE_FAILED')}
      const facts={changes:current.changes,facts:current.facts},canonical=canonicalCommand(facts);if(new TextEncoder().encode(canonical).length>33554432)throw Error('SHARED_CAPTURE_TOO_LARGE');current.sourceHash=commandHash(facts);
      const stored=await outbox.mutate({type:capture.row?'put':'add',trans:request.trans,values:[current]});if(stored.numFailures)throw Error('SHARED_CAPTURE_STORAGE_FAILED');capture.row=current;
     }
     return result;
    }catch(error){request.trans.abort();throw error}
   },
  }},
 }}});
}
