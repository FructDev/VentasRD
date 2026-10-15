import {useEffect,useRef,useState} from 'react';
import {accessMessage,backupPort,type BaselineDecision,type TransitionDifferences,type TransitionReport} from '../../platform/access';
const button='px-4 py-3 bg-navy-3 border border-navy-3 hover:border-gold/40 text-vr-gray hover:text-gold font-bold rounded-xl text-sm disabled:opacity-40';

export function BaselineReview({report,disabled,onReport}:{report:TransitionReport;disabled:boolean;onReport:(report:TransitionReport)=>void}){
 const[data,setData]=useState<TransitionDifferences|null>(null),[page,setPage]=useState(0),[reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[pendingDecision,setPendingDecision]=useState(false),[error,setError]=useState('');
 const gate=useRef(false),attempt=useRef<BaselineDecision|null>(null),live=useRef(true);
 useEffect(()=>{live.current=true;let current=true;if(report.cloudCoverage==='SCOPE_COMPLETE_SINGLE_SNAPSHOT')void backupPort.transitionDifferences(report.runId,page).then(v=>{if(current)setData(v)}).catch(e=>{if(current)setError(accessMessage(e))});return()=>{current=false;live.current=false}},[report.runId,report.cloudCoverage,page]);
 async function save(){
  if(gate.current||!data)return;gate.current=true;setBusy(true);setError('');
  setPendingDecision(true);attempt.current??={runId:report.runId,revision:report.revision,differenceHash:data.differenceHash,reason:reason.trim().replace(/[\r\n\t]+/g,' '),confirmation:'USE_CLOUD_BASELINE_PRESERVE_HISTORY'};
  try{const next=await backupPort.transitionBaselineReview(attempt.current);if(live.current)onReport(next)}catch(e){if(live.current)setError(accessMessage(e))}finally{gate.current=false;if(live.current)setBusy(false)}
 }
 if(report.cloudCoverage!=='SCOPE_COMPLETE_SINGLE_SNAPSHOT')return null;
 return <div className="mt-4 p-4 rounded-xl bg-navy border border-navy-3">
  <h5 className="font-bold text-gold">Diferencias entre las copias y la nube</h5>
  {error&&<p role="alert" className="text-sm text-vr-red mt-2">{error}</p>}
  {!data?<p className="text-sm text-vr-gray mt-2">Consultando las fuentes conservadas…</p>:!data.total?<p className="text-sm text-vr-green mt-2">Las versiones elegidas coinciden con la captura de nube.</p>:<>
   <p className="text-sm text-vr-gray mt-2">{data.total} registros diferentes · {Object.entries(data.counts).map(([table,count])=>`${table}: ${count}`).join(' · ')}</p>
   <p className="text-xs text-vr-gray mt-2">El historial y todas las copias se conservan. Si eliges la nube, sólo sus saldos, existencias y documentos serán la base operativa. Los datos exclusivos del navegador siguen en consulta y sus pendientes no se envían ni se marcan como aplicados. Si falta un cobro, deuda o ajuste real en la nube, concílialo antes de elegir esta opción.</p>
   <div className="space-y-2 mt-3">{data.page===page&&data.rows.map(row=><details key={row.table+':'+row.id} className="p-3 bg-navy-2 rounded-xl"><summary className="text-sm break-all cursor-pointer">{row.table} · {row.id}</summary><div className="grid sm:grid-cols-2 gap-3 mt-3">{(['preserved','cloud'] as const).map(side=><div key={side} className="min-w-0"><p className="font-bold text-xs">{side==='cloud'?'Nube · base operativa propuesta':'Historial combinado · se conserva'}</p>{row[side]===null?<p className="text-xs text-vr-orange mt-2">No existe en esta versión.</p>:<pre className="text-xs whitespace-pre-wrap break-all mt-2">{JSON.stringify(row[side],null,2)}</pre>}</div>)}</div></details>)}</div>
   <div className="flex items-center flex-wrap gap-3 mt-3"><button type="button" className={button} disabled={busy||page===0} onClick={()=>setPage(p=>p-1)}>Diferencias anteriores</button><span className="text-xs text-vr-gray">Página {page+1} de {Math.ceil(data.total/10)}</span><button type="button" className={button} disabled={busy||(page+1)*10>=data.total} onClick={()=>setPage(p=>p+1)}>Más diferencias</button></div>
   {data.reviewed?<div><p role="status" className="text-sm text-vr-green mt-3">Base de nube elegida y decisión guardada. Crea un respaldo nuevo de esta revisión antes del corte.</p>{data.decision&&<p className="text-xs text-vr-gray break-all mt-2">Motivo guardado: {data.decision.reason}</p>}</div>:<div className="space-y-3 mt-4">
    <label className="block text-sm">Motivo de la decisión sobre la base operativa<textarea aria-label="Motivo de la base operativa" className="w-full bg-navy-3 rounded-xl p-3 mt-2" maxLength={500} value={reason} disabled={busy||disabled||pendingDecision} onChange={e=>setReason(e.target.value)}/></label>
    <label className="flex gap-2 items-start text-sm"><input type="checkbox" checked={confirmed} disabled={busy||disabled||pendingDecision} onChange={e=>setConfirmed(e.target.checked)}/>He revisado los {data.total} registros diferentes y los saldos y existencias actuales. Elijo la nube como base operativa y conservar las diferencias sólo como historial, sin aplicar sus efectos.</label>
    <p className="text-xs text-vr-gray">Esto guarda la revisión; no activa el negocio ni omite errores, cajas abiertas o servicios activos con versiones distintas.</p>
    <button type="button" className={button} disabled={busy||disabled||!report.historyPublished||report.conflicts>0||!confirmed||reason.trim().length<10} onClick={()=>void save()}>{pendingDecision?'Recuperar decisión de base operativa':'Guardar decisión de base operativa'}</button>
    {!report.historyPublished&&<p className="text-xs text-vr-orange">Primero resuelve los conflictos e incorpora el historial para consulta.</p>}
   </div>}
  </>}
 </div>;
}
