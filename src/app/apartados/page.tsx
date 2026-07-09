// src/app/apartados/page.tsx
'use client';

import { useMemo, useState, useRef } from 'react';
import { db, getNextFolioApartado } from '@/lib/db/dexie';
import { registrarMovimientoStock } from '@/lib/db/stock';
import { useConfigStore } from '@/store/useConfigStore';
import { useProductosTenant } from '@/lib/db/tenantQuery';
import { useLiveQuery } from 'dexie-react-hooks';
import { ApartadoLocal, ItemApartado, MetodoPagoReparacion, AbonoApartado } from '@/types/database';
import { formatDOP } from '@/lib/utils';
import { linkWhatsApp } from '@/lib/whatsapp';
import { v4 as uuidv4 } from 'uuid';
import { useReactToPrint } from 'react-to-print';
import { TicketApartado } from '@/components/TicketApartado';
import PinGuard from '@/components/ui/PinGuard';
import { useCandado } from '@/lib/useCandado';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';
import ConfirmModal from '@/components/ui/ConfirmModal';
import ClientePicker from '@/components/shared/ClientePicker';
import { SkeletonTable } from '@/components/ui/Skeleton';

const DIA = 24 * 60 * 60 * 1000;
const WHATSAPP_NUMBER_SOPORTE = '18294515303';
const METODOS: MetodoPagoReparacion[] = ['efectivo', 'tarjeta', 'transferencia'];

const norm = (s: string | null | undefined): string =>
    (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const FORM_VACIO = {
    cliente_id: undefined as string | undefined,
    cliente_nombre: '', cliente_telefono: '', guardar_cliente: false,
    abono: '', metodo_abono: 'efectivo' as MetodoPagoReparacion,
    notas: '',
    items: [] as ItemApartado[],
};

export default function ApartadosPage() {
    const { negocioId, sucursalId, planTier, garantiaDiasDefault, showToast, negocioNombre, negocioRnc, negocioDireccion, negocioTelefono } = useConfigStore();
    const { ocupado, conCandado } = useCandado();
    const productos = useProductosTenant();

    const apartadosRaw = useLiveQuery(
        () => negocioId ? db.apartados.where('negocio_id').equals(negocioId).reverse().sortBy('fecha_creacion') : [],
        [negocioId]
    );
    const isLoading = apartadosRaw === undefined;
    const lista = useMemo(() => apartadosRaw ?? [], [apartadosRaw]);

    const [busqueda, setBusqueda] = useState('');
    const [filtro, setFiltro] = useState<'activos' | 'completados' | 'cancelados' | 'todos'>('activos');

    // Nuevo apartado
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [formData, setFormData] = useState(FORM_VACIO);
    const [busquedaProducto, setBusquedaProducto] = useState('');
    const [productoParaSerial, setProductoParaSerial] = useState<{ id: string; nombre: string; precio: number } | null>(null);
    const [guardando, setGuardando] = useState(false);

    // Abono
    const [abonando, setAbonando] = useState<ApartadoLocal | null>(null);
    const [montoAbono, setMontoAbono] = useState('');
    const [metodoAbono, setMetodoAbono] = useState<MetodoPagoReparacion>('efectivo');

    // Completar / cancelar
    const [completando, setCompletando] = useState<ApartadoLocal | null>(null);
    const [metodoFinal, setMetodoFinal] = useState<MetodoPagoReparacion>('efectivo');
    const [cancelando, setCancelando] = useState<ApartadoLocal | null>(null);

    // Impresión
    const ticketRef = useRef<HTMLDivElement>(null);
    const [recibo, setRecibo] = useState<{ ap: ApartadoLocal; modo: 'contrato' | 'abono' | 'entrega' } | null>(null);
    const handlePrint = useReactToPrint({ contentRef: ticketRef });
    const imprimir = (ap: ApartadoLocal, modo: 'contrato' | 'abono' | 'entrega') => {
        setRecibo({ ap, modo });
        setTimeout(() => handlePrint(), 120);
    };

    // Seriales disponibles del producto a apartar
    const serialesModal = useLiveQuery(async () => {
        if (!productoParaSerial) return [];
        return db.seriales.where('producto_id').equals(productoParaSerial.id).filter(s => s.estado === 'disponible').toArray();
    }, [productoParaSerial]) ?? [];

    const totalForm = useMemo(() => formData.items.reduce((s, it) => s + it.precio_unitario * it.cantidad, 0), [formData.items]);

    const listaFiltrada = useMemo(() => {
        const q = norm(busqueda).trim();
        const terminos = q ? q.split(/\s+/) : [];
        return lista.filter(a => {
            if (filtro === 'activos' && a.estado !== 'activo') return false;
            if (filtro === 'completados' && a.estado !== 'completado') return false;
            if (filtro === 'cancelados' && a.estado !== 'cancelado') return false;
            if (terminos.length > 0) {
                const heno = norm(`${a.folio} ${a.cliente_nombre} ${a.cliente_telefono || ''} ${a.items.map(i => i.nombre).join(' ')}`);
                if (!terminos.every(t => heno.includes(t))) return false;
            }
            return true;
        });
    }, [lista, busqueda, filtro]);

    const conteoActivos = useMemo(() => lista.filter(a => a.estado === 'activo').length, [lista]);

    const productosFiltrados = useMemo(() => {
        const q = norm(busquedaProducto).trim();
        if (!q) return [];
        return productos.filter(p => p.tipo !== 'combo' && (norm(p.nombre).includes(q) || norm(p.codigo_barras).includes(q))).slice(0, 8);
    }, [productos, busquedaProducto]);

    // ─── Acciones ─────────────────────────────────────────────────────────
    const abrirNuevo = () => {
        setFormData(FORM_VACIO);
        setBusquedaProducto('');
        setProductoParaSerial(null);
        setIsModalOpen(true);
    };

    const elegirProducto = (prodId: string) => {
        const prod = productos.find(p => p.id === prodId);
        if (!prod) return;
        if (prod.serializable) {
            setProductoParaSerial({ id: prod.id, nombre: prod.nombre, precio: prod.precio_venta || 0 });
            setBusquedaProducto('');
            return;
        }
        setFormData(f => ({
            ...f,
            items: [...f.items, { producto_id: prod.id, nombre: prod.nombre, cantidad: 1, precio_unitario: prod.precio_venta || 0 }],
        }));
        setBusquedaProducto('');
    };

    const elegirSerial = (serialId: string, serialNumero: string) => {
        if (!productoParaSerial) return;
        if (formData.items.some(i => i.serial_id === serialId)) { setProductoParaSerial(null); return; }
        setFormData(f => ({
            ...f,
            items: [...f.items, {
                producto_id: productoParaSerial.id,
                nombre: productoParaSerial.nombre,
                cantidad: 1,
                precio_unitario: productoParaSerial.precio,
                serial_id: serialId,
                serial_numero: serialNumero,
            }],
        }));
        setProductoParaSerial(null);
    };

    const actualizarItem = (idx: number, campo: 'cantidad' | 'precio_unitario', valor: string) => {
        setFormData(f => {
            const items = [...f.items];
            items[idx] = { ...items[idx], [campo]: parseFloat(valor) || 0 };
            return { ...f, items };
        });
    };

    const quitarItem = (idx: number) => setFormData(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));

    const guardar = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId) return;
        if (!formData.cliente_nombre.trim() || formData.items.length === 0) {
            showToast('Agrega el cliente y al menos un artículo.', 'error');
            return;
        }
        setGuardando(true);
        try {
            const id = uuidv4();
            const ahora = Date.now();
            const folio = await getNextFolioApartado(negocioId);

            // Cliente: si es nuevo y se pidió guardar, crearlo y enlazarlo
            let clienteId = formData.cliente_id;
            if (!clienteId && formData.guardar_cliente && formData.cliente_nombre.trim()) {
                clienteId = uuidv4();
                await db.clientes.add({
                    id: clienteId,
                    negocio_id: negocioId,
                    nombre: formData.cliente_nombre.trim(),
                    telefono: formData.cliente_telefono.trim() || null,
                    limite_credito: 0,
                    estado_sincronizacion: 0,
                    fecha_actualizacion: ahora,
                });
            }

            const total = formData.items.reduce((s, it) => s + it.precio_unitario * it.cantidad, 0);
            const abonoInicial = parseFloat(formData.abono) || 0;
            const abonos: AbonoApartado[] = abonoInicial > 0
                ? [{ monto: abonoInicial, metodo: formData.metodo_abono, fecha: ahora }]
                : [];

            // Reservar: descontar stock y marcar seriales como apartados
            for (const it of formData.items) {
                await registrarMovimientoStock({ productoId: it.producto_id, tipo: 'apartado', delta: -Math.abs(it.cantidad), referenciaId: id });
                if (it.serial_id) {
                    await db.seriales.update(it.serial_id, { estado: 'apartado', estado_sincronizacion: 0, fecha_actualizacion: ahora });
                }
            }

            const ap: ApartadoLocal = {
                id, negocio_id: negocioId, sucursal_id: sucursalId || undefined,
                folio,
                ...(clienteId && { cliente_id: clienteId }),
                cliente_nombre: formData.cliente_nombre.trim(),
                ...(formData.cliente_telefono.trim() && { cliente_telefono: formData.cliente_telefono.trim() }),
                items: formData.items,
                total,
                abonado: abonoInicial,
                abonos,
                estado: 'activo',
                ...(formData.notas.trim() && { notas: formData.notas.trim() }),
                fecha_creacion: ahora,
                estado_sincronizacion: 0,
                fecha_actualizacion: ahora,
            };
            await db.apartados.put(ap);
            setIsModalOpen(false);
            showToast(`Apartado ${folio} creado.`, 'success');
            setTimeout(() => imprimir(ap, 'contrato'), 150);
        } catch (err) {
            console.error('[apartado]', err);
            showToast('No se pudo crear el apartado.', 'error');
        }
        setGuardando(false);
    };

    const guardarAbono = async () => {
        if (!abonando) return;
        const monto = parseFloat(montoAbono) || 0;
        if (monto <= 0) { showToast('Ingresa un monto válido.', 'error'); return; }
        const ahora = Date.now();
        const nuevosAbonos = [...abonando.abonos, { monto, metodo: metodoAbono, fecha: ahora }];
        const abonado = abonando.abonado + monto;
        await db.apartados.update(abonando.id, { abonos: nuevosAbonos, abonado, estado_sincronizacion: 0, fecha_actualizacion: ahora });
        const actualizado: ApartadoLocal = { ...abonando, abonos: nuevosAbonos, abonado };
        setAbonando(null);
        setMontoAbono('');
        showToast('Abono registrado.', 'success');
        setTimeout(() => imprimir(actualizado, 'abono'), 150);
    };

    const confirmarCompletar = async () => {
        if (!completando) return;
        const ahora = Date.now();
        const saldo = Math.max(0, completando.total - completando.abonado);
        const abonos = [...completando.abonos];
        let abonado = completando.abonado;
        if (saldo > 0) {
            abonos.push({ monto: saldo, metodo: metodoFinal, fecha: ahora });
            abonado += saldo;
        }
        // Marcar seriales como vendidos + garantía (Pro)
        const dias = garantiaDiasDefault || 0;
        for (const it of completando.items) {
            if (it.serial_id) {
                await db.seriales.update(it.serial_id, {
                    estado: 'vendido',
                    fecha_venta: ahora,
                    garantia_dias: dias,
                    garantia_hasta: dias > 0 ? ahora + dias * DIA : null,
                    precio_venta: it.precio_unitario,
                    cliente_nombre: completando.cliente_nombre,
                    estado_sincronizacion: 0,
                    fecha_actualizacion: ahora,
                });
            }
        }
        await db.apartados.update(completando.id, { estado: 'completado', abonos, abonado, fecha_completado: ahora, estado_sincronizacion: 0, fecha_actualizacion: ahora });
        const actualizado: ApartadoLocal = { ...completando, estado: 'completado', abonos, abonado, fecha_completado: ahora };
        setCompletando(null);
        showToast('Apartado entregado.', 'success');
        setTimeout(() => imprimir(actualizado, 'entrega'), 150);
    };

    const confirmarCancelar = async () => {
        if (!cancelando) return;
        const ahora = Date.now();
        // Devolver stock y liberar seriales
        for (const it of cancelando.items) {
            await registrarMovimientoStock({ productoId: it.producto_id, tipo: 'devolucion', delta: Math.abs(it.cantidad), referenciaId: cancelando.id });
            if (it.serial_id) {
                await db.seriales.update(it.serial_id, { estado: 'disponible', estado_sincronizacion: 0, fecha_actualizacion: ahora });
            }
        }
        await db.apartados.update(cancelando.id, { estado: 'cancelado', fecha_cancelado: ahora, estado_sincronizacion: 0, fecha_actualizacion: ahora });
        setCancelando(null);
        showToast('Apartado cancelado. El stock volvió al inventario.', 'info');
    };

    const avisarWhatsApp = (a: ApartadoLocal) => {
        if (!a.cliente_telefono) { showToast('Este apartado no tiene teléfono del cliente.', 'info'); return; }
        const saldo = Math.max(0, a.total - a.abonado);
        const msg = `Hola ${a.cliente_nombre} 👋, le saluda *${negocioNombre || 'nuestra tienda'}*.\n\n` +
            `Le recordamos su apartado *${a.folio}*.\n` +
            `Total: *${formatDOP(a.total)}* · Abonado: *${formatDOP(a.abonado)}*\n` +
            (saldo > 0 ? `Saldo pendiente: *${formatDOP(saldo)}*.\n` : 'Ya está saldado, ¡puede pasar a retirarlo! ✅\n') +
            `\n_Hecho con VentaRD_`;
        window.open(linkWhatsApp(msg, a.cliente_telefono), '_blank');
    };

    // ─── Candado de plan Pro ──────────────────────────────────────────────
    if (planTier !== 'pro') {
        const linkWa = `https://wa.me/${WHATSAPP_NUMBER_SOPORTE}?text=${encodeURIComponent('Hola, quiero activar Apartados (Plan Pro) en VentaRD.')}`;
        return (
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <OfflineBanner />
                <div className="flex-1 flex items-center justify-center p-6">
                    <div className="max-w-lg w-full text-center bg-navy-2 border border-gold/25 rounded-2xl p-8">
                        <span className="text-5xl block mb-4">🔖</span>
                        <h1 className="text-2xl font-display font-black text-white mb-2">Apartados (Plan Separe)</h1>
                        <p className="text-vr-gray text-sm mb-6">Disponible en el <span className="text-gold font-bold">Plan Pro</span>. Reserva equipos con un abono, cobra en partes y entrega al saldar — el equipo queda fuera del inventario mientras tanto.</p>
                        <a href={linkWa} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 bg-gold-gradient text-navy px-7 py-3.5 rounded-2xl font-extrabold hover:brightness-110 transition-all">💬 Activar Plan Pro por WhatsApp</a>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <PinGuard title="Apartados">
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <OfflineBanner />
                <div className="flex-1 p-3 sm:p-6 lg:p-8">
                    <div className="max-w-5xl mx-auto">
                        <div className="flex justify-between items-center mb-4 sm:mb-6">
                            <div>
                                <h1 className="text-2xl sm:text-3xl font-display font-extrabold text-white flex items-center gap-2">
                                    🔖 Apartados
                                    <span className="text-[10px] font-black bg-gold/15 text-gold px-2 py-0.5 rounded-full uppercase tracking-wider">Pro</span>
                                </h1>
                                <p className="text-vr-gray mt-0.5 text-sm hidden sm:block">{conteoActivos} apartado{conteoActivos === 1 ? '' : 's'} activo{conteoActivos === 1 ? '' : 's'}</p>
                            </div>
                            <button onClick={abrirNuevo} className="px-4 sm:px-6 py-2.5 sm:py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all shadow-md text-sm sm:text-base whitespace-nowrap">+ Nuevo</button>
                        </div>

                        {/* Buscador + filtros */}
                        <div className="mb-3 sm:mb-4 space-y-3">
                            <input type="text" inputMode="search" placeholder="Buscar por folio, cliente, teléfono o artículo…" className="w-full bg-navy-2 border border-navy-3 rounded-xl px-4 py-3 text-white placeholder-vr-gray/50 focus:border-gold outline-none transition-all" value={busqueda} onChange={e => setBusqueda(e.target.value)} />
                            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                                {([
                                    { key: 'activos', label: 'Activos' },
                                    { key: 'completados', label: 'Completados' },
                                    { key: 'cancelados', label: 'Cancelados' },
                                    { key: 'todos', label: 'Todos' },
                                ] as const).map(({ key, label }) => (
                                    <button key={key} type="button" onClick={() => setFiltro(key)} className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all border shrink-0 ${filtro === key ? 'bg-gold/15 text-gold border-gold/40' : 'bg-navy-2 text-vr-gray border-navy-3 hover:text-white'}`}>{label}</button>
                                ))}
                            </div>
                        </div>

                        {/* Lista */}
                        <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                            {isLoading ? (
                                <table className="w-full"><tbody><SkeletonTable rows={5} cols={4} /></tbody></table>
                            ) : listaFiltrada.length === 0 ? (
                                <div className="py-16 text-center text-vr-gray">
                                    <span className="text-4xl block mb-3">🔖</span>
                                    <p className="font-medium">{lista.length === 0 ? 'Aún no hay apartados. Crea el primero.' : 'Sin apartados con ese filtro.'}</p>
                                </div>
                            ) : (
                                <div className="divide-y divide-navy-3/50">
                                    {listaFiltrada.map(a => {
                                        const saldo = Math.max(0, a.total - a.abonado);
                                        const activo = a.estado === 'activo';
                                        const pct = a.total > 0 ? Math.min(100, Math.round((a.abonado / a.total) * 100)) : 0;
                                        const estadoColor = a.estado === 'activo' ? 'bg-gold/15 text-gold border-gold/30' : a.estado === 'completado' ? 'bg-vr-green/15 text-vr-green border-vr-green/30' : 'bg-vr-red/15 text-vr-red border-vr-red/30';
                                        return (
                                            <div key={a.id} className="p-3 sm:p-4 hover:bg-navy-3/20 transition-colors">
                                                <div className="flex items-start justify-between gap-3 flex-wrap">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <span className="font-mono font-black text-gold text-sm">{a.folio}</span>
                                                            <span className={`px-2 py-0.5 rounded-md text-[10px] font-black border capitalize ${estadoColor}`}>{a.estado}</span>
                                                        </div>
                                                        <p className="text-sm font-bold text-white mt-1 truncate">👤 {a.cliente_nombre}{a.cliente_telefono ? ` · ${a.cliente_telefono}` : ''}</p>
                                                        <p className="text-xs text-vr-gray mt-0.5 truncate">{a.items.map(i => `${i.cantidad}× ${i.nombre}`).join(', ')}</p>
                                                    </div>
                                                    <div className="text-right shrink-0">
                                                        <p className="font-mono font-black text-white text-sm">{formatDOP(a.total)}</p>
                                                        <p className="text-[11px] text-vr-gray">Abonado {formatDOP(a.abonado)}</p>
                                                        {saldo > 0 && a.estado !== 'cancelado' && <p className="text-[11px] font-bold text-vr-orange">Saldo {formatDOP(saldo)}</p>}
                                                    </div>
                                                </div>
                                                {/* Barra de progreso */}
                                                {a.estado !== 'cancelado' && (
                                                    <div className="mt-2 h-1.5 bg-navy-3 rounded-full overflow-hidden">
                                                        <div className="h-full bg-gold-gradient" style={{ width: `${pct}%` }} />
                                                    </div>
                                                )}
                                                {/* Acciones */}
                                                <div className="flex items-center gap-2 flex-wrap mt-3">
                                                    {activo && (
                                                        <>
                                                            <button onClick={() => { setAbonando(a); setMontoAbono(''); setMetodoAbono('efectivo'); }} className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-vr-green/10 text-vr-green border border-vr-green/20 hover:bg-vr-green/20 transition-all">+ Abono</button>
                                                            <button onClick={() => { setCompletando(a); setMetodoFinal('efectivo'); }} className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-gold/10 text-gold border border-gold/20 hover:bg-gold/20 transition-all">📦 Entregar</button>
                                                            {a.cliente_telefono && <button onClick={() => avisarWhatsApp(a)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-navy-3 text-vr-gray border border-navy-3 hover:text-white transition-all">💬 Recordar</button>}
                                                        </>
                                                    )}
                                                    <button onClick={() => imprimir(a, a.estado === 'completado' ? 'entrega' : 'contrato')} className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-navy-3 text-vr-gray border border-navy-3 hover:text-white transition-all">🖨️ Recibo</button>
                                                    {activo && <button onClick={() => setCancelando(a)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-vr-red hover:bg-vr-red/10 transition-all">Cancelar</button>}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* MODAL NUEVO */}
                {isModalOpen && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                        <div className="bg-navy-2 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden max-h-[95vh] sm:max-h-[90vh] flex flex-col animate-scale-in">
                            <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center shrink-0">
                                <h2 className="text-xl font-display font-bold text-white">Nuevo apartado</h2>
                                <button onClick={() => setIsModalOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                            </div>
                            <form onSubmit={conCandado(guardar)} className="p-4 sm:p-6 space-y-4 overflow-y-auto">
                                <ClientePicker
                                    value={{ clienteId: formData.cliente_id, nombre: formData.cliente_nombre, telefono: formData.cliente_telefono, guardarNuevo: formData.guardar_cliente }}
                                    onChange={v => setFormData({ ...formData, cliente_id: v.clienteId, cliente_nombre: v.nombre, cliente_telefono: v.telefono, guardar_cliente: v.guardarNuevo })}
                                />

                                {/* Artículos */}
                                <div className="p-3 bg-navy rounded-xl border border-navy-3">
                                    <p className="text-xs font-bold text-vr-gray uppercase tracking-wider mb-2">Artículos a apartar</p>
                                    {productoParaSerial ? (
                                        <div className="mb-2">
                                            <div className="flex items-center justify-between mb-1.5">
                                                <p className="text-xs font-bold text-white">Elige el serial de {productoParaSerial.nombre}</p>
                                                <button type="button" onClick={() => setProductoParaSerial(null)} className="text-xs text-vr-red font-bold">Cancelar</button>
                                            </div>
                                            <div className="space-y-1 max-h-40 overflow-y-auto">
                                                {serialesModal.length === 0 ? (
                                                    <p className="text-xs text-vr-gray py-2 text-center">Sin seriales disponibles.</p>
                                                ) : serialesModal.filter(s => !formData.items.some(i => i.serial_id === s.id)).map(s => (
                                                    <button key={s.id} type="button" onClick={() => elegirSerial(s.id, s.numero_serial)} className="w-full text-left p-2 bg-navy-3 rounded-lg text-xs font-mono text-white hover:bg-navy-3/70">{s.numero_serial}</button>
                                                ))}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="relative mb-2">
                                            <input type="text" placeholder="Buscar producto en inventario…" className="w-full bg-navy-3 border border-navy-3 rounded-lg p-2.5 text-white text-sm focus:border-gold outline-none transition-all" value={busquedaProducto} onChange={e => setBusquedaProducto(e.target.value)} />
                                            {productosFiltrados.length > 0 && (
                                                <div className="absolute z-50 w-full bg-navy shadow-xl rounded-lg mt-1 border border-navy-3 max-h-48 overflow-y-auto">
                                                    {productosFiltrados.map(p => (
                                                        <button key={p.id} type="button" onClick={() => elegirProducto(p.id)} className="w-full text-left p-2.5 hover:bg-navy-3 text-xs border-b border-navy-3 last:border-0 text-white flex justify-between gap-2">
                                                            <span className="truncate">{p.nombre}{p.serializable ? ' 📱' : ''}</span>
                                                            <span className="text-vr-gray font-mono shrink-0">{formatDOP(p.precio_venta)}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {formData.items.length > 0 && (
                                        <div className="space-y-2">
                                            {formData.items.map((it, i) => (
                                                <div key={i} className="flex items-center gap-2 bg-navy-3 rounded-lg p-2">
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-xs font-bold text-white truncate">{it.nombre}</p>
                                                        {it.serial_numero && <p className="text-[10px] font-mono text-gold/70 truncate">S/N: {it.serial_numero}</p>}
                                                    </div>
                                                    {!it.serial_id && <input type="number" step="any" min="1" title="Cantidad" className="w-12 bg-navy-2 border border-navy-2 rounded text-center text-white text-xs font-mono p-1 outline-none focus:border-gold" value={it.cantidad} onChange={e => actualizarItem(i, 'cantidad', e.target.value)} />}
                                                    <input type="number" step="0.01" min="0" title="Precio" className="w-20 bg-navy-2 border border-navy-2 rounded text-right text-white text-xs font-mono p-1 outline-none focus:border-gold" value={it.precio_unitario} onChange={e => actualizarItem(i, 'precio_unitario', e.target.value)} />
                                                    <button type="button" onClick={() => quitarItem(i)} className="text-vr-red font-bold px-1 shrink-0">✕</button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* Abono inicial */}
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Abono inicial (RD$)</label>
                                        <input type="number" step="0.01" min="0" placeholder="0 (opcional)" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono focus:border-gold outline-none transition-all" value={formData.abono} onChange={e => setFormData({ ...formData, abono: e.target.value })} />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Total</label>
                                        <div className="w-full bg-gold/5 border border-gold/15 rounded-xl p-3 font-mono font-black text-gold text-right">{formatDOP(totalForm)}</div>
                                    </div>
                                </div>
                                {(parseFloat(formData.abono) || 0) > 0 && (
                                    <div className="grid grid-cols-3 gap-2">
                                        {METODOS.map(m => (
                                            <button key={m} type="button" onClick={() => setFormData({ ...formData, metodo_abono: m })} className={`py-2 rounded-lg border text-xs font-bold capitalize transition-all ${formData.metodo_abono === m ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}>{m}</button>
                                        ))}
                                    </div>
                                )}

                                <div className="pt-2 flex gap-3">
                                    <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                                    <button type="submit" disabled={guardando} className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-40">{guardando ? 'Guardando…' : 'Crear apartado'}</button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}

                {/* MODAL ABONO */}
                {abonando && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                        <div className="bg-navy-2 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                            <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                <div>
                                    <h2 className="text-xl font-display font-bold text-white">Registrar abono</h2>
                                    <p className="text-sm text-vr-gray mt-0.5">{abonando.folio} · Saldo {formatDOP(Math.max(0, abonando.total - abonando.abonado))}</p>
                                </div>
                                <button onClick={() => setAbonando(null)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                            </div>
                            <div className="p-4 sm:p-6 space-y-4">
                                <div>
                                    <label className="block text-xs font-bold text-vr-gray uppercase tracking-wider mb-1.5">Monto</label>
                                    <input type="number" step="0.01" min="0" autoFocus className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono text-xl text-center focus:border-gold outline-none transition-all" value={montoAbono} onChange={e => setMontoAbono(e.target.value)} placeholder="0" />
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                    {METODOS.map(m => (
                                        <button key={m} type="button" onClick={() => setMetodoAbono(m)} className={`py-2.5 rounded-lg border text-xs font-bold capitalize transition-all ${metodoAbono === m ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}>{m}</button>
                                    ))}
                                </div>
                                <div className="flex gap-3">
                                    <button type="button" onClick={() => setAbonando(null)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                                    <button type="button" onClick={conCandado(guardarAbono)} disabled={ocupado} className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-50">{ocupado ? 'Guardando…' : 'Guardar abono'}</button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* MODAL COMPLETAR */}
                {completando && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                        <div className="bg-navy-2 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                            <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                <div>
                                    <h2 className="text-xl font-display font-bold text-white">Entregar apartado</h2>
                                    <p className="text-sm text-vr-gray mt-0.5">{completando.folio} · {completando.cliente_nombre}</p>
                                </div>
                                <button onClick={() => setCompletando(null)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                            </div>
                            <div className="p-4 sm:p-6 space-y-4">
                                {(() => {
                                    const saldo = Math.max(0, completando.total - completando.abonado);
                                    return (
                                        <>
                                            <div className="flex justify-between items-center bg-navy rounded-xl px-4 py-3 border border-navy-3">
                                                <span className="text-sm text-vr-gray font-bold">{saldo > 0 ? 'Saldo a cobrar ahora' : 'Saldado'}</span>
                                                <span className="font-mono font-black text-white text-lg">{formatDOP(saldo)}</span>
                                            </div>
                                            {saldo > 0 && (
                                                <div className="grid grid-cols-3 gap-2">
                                                    {METODOS.map(m => (
                                                        <button key={m} type="button" onClick={() => setMetodoFinal(m)} className={`py-2.5 rounded-lg border text-xs font-bold capitalize transition-all ${metodoFinal === m ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}>{m}</button>
                                                    ))}
                                                </div>
                                            )}
                                            <p className="text-[11px] text-vr-gray">Al entregar, los equipos con número de serie quedan vendidos con su garantía.</p>
                                            <div className="flex gap-3">
                                                <button type="button" onClick={() => setCompletando(null)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                                                <button type="button" onClick={confirmarCompletar} className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all">{saldo > 0 ? 'Cobrar y entregar' : 'Entregar'}</button>
                                            </div>
                                        </>
                                    );
                                })()}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Recibo oculto */}
            {recibo && (
                <div style={{ display: 'none' }}>
                    <TicketApartado
                        ref={ticketRef}
                        apartado={recibo.ap}
                        modo={recibo.modo}
                        nombreNegocio={negocioNombre || 'VentaRD'}
                        rnc={negocioRnc || undefined}
                        direccion={negocioDireccion || undefined}
                        telefono={negocioTelefono || undefined}
                    />
                </div>
            )}

            <ConfirmModal
                isOpen={!!cancelando}
                title="Cancelar apartado"
                mensaje={<>¿Cancelar el apartado <span className="font-bold text-white">{cancelando?.folio}</span>? Los artículos vuelven al inventario. Los abonos quedan registrados.</>}
                confirmLabel="Sí, cancelar"
                onConfirm={confirmarCancelar}
                onClose={() => setCancelando(null)}
            />
        </PinGuard>
    );
}
