// src/app/clientes/page.tsx
'use client';

import { useMemo, useState } from 'react';
import { db } from '@/lib/db/dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { useClientesTenant, useTransaccionesFiadoTenant } from '@/lib/db/tenantQuery';
import { useConfigStore } from '@/store/useConfigStore';
import { ClienteLocal } from '@/types/database';
import { formatDOP } from '@/lib/utils';
import { v4 as uuidv4 } from 'uuid';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';
import Pagination from '@/components/ui/Pagination';
import { SkeletonTable } from '@/components/ui/Skeleton';
import ConfirmModal from '@/components/ui/ConfirmModal';

export default function ClientesPage() {
    const { negocioId, showToast, negocioNombre, planTier } = useConfigStore();
    const clientes = useClientesTenant();
    const transacciones = useTransaccionesFiadoTenant();
    const esPro = planTier === 'pro';

    // Fuentes Pro para la ficha del cliente
    const reparacionesAll = useLiveQuery(
        () => (esPro && negocioId) ? db.reparaciones.where('negocio_id').equals(negocioId).toArray() : [],
        [esPro, negocioId]
    );
    const apartadosAll = useLiveQuery(
        () => (esPro && negocioId) ? db.apartados.where('negocio_id').equals(negocioId).toArray() : [],
        [esPro, negocioId]
    );

    const clientesRaw = useLiveQuery(
        () => negocioId ? db.clientes.where('negocio_id').equals(negocioId).limit(1).toArray() : [],
        [negocioId]
    );
    const isLoading = clientesRaw === undefined;

    const clientesConSaldo = useMemo(() => {
        return clientes.map(cliente => {
            const txsCliente = transacciones.filter(t => t.cliente_id === cliente.id);
            const totalCargos = txsCliente.filter(t => t.tipo === 'cargo').reduce((acc, t) => acc + t.monto, 0);
            const totalAbonos = txsCliente.filter(t => t.tipo === 'abono').reduce((acc, t) => acc + t.monto, 0);
            return { ...cliente, saldo_pendiente: totalCargos - totalAbonos };
        });
    }, [clientes, transacciones]);

    const [isModalClienteOpen, setIsModalClienteOpen] = useState(false);
    const [clienteEditando, setClienteEditando] = useState<ClienteLocal | null>(null);
    const [formDataCliente, setFormDataCliente] = useState({ nombre: '', telefono: '', limite_credito: '', tipo_precio: '1', al_por_mayor: false });

    const [clienteAEliminar, setClienteAEliminar] = useState<ClienteLocal | null>(null);
    const [isModalAbonoOpen, setIsModalAbonoOpen] = useState(false);

    // Ficha de cliente (trazabilidad)
    const [fichaCliente, setFichaCliente] = useState<(ClienteLocal & { saldo_pendiente: number }) | null>(null);
    const fichaData = useMemo(() => {
        if (!fichaCliente) return null;
        const reps = (reparacionesAll ?? []).filter(r => r.cliente_id === fichaCliente.id);
        const aps = (apartadosAll ?? []).filter(a => a.cliente_id === fichaCliente.id);
        const txs = transacciones.filter(t => t.cliente_id === fichaCliente.id);
        const cargos = txs.filter(t => t.tipo === 'cargo').reduce((s, t) => s + t.monto, 0);

        type FM = { key: string; icono: string; titulo: string; sub: string; fecha: number; monto: number; signo: 'in' | 'out' };
        const movs: FM[] = [];
        txs.forEach(t => movs.push({
            key: `t-${t.id}`, icono: t.tipo === 'abono' ? '💵' : '🧾',
            titulo: t.tipo === 'abono' ? 'Abono' : 'Compra a crédito', sub: t.concepto || '',
            fecha: t.fecha_creacion, monto: t.monto, signo: t.tipo === 'abono' ? 'out' : 'in',
        }));
        reps.forEach(r => movs.push({
            key: `r-${r.id}`, icono: '🔧', titulo: `${r.folio} · ${[r.equipo_marca, r.equipo_modelo].filter(Boolean).join(' ')}`,
            sub: `Reparación · ${r.estado}`, fecha: r.fecha_creacion, monto: r.total, signo: 'in',
        }));
        aps.forEach(a => movs.push({
            key: `a-${a.id}`, icono: '🔖', titulo: `${a.folio} · ${a.items.map(i => i.nombre).join(', ')}`,
            sub: `Apartado · ${a.estado} · abonado ${formatDOP(a.abonado)}`, fecha: a.fecha_creacion, monto: a.total, signo: 'in',
        }));
        movs.sort((x, y) => y.fecha - x.fecha);

        return {
            movs,
            totalFiado: cargos,
            reparaciones: reps.length,
            apartados: aps.length,
            comprado: cargos + reps.reduce((s, r) => s + r.total, 0) + aps.reduce((s, a) => s + a.abonado, 0),
        };
    }, [fichaCliente, reparacionesAll, apartadosAll, transacciones]);

    const eliminarCliente = async () => {
        if (!clienteAEliminar) return;
        // Borrado suave: se oculta y se sincroniza; conserva el historial
        await db.clientes.update(clienteAEliminar.id, {
            eliminado: true, estado_sincronizacion: 0, fecha_actualizacion: Date.now(),
        });
        setClienteAEliminar(null);
        setIsModalClienteOpen(false);
        showToast('Cliente eliminado.', 'info');
    };
    const [clienteParaAbono, setClienteParaAbono] = useState<any>(null);
    const [abonoMonto, setAbonoMonto] = useState('');
    const [abonoConcepto, setAbonoConcepto] = useState('Abono en efectivo');

    const abrirModalNuevoCliente = () => {
        setClienteEditando(null);
        setFormDataCliente({ nombre: '', telefono: '', limite_credito: '0', tipo_precio: '1', al_por_mayor: false });
        setIsModalClienteOpen(true);
    };

    const abrirModalEditarCliente = (cliente: ClienteLocal) => {
        setClienteEditando(cliente);
        setFormDataCliente({
            nombre: cliente.nombre,
            telefono: cliente.telefono || '',
            limite_credito: cliente.limite_credito.toString(),
            tipo_precio: String(cliente.tipo_precio ?? 1),
            al_por_mayor: cliente.al_por_mayor ?? false,
        });
        setIsModalClienteOpen(true);
    };

    const guardarCliente = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId) return;
        const idCliente = clienteEditando ? clienteEditando.id : uuidv4();
        await db.clientes.put({
            id: idCliente,
            negocio_id: negocioId,
            nombre: formDataCliente.nombre,
            telefono: formDataCliente.telefono || null,
            limite_credito: parseFloat(formDataCliente.limite_credito) || 0,
            tipo_precio: parseInt(formDataCliente.tipo_precio) as 1 | 2 | 3,
            al_por_mayor: formDataCliente.al_por_mayor,
            estado_sincronizacion: 0,
            fecha_actualizacion: Date.now(),
        });
        setIsModalClienteOpen(false);
        showToast(clienteEditando ? "Cliente actualizado" : "Cliente creado", "success");
    };

    const abrirModalAbono = (cliente: any) => {
        setClienteParaAbono(cliente);
        setAbonoMonto('');
        setAbonoConcepto('Abono en efectivo');
        setIsModalAbonoOpen(true);
    };

    const registrarAbono = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId || !clienteParaAbono) return;
        const monto = parseFloat(abonoMonto);
        if (monto <= 0) { showToast("Monto debe ser mayor a 0", "error"); return; }

        await db.transacciones_fiado.add({
            id: uuidv4(), negocio_id: negocioId, cliente_id: clienteParaAbono.id,
            venta_id: null, tipo: 'abono', monto, concepto: abonoConcepto,
            fecha_creacion: Date.now(), estado_sincronizacion: 0, fecha_actualizacion: Date.now()
        });
        setIsModalAbonoOpen(false);
        showToast(`Abono de ${formatDOP(monto)} registrado`, "success");
    };

    const enviarWhatsApp = (cliente: any) => {
        if (!cliente.telefono) { showToast("El cliente no tiene teléfono registrado.", "error"); return; }
        const nombreNegocioStr = negocioNombre ? negocioNombre : "nuestro negocio";
        const mensaje = `Hola ${cliente.nombre}, te contactamos de ${nombreNegocioStr}. Tu saldo pendiente actual es de ${formatDOP(cliente.saldo_pendiente)}. Por favor, acércate a realizar un abono cuando puedas. ¡Gracias!`;
        const url = `https://wa.me/${cliente.telefono.replace(/\D/g, '')}?text=${encodeURIComponent(mensaje)}`;
        window.open(url, '_blank');
    };

    const totalCuentasPorCobrar = clientesConSaldo.reduce((acc, c) => acc + c.saldo_pendiente, 0);
    const clientesConDeuda = clientesConSaldo.filter(c => c.saldo_pendiente > 0).length;

    // ¿A quién cobrar hoy? — deudores ordenados por días sin abonar (los más urgentes primero)
    const cobrosPendientes = useMemo(() => {
        const DIA = 24 * 60 * 60 * 1000;
        return clientesConSaldo
            .filter(c => c.saldo_pendiente > 0)
            .map(c => {
                const txs = transacciones.filter(t => t.cliente_id === c.id);
                const ultimoAbono = txs.filter(t => t.tipo === 'abono').reduce((m, t) => Math.max(m, t.fecha_creacion), 0);
                const primerCargo = txs.filter(t => t.tipo === 'cargo').reduce((m, t) => Math.min(m, t.fecha_creacion), Infinity);
                const referencia = ultimoAbono > 0 ? ultimoAbono : primerCargo;
                const dias = referencia === Infinity ? 0 : Math.floor((Date.now() - referencia) / DIA);
                return { ...c, diasSinAbonar: dias };
            })
            .sort((a, b) => b.diasSinAbonar - a.diasSinAbonar || b.saldo_pendiente - a.saldo_pendiente)
            .slice(0, 5);
    }, [clientesConSaldo, transacciones]);

    const ITEMS_POR_PAGINA = 20;
    const [pagina, setPagina] = useState(1);
    const clientesPaginados = useMemo(() => {
        const inicio = (pagina - 1) * ITEMS_POR_PAGINA;
        return clientesConSaldo.slice(inicio, inicio + ITEMS_POR_PAGINA);
    }, [clientesConSaldo, pagina]);
    const totalPaginas = Math.ceil(clientesConSaldo.length / ITEMS_POR_PAGINA);

    return (
        <div className="min-h-screen bg-navy flex flex-col">
            <TopBar />
            <OfflineBanner />

            <div className="flex-1 p-3 sm:p-6 lg:p-8">
                <div className="max-w-7xl mx-auto">
                    <div className="flex justify-between items-center mb-4 sm:mb-8">
                        <div>
                            <h1 className="text-2xl sm:text-3xl font-display font-extrabold text-white">Clientes & Fiados</h1>
                            <p className="text-vr-gray mt-0.5 text-sm hidden sm:block">Administración de cartera de crédito</p>
                        </div>
                        <button onClick={abrirModalNuevoCliente} className="px-4 sm:px-6 py-2.5 sm:py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all shadow-md text-sm sm:text-base">
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
                                            onClick={() => enviarWhatsApp(c)}
                                            disabled={!c.telefono}
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
                                                <button onClick={() => abrirModalEditarCliente(cliente)} className="text-xs text-gold hover:text-gold-2 transition-colors">Editar</button>
                                                {cliente.telefono && (
                                                    <span className="sm:hidden ml-2 text-xs text-vr-gray font-mono">{cliente.telefono}</span>
                                                )}
                                            </td>
                                            <td className="p-3 sm:p-4 text-vr-gray font-mono text-sm hidden sm:table-cell">{cliente.telefono || '-'}</td>
                                            <td className="p-3 sm:p-4 text-vr-gray font-mono text-sm hidden md:table-cell">
                                                {cliente.limite_credito > 0 ? formatDOP(cliente.limite_credito) : 'Ilimitado'}
                                            </td>
                                            <td className="p-3 sm:p-4 text-right">
                                                <span className={`font-black font-mono text-sm ${cliente.saldo_pendiente > 0 ? 'text-vr-red' : 'text-vr-green'}`}>
                                                    {formatDOP(cliente.saldo_pendiente)}
                                                </span>
                                            </td>
                                            <td className="p-3 sm:p-4 text-center">
                                                <div className="flex items-center justify-center gap-1.5 sm:gap-2">
                                                    <button
                                                        onClick={() => abrirModalAbono(cliente)}
                                                        disabled={cliente.saldo_pendiente <= 0}
                                                        className="px-2 sm:px-3 py-1.5 bg-vr-green/10 text-vr-green font-bold rounded-lg hover:bg-vr-green/20 disabled:opacity-30 text-xs border border-vr-green/20 transition-all whitespace-nowrap"
                                                    >
                                                        + Abono
                                                    </button>
                                                    <button
                                                        onClick={() => enviarWhatsApp(cliente)}
                                                        disabled={!cliente.telefono || cliente.saldo_pendiente <= 0}
                                                        className="hidden sm:inline px-3 py-1.5 bg-vr-green/10 text-vr-green font-bold rounded-lg hover:bg-vr-green/20 disabled:opacity-30 text-xs border border-vr-green/20 transition-all"
                                                    >
                                                        WhatsApp
                                                    </button>
                                                    <button
                                                        onClick={() => enviarWhatsApp(cliente)}
                                                        disabled={!cliente.telefono || cliente.saldo_pendiente <= 0}
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
                            pagina={pagina}
                            totalPaginas={totalPaginas}
                            onCambiar={setPagina}
                            totalItems={clientesConSaldo.length}
                            itemsPorPagina={ITEMS_POR_PAGINA}
                        />
                    </div>

                    {/* MODAL CREAR/EDITAR CLIENTE — full screen on mobile */}
                    {isModalClienteOpen && (
                        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                            <div className="bg-navy-2 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                                <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                    <h2 className="text-xl font-display font-bold text-white">{clienteEditando ? 'Editar Cliente' : 'Nuevo Cliente'}</h2>
                                    <button onClick={() => setIsModalClienteOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                                </div>
                                <form onSubmit={guardarCliente} className="p-4 sm:p-6 space-y-4">
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Nombre Completo *</label>
                                        <input required type="text" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" value={formDataCliente.nombre} onChange={e => setFormDataCliente({ ...formDataCliente, nombre: e.target.value })} />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Teléfono (WhatsApp)</label>
                                        <input type="text" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" placeholder="Ej: 8091234567" value={formDataCliente.telefono} onChange={e => setFormDataCliente({ ...formDataCliente, telefono: e.target.value })} />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Límite de Crédito (RD$)</label>
                                        <input type="number" min="0" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all font-mono" value={formDataCliente.limite_credito} onChange={e => setFormDataCliente({ ...formDataCliente, limite_credito: e.target.value })} />
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
                                        <button type="submit" className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all">Guardar</button>
                                    </div>

                                    {/* Eliminar — solo al editar un cliente existente */}
                                    {clienteEditando && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const conSaldo = clientesConSaldo.find(c => c.id === clienteEditando.id);
                                                if (conSaldo && conSaldo.saldo_pendiente > 0) {
                                                    showToast('No puedes borrar un cliente con deuda pendiente. Registra el pago primero.', 'error');
                                                    return;
                                                }
                                                setClienteAEliminar(clienteEditando);
                                            }}
                                            className="w-full text-center text-vr-red/80 hover:text-vr-red text-sm font-bold py-2 hover:bg-vr-red/10 rounded-xl transition-all"
                                        >
                                            🗑 Eliminar cliente
                                        </button>
                                    )}
                                </form>
                            </div>
                        </div>
                    )}

                    {/* MODAL REGISTRAR ABONO — full screen on mobile */}
                    {isModalAbonoOpen && clienteParaAbono && (
                        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                            <div className="bg-navy-2 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                                <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                    <h2 className="text-xl font-display font-bold text-vr-green">Registrar Abono</h2>
                                    <button onClick={() => setIsModalAbonoOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                                </div>
                                <form onSubmit={registrarAbono} className="p-4 sm:p-6 space-y-4">
                                    <div className="text-center mb-2">
                                        <p className="text-vr-gray text-sm">Deuda de {clienteParaAbono.nombre}</p>
                                        <p className="text-3xl font-black font-mono text-vr-red">{formatDOP(clienteParaAbono.saldo_pendiente)}</p>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Monto del Abono (RD$) *</label>
                                        <input required type="number" step="0.01" max={clienteParaAbono.saldo_pendiente} className="w-full bg-navy-3 border border-vr-green/30 rounded-xl p-3 text-white focus:border-vr-green outline-none text-xl font-bold font-mono text-center transition-all" value={abonoMonto} onChange={e => setAbonoMonto(e.target.value)} />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Concepto</label>
                                        <input type="text" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" value={abonoConcepto} onChange={e => setAbonoConcepto(e.target.value)} />
                                    </div>
                                    <div className="flex flex-col gap-2 pt-2">
                                        <button type="submit" className="w-full py-4 bg-vr-green text-white font-extrabold rounded-xl hover:bg-vr-green/90 text-lg transition-all">Confirmar Pago</button>
                                        <button type="button" onClick={() => setIsModalAbonoOpen(false)} className="w-full py-3 font-bold text-vr-gray hover:text-white hover:bg-navy-3 rounded-xl transition-all">Cancelar</button>
                                    </div>
                                </form>
                            </div>
                        </div>
                    )}

                    {/* FICHA DEL CLIENTE — trazabilidad */}
                    {fichaCliente && fichaData && (
                        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                            <div className="bg-navy-2 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden max-h-[92vh] sm:max-h-[88vh] flex flex-col animate-scale-in">
                                <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-start gap-3">
                                    <div className="min-w-0">
                                        <h2 className="text-xl font-display font-bold text-white truncate">{fichaCliente.nombre}</h2>
                                        <p className="text-sm text-vr-gray mt-0.5">{fichaCliente.telefono || 'Sin teléfono'}</p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {fichaCliente.telefono && (
                                            <button onClick={() => enviarWhatsApp(fichaCliente)} className="px-3 py-1.5 bg-vr-green/10 text-vr-green font-bold rounded-lg hover:bg-vr-green/20 text-xs border border-vr-green/20 transition-all">📱 WhatsApp</button>
                                        )}
                                        <button onClick={() => setFichaCliente(null)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                                    </div>
                                </div>

                                {/* Resumen */}
                                <div className="px-4 sm:px-6 pt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
                                    <div className="bg-navy p-2.5 rounded-xl border border-navy-3">
                                        <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Saldo</p>
                                        <p className={`text-sm font-black font-mono mt-0.5 ${fichaCliente.saldo_pendiente > 0 ? 'text-vr-red' : 'text-vr-green'}`}>{formatDOP(fichaCliente.saldo_pendiente)}</p>
                                    </div>
                                    <div className="bg-navy p-2.5 rounded-xl border border-navy-3">
                                        <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Total fiado</p>
                                        <p className="text-sm font-black font-mono mt-0.5 text-white">{formatDOP(fichaData.totalFiado)}</p>
                                    </div>
                                    {esPro && (
                                        <div className="bg-navy p-2.5 rounded-xl border border-navy-3">
                                            <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Reparac.</p>
                                            <p className="text-sm font-black font-mono mt-0.5 text-white">{fichaData.reparaciones}</p>
                                        </div>
                                    )}
                                    {esPro && (
                                        <div className="bg-navy p-2.5 rounded-xl border border-navy-3">
                                            <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Apartados</p>
                                            <p className="text-sm font-black font-mono mt-0.5 text-white">{fichaData.apartados}</p>
                                        </div>
                                    )}
                                </div>

                                {/* Movimientos del cliente */}
                                <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                                    <p className="text-xs font-bold text-vr-gray uppercase tracking-wider mb-2">Actividad</p>
                                    {fichaData.movs.length === 0 ? (
                                        <p className="text-sm text-vr-gray text-center py-8">Este cliente aún no tiene movimientos.</p>
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
                                    <button onClick={() => { abrirModalEditarCliente(fichaCliente); setFichaCliente(null); }} className="flex-1 py-3 font-bold text-gold border border-gold/30 rounded-xl hover:bg-gold/10 transition-colors">Editar</button>
                                    {fichaCliente.saldo_pendiente > 0 && (
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
