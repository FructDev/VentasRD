import {useCallback,useEffect,useRef,useState} from 'react';
import {useSales} from '../sales/workspace';
import {useManagement} from '../management/workspace';
import {ManagementStatus} from '../management/status';
import {posError} from '../../platform/pos-adapter';
import type {CatalogueView} from '../../platform/management';
const families=['CATALOGUE_PUBLISH'] as const;
export function PublicCatalogueSettings(){
 const s=useSales(),m=useManagement(families),port=s.management;
 const [view,setView]=useState<CatalogueView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const gate=useRef(false);
 const load=useCallback(async()=>{if(port)setView(await port.catalogueRead())},[port]);
 useEffect(()=>{let live=true;if(port&&s.snapshot?.mode!=='recovery-readonly')void port.catalogueRead().then(v=>{if(live)setView(v)}).catch(e=>{if(live)setError(posError(e))});return()=>{live=false}},[port,s.snapshot?.scopeRevision,s.snapshot?.mode]);
 if(s.snapshot?.mode==='recovery-readonly')return null;
 const remote=view?.remote,pending=!!view?.pending.length||!!m.pending,link=remote?.enabled&&view?.webOrigin?view.webOrigin+remote.publicPath:null;
 async function refresh(){if(gate.current)return;gate.current=true;setBusy(true);setError('');try{await load()}catch(e){setError(posError(e))}finally{setBusy(false);gate.current=false}}
 async function toggle(){if(!remote||gate.current||pending)return;gate.current=true;setBusy(true);setError('');setNotice('');try{if(await m.execute({kind:'CATALOGUE_PUBLISH',operationId:crypto.randomUUID(),expectedRevision:remote.revision,expectedEnabled:remote.enabled,enabled:!remote.enabled})){setNotice('Cambio guardado. Publicación pendiente de confirmación del servidor.');await load()}}catch(e){setError(posError(e))}finally{gate.current=false;setBusy(false)}}
 async function open(share:boolean){if(!port||busy)return;setBusy(true);setError('');try{await port.catalogueOpen(share);setNotice(share?'Borrador de WhatsApp abierto. Revisa y envía desde WhatsApp.':'Catálogo abierto en el navegador.')}catch(e){setError(posError(e))}finally{setBusy(false)}}
 return <section className="bg-navy-2 rounded-2xl border border-navy-3 p-4 sm:p-8">
  <h3 className="text-lg font-bold text-vr-green mb-2 border-b border-navy-3 pb-2">🛍️ Catálogo Público</h3>
  <p className="text-xs text-vr-gray mb-4">Comparte un link con tus productos y precios. Tus clientes arman su pedido y te llega por WhatsApp. No muestra costos ni existencias.</p>
  <ManagementStatus {...m} notice={pending?m.notice:''}/>
  <button type="button" role="switch" aria-checked={remote?.enabled??false} aria-label="Activar catálogo público" disabled={!remote||pending||busy||m.busy||!m.canManage} onClick={()=>void toggle()} className="w-full flex items-center justify-between gap-4 py-3 disabled:opacity-50 text-left">
   <span><span className="font-bold text-white text-sm">Activar catálogo público</span><span className="block text-xs text-vr-gray">Cualquiera con el link podrá ver tus productos.</span></span>
   <span className={'w-12 h-7 rounded-full p-1 shrink-0 '+(remote?.enabled?'bg-vr-green':'bg-navy-3')}><span className={'block w-5 h-5 rounded-full bg-white transition-transform '+(remote?.enabled?'translate-x-5':'')}/></span>
  </button>
  <p role="status" className="text-xs text-vr-gray mt-2">{pending?'Hay un cambio pendiente. Sincroniza y actualiza para comprobar su resultado.':remote?`Última consulta al servidor: catálogo ${remote.enabled?'activado':'desactivado'}.`:'Estado actual sin verificar. Inicia sesión online y actualiza.'}</p>
  {!remote&&view?.lastConfirmed&&<p className="text-xs text-vr-gray mt-2">Última confirmación nativa guardada: {view.lastConfirmed.enabled?'activado':'desactivado'}. Puede haber cambiado en otro equipo.</p>}
  {view&&!view.webOrigin&&<p className="text-xs text-vr-orange mt-3">Dirección web pendiente de configurar. Staging todavía no tiene una web desplegada para abrir o compartir el catálogo.</p>}
  {link&&!pending&&<div className="mt-4 grid gap-3"><input aria-label="Enlace del catálogo" readOnly value={link} className="min-w-0 w-full bg-navy border border-navy-3 rounded-xl p-3 text-sm text-white"/><div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={()=>void navigator.clipboard.writeText(link).then(()=>setNotice('Enlace copiado.')).catch(()=>setError('No se pudo copiar el enlace.'))} className="px-4 py-2 bg-navy-3 rounded-xl text-sm text-white">Copiar</button><button type="button" disabled={busy} onClick={()=>void open(false)} className="px-4 py-2 bg-navy-3 rounded-xl text-sm text-white">Ver catálogo</button><button type="button" disabled={busy} onClick={()=>void open(true)} className="px-4 py-2 bg-vr-green/10 border border-vr-green/30 rounded-xl text-sm text-vr-green">Compartir por WhatsApp</button></div></div>}
  {view?.remoteError&&<p className="text-sm text-vr-orange mt-3">{posError({code:view.remoteError})}</p>}{error&&<p role="alert" className="text-sm text-vr-red mt-3">{error}</p>}{notice&&<p className="text-sm text-vr-gray mt-3">{notice}</p>}
  <div className="flex gap-3 mt-4"><button type="button" disabled={busy} onClick={()=>void refresh()} className="px-4 py-2 border border-navy-3 rounded-xl text-sm text-gold">{busy?'Consultando…':'Actualizar catálogo'}</button>{pending&&s.synchronize&&<button type="button" disabled={busy} onClick={()=>void s.synchronize?.().then(load).catch(e=>setError(posError(e)))} className="px-4 py-2 border border-gold rounded-xl text-sm text-gold">Sincronizar cambio</button>}</div>
 </section>
}
