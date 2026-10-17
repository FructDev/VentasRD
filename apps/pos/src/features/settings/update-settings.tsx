import {useEffect,useRef,useState} from 'react';
import {updatePort,updateMessage,type UpdateView} from '../../platform/updates';
import {ConfirmModal} from '../management/confirm-modal';
export function UpdateSettings(){
 const [view,setView]=useState<UpdateView|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false);const gate=useRef(false);
 useEffect(()=>{let active=true;void updatePort.status().then(v=>{if(active)setView(v)}).catch(e=>{if(active)setError(updateMessage(e))});return()=>{active=false}},[]);
 async function run(install=false){if(gate.current)return;gate.current=true;setBusy(true);setError('');try{setView(install&&view?.version?await updatePort.install(view.version):await updatePort.check());setConfirm(false)}catch(e){setError(updateMessage(e))}finally{gate.current=false;setBusy(false)}}
 return <section className="bg-navy-2 rounded-xl p-5 border border-navy-3"><h2 className="font-display font-bold text-white text-lg">Actualización de VentaRD</h2>
  {view&&<p className="text-vr-gray mt-2 text-sm">Versión instalada: {view.currentVersion}</p>}
  {view?.status==='NOT_CONFIGURED'?<p className="text-vr-gray mt-3 text-sm">Las actualizaciones para esta instalación todavía no están publicadas.</p>:view&&<>
   {view.status==='UP_TO_DATE'&&<p role="status" className="text-vr-green mt-3 text-sm">Ya tienes la versión disponible más reciente.</p>}
   {view.status==='INSTALLING'&&<p role="status" className="text-gold mt-3 text-sm">Instalando actualización. VentaRD se cerrará para completar la instalación.</p>}
   {view.status==='AVAILABLE'&&<div className="mt-3"><p className="text-gold font-bold">Versión {view.version} disponible</p>{view.notes&&<p className="text-vr-gray text-sm whitespace-pre-wrap mt-2">{view.notes}</p>}<button disabled={busy} onClick={()=>setConfirm(true)} className="bg-gold text-navy font-bold px-4 py-3 rounded-xl mt-3">Actualizar VentaRD</button></div>}
   {view.status!=='INSTALLING'&&<button disabled={busy} onClick={()=>void run()} className="text-gold font-bold text-sm mt-4 disabled:opacity-50">{busy?'Comprobando…':'Buscar actualizaciones'}</button>}
  </>}
  {error&&<p role="alert" className="text-vr-red text-sm mt-3">{error}</p>}
  <ConfirmModal isOpen={confirm} title="Actualizar VentaRD" mensaje={<>Se verificará la descarga y se cerrará VentaRD para instalar la versión {view?.version}. Tus datos se conservan. Termina el carrito y sincroniza los pendientes antes de continuar.</>} confirmLabel={busy?'Instalando…':'Instalar actualización'} busy={busy} onConfirm={()=>void run(true)} onClose={()=>{if(!busy)setConfirm(false)}}/>
 </section>;
}
