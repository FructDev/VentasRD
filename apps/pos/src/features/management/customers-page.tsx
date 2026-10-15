import {useSales} from '../sales/workspace';
// Existing VentaRD Clientes & Fiados presentation, native commands only.
import {useEffect,useMemo,useState,type FormEvent} from 'react';
import {useManagement} from './workspace';import {ManagementStatus} from './status';import {ConfirmModal} from './confirm-modal';
import {showCents,inputCents,posError} from '../../platform/pos-adapter';import type {Customer,CustomerActivity} from '../../platform/management';
import Pagination from '@ventard/ui/pagination';import {SkeletonTable} from '@ventard/ui/skeleton';
const norm=(s:string|null|undefined)=>(s??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
type FiltroCliente='todos'|'deuda'|'aldia'|'mayor';type OrdenCliente='nombre'|'deuda'|'atraso';type MetodoAbono='efectivo'|'tarjeta'|'transferencia';
type ViewCustomer=Customer&{nombre:string;telefono:string|null;saldo_pendiente:string;limite_credito:string|null;tipo_precio:number;al_por_mayor:boolean};
const formatDOP=showCents,editable=(c:string)=>{const n=BigInt(c);return `${n/100n}.${(n%100n).toString().padStart(2,'0')}`;};
const families=["CUSTOMER_SAVE","CUSTOMER_DELETE","CREDIT_PAYMENT"] as const;
export function CustomersPage(){
 const s=useSales(),m=useManagement(families),ocupado=m.busy,isLoading=m.available&&!m.view;
 const [localError,setLocalError]=useState('');const showToast=(text:string)=>setLocalError(text);
 const clientesConSaldo:ViewCustomer[]=useMemo(()=>(m.view?.customers??[]).filter(c=>c.active).map(c=>({...c,nombre:c.name,telefono:c.phone,saldo_pendiente:c.balanceCents,limite_credito:c.limitCents,tipo_precio:c.priceTier,al_por_mayor:c.wholesale})),[m.view]);
 const [isModalClienteOpen,setIsModalClienteOpen]=useState(false),[clienteEditando,setClienteEditando]=useState<ViewCustomer|null>(null),[formDataCliente,setFormDataCliente]=useState({nombre:'',telefono:'',limite_credito:'0',tipo_precio:'1',al_por_mayor:false});
 const [clienteAEliminar,setClienteAEliminar]=useState<ViewCustomer|null>(null),[isModalAbonoOpen,setIsModalAbonoOpen]=useState(false),[clienteParaAbono,setClienteParaAbono]=useState<ViewCustomer|null>(null),[abonoMonto,setAbonoMonto]=useState(''),[abonoConcepto,setAbonoConcepto]=useState('Abono'),[abonoMetodo,setAbonoMetodo]=useState<MetodoAbono>('efectivo'),[abonoTurnId,setAbonoTurnId]=useState<string|null>(null);
 const [fichaCliente,setFichaCliente]=useState<ViewCustomer|null>(null),[busqueda,setBusqueda]=useState(''),[filtro,setFiltro]=useState<FiltroCliente>('todos'),[orden,setOrden]=useState<OrdenCliente>('nombre'),[pagina,setPagina]=useState(1);
 const [activity,setActivity]=useState<CustomerActivity|null>(null),[activityError,setActivityError]=useState('');
 const fichaId=fichaCliente?.id;
 useEffect(()=>{let live=true;setActivity(null);setActivityError('');if(fichaId&&s.management)void s.management.customerActivity(fichaId).then(v=>{if(live&&v.customer.id===fichaId)setActivity(v)}).catch(e=>{if(live)setActivityError(posError(e))});return()=>{live=false}},[fichaId,s.management,s.snapshot?.scopeRevision]);
 const fichaActual=activity?.customer.id===fichaId?activity:null;
 const servicesAvailable=!!fichaActual&&fichaActual.repairs!==null&&fichaActual.layaways!==null,cobrosPendientes: {id:string;nombre:string;telefono:string|null;saldo_pendiente:string;diasSinAbonar:number}[]=[];
 const totalCuentasPorCobrar=clientesConSaldo.reduce((n,c)=>n+BigInt(c.saldo_pendiente),0n).toString(),clientesConDeuda=clientesConSaldo.filter(c=>BigInt(c.saldo_pendiente)>0n).length;
 const conteos={todos:clientesConSaldo.length,deuda:clientesConDeuda,aldia:clientesConSaldo.length-clientesConDeuda,mayor:clientesConSaldo.filter(c=>c.al_por_mayor).length};
 const clientesFiltrados=clientesConSaldo.filter(c=>{if(filtro==='deuda'&&BigInt(c.saldo_pendiente)<=0n)return false;if(filtro==='aldia'&&BigInt(c.saldo_pendiente)>0n)return false;if(filtro==='mayor'&&!c.al_por_mayor)return false;return norm(c.nombre+' '+(c.telefono??'')).includes(norm(busqueda));}).sort((a,b)=>orden==='deuda'?(BigInt(b.saldo_pendiente)>BigInt(a.saldo_pendiente)?1:BigInt(b.saldo_pendiente)<BigInt(a.saldo_pendiente)?-1:a.nombre.localeCompare(b.nombre)):a.nombre.localeCompare(b.nombre,'es',{sensitivity:'base'}));
 const ITEMS_POR_PAGINA=20,totalPaginas=Math.ceil(clientesFiltrados.length/ITEMS_POR_PAGINA),currentPage=Math.min(pagina,Math.max(1,totalPaginas)),clientesPaginados=clientesFiltrados.slice((currentPage-1)*ITEMS_POR_PAGINA,currentPage*ITEMS_POR_PAGINA);
 const fichaData=fichaCliente?{totalFiado:fichaActual?.recordedCreditCents??null,reparaciones:fichaActual?.repairs,apartados:fichaActual?.layaways,movs:(fichaActual?.rows??[]).map(r=>({key:r.operationId,icono:r.kind==='SALE_CONFIRM'?'🧾':'💵',titulo:r.concept,sub:r.remoteStatus==='APPLIED'?'Confirmado':r.remoteStatus,fecha:Number(r.dateMs),monto:r.amountCents,signo:r.direction==='PAYMENT'?'out':r.direction==='CHARGE'?'in':'neutral'}))}:null;
 const abrirModalNuevoCliente=()=>{setClienteEditando(null);setFormDataCliente({nombre:'',telefono:'',limite_credito:'0',tipo_precio:'1',al_por_mayor:false});setIsModalClienteOpen(true);};
 const abrirModalEditarCliente=(c:ViewCustomer)=>{if(!m.canManage)return;setClienteEditando(c);setFormDataCliente({nombre:c.name,telefono:c.phone??'',limite_credito:editable(c.limitCents??'0'),tipo_precio:String(c.priceTier),al_por_mayor:c.wholesale});setIsModalClienteOpen(true);};
 async function guardarCliente(e:FormEvent){e.preventDefault();try{const ok=await m.execute({kind:'CUSTOMER_SAVE',operationId:crypto.randomUUID(),customerId:clienteEditando?.id??crypto.randomUUID(),expectedRevision:clienteEditando?.revision??'0',name:formDataCliente.nombre.trim(),phone:formDataCliente.telefono||null,limitCents:inputCents(formDataCliente.limite_credito),priceTier:Number(formDataCliente.tipo_precio) as 1|2|3,wholesale:formDataCliente.al_por_mayor});if(ok)setIsModalClienteOpen(false);}catch{setLocalError('Comprueba el importe del límite de crédito.');}}
 async function eliminarCliente(){if(!clienteAEliminar)return;if(await m.execute({kind:'CUSTOMER_DELETE',operationId:crypto.randomUUID(),customerId:clienteAEliminar.id,expectedRevision:clienteAEliminar.revision})){setClienteAEliminar(null);setIsModalClienteOpen(false);}}
 function abrirModalAbono(c:ViewCustomer){if(!m.view?.turn||m.view.turn.status!=='OPEN'){setLocalError('Abre una caja en esta sucursal antes de recibir el abono.');return;}setAbonoTurnId(m.view.turn.turnId);setClienteParaAbono(c);setAbonoMonto('');setAbonoMetodo('efectivo');setAbonoConcepto('Abono');setIsModalAbonoOpen(true);}
 async function registrarAbono(e:FormEvent){e.preventDefault();if(!clienteParaAbono||!abonoTurnId)return;try{const ok=await m.execute({kind:'CREDIT_PAYMENT',operationId:crypto.randomUUID(),customerId:clienteParaAbono.id,expectedRevision:clienteParaAbono.balanceRevision,amountCents:inputCents(abonoMonto),method:abonoMetodo.toUpperCase() as 'EFECTIVO'|'TARJETA'|'TRANSFERENCIA',concept:abonoConcepto,turnId:abonoTurnId});if(ok)setIsModalAbonoOpen(false);}catch{setLocalError('Comprueba el importe del abono.');}}
 async function enviarWhatsApp(id:string){if(!s.management)return;try{await s.management.contactNotice('CREDIT',id);setLocalError('');}catch(e){setLocalError(posError(e));}}
    return (
        <div className="flex-1 min-h-0 overflow-y-auto bg-navy flex flex-col">
            <div className="px-4 pt-4">{!isModalClienteOpen&&!isModalAbonoOpen&&!clienteAEliminar&&<ManagementStatus {...m}/>}{localError&&<p role="alert" className="text-vr-red">{localError}</p>}<p className="text-xs text-vr-gray">Saldo actual de la cuenta preparada. La ficha consulta la historia nativa guardada; la historia web trasladada se conserva en Historial.</p></div>

            <div className="flex-1 p-3 sm:p-6 lg:p-8">
                <div className="max-w-7xl mx-auto">
                    <div className="flex justify-between items-center mb-4 sm:mb-8">
                        <div>
                            <h1 className="text-2xl sm:text-3xl font-display font-extrabold text-white">Clientes & Fiados</h1>
                            <p className="text-vr-gray mt-0.5 text-sm hidden sm:block">Administración de cartera de crédito</p>
                        </div>
                        <button disabled={!m.available || !m.canManage || ocupado || !!m.pending} onClick={abrirModalNuevoCliente} className="px-4 sm:px-6 py-2.5 sm:py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all shadow-md text-sm sm:text-base">
                            + Nuevo
                        </button>
                    </div>

                    {/* Insights */}
                    <div className="grid grid-cols-2 gap-3 sm:gap-4 mb-4 sm:mb-8">
                        <div className="p-3 sm:p-5 rounded-2xl border border-vr-red/20 bg-vr-red/5">
                            <p className="text-xs font-bold text-vr-red uppercase tracking-wider leading-tight">Por Cobrar</p>
                            {isLoading
                                ? <div className="h-8 w-28 bg-navy-3 rounded-lg animate-pulse mt-1" />
                                : <h3 className="text-xl sm:text-3xl font-black font-mono mt-1 text-vr-red truncate">{formatDOP(totalCuentasPorCobrar)}</h3>
                            }
                        </div>
                        <div className="p-3 sm:p-5 rounded-2xl border border-navy-3 bg-navy-2">
                            <p className="text-xs font-bold text-vr-gray uppercase tracking-wider leading-tight">Con Deuda</p>
                            {isLoading
                                ? <div className="h-8 w-12 bg-navy-3 rounded-lg animate-pulse mt-1" />
                                : <h3 className="text-xl sm:text-3xl font-black font-mono mt-1 text-white">{clientesConDeuda}</h3>
                            }
                        </div>
                    </div>

                    {/* ¿A quién cobrar hoy? */}
                    {cobrosPendientes.length > 0 && (
                        <div className="bg-navy-2 rounded-2xl border border-vr-orange/20 overflow-hidden mb-4 sm:mb-6">
                            <div className="px-4 py-3 border-b border-navy-3 flex items-center justify-between">
                                <h2 className="text-sm font-display font-bold text-vr-orange">📢 ¿A quién cobrar hoy?</h2>
                                <span className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Los más atrasados primero</span>
                            </div>
                            <div className="divide-y divide-navy-3/50">
                                {cobrosPendientes.map(c => (
                                    <div key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-navy-3/20 transition-colors">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-bold text-white truncate">{c.nombre}</p>
                                            <p className="text-[11px] text-vr-gray">
                                                {c.diasSinAbonar === 0
                                                    ? 'Deuda reciente'
                                                    : <span className={c.diasSinAbonar >= 30 ? 'text-vr-red font-bold' : c.diasSinAbonar >= 14 ? 'text-vr-orange font-bold' : ''}>
                                                        {c.diasSinAbonar} día{c.diasSinAbonar === 1 ? '' : 's'} sin abonar
                                                      </span>}
                                            </p>
                                        </div>
                                        <span className="font-mono font-black text-vr-red text-sm shrink-0">{formatDOP(c.saldo_pendiente)}</span>
                                        <button
                                            onClick={() => void enviarWhatsApp(c.id)}
                                            disabled={!m.canManage||!c.telefono}
                                            title={c.telefono ? 'Enviar recordatorio por WhatsApp' : 'Sin teléfono registrado'}
                                            className="px-3 py-1.5 bg-vr-green/10 text-vr-green font-bold rounded-lg hover:bg-vr-green/20 disabled:opacity-30 text-xs border border-vr-green/20 transition-all shrink-0 whitespace-nowrap"
                                        >
                                            📱 Cobrar
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Buscador + filtros + orden */}
                    {(clientesConSaldo.length > 0 || busqueda || filtro !== 'todos') && (
                        <div className="mb-3 sm:mb-4 space-y-3">
                            <div className="relative">
                                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-vr-gray pointer-events-none">
                                    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                                </span>
                                <input
                                    type="text"
                                    inputMode="search"
                                    placeholder="Buscar por nombre o teléfono…"
                                    className="w-full bg-navy-2 border border-navy-3 rounded-xl pl-11 pr-10 py-3 text-white placeholder-vr-gray/50 focus:border-gold outline-none transition-all"
                                    value={busqueda}
                                    onChange={e => setBusqueda(e.target.value)}
                                />
                                {busqueda && (
                                    <button type="button" onClick={() => setBusqueda('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-vr-gray hover:text-white font-bold transition-colors" title="Limpiar">✕</button>
                                )}
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                                <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 pb-1 flex-1 scrollbar-none">
                                    {([
                                        { key: 'todos', label: 'Todos', n: conteos.todos },
                                        { key: 'deuda', label: 'Con deuda', n: conteos.deuda },
                                        { key: 'aldia', label: 'Al día', n: conteos.aldia },
                                        { key: 'mayor', label: 'Mayoristas', n: conteos.mayor },
                                    ] as const).filter(c => c.key === 'todos' || c.n > 0).map(({ key, label, n }) => {
                                        const activo = filtro === key;
                                        const esDeuda = key === 'deuda' && n > 0;
                                        return (
                                            <button key={key} type="button" onClick={() => setFiltro(key)}
                                                className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all border shrink-0 ${activo ? 'bg-gold/15 text-gold border-gold/40' : esDeuda ? 'bg-vr-red/10 text-vr-red border-vr-red/20 hover:border-vr-red/40' : 'bg-navy-2 text-vr-gray border-navy-3 hover:text-white'}`}>
                                                {label}<span className={`ml-1.5 ${activo ? 'text-gold/70' : 'opacity-60'}`}>{n}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                                <select value={orden} onChange={e => setOrden(e.target.value as OrdenCliente)}
                                    className="bg-navy-2 border border-navy-3 rounded-lg py-1.5 pl-2.5 pr-7 text-xs font-bold text-vr-gray focus:border-gold outline-none transition-all shrink-0 cursor-pointer" title="Ordenar">
                                    <option value="nombre">A–Z</option>
                                    <option value="deuda">Más deuda</option>

                                </select>
                            </div>
                        </div>
                    )}

                    {/* Tabla */}
                    <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                        <div className="overflow-x-auto">
                        {isLoading ? (
                            <table className="w-full">
                                <tbody><SkeletonTable rows={6} cols={5} /></tbody>
                            </table>
                        ) : (
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="border-b border-navy-3 text-vr-gray text-xs uppercase tracking-wider">
                                    <th className="p-3 sm:p-4 font-semibold">Nombre</th>
                                    <th className="p-3 sm:p-4 font-semibold hidden sm:table-cell">Teléfono</th>
                                    <th className="p-3 sm:p-4 font-semibold hidden md:table-cell">Límite</th>
                                    <th className="p-3 sm:p-4 font-semibold text-right">Saldo</th>
                                    <th className="p-3 sm:p-4 font-semibold text-center">Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {clientesConSaldo.length === 0 ? (
                                    <tr><td colSpan={5} className="p-8 text-center text-vr-gray">
                                        <span className="text-4xl block mb-3">👥</span>
                                        No hay clientes registrados.
                                    </td></tr>
                                ) : clientesFiltrados.length === 0 ? (
                                    <tr><td colSpan={5} className="p-8 text-center text-vr-gray">
                                        <span className="text-4xl block mb-3">🔍</span>
                                        No se encontraron clientes.
                                        <button type="button" onClick={() => { setBusqueda(''); setFiltro('todos'); }} className="block mx-auto mt-3 text-gold hover:text-gold-2 text-sm font-bold transition-colors">Limpiar búsqueda y filtros</button>
                                    </td></tr>
                                ) : (
                                    clientesPaginados.map((cliente) => (
                                        <tr key={cliente.id} className="border-b border-navy-3/50 hover:bg-navy-3/30 transition-colors">
                                            <td className="p-3 sm:p-4">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <button onClick={() => setFichaCliente(cliente)} className="font-bold text-white text-sm hover:text-gold transition-colors text-left" title="Ver ficha del cliente">{cliente.nombre}</button>
                                                    {cliente.al_por_mayor && (
                                                        <span className="px-1.5 py-0.5 rounded text-[10px] font-black uppercase bg-vr-green/15 text-vr-green">Mayor</span>
                                                    )}
                                                    {(cliente.tipo_precio ?? 1) > 1 && (
                                                        <span className="px-1.5 py-0.5 rounded text-[10px] font-black bg-gold/15 text-gold">P{cliente.tipo_precio}</span>
                                                    )}
                                                </div>
                                                <button disabled={!m.canManage || ocupado || !!m.pending} onClick={() => abrirModalEditarCliente(cliente)} className="text-xs text-gold hover:text-gold-2 transition-colors">Editar</button>
                                                {cliente.telefono && (
                                                    <span className="sm:hidden ml-2 text-xs text-vr-gray font-mono">{cliente.telefono}</span>
                                                )}
                                            </td>
                                            <td className="p-3 sm:p-4 text-vr-gray font-mono text-sm hidden sm:table-cell">{cliente.telefono || '-'}</td>
                                            <td className="p-3 sm:p-4 text-vr-gray font-mono text-sm hidden md:table-cell">
                                                {cliente.limite_credito !== null && BigInt(cliente.limite_credito) > 0n ? formatDOP(cliente.limite_credito!) : cliente.limite_credito === null ? 'No verificable' : 'Ilimitado'}
                                            </td>
                                            <td className="p-3 sm:p-4 text-right">
                                                <span className={`font-black font-mono text-sm ${BigInt(cliente.saldo_pendiente) > 0n ? 'text-vr-red' : 'text-vr-green'}`}>
                                                    {formatDOP(cliente.saldo_pendiente)}
                                                </span>
                                            </td>
                                            <td className="p-3 sm:p-4 text-center">
                                                <div className="flex items-center justify-center gap-1.5 sm:gap-2">
                                                    <button
                                                        onClick={() => abrirModalAbono(cliente)}
                                                        disabled={ocupado || BigInt(cliente.saldo_pendiente) <= 0n || !m.view?.turn || m.view.turn.status !== "OPEN"}
                                                        className="px-2 sm:px-3 py-1.5 bg-vr-green/10 text-vr-green font-bold rounded-lg hover:bg-vr-green/20 disabled:opacity-30 text-xs border border-vr-green/20 transition-all whitespace-nowrap"
                                                    >
                                                        + Abono
                                                    </button>
                                                    <button
                                                        onClick={() => void enviarWhatsApp(cliente.id)}
                                                        disabled={!m.canManage||!cliente.telefono||BigInt(cliente.saldo_pendiente)<=0n} title="Preparar recordatorio en WhatsApp"
                                                        className="hidden sm:inline px-3 py-1.5 bg-vr-green/10 text-vr-green font-bold rounded-lg hover:bg-vr-green/20 disabled:opacity-30 text-xs border border-vr-green/20 transition-all"
                                                    >
                                                        WhatsApp
                                                    </button>
                                                    <button
                                                        onClick={() => void enviarWhatsApp(cliente.id)}
                                                        disabled={!m.canManage||!cliente.telefono||BigInt(cliente.saldo_pendiente)<=0n} title="Preparar recordatorio en WhatsApp"
                                                        className="sm:hidden px-2 py-1.5 bg-vr-green/10 text-vr-green font-bold rounded-lg hover:bg-vr-green/20 disabled:opacity-30 text-xs border border-vr-green/20 transition-all"
                                                    >
                                                        📱
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                        )}
                        </div>
                        <Pagination
                            pagina={currentPage}
                            totalPaginas={totalPaginas}
                            onCambiar={setPagina}
                            totalItems={clientesFiltrados.length}
                            itemsPorPagina={ITEMS_POR_PAGINA}
                        />
                    </div>

                    {/* MODAL CREAR/EDITAR CLIENTE — full screen on mobile */}
                    {isModalClienteOpen && (
                        <div role="dialog" aria-modal="true" className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                            <div className="bg-navy-2 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                                <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                    <h2 className="text-xl font-display font-bold text-white">{clienteEditando ? 'Editar Cliente' : 'Nuevo Cliente'}</h2>
                                    <button onClick={() => setIsModalClienteOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                                </div>
                                <form onSubmit={e=>void guardarCliente(e)} className="p-4 sm:p-6 space-y-4"><ManagementStatus {...m} notice="" retry={async()=>{if(await m.retry()){setIsModalClienteOpen(false);setIsModalAbonoOpen(false);setClienteAEliminar(null);}}}/><fieldset disabled={ocupado || !!m.pending} className="contents">
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Nombre Completo *</label>
                                        <input aria-label="Nombre Completo" required type="text" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" value={formDataCliente.nombre} onChange={e => setFormDataCliente({ ...formDataCliente, nombre: e.target.value })} />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Teléfono (WhatsApp)</label>
                                        <input aria-label="Teléfono" type="text" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" placeholder="Ej: 8091234567" value={formDataCliente.telefono} onChange={e => setFormDataCliente({ ...formDataCliente, telefono: e.target.value })} />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Límite de Crédito (RD$)</label>
                                        <input aria-label="Límite de Crédito" type="number" step="0.01" min="0" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all font-mono" value={formDataCliente.limite_credito} onChange={e => setFormDataCliente({ ...formDataCliente, limite_credito: e.target.value })} />
                                        <p className="text-xs text-vr-gray mt-1">Deja 0 para crédito ilimitado</p>
                                    </div>

                                    {/* Precio y tipo de cliente */}
                                    <div className="p-3 bg-navy rounded-xl border border-navy-3 space-y-3">
                                        <div>
                                            <label className="block text-sm font-bold text-vr-gray mb-2">Precio asignado</label>
                                            <div className="grid grid-cols-3 gap-2">
                                                {([
                                                    { val: '1', label: 'Precio 1', sub: 'Menudeo' },
                                                    { val: '2', label: 'Precio 2', sub: 'Mayoreo' },
                                                    { val: '3', label: 'Precio 3', sub: 'Especial' },
                                                ] as const).map(({ val, label, sub }) => (
                                                    <button
                                                        key={val} type="button"
                                                        onClick={() => setFormDataCliente({ ...formDataCliente, tipo_precio: val })}
                                                        className={`py-2 px-1 rounded-xl border font-bold text-xs transition-all flex flex-col items-center gap-0.5 ${formDataCliente.tipo_precio === val ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}
                                                    >
                                                        <span>{label}</span>
                                                        <span className="font-normal opacity-70">{sub}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setFormDataCliente({ ...formDataCliente, al_por_mayor: !formDataCliente.al_por_mayor })}
                                            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition-all ${formDataCliente.al_por_mayor ? 'border-vr-green/40 bg-vr-green/10 text-vr-green' : 'border-navy-3 text-vr-gray'}`}
                                        >
                                            <span className="text-sm font-bold">Cliente al por mayor</span>
                                            <div className={`relative w-9 h-5 rounded-full transition-colors ${formDataCliente.al_por_mayor ? 'bg-vr-green' : 'bg-navy-3'}`}>
                                                <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${formDataCliente.al_por_mayor ? 'translate-x-4' : ''}`} />
                                            </div>
                                        </button>
                                    </div>

                                    <div className="flex gap-3 pt-2">
                                        <button type="button" onClick={() => setIsModalClienteOpen(false)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                                        <button type="submit" disabled={ocupado || !m.canManage} className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-50">{ocupado ? 'Guardando…' : 'Guardar'}</button>
                                    </div>

                                    {/* Eliminar — solo al editar un cliente existente */}
                                    {clienteEditando && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const conSaldo = clientesConSaldo.find(c => c.id === clienteEditando.id);
                                                if (conSaldo && BigInt(conSaldo.saldo_pendiente) > 0n) {
                                                    showToast('No puedes borrar un cliente con deuda pendiente. Registra el pago primero.');
                                                    return;
                                                }
                                                setClienteAEliminar(clienteEditando);
                                            }}
                                            className="w-full text-center text-vr-red/80 hover:text-vr-red text-sm font-bold py-2 hover:bg-vr-red/10 rounded-xl transition-all"
                                        >
                                            🗑 Eliminar cliente
                                        </button>
                                    )}
                                </fieldset></form>
                            </div>
                        </div>
                    )}

                    {/* MODAL REGISTRAR ABONO — full screen on mobile */}
                    {isModalAbonoOpen && clienteParaAbono && (
                        <div role="dialog" aria-modal="true" className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                            <div className="bg-navy-2 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                                <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                    <h2 className="text-xl font-display font-bold text-vr-green">Registrar Abono</h2>
                                    <button onClick={() => setIsModalAbonoOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                                </div>
                                <form onSubmit={e => { e.preventDefault(); void registrarAbono(e); }} className="p-4 sm:p-6 space-y-4"><ManagementStatus {...m} notice="" retry={async()=>{if(await m.retry()){setIsModalClienteOpen(false);setIsModalAbonoOpen(false);setClienteAEliminar(null);}}}/><fieldset disabled={ocupado || !!m.pending} className="contents">
                                    <div className="text-center mb-2">
                                        <p className="text-vr-gray text-sm">Deuda de {clienteParaAbono.nombre}</p>
                                        <p className="text-3xl font-black font-mono text-vr-red">{formatDOP(clienteParaAbono.saldo_pendiente)}</p>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Monto del Abono (RD$) *</label>
                                        <input aria-label="Monto del abono" required type="number" min="0.01" step="0.01" max={editable(clienteParaAbono.saldo_pendiente)} className="w-full bg-navy-3 border border-vr-green/30 rounded-xl p-3 text-white focus:border-vr-green outline-none text-xl font-bold font-mono text-center transition-all" value={abonoMonto} onChange={e => setAbonoMonto(e.target.value)} />
                                    </div>
                                    <div>
                                        <label htmlFor="metodo-abono" className="block text-sm font-bold text-vr-gray mb-1.5">Método recibido</label>
                                        <select id="metodo-abono" value={abonoMetodo} onChange={e => setAbonoMetodo(e.target.value as MetodoAbono)} className="w-full bg-navy-3 rounded-xl p-3 text-white">
                                            <option value="efectivo">Efectivo</option>
                                            <option value="tarjeta">Tarjeta</option>
                                            <option value="transferencia">Transferencia</option>
                                        </select>
                                        <p className="text-xs text-vr-gray mt-2">Quedará vinculado a la caja abierta. Solo efectivo entra en la gaveta.</p>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Concepto</label>
                                        <input type="text" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" value={abonoConcepto} onChange={e => setAbonoConcepto(e.target.value)} />
                                    </div>
                                    <div className="flex flex-col gap-2 pt-2">
                                        <button type="submit" disabled={ocupado} className="w-full py-4 bg-vr-green text-white font-extrabold rounded-xl hover:bg-vr-green/90 text-lg transition-all disabled:opacity-50">{ocupado ? 'Procesando…' : 'Confirmar Pago'}</button>
                                        <button type="button" onClick={() => setIsModalAbonoOpen(false)} className="w-full py-3 font-bold text-vr-gray hover:text-white hover:bg-navy-3 rounded-xl transition-all">Cancelar</button>
                                    </div>
                                </fieldset></form>
                            </div>
                        </div>
                    )}

                    {/* FICHA DEL CLIENTE — trazabilidad */}
                    {fichaCliente && fichaData && (
                        <div role="dialog" aria-modal="true" className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                            <div className="bg-navy-2 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden max-h-[92vh] sm:max-h-[88vh] flex flex-col animate-scale-in">
                                <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-start gap-3">
                                    <div className="min-w-0">
                                        <h2 className="text-xl font-display font-bold text-white truncate">{fichaCliente.nombre}</h2>
                                        <p className="text-sm text-vr-gray mt-0.5">{fichaCliente.telefono || 'Sin teléfono'}</p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {fichaCliente.telefono&&BigInt(fichaActual?.customer.balanceCents??fichaCliente.saldo_pendiente)>0n && (
                                            <button disabled={!m.canManage} onClick={() => void enviarWhatsApp(fichaCliente.id)} className="px-3 py-1.5 bg-vr-green/10 text-vr-green font-bold rounded-lg hover:bg-vr-green/20 text-xs border border-vr-green/20 transition-all">📱 WhatsApp</button>
                                        )}
                                        <button aria-label="Cerrar ficha" onClick={() => setFichaCliente(null)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                                    </div>
                                </div>

                                {/* Resumen */}
                                <div className="px-4 sm:px-6 pt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
                                    <div className="bg-navy p-2.5 rounded-xl border border-navy-3">
                                        <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Saldo</p>
                                        <p className={`text-sm font-black font-mono mt-0.5 ${BigInt(fichaActual?.customer.balanceCents??fichaCliente.saldo_pendiente) > 0n ? 'text-vr-red' : 'text-vr-green'}`}>{formatDOP(fichaActual?.customer.balanceCents??fichaCliente.saldo_pendiente)}</p>
                                    </div>
                                    <div className="bg-navy p-2.5 rounded-xl border border-navy-3">
                                        <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Fiado registrado</p>
                                        <p className="text-sm font-black font-mono mt-0.5 text-white">{fichaData.totalFiado===null?'…':formatDOP(fichaData.totalFiado)}</p>
                                    </div>
                                    {servicesAvailable && (
                                        <div className="bg-navy p-2.5 rounded-xl border border-navy-3">
                                            <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Reparac.</p>
                                            <p className="text-sm font-black font-mono mt-0.5 text-white">{fichaData.reparaciones}</p>
                                        </div>
                                    )}
                                    {servicesAvailable && (
                                        <div className="bg-navy p-2.5 rounded-xl border border-navy-3">
                                            <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Apartados</p>
                                            <p className="text-sm font-black font-mono mt-0.5 text-white">{fichaData.apartados}</p>
                                        </div>
                                    )}
                                </div>

                                <p className="px-4 sm:px-6 pt-3 text-xs text-vr-gray">Fiado y actividad de la historia nativa guardada en esta sucursal. El saldo actual puede incluir un saldo inicial anterior; no se calcula sumando esta lista.{fichaActual&&BigInt(fichaActual.totalRows)>BigInt(fichaActual.rows.length)&&` Se muestran ${fichaActual.rows.length} de ${fichaActual.totalRows} movimientos.`}</p>
                                {/* Movimientos del cliente */}
                                <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                                    <p className="text-xs font-bold text-vr-gray uppercase tracking-wider mb-2">Actividad</p>
                                    {activityError ? <p role="alert" className="text-sm text-vr-red">{activityError}</p> : !fichaActual ? <p role="status" className="text-sm text-vr-gray py-8">Cargando actividad del cliente…</p> : fichaData.movs.length === 0 ? (
                                        <p className="text-sm text-vr-gray text-center py-8">Sin movimientos nativos guardados para este cliente en esta sucursal.</p>
                                    ) : (
                                        <div className="space-y-1.5">
                                            {fichaData.movs.map(m => (
                                                <div key={m.key} className="flex items-center gap-3 bg-navy rounded-xl border border-navy-3 px-3 py-2.5">
                                                    <span className="text-base shrink-0">{m.icono}</span>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-bold text-white truncate">{m.titulo}</p>
                                                        <p className="text-[11px] text-vr-gray truncate">{m.sub}{m.sub ? ' · ' : ''}{new Date(m.fecha).toLocaleDateString('es-DO')}</p>
                                                    </div>
                                                    <span className={`font-mono font-black text-sm whitespace-nowrap shrink-0 ${m.signo === 'out' ? 'text-vr-green' : 'text-white'}`}>
                                                        {m.signo === 'out' ? '−' : ''}{formatDOP(m.monto)}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="p-4 sm:p-6 border-t border-navy-3 flex gap-3">
                                    <button disabled={!m.canManage || ocupado || !!m.pending} onClick={() => { abrirModalEditarCliente(fichaCliente); setFichaCliente(null); }} className="flex-1 py-3 font-bold text-gold border border-gold/30 rounded-xl hover:bg-gold/10 transition-colors">Editar</button>
                                    {BigInt(fichaActual?.customer.balanceCents??fichaCliente.saldo_pendiente) > 0n && (
                                        <button onClick={() => { abrirModalAbono(fichaCliente); setFichaCliente(null); }} className="flex-1 py-3 bg-vr-green text-white font-extrabold rounded-xl hover:bg-vr-green/90 transition-all">+ Abono</button>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Confirmación de borrado de cliente */}
                    <ConfirmModal
                        isOpen={!!clienteAEliminar}
                        title="Eliminar cliente"
                        mensaje={<>¿Eliminar a <span className="font-bold text-white">{clienteAEliminar?.nombre}</span>? Dejará de aparecer en tus listas. Su historial de ventas se conserva.</>}
                        confirmLabel="Eliminar"
                        onConfirm={eliminarCliente}
                        onClose={() => setClienteAEliminar(null)}
                    />
                </div>
            </div>
        </div>
    );
}
