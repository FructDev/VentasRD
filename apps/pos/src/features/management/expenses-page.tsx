// VentaRD Gastos layout, with transactions and original turn supplied by Rust.
import {useState} from 'react';import {useManagement} from './workspace';import {ManagementStatus} from './status';import {showCents,inputCents} from '../../platform/pos-adapter';
type Periodo='hoy'|'7d'|'mes';type GastoCategoria='mercancia'|'servicios'|'alquiler'|'sueldos'|'transporte'|'otro';
const CATEGORIAS=[{key:'mercancia',label:'Mercancía',icon:'🛒'},{key:'servicios',label:'Servicios',icon:'💡'},{key:'alquiler',label:'Alquiler',icon:'🏠'},{key:'sueldos',label:'Sueldos',icon:'👷'},{key:'transporte',label:'Transporte',icon:'🚚'},{key:'otro',label:'Otro',icon:'📦'}] as const;
const CAT_MAP=Object.fromEntries(CATEGORIAS.map(c=>[c.key,c]));const formatDOP=showCents;
const families=["EXPENSE_RECORD","CASH_ENTRY"] as const;
export function ExpensesPage(){const m=useManagement(families);const [periodo,setPeriodo]=useState<Periodo>('mes'),[isModalOpen,setIsModalOpen]=useState(false),[localError,setLocalError]=useState(''),[originalTurn,setOriginalTurn]=useState<string|null>(null),[form,setForm]=useState({monto:'',categoria:'mercancia' as GastoCategoria,descripcion:'',metodo:'efectivo' as 'efectivo'|'tarjeta'|'transferencia'});const guardando=m.busy;
 const now=new Date(),from=new Date(now.getFullYear(),now.getMonth(),periodo==='mes'?1:now.getDate()-(periodo==='7d'?6:0)).getTime(),to=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1).getTime();
 const gastos=(m.view?.movements??[]).filter(r=>r.kind==='EXPENSE_RECORD'&&Number(r.createdAtMs)>=from&&Number(r.createdAtMs)<to).map(r=>({id:r.operationId,descripcion:r.concept,monto:r.amountCents,fecha_creacion:Number(r.createdAtMs),categoria:(r.document.category??'otro') as GastoCategoria,metodo:(r.method??'').toLowerCase(),creado_por:null,remoteStatus:r.remoteStatus}));
 const totalPeriodo=gastos.reduce((n,g)=>n+BigInt(g.monto),0n).toString(),mapa=new Map<string,bigint>();for(const g of gastos)mapa.set(g.categoria,(mapa.get(g.categoria)??0n)+BigInt(g.monto));const porCategoria=[...mapa].map(([cat,total])=>({cat:cat as GastoCategoria,total:total.toString()}));const gastosOrdenados=gastos;
 const abrirModal=()=>{setForm({monto:'',categoria:'mercancia',descripcion:'',metodo:'efectivo'});setOriginalTurn(m.view?.turn?.turnId??null);setIsModalOpen(true);};
 const formatFecha=(ms:number)=>new Date(ms).toLocaleString('es-DO',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
 async function guardarGasto(e:React.FormEvent){e.preventDefault();if(!originalTurn)return;try{if(await m.execute({kind:'EXPENSE_RECORD',operationId:crypto.randomUUID(),turnId:originalTurn,amountCents:inputCents(form.monto),method:form.metodo.toUpperCase() as 'EFECTIVO'|'TARJETA'|'TRANSFERENCIA',concept:form.descripcion.trim(),category:form.categoria}))setIsModalOpen(false);}catch{setLocalError('Comprueba el importe del gasto.');}}
    return (
        <>
            <div className="flex-1 min-h-0 overflow-y-auto bg-navy flex flex-col">
                <div className="px-4 pt-4">{!isModalOpen&&<ManagementStatus {...m}/>}{localError&&<p role="alert" className="text-vr-red">{localError}</p>}</div>
                {m.view&&m.view.movements.length>=m.view.movementLimit&&<p className="px-4 pt-2 text-xs text-vr-orange">Esta vista muestra los últimos {m.view.movementLimit} movimientos. Consulta Reportes para el total nativo del período.</p>}

                <div className="flex-1 p-3 sm:p-6 lg:p-8">
                    <div className="max-w-4xl mx-auto">

                        {/* Header */}
                        <div className="flex justify-between items-center mb-4 sm:mb-6 gap-3">
                            <div>
                                <h1 className="text-2xl sm:text-3xl font-display font-extrabold text-white">Gastos</h1>
                                <p className="text-vr-gray mt-0.5 text-sm hidden sm:block">Registra las salidas de dinero para conocer tu ganancia real</p>
                            </div>
                            <button disabled={!m.canManage || !m.view?.turn || m.view.turn.status!=="OPEN"} onClick={abrirModal} className="px-4 sm:px-6 py-2.5 sm:py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all shadow-md text-sm sm:text-base whitespace-nowrap">
                                + Gasto
                            </button>
                        </div>

                        {/* Selector de período */}
                        <div className="flex bg-navy-2 border border-navy-3 rounded-xl p-1 gap-1 w-fit mb-4 sm:mb-6">
                            {([
                                { key: 'hoy', label: 'Hoy' },
                                { key: '7d', label: '7 días' },
                                { key: 'mes', label: 'Este mes' },
                            ] as const).map(p => (
                                <button
                                    key={p.key}
                                    onClick={() => setPeriodo(p.key)}
                                    className={`px-3 sm:px-4 py-1.5 rounded-lg text-sm font-bold transition-all ${periodo === p.key ? 'bg-gold text-navy' : 'text-vr-gray hover:text-white'}`}
                                >
                                    {p.label}
                                </button>
                            ))}
                        </div>

                        {/* Total + desglose por categoría */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-4 sm:mb-6">
                            <div className="p-4 sm:p-5 rounded-2xl border border-vr-red/20 bg-vr-red/5">
                                <p className="text-xs font-bold text-vr-red uppercase tracking-wider">Total Gastado</p>
                                <h3 className="text-2xl sm:text-3xl font-black font-mono mt-1 text-vr-red truncate">{formatDOP(totalPeriodo)}</h3>
                                <p className="text-xs text-vr-gray mt-1">{gastos.length} gasto{gastos.length === 1 ? '' : 's'}</p>
                            </div>
                            <div className="sm:col-span-2 p-4 sm:p-5 rounded-2xl border border-navy-3 bg-navy-2">
                                <p className="text-xs font-bold text-vr-gray uppercase tracking-wider mb-2">Por Categoría</p>
                                {porCategoria.length === 0 ? (
                                    <p className="text-vr-gray text-sm">Sin gastos en este período</p>
                                ) : (
                                    <div className="flex flex-wrap gap-2">
                                        {porCategoria.map(({ cat, total }) => (
                                            <div key={cat} className="flex items-center gap-1.5 bg-navy-3/60 rounded-lg px-2.5 py-1.5">
                                                <span className="text-sm">{CAT_MAP[cat]?.icon}</span>
                                                <span className="text-xs text-vr-gray font-bold">{CAT_MAP[cat]?.label}</span>
                                                <span className="text-xs font-mono font-black text-white">{formatDOP(total)}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Lista */}
                        <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                            {gastosOrdenados.length === 0 ? (
                                <div className="py-16 text-center text-vr-gray">
                                    <span className="text-4xl block mb-3">💸</span>
                                    <p className="font-medium text-sm">Sin gastos registrados en este período</p>
                                    <p className="text-xs mt-1">Registra compras de mercancía, luz, alquiler… para ver tu ganancia real</p>
                                </div>
                            ) : (
                                <div className="divide-y divide-navy-3/50">
                                    {gastosOrdenados.map(g => (
                                        <div key={g.id} className="flex items-center gap-3 p-3 sm:p-4 hover:bg-navy-3/20 transition-colors">
                                            <span className="text-xl shrink-0">{CAT_MAP[g.categoria]?.icon ?? '📦'}</span>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-bold text-white truncate">{g.descripcion}</p>
                                                <p className="text-[11px] text-vr-gray">
                                                    {formatFecha(g.fecha_creacion)} · {CAT_MAP[g.categoria]?.label}
                                                    {g.metodo !== 'efectivo' && ` · ${g.metodo}`}
                                                    {g.creado_por && ` · ${g.creado_por}`}
                                                </p>
                                            </div>
                                            <span className="font-mono font-black text-vr-red text-sm shrink-0">- {formatDOP(g.monto)}</span>
                                            <button
                                                disabled
                                                className="text-vr-gray hover:text-vr-red font-bold px-2 py-1 rounded-lg hover:bg-vr-red/10 transition-all shrink-0"
                                                title="Reverso de gastos nativo pendiente; se conserva el movimiento original"
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* MODAL NUEVO GASTO — bottom sheet en móvil */}
                {isModalOpen && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                        <div className="bg-navy-2 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                            <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                <h2 className="text-xl font-display font-bold text-white">Nuevo Gasto</h2>
                                <button onClick={() => setIsModalOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                            </div>
                            <form onSubmit={e=>void guardarGasto(e)} className="p-4 sm:p-6 space-y-4"><ManagementStatus {...m} notice="" retry={async()=>{if(await m.retry())setIsModalOpen(false);}}/><fieldset disabled={guardando || !!m.pending} className="contents">
                                {/* Monto grande, protagonista */}
                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">¿Cuánto gastaste? (RD$) *</label>
                                    <input
                                        aria-label="Monto del gasto" required type="number" step="0.01" min="0.01" autoFocus
                                        placeholder="0.00"
                                        className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono font-black text-2xl text-center focus:border-gold outline-none transition-all"
                                        value={form.monto}
                                        onChange={e => setForm({ ...form, monto: e.target.value })}
                                    />
                                </div>

                                {/* Categoría */}
                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-2">¿En qué?</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {CATEGORIAS.map(c => (
                                            <button
                                                key={c.key} type="button"
                                                onClick={() => setForm({ ...form, categoria: c.key })}
                                                className={`py-2.5 px-1 rounded-xl border font-bold text-xs transition-all flex flex-col items-center gap-1 ${form.categoria === c.key ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}
                                            >
                                                <span className="text-base">{c.icon}</span>
                                                <span>{c.label}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Descripción */}
                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">Descripción *</label>
                                    <input
                                        aria-label="Descripción del gasto" required type="text"
                                        placeholder='Ej: "Compra de refrescos al suplidor"'
                                        className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all"
                                        value={form.descripcion}
                                        onChange={e => setForm({ ...form, descripcion: e.target.value })}
                                    />
                                </div>

                                {/* Método */}
                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-2">¿Cómo pagaste?</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {([
                                            { key: 'efectivo', label: 'Efectivo' },
                                            { key: 'transferencia', label: 'Transfer.' },
                                            { key: 'tarjeta', label: 'Tarjeta' },
                                        ] as const).map(m => (
                                            <button
                                                key={m.key} type="button"
                                                onClick={() => setForm({ ...form, metodo: m.key })}
                                                className={`py-2.5 rounded-xl border font-bold text-xs sm:text-sm transition-all ${form.metodo === m.key ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}
                                            >
                                                {m.label}
                                            </button>
                                        ))}
                                    </div>
                                    {form.metodo === 'efectivo' && (
                                        <p className="text-[11px] text-vr-gray mt-1.5">Los gastos en efectivo se descuentan del cuadre de caja automáticamente.</p>
                                    )}
                                </div>

                                <div className="flex gap-3 pt-2">
                                    <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                                    <button type="submit" disabled={guardando} className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-50">
                                        {guardando ? 'Guardando…' : 'Registrar'}
                                    </button>
                                </div>
                            </fieldset></form>
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
