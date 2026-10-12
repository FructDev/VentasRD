// Presentation adapted directly from src/components/shared/CajaModal.tsx.
import {useEffect,useRef,useState,type KeyboardEvent} from 'react';
import {posError,showCents,type PosCashView} from '../../platform/pos-adapter';
import type {ManagementPort,ManagementCommand,ManagementView,Denomination,CutTicket} from '../../platform/management';
import {CutTicketDialog} from './cut-ticket-dialog';
const DENOMINACIONES=[{valor:2000,label:'RD$2,000'},{valor:1000,label:'RD$1,000'},{valor:500,label:'RD$500'},{valor:200,label:'RD$200'},{valor:100,label:'RD$100'},{valor:50,label:'RD$50'},{valor:25,label:'RD$25'},{valor:10,label:'RD$10'},{valor:5,label:'RD$5'},{valor:1,label:'RD$1'}];
const formatDOP=(n:string)=>n?showCents(n):'No verificable';
export function CashDialog({read,open,management,synchronize,onClose}:{read:()=>Promise<PosCashView>;open?:(operationId:string,openingCents:string,denominations?:Denomination[])=>Promise<PosCashView>;management?:ManagementPort;synchronize?:()=>Promise<unknown>;onClose:()=>void}){
 const ref=useRef<HTMLDivElement>(null),[view,setView]=useState<PosCashView|null>(null),[data,setData]=useState<ManagementView|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [denominaciones,setDenominaciones]=useState<Record<string,string>>({}),[notas,setNotas]=useState(''),[loading,setLoading]=useState(false),[verDetalle,setVerDetalle]=useState(false),[hasIntent,setHasIntent]=useState(false);
 const intent=useRef<ManagementCommand|{operationId:string;openingCents:string;denominations?:Denomination[]}|null>(null);
 const [ticket,setTicket]=useState<CutTicket|null>(null);
 const canManage=data?.canManage??false;
 const latestCut=data?.movements.find(r=>r.kind==='CUT_X'||r.kind==='TURN_CLOSE');
 async function showCut(){if(!management||!latestCut)return;setLoading(true);setError('');try{setTicket(await management.cutTicket(latestCut.operationId));}catch(e){setError(posError(e));}finally{setLoading(false);}}
 function closeTicket(){setTicket(null);requestAnimationFrame(()=>ref.current?.querySelector<HTMLButtonElement>('button[data-cut-preview]')?.focus());}
 const totalContado=DENOMINACIONES.reduce((n,d)=>n+BigInt(d.valor)*100n*BigInt(denominaciones[String(d.valor)]||'0'),0n).toString();
 const currentTurn=data?.turn??view?.turn;const esCierre=!!currentTurn,cajaAbierta=currentTurn?{fecha_apertura:currentTurn.openedAtMs,monto_apertura:currentTurn.openingCents}:null;
 const summary=data?.turn?.summary;
 const resumenVentas={cantidad:summary?.salesCount??'',efectivo:summary?.cashSalesCents??'',tarjeta:summary?.cardCents??'',transferencia:summary?.transferCents??'',fiado:summary?.creditCents??'',mixto:summary?.mixedCents??'',total:summary?.totalCents??'',efectivoDevuelto:'0'};
 const ventasEfectivoDesdeApertura=resumenVentas.efectivo,gastosEfectivoTurno=summary?.cashExpensesCents??'',efectivoReparacionesTurno=summary?.repairCashCents??'0',efectivoApartadosTurno=summary?.layawayCashCents??'0';
 const ingresosFiado={efectivo:summary?.cashCreditPaymentsCents??'',tarjeta:summary?.cardCreditPaymentsCents??'',transferencia:summary?.transferCreditPaymentsCents??'',total:(BigInt(summary?.cashCreditPaymentsCents??'0')+BigInt(summary?.cardCreditPaymentsCents??'0')+BigInt(summary?.transferCreditPaymentsCents??'0')).toString(),noClasificados:0};
 const abonosFiadoTurno=!!data,resultadoContexto={error:!data&&esCierre?'Resumen nativo no disponible; no se puede cerrar.':''},contexto={limites:[]};
 const montoEsperado=data?.turn?.expectedCents??'',diferencia=(BigInt(totalContado)-BigInt(montoEsperado||'0')).toString();
 const detalleEfectivo=(data?.turn?.details??[]).map(m=>({key:m.key,titulo:m.title,tipo:m.kind,fecha:m.dateMs,signo:BigInt(m.amountCents)<0n?'out':'in',monto:(BigInt(m.amountCents)<0n?-BigInt(m.amountCents):BigInt(m.amountCents)).toString()}));
 function handleDenominacion(valor:number,cantidad:string){if(cantidad&&!/^\d+$/.test(cantidad))return;const n=cantidad?BigInt(cantidad):0n;if(n>9007199254740991n)return;setDenominaciones(v=>({...v,[String(valor)]:n.toString()}));}
 const denominations=():Denomination[]=>DENOMINACIONES.filter(d=>BigInt(denominaciones[String(d.valor)]||'0')>0n).map(d=>({valueCents:(BigInt(d.valor)*100n).toString(),count:denominaciones[String(d.valor)]}));
 async function reload(){setView(await read());if(management)setData(await management.read());}
 async function resume(){if(!intent.current||loading)return;setLoading(true);setError('');try{if('openingCents' in intent.current){if(!open)return;setView(await open(intent.current.operationId,intent.current.openingCents,intent.current.denominations));}else{if(!management)return;await management.execute(intent.current);setNotice(intent.current.kind==='TURN_CLOSE'?'Cierre local guardado. Confirmando sincronización…':'Corte parcial guardado.');}intent.current=null;setHasIntent(false);await reload();if(synchronize){await synchronize();await reload();}}catch(e){setError(posError(e));await reload().catch(()=>{});}finally{setLoading(false);}}
 async function abrirCaja(){intent.current??={operationId:crypto.randomUUID(),openingCents:totalContado,denominations:denominations()};setHasIntent(true);await resume();}
 async function cut(kind:'CUT_X'|'TURN_CLOSE'){if(!data?.turn||!management)return;intent.current??={kind,operationId:crypto.randomUUID(),turnId:data.turn.turnId,countedCents:totalContado,denominations:denominations(),notes:notas};setHasIntent(true);await resume();}
 const generarCorte=()=>cut('CUT_X'),cerrarCaja=()=>cut('TURN_CLOSE');
 useEffect(()=>{let live=true;void Promise.all([read(),management?.read()]).then(([v,m])=>{if(!live)return;setView(v);setData(m??null);const pending=m?.pending.find(p=>p.kind==='TURN_CLOSE'||p.kind==='CUT_X');if(pending){intent.current=pending;setHasIntent(true);if('denominations' in pending)setDenominaciones(Object.fromEntries(pending.denominations.map(d=>[(BigInt(d.valueCents)/100n).toString(),d.count])));}else if(v.pendingOpening){intent.current=v.pendingOpening;setHasIntent(true);if(v.pendingOpening.denominations)setDenominaciones(Object.fromEntries(v.pendingOpening.denominations.map(d=>[(BigInt(d.valueCents)/100n).toString(),d.count])));setNotice('Apertura pendiente; recupera el mismo intento.');}}).catch(e=>{if(live)setError(posError(e));});return()=>{live=false;};},[read,management]);
 useEffect(()=>{const old=document.activeElement;ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();return()=>{requestAnimationFrame(()=>{const target=Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label="Caja"]')).find(b=>!b.disabled&&b.getClientRects().length>0);if(target)target.focus();else if(old instanceof HTMLElement&&old.isConnected)old.focus();});};},[]);
 function key(e:KeyboardEvent<HTMLDivElement>){if(e.key==='Escape'){e.preventDefault();onClose();}if(e.key==='Tab'){const all=ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)');if(all?.length){const first=all[0],last=all[all.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}}
 return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-center justify-center p-2 sm:p-4 animate-fade-in">
            <div ref={ref} inert={!!ticket} aria-hidden={ticket?true:undefined} onKeyDown={key} role="dialog" aria-modal="true" aria-labelledby="native-cash-title" className={`bg-navy-2 w-full ${esCierre
                ? 'max-w-5xl md:grid md:grid-cols-[minmax(15rem,0.85fr)_minmax(24rem,1.15fr)] md:grid-rows-[auto_minmax(0,1fr)_auto]'
                : 'max-w-3xl flex flex-col'
            } rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)]`}>
                {/* Header */}
                <div className="p-4 sm:px-6 sm:py-4 border-b border-navy-3 flex justify-between items-start shrink-0 gap-3 md:col-span-2 md:col-start-1 md:row-start-1">
                    <div>
                        <h2 id="native-cash-title" className="text-xl font-display font-bold text-white">
                            {esCierre ? '🔒 Cerrar Caja' : '🔓 Abrir Caja'}
                        </h2>
                        <p className="text-sm text-vr-gray mt-0.5">
                            {esCierre
                                ? `Abierta desde ${new Date(Number(cajaAbierta!.fecha_apertura)).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}`
                                : 'Cuenta el dinero para iniciar tu turno'
                            }
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {esCierre && (
                            <button
                                onClick={() => void generarCorte()}
                                disabled={loading || hasIntent || !abonosFiadoTurno || !management || !canManage || data?.turn?.status!=='OPEN'}
                                className="px-3 py-1.5 text-xs font-bold bg-navy-3 border border-navy-3 hover:border-gold/40 hover:text-gold text-vr-gray rounded-lg transition-all"
                            >
                                📊 Corte Parcial
                            </button>
                        )}
                        <button aria-label="Cerrar consulta de caja" onClick={onClose} className="text-vr-gray hover:text-white font-bold text-xl transition-colors px-1">✕</button>
                    </div>
                </div>

                <div className="px-4 text-xs text-vr-gray md:col-span-2 md:row-start-4 pb-3">{error && <p role="alert" className="text-vr-red p-2">{error}</p>}{notice && <p role="status" className="p-2">{notice}</p>}{hasIntent && <button className="text-gold py-2" disabled={loading} onClick={()=>void resume()}>Recuperar el mismo intento</button>}{latestCut&&management&&<button data-cut-preview disabled={loading||hasIntent||!canManage} onClick={()=>void showCut()} className="text-gold underline py-2">Ver ticket de corte guardado</button>}{!management && <p className="py-2">Consulta disponible. Cuadre comercial no preparado.</p>}{data?.turn?.status === 'CLOSING' && <p className="py-2 text-gold">Cierre guardado · pendiente de confirmación remota.</p>}</div>
                {/* Info panel for closing */}
                {esCierre && (
                    <div className="px-4 py-4 sm:px-5 min-h-0 space-y-3 md:col-start-1 md:row-start-2 md:overflow-y-auto md:border-r md:border-navy-3">
                        {/* Desglose de ventas del turno */}
                        {resultadoContexto?.error && (
                            <p role="alert" className="text-sm text-vr-red bg-vr-red/5 p-3 rounded-xl">{resultadoContexto.error}</p>
                        )}
                        <div className="bg-navy rounded-xl border border-navy-3 overflow-hidden">
                            <div className="px-3 py-2 border-b border-navy-3 flex justify-between items-center">
                                <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Ventas del turno</p>
                                <p className="text-xs font-bold text-vr-gray">{resumenVentas.cantidad} transacciones</p>
                            </div>
                            <div className="p-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                                {[
                                    { label: 'Efectivo',      val: resumenVentas.efectivo,      color: 'text-vr-green' },
                                    { label: 'Tarjeta',       val: resumenVentas.tarjeta,       color: 'text-blue-400' },
                                    { label: 'Transfer.',     val: resumenVentas.transferencia, color: 'text-purple-400' },
                                    { label: 'Fiado',         val: resumenVentas.fiado,         color: 'text-vr-orange' },
                                    { label: 'Mixto',         val: resumenVentas.mixto,         color: 'text-gold' },
                                ].filter(l => l.val !== '0').map(l => (
                                    <div key={l.label} className="flex justify-between gap-2">
                                        <span className="text-vr-gray">{l.label}</span>
                                        <span className={`font-mono font-bold ${l.color}`}>{formatDOP(l.val)}</span>
                                    </div>
                                ))}
                                {resumenVentas.cantidad === '0' && (
                                    <p className="col-span-2 text-vr-gray text-center py-1">Sin ventas en este turno</p>
                                )}
                            </div>
                            <div className="px-3 py-2 border-t border-navy-3 flex justify-between">
                                <span className="text-xs font-bold text-white">Total ventas</span>
                                <span className="font-mono font-black text-white text-sm">{formatDOP(resumenVentas.total)}</span>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                            <div className="bg-navy p-3 rounded-xl border border-navy-3">
                                <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Apertura</p>
                                <p className="text-lg font-black font-mono text-white">{formatDOP(cajaAbierta!.monto_apertura)}</p>
                            </div>
                            <div className="bg-navy p-3 rounded-xl border border-navy-3">
                                <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Ventas Efectivo Neto</p>
                                <p className="text-lg font-black font-mono text-vr-green">{formatDOP(ventasEfectivoDesdeApertura)}</p>
                            </div>
                            {BigInt(resumenVentas.efectivoDevuelto || '0') > 0n && (
                                <div className="bg-navy p-3 rounded-xl border border-vr-red/20">
                                    <p className="text-[10px] font-bold text-vr-red uppercase tracking-wider">Devoluciones Efectivo</p>
                                    <p className="text-lg font-black font-mono text-vr-red">- {formatDOP(resumenVentas.efectivoDevuelto)}</p>
                                </div>
                            )}
                            {BigInt(efectivoReparacionesTurno || '0') > 0n && (
                                <div className="bg-navy p-3 rounded-xl border border-navy-3">
                                    <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Reparac. Efectivo</p>
                                    <p className="text-lg font-black font-mono text-vr-green">{formatDOP(efectivoReparacionesTurno)}</p>
                                </div>
                            )}
                            {BigInt(efectivoApartadosTurno || '0') > 0n && (
                                <div className="bg-navy p-3 rounded-xl border border-navy-3">
                                    <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Apartados Efectivo</p>
                                    <p className="text-lg font-black font-mono text-vr-green">{formatDOP(efectivoApartadosTurno)}</p>
                                </div>
                            )}
                            {BigInt(gastosEfectivoTurno || '0') > 0n && (
                                <div className="bg-navy p-3 rounded-xl border border-vr-red/20">
                                    <p className="text-[10px] font-bold text-vr-red uppercase tracking-wider">Gastos Efectivo</p>
                                    <p className="text-lg font-black font-mono text-vr-red">- {formatDOP(gastosEfectivoTurno)}</p>
                                </div>
                            )}
                        </div>
                        {BigInt(ingresosFiado.total || '0') > 0n && (
                            <div className="bg-navy p-3 rounded-xl border border-vr-green/20">
                                <p className="text-xs font-bold text-vr-gray">Abonos fiado · efectivo</p>
                                <p className="text-lg font-black font-mono text-vr-green">{formatDOP(ingresosFiado.efectivo)}</p>
                                <p className="text-xs text-vr-gray">Tarjeta: {formatDOP(ingresosFiado.tarjeta)} · Transferencia: {formatDOP(ingresosFiado.transferencia)}</p>
                            </div>
                        )}
                        {ingresosFiado.noClasificados > 0 && (
                            <p role="status" className="text-xs text-gold bg-gold/5 p-3 rounded-xl">Hay {ingresosFiado.noClasificados} abono(s) sin caja, sucursal o método verificable en esta ventana. No se incluyeron en el cuadre; revisa el histórico antes de cerrar.</p>
                        )}
                        {!!contexto?.limites.length && (
                            <p role="status" className="text-xs text-gold bg-gold/5 p-3 rounded-xl">
                                El resumen incluye limitaciones históricas. Los registros legacy se atribuyen por ventana cuando falta vínculo de turno; los métodos desconocidos no se inventan. Devolver stock no prueba un reintegro bancario.
                            </p>
                        )}
                        <div className="bg-gold/5 border border-gold/15 p-3 rounded-xl flex justify-between items-center">
                            <span className="text-sm font-bold text-gold">Deberías tener:</span>
                            <span className="text-xl font-black font-mono text-gold">{formatDOP(montoEsperado)}</span>
                        </div>

                        {/* Hilo de dinero: detalle de cada movimiento de efectivo del turno */}
                        <button
                            type="button"
                            onClick={() => setVerDetalle(v => !v)}
                            className="w-full text-xs font-bold text-vr-gray hover:text-gold transition-colors text-center py-1"
                        >
                            {verDetalle ? '▲ Ocultar detalle del efectivo' : `▼ Ver detalle del efectivo (${detalleEfectivo.length})`}
                        </button>
                        {verDetalle && (
                            <div className="bg-navy rounded-xl border border-navy-3 max-h-48 overflow-y-auto divide-y divide-navy-3/50">
                                {detalleEfectivo.length === 0 ? (
                                    <p className="text-xs text-vr-gray text-center py-4">Sin movimientos de efectivo en el turno.</p>
                                ) : detalleEfectivo.map(m => (
                                    <div key={m.key} className="flex items-center gap-2 px-3 py-2">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-bold text-white truncate">{m.titulo}</p>
                                            <p className="text-[10px] text-vr-gray">{m.tipo} · {new Date(Number(m.fecha)).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}</p>
                                        </div>
                                        <span className={`font-mono font-bold text-xs shrink-0 ${m.signo === 'out' ? 'text-vr-red' : 'text-vr-green'}`}>
                                            {m.signo === 'out' ? '−' : '+'}{formatDOP(m.monto)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Denominaciones */}
                <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 md:col-start-2 md:row-start-2">
                    <div className="flex items-center justify-between gap-3 mb-3">
                        <p className="text-sm font-bold text-white uppercase tracking-wider">Conteo de denominaciones</p>
                        <span className="text-xs text-vr-gray">Billetes y monedas</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {DENOMINACIONES.map(d => (
                            <label
                                key={d.valor}
                                className="grid grid-cols-[minmax(4.5rem,1fr)_auto_minmax(6rem,1.15fr)] items-center gap-2 rounded-xl border border-navy-3 bg-navy px-3 py-2.5 focus-within:border-gold/60 focus-within:bg-gold/5 transition-colors"
                            >
                                <span className="text-base font-black text-white whitespace-nowrap">{d.label}</span>
                                <span className="text-vr-gray font-bold" aria-hidden="true">×</span>
                                <input
                                    disabled={loading || hasIntent}
                                    type="number"
                                    min="0"
                                    inputMode="numeric"
                                    aria-label={`Cantidad de ${d.label}`}
                                    className="w-full min-w-0 h-12 bg-navy-3 border border-navy-3 rounded-lg px-3 text-white font-mono font-bold text-center focus:border-gold outline-none transition-all text-lg"
                                    value={denominaciones[String(d.valor)] || ''}
                                    onChange={e => handleDenominacion(d.valor, e.target.value)}
                                    placeholder="0"
                                />
                                <span className="col-span-3 text-vr-gray text-xs font-mono text-right min-h-4">
                                    {BigInt(denominaciones[String(d.valor)] || '0') > 0n
                                        ? formatDOP((BigInt(d.valor) * 100n * BigInt(denominaciones[String(d.valor)] || '0')).toString())
                                        : '-'}
                                </span>
                            </label>
                        ))}
                    </div>

                    {esCierre && (
                        <div className="mt-4">
                            <label className="block text-xs font-bold text-vr-gray uppercase tracking-wider mb-1.5">Notas (opcional)</label>
                            <textarea
                                className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white text-sm focus:border-gold outline-none transition-all resize-none h-16"
                                placeholder="Ej: Se sacaron RD$500 para compra de suministros"
                                disabled={loading || hasIntent} value={notas} onChange={e => setNotas(e.target.value)}
                            />
                        </div>
                    )}
                </div>

                {/* Footer con total y botón */}
                <div className="p-4 sm:px-6 border-t border-navy-3 shrink-0 md:col-span-2 md:col-start-1 md:row-start-3">
                    <div className="md:flex md:items-stretch md:gap-5">
                        <div className="flex-1">
                            <div className="flex justify-between items-center mb-3 md:mb-0">
                                <span className="text-lg font-bold text-white">Total Contado</span>
                                <span className="text-3xl font-black font-mono text-gold">{formatDOP(totalContado)}</span>
                            </div>

                            {esCierre && montoEsperado !== '' && BigInt(totalContado || '0') > 0n && (
                                <div className={`mb-3 md:mt-2 md:mb-0 px-3 py-2 rounded-xl text-center font-bold text-sm ${BigInt(diferencia) === 0n ? 'bg-vr-green/10 border border-vr-green/20 text-vr-green' :
                                        BigInt(diferencia || '0') > 0n ? 'bg-gold/10 border border-gold/20 text-gold' :
                                            'bg-vr-red/10 border border-vr-red/20 text-vr-red'
                                    }`}>
                                    {BigInt(diferencia) === 0n ? '✓ Cuadre perfecto' :
                                        BigInt(diferencia || '0') > 0n ? `↑ Sobrante: ${formatDOP(diferencia)}` :
                                            `↓ Faltante: ${formatDOP((-BigInt(diferencia)).toString())}`}
                                </div>
                            )}
                        </div>

                        <button
                            onClick={() => void (esCierre ? cerrarCaja() : abrirCaja())}
                            disabled={loading || !view || (esCierre ? (!abonosFiadoTurno || !management || !canManage || data?.turn?.status !== "OPEN") : (!view.canOpen || !open))}
                            className="w-full md:w-72 md:self-stretch py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-30 text-lg"
                        >
                            {loading ? 'Procesando...' : esCierre ? '🔒 Cerrar Caja' : '🔓 Abrir Caja'}
                        </button>
                    </div>
                </div>
            </div>
            {ticket&&management&&<CutTicketDialog ticket={ticket} port={management} onClose={closeTicket}/>}
        </div>
    );
}
