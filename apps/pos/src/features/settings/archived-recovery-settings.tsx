import {useEffect,useState} from 'react';
import {backupPort,accessMessage} from '../../platform/access';
export function ArchivedRecoverySettings(){
 const [rows,setRows]=useState<{recoveryId:string;backupId:string;capturedAtMs:string}[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let live=true;void backupPort.recoveryArchivedList().then(v=>{if(live)setRows(v.rows)}).catch(e=>{if(live)setError(accessMessage(e))});return()=>{live=false}},[]);
 if(!rows.length&&!error)return null;
 return <div className="mt-5 border-t border-navy-3 pt-4"><h4 className="font-bold text-gold">Respaldos anteriores conservados</h4><p className="text-xs text-vr-gray mt-2">Estas copias están incluidas en el respaldo abierto. Permiten consultar historia anterior sin activar sus escritores.</p>{error&&<p role="alert" className="text-vr-red text-sm mt-2">{error}</p>}<div className="flex flex-wrap gap-2 mt-3">{rows.map(r=><button type="button" key={r.recoveryId} disabled={busy} className="px-4 py-2.5 bg-navy-3 border border-navy-3 text-gold rounded-xl text-sm disabled:opacity-40" onClick={()=>void(async()=>{if(busy)return;setBusy(true);setError('');try{await backupPort.recoveryOpenNested(r.recoveryId);window.location.hash='#/historial';window.location.reload()}catch(e){setError(accessMessage(e));setBusy(false)}})()}>Consultar respaldo anterior {r.backupId.slice(-8)}</button>)}</div></div>
}
