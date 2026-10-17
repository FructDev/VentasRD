import {invoke,isTauri} from '@tauri-apps/api/core';
export interface UpdateView{currentVersion:string;status:'NOT_CONFIGURED'|'READY'|'UP_TO_DATE'|'AVAILABLE'|'INSTALLING';version?:string;notes?:string|null}
async function call(command:Record<string,string>):Promise<UpdateView>{
 if(!isTauri())throw{code:'ACCESS_NATIVE_REQUIRED'};
 return invoke('native_update',{command,ipcVersion:'ventard.native.access.1',requestId:crypto.randomUUID()});
}
export const updatePort={status:()=>call({action:'STATUS'}),check:()=>call({action:'CHECK'}),install:(version:string)=>call({action:'INSTALL',version,confirmation:'INSTALAR_ACTUALIZACION'})};
export function updateMessage(error:unknown):string{
 const code=typeof error==='object'&&error!==null&&'code'in error?String(error.code):'';
 return ({UPDATE_NOT_CONFIGURED:'Las actualizaciones todavía no están publicadas para esta instalación.',UPDATE_OPERATIONS_PENDING:'Termina el carrito y sincroniza las operaciones pendientes antes de actualizar.',UPDATE_CHECK_REQUIRED:'Vuelve a buscar la actualización antes de instalarla.',UPDATE_DOWNLOAD_OR_SIGNATURE_INVALID:'No se pudo descargar o verificar la actualización. La versión actual y tus datos se conservan.',UPDATE_NETWORK_UNAVAILABLE:'No se pudo buscar la actualización. Comprueba la conexión y vuelve a intentarlo.',ACCESS_PIN_REQUIRED:'Desbloquea VentaRD con tu PIN antes de actualizar.',UPDATE_BUSY:'Ya hay una comprobación o actualización en curso.'} as Record<string,string>)[code]??'No se pudo completar la actualización. La instalación actual se conserva.';
}
