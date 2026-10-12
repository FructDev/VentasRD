import {useEffect,useState} from 'react';
import type {ManagementPort,RepairPrivateView} from '../../platform/management';
import {posError} from '../../platform/pos-adapter';
export function PrivateCredential({repairId,port}:{repairId:string;port:ManagementPort|undefined}){
 const [view,setView]=useState<RepairPrivateView|null>(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;if(port)void port.repairPrivateRead(repairId).then(v=>{if(live)setView(v);}).catch(e=>{if(live)setError(posError(e));});return()=>{live=false;};},[port,repairId]);
 return <div className="bg-navy rounded-xl border border-navy-3 p-3"><p className="text-sm font-bold text-vr-gray">Patrón / Clave</p><p className="font-mono text-sm mt-1 break-words">{error||(!view?'Cargando dato privado…':view.value===null?'No capturado en este equipo':view.value||'Sin clave indicada')}</p>{view&&view.remoteState!=='APPLIED'&&view.value!==null&&<p className="text-xs text-vr-orange mt-1">{view.remoteState==='INTERVENTION'?'Dato privado con conflicto de sincronización.':'Dato privado local; sincronización pendiente.'}</p>}</div>;
}
