import type {VentaRDDatabase} from '@/lib/db/dexie';
import type {CajaLocal} from '@/types/database';
import {getSharedCaptureContext} from './shared-capture';
import {sharedContextKey} from './shared-journal';
type Obj=Record<string,unknown>;
/** A deposit refund is its own audited operation, never a fabricated expense. */
export async function sharedCashRefunds(db:VentaRDDatabase,turn:CajaLocal,at:number){
 const c=getSharedCaptureContext(db),rows=new Map<string,{key:string;fecha:number;tipo:string;titulo:string;monto:number;signo:'out'}>();
 if(!c||c.tenantId!==turn.negocio_id||c.branchId!==(turn.sucursal_id??null))return{cents:0,details:[]};
 const key=sharedContextKey(c),add=(id:string,date:unknown,amount:unknown,title:unknown)=>{const fecha=Number(date),cents=Number(amount);if(!Number.isSafeInteger(fecha)||!Number.isSafeInteger(cents)||cents<=0)throw Error('SHARED_DEPOSIT_REVIEW_REQUIRED');if(fecha>=turn.fecha_apertura&&fecha<=at)rows.set(id,{key:'deposito-'+id,fecha,tipo:'Devolución de depósito',titulo:String(title??'Devolución de depósito'),monto:cents/100,signo:'out'})};
 for(const entity of await db.shared_entities.where('[scopeKey+kind]').equals([key,'EVENT']).toArray()){
  const v=JSON.parse(String((entity.value.event as Obj).intent)) as Obj;if(v.kind!=='SERVICE_REFUND'||v.originalTurnId!==turn.id)continue;
  const d=(v.payload as Obj).document as Obj;if(d.method==='EFECTIVO')add(String(v.operationId),v.originAtUtcMs,d.amountCents,d.concept);
 }
 for(const raw of await db.shared_mutations.where('scopeKey').equals(key).toArray()){
  if(raw.facts.ACTIVE_TURN_ID!==turn.id)continue;
  for(const change of raw.changes){const d=change.after;if(change.table==='shared_configuration'&&d?.kind==='SERVICE_REFUND'&&d.method==='EFECTIVO')add(raw.id,d.at,d.amountCents,d.reason)}
 }
 const details=[...rows.values()],cents=details.reduce((n,r)=>n+Math.round(r.monto*100),0);if(!Number.isSafeInteger(cents))throw Error('importe_fuera_de_rango');return{cents,details};
}
