import {useCallback,useEffect,useRef,useState} from 'react';
import {useSales} from '../sales/workspace';
import {posError} from '../../platform/pos-adapter';
import type {ManagementCommand,ManagementView,RepairPrivateChange} from '../../platform/management';
/** Requests live in Rust before effects. Response loss always retries the same ID. */
export function useManagement(families?:readonly string[]){
 const s=useSales(),port=s.management;
 const [view,setView]=useState<ManagementView|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[pending,setPending]=useState<ManagementCommand|null>(null);
 const intent=useRef<ManagementCommand|null>(null),gate=useRef(false);
 const reload=useCallback(async()=>{if(port)setView(await port.read());},[port]);
 useEffect(()=>{let live=true;if(port)void port.read().then(v=>{if(live){setView(v);if(!intent.current&&families){intent.current=v.pending.find(p=>families.includes(p.kind))??null;setPending(intent.current);}}}).catch(e=>{if(live)setError(posError(e));});return()=>{live=false;};},[port,s.snapshot?.scopeRevision,families]);
 async function execute(request:ManagementCommand,privateChange?:RepairPrivateChange){if(!port||gate.current)return false;if(intent.current&&intent.current.operationId!==request.operationId){setError('Recupera el intento pendiente antes de iniciar otra operación.');return false;}gate.current=true;setBusy(true);setError('');intent.current??=request;setPending(intent.current);let committed=false;try{await port.execute(intent.current,privateChange);committed=true;intent.current=null;setPending(null);setNotice('Guardado localmente · sincronización pendiente hasta recibir confirmación.');await reload();await s.refresh();if(s.synchronize)void s.synchronize();return true;}catch(e){setError(committed?'La operación está guardada. No se pudo actualizar la vista; vuelve a abrir esta sección.':posError(e));if(committed)return true;const current=await port.read().catch(()=>null);if(current){setView(current);const op=intent.current?.operationId;if(!current.pending.some(p=>p.operationId===op)&&!current.movements.some(r=>r.operationId===op))intent.current=null;}return false;}finally{setPending(intent.current);gate.current=false;setBusy(false);}}
 async function abandon(){if(!port||gate.current||!intent.current)return false;gate.current=true;setBusy(true);setError('');try{await port.abandon(intent.current.operationId);intent.current=null;setPending(null);setNotice('Intento descartado sin aplicar efectos.');await reload();return true;}catch(e){setError(posError(e));return false;}finally{gate.current=false;setBusy(false);}}
 return{view,error,busy,notice,execute,reload,abandon,canManage:view?.canManage??false,available:!!port,pending,retry:()=>intent.current?execute(intent.current):Promise.resolve(false),clearNotice:()=>setNotice('')};
}
