import type {VentaRDDatabase} from '@/lib/db/dexie';
import {useConfigStore} from '@/store/useConfigStore';
import {sharedContextKey,type SharedContext} from './shared-journal';

/** Refresh the original public presentation cache before enabling checkout. */
export async function hydrateSharedBrand(db:VentaRDDatabase,c:SharedContext,live:()=>boolean){
 const key=sharedContextKey(c),[e,state,publication]=await Promise.all([db.shared_entities.get(key+'/BUSINESS/current'),db.shared_state.get(key),db.shared_entities.get(key+'/CATALOGUE_PUBLICATION/current')]);
 if(!live())throw Error('SHARED_SCOPE_CHANGED');
 if(!e)throw Error('SHARED_BUSINESS_HEADER_REQUIRED');
 const days=Number((state?.bootstrap?.warrantyDefault as Record<string,unknown>|undefined)?.days);
 const b=e.value,text=(v:unknown)=>typeof v==='string'?v:null,bank=b.bank as Record<string,unknown>|null|undefined;
 useConfigStore.setState({...(Number.isSafeInteger(days)&&days>=0&&days<=3650?{garantiaDiasDefault:days}:{}),...(typeof publication?.value.enabled==='boolean'?{catalogoPublico:publication.value.enabled}:{}),negocioNombre:text(b.name),negocioRnc:text(b.rnc),negocioDireccion:text(b.address),negocioTelefono:text(b.phone),negocioWhatsapp:text(b.whatsapp),negocioMensajeTicket:text(b.footer),negocioLogo:text(b.logo),...(typeof b.color==='string'?{colorMarca:b.color}:{}),...(typeof b.font==='string'?{fuenteMarca:b.font}:{}),datosPago:bank?{banco:String(bank.name),cuenta:String(bank.account),titular:String(bank.holder)}:null});
}
