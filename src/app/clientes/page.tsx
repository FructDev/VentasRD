// src/app/clientes/page.tsx
'use client';

import { useMemo, useState } from 'react';
import { db } from '@/lib/db/dexie';
import { useClientesTenant, useTransaccionesFiadoTenant } from '@/lib/db/tenantQuery';
import { useConfigStore } from '@/store/useConfigStore';
import { ClienteLocal } from '@/types/database';
import { formatDOP } from '@/lib/utils';
import { v4 as uuidv4 } from 'uuid';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';
import Pagination from '@/components/ui/Pagination';

export default function ClientesPage() {
    const { negocioId, showToast, negocioNombre } = useConfigStore();
    const clientes = useClientesTenant();
    const transacciones = useTransaccionesFiadoTenant();

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
    const [formDataCliente, setFormDataCliente] = useState({ nombre: '', telefono: '', limite_credito: '' });

    const [isModalAbonoOpen, setIsModalAbonoOpen] = useState(false);
    const [clienteParaAbono, setClienteParaAbono] = useState<any>(null);
    const [abonoMonto, setAbonoMonto] = useState('');
    const [abonoConcepto, setAbonoConcepto] = useState('Abono en efectivo');

    const abrirModalNuevoCliente = () => {
        setClienteEditando(null);
        setFormDataCliente({ nombre: '', telefono: '', limite_credito: '0' });
        setIsModalClienteOpen(true);
    };

    const abrirModalEditarCliente = (cliente: ClienteLocal) => {
        setClienteEditando(cliente);
        setFormDataCliente({ nombre: cliente.nombre, telefono: cliente.telefono || '', limite_credito: cliente.limite_credito.toString() });
        setIsModalClienteOpen(true);
    };

    const guardarCliente = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId) return;
        const idCliente = clienteEditando ? clienteEditando.id : uuidv4();
        await db.clientes.put({
            id: idCliente, negocio_id: negocioId, nombre: formDataCliente.nombre,
            telefono: formDataCliente.telefono || null, limite_credito: parseFloat(formDataCliente.limite_credito) || 0,
            estado_sincronizacion: 0, fecha_actualizacion: Date.now()
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
                            <h3 className="text-xl sm:text-3xl font-black font-mono mt-1 text-vr-red truncate">{formatDOP(totalCuentasPorCobrar)}</h3>
                        </div>
                        <div className="p-3 sm:p-5 rounded-2xl border border-navy-3 bg-navy-2">
                            <p className="text-xs font-bold text-vr-gray uppercase tracking-wider leading-tight">Con Deuda</p>
                            <h3 className="text-xl sm:text-3xl font-black font-mono mt-1 text-white">{clientesConDeuda}</h3>
                        </div>
                    </div>

                    {/* Tabla */}
                    <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                        <div className="overflow-x-auto">
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
                                                <span className="font-bold text-white text-sm block">{cliente.nombre}</span>
                                                {/* Edit inline link */}
                                                <button onClick={() => abrirModalEditarCliente(cliente)} className="text-xs text-gold hover:text-gold-2 transition-colors">Editar</button>
                                                {/* Phone on mobile */}
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
                                    <div className="flex gap-3 pt-2">
                                        <button type="button" onClick={() => setIsModalClienteOpen(false)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                                        <button type="submit" className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all">Guardar</button>
                                    </div>
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
                </div>
            </div>
        </div>
    );
}
