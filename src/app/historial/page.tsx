// src/app/historial/page.tsx
'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import Link from 'next/link';
import { db } from '@/lib/db/dexie';
import { registrarMovimientoStock } from '@/lib/db/stock';
import { useVentasTenant, useVentaDetallesPorVentas, useDevolucionesTenant, useClientesTenant, useProductosTenant } from '@/lib/db/tenantQuery';
import { useConfigStore } from '@/store/useConfigStore';
import { VentaLocal, VentaDetalleLocal, SerialLocal } from '@/types/database';
import { formatDOP, formatTicket } from '@/lib/utils';
import { logoParaImprimir } from '@/lib/logoCache';
import { v4 as uuidv4 } from 'uuid';
import { useLiveQuery } from 'dexie-react-hooks';
import { useReactToPrint } from 'react-to-print';
import { TicketVenta } from '@/components/TicketVenta';
import { CartItem } from '@/store/useCartStore';
import PinGuard from '@/components/ui/PinGuard';
import ConfirmModal from '@/components/ui/ConfirmModal';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';
import { SkeletonTable } from '@/components/ui/Skeleton';
import Pagination from '@/components/ui/Pagination';

const METODO_LABEL: Record<string, string> = {
    efectivo: 'Efectivo',
    tarjeta: 'Tarjeta',
    transferencia: 'Transfer.',
    fiado: 'Fiado',
    mixto: 'Mixto',
};

const METODO_COLOR: Record<string, string> = {
    efectivo: 'text-vr-green bg-vr-green/10 border-vr-green/20',
    tarjeta: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
    transferencia: 'text-purple-400 bg-purple-400/10 border-purple-400/20',
    fiado: 'text-vr-orange bg-vr-orange/10 border-vr-orange/20',
    mixto: 'text-gold bg-gold/10 border-gold/20',
};

const RAZONES = ['Producto defectuoso', 'Error de cobro', 'Cliente no lo quiso', 'Producto incorrecto', 'Otro'];

// Config visual del feed unificado de movimientos
const MOV_META: Record<string, { icono: string; label: string }> = {
    venta: { icono: '💰', label: 'Venta' },
    reparacion: { icono: '🔧', label: 'Reparación' },
    apartado: { icono: '🔖', label: 'Apartado' },
    devolucion: { icono: '↩️', label: 'Devolución' },
    gasto: { icono: '💸', label: 'Gasto' },
};

interface ItemDevolucion {
    producto_id: string;
    nombre: string;
    cantidad_original: number;
    precio_unitario: number;
    cantidad_devolver: number;
    seleccionado: boolean;
}

export default function HistorialPage() {
    const { negocioId, showToast, negocioNombre, negocioRnc, negocioDireccion, negocioTelefono, negocioMensajeTicket, negocioLogo, impresion, rolUsuario, planTier } = useConfigStore();
    const [confirmDevolucionPin, setConfirmDevolucionPin] = useState(false);
    const ventasRaw = useLiveQuery(
        () => negocioId ? db.ventas.where('negocio_id').equals(negocioId).limit(1).toArray() : [],
        [negocioId]
    );
    const isLoading = ventasRaw === undefined;
    const ventas = useVentasTenant(200);
    // Solo los detalles de las ventas visibles (no toda la historia)
    const detalles = useVentaDetallesPorVentas(useMemo(() => ventas.map(v => v.id), [ventas]));
    const devoluciones = useDevolucionesTenant();
    const clientes = useClientesTenant();

    // Logo cacheado como data URL (imprime bien offline; ver logoCache.ts)
    const [logoTicket, setLogoTicket] = useState<string | undefined>(undefined);
    useEffect(() => {
        let vivo = true;
        logoParaImprimir(negocioLogo).then(d => { if (vivo) setLogoTicket(d); });
        return () => { vivo = false; };
    }, [negocioLogo]);

    // Estado para reimprimir ticket
    const ticketReimpresionRef = useRef<HTMLDivElement>(null);
    const [ventaReimprimiendo, setVentaReimprimiendo] = useState<VentaLocal | null>(null);
    const [itemsReimpresion, setItemsReimpresion] = useState<CartItem[]>([]);
    const handleReimprimir = useReactToPrint({ contentRef: ticketReimpresionRef });

    const clienteDeVenta = (v: VentaLocal | null) => v?.cliente_nombre ?? (v?.cliente_id ? clientes.find(c => c.id === v.cliente_id)?.nombre : undefined);

    const abrirReimpresion = async (venta: VentaLocal) => {
        const detallesVenta = detallesPorVenta.get(venta.id) || [];
        const prods = await db.productos.bulkGet(detallesVenta.map(d => d.producto_id));
        // Seriales de esta venta agrupados por producto (para mostrar el S/N en el ticket)
        const serialesPorProducto = new Map<string, string[]>();
        (serialesPorVenta.get(venta.id) || []).forEach(s => {
            const arr = serialesPorProducto.get(s.producto_id) || [];
            arr.push(s.numero_serial);
            serialesPorProducto.set(s.producto_id, arr);
        });
        const cartItems: CartItem[] = detallesVenta.map((d, i) => ({
            id: d.producto_id,
            nombre: d.nombre || prods[i]?.nombre || 'Producto eliminado',
            precio_venta: d.precio_unitario,
            cantidad: d.cantidad,
            negocio_id: d.negocio_id,
            codigo_barras: prods[i]?.codigo_barras || '',
            costo: prods[i]?.costo || 0,
            stock_actual: prods[i]?.stock_actual || 0,
            stock_minimo: prods[i]?.stock_minimo || 0,
            tasa_itbis: prods[i]?.tasa_itbis || 0,
            tipo: prods[i]?.tipo || 'simple',
            ...(prods[i]?.ubicacion && { ubicacion: prods[i]!.ubicacion }),
            ...(serialesPorProducto.has(d.producto_id) && { serial_numero: serialesPorProducto.get(d.producto_id)!.join(', ') }),
        }));
        setItemsReimpresion(cartItems);
        setVentaReimprimiendo(venta);

        // Impresión directa ESC/POS si está configurada
        if (impresion.modoImpresion === 'directa') {
            try {
                const { imprimirVentaDirecta } = await import('@/lib/print/tickets');
                await imprimirVentaDirecta({
                    items: cartItems.map(i => ({ cantidad: i.cantidad, nombre: i.nombre, precio: i.precio_venta, ubicacion: i.ubicacion })),
                    subtotal: cartItems.reduce((s, i) => s + i.precio_venta * i.cantidad, 0),
                    itbis: cartItems.reduce((s, i) => s + i.precio_venta * i.cantidad * (i.tasa_itbis || 0), 0),
                    descuento: 0,
                    total: venta.total,
                    metodoPago: venta.metodo_pago,
                    montoRecibido: venta.total,
                    devuelta: 0,
                    negocio: {
                        nombre: negocioNombre || 'VentaRD',
                        rnc: negocioRnc || undefined,
                        direccion: negocioDireccion || undefined,
                        telefono: negocioTelefono || undefined,
                    },
                    numeroTicket: venta.numero_ticket,
                    cajaCodigo: venta.caja_codigo,
                    ncf: venta.ncf,
                    vendedor: venta.vendedor_nombre,
                    mensajePie: negocioMensajeTicket || undefined,
                    clienteNombre: clienteDeVenta(venta),
                    logoUrl: logoTicket,
                }, impresion);
                return;
            } catch (e) {
                console.error('[print] impresión directa falló, usando navegador:', e);
                showToast('Impresora directa no disponible — usando impresión del navegador.', 'info');
            }
        }

        // Pequeño delay para que React renderice el ticket antes de imprimir
        setTimeout(() => handleReimprimir(), 100);
    };

    const [filtroMetodo, setFiltroMetodo] = useState<string>('todos');
    // Vista: 'ventas' (tabla detallada de siempre) | 'movimientos' (todo unificado)
    const [vista, setVista] = useState<'ventas' | 'movimientos'>('ventas');
    const esPro = planTier === 'pro';
    type MovTipo = 'venta' | 'reparacion' | 'apartado' | 'devolucion' | 'gasto';
    const [movFiltro, setMovFiltro] = useState<MovTipo | 'todo'>('todo');
    const ITEMS_POR_PAGINA = 25;
    const [pagina, setPagina] = useState(1);
    const [ventaExpandida, setVentaExpandida] = useState<string | null>(null);
    const [modalVenta, setModalVenta] = useState<VentaLocal | null>(null);
    const [itemsDevolucion, setItemsDevolucion] = useState<ItemDevolucion[]>([]);
    const [razon, setRazon] = useState(RAZONES[0]);
    const [procesando, setProcesando] = useState(false);

    const devolucionesMap = useMemo(() => {
        const m = new Map<string, boolean>();
        devoluciones.forEach(d => m.set(d.venta_id, true));
        return m;
    }, [devoluciones]);

    const detallesPorVenta = useMemo(() => {
        const m = new Map<string, VentaDetalleLocal[]>();
        detalles.forEach(d => {
            const arr = m.get(d.venta_id) || [];
            arr.push(d);
            m.set(d.venta_id, arr);
        });
        return m;
    }, [detalles]);

    const clientesMap = useMemo(() => {
        const m = new Map<string, string>();
        clientes.forEach(c => m.set(c.id, c.nombre));
        return m;
    }, [clientes]);

    // ── Fuentes para el feed de Movimientos ───────────────────────────────────
    const reparacionesRaw = useLiveQuery(
        () => (esPro && negocioId) ? db.reparaciones.where('negocio_id').equals(negocioId).toArray() : [],
        [esPro, negocioId]
    );
    const apartadosMovRaw = useLiveQuery(
        () => (esPro && negocioId) ? db.apartados.where('negocio_id').equals(negocioId).toArray() : [],
        [esPro, negocioId]
    );
    const gastosRaw = useLiveQuery(
        () => negocioId ? db.gastos.where('negocio_id').equals(negocioId).toArray() : [],
        [negocioId]
    );

    interface Mov {
        key: string; tipo: MovTipo; fecha: number; titulo: string; sub?: string;
        monto: number; signo: 'in' | 'out'; estado?: string; href?: string;
    }

    const movimientos = useMemo<Mov[]>(() => {
        const reps = reparacionesRaw ?? [];
        const aps = apartadosMovRaw ?? [];
        const gastos = (gastosRaw ?? []).filter(g => !g.eliminado);
        const lista: Mov[] = [];

        ventas.forEach(v => lista.push({
            key: `v-${v.id}`, tipo: 'venta', fecha: v.fecha_creacion,
            titulo: `Venta #${formatTicket(v.numero_ticket, v.caja_codigo)}`,
            sub: v.metodo_pago === 'fiado' && v.cliente_id ? (clientesMap.get(v.cliente_id) || 'Fiado') : undefined,
            monto: v.total, signo: 'in',
        }));
        reps.forEach(r => lista.push({
            key: `r-${r.id}`, tipo: 'reparacion', fecha: r.fecha_creacion,
            titulo: `${r.folio} · ${[r.equipo_marca, r.equipo_modelo].filter(Boolean).join(' ')}`,
            sub: r.cliente_nombre, monto: r.total, signo: 'in', estado: r.estado, href: '/reparaciones',
        }));
        aps.forEach(a => lista.push({
            key: `a-${a.id}`, tipo: 'apartado', fecha: a.fecha_creacion,
            titulo: `${a.folio} · ${a.items.map(i => i.nombre).join(', ')}`,
            sub: `${a.cliente_nombre} · abonado ${formatDOP(a.abonado)}`, monto: a.total, signo: 'in', estado: a.estado, href: '/apartados',
        }));
        devoluciones.forEach(d => lista.push({
            key: `d-${d.id}`, tipo: 'devolucion', fecha: d.fecha_creacion,
            titulo: 'Devolución', sub: d.razon, monto: d.monto_devuelto, signo: 'out',
        }));
        gastos.forEach(g => lista.push({
            key: `g-${g.id}`, tipo: 'gasto', fecha: g.fecha_creacion,
            titulo: g.descripcion || 'Gasto', sub: g.categoria, monto: g.monto, signo: 'out',
        }));

        return lista.sort((a, b) => b.fecha - a.fecha);
    }, [ventas, reparacionesRaw, apartadosMovRaw, devoluciones, gastosRaw, clientesMap]);

    const movimientosFiltrados = useMemo(
        () => movFiltro === 'todo' ? movimientos : movimientos.filter(m => m.tipo === movFiltro),
        [movimientos, movFiltro]
    );

    // Seriales (IMEI) vendidos, agrupados por venta — para mostrarlos en el detalle
    // y en la reimpresión. venta_id no está indexado, así que filtramos en memoria.
    const serialesNegocioRaw = useLiveQuery(
        () => negocioId ? db.seriales.where('negocio_id').equals(negocioId).toArray() : [],
        [negocioId]
    );
    const serialesNegocio = useMemo(() => serialesNegocioRaw ?? [], [serialesNegocioRaw]);
    const serialesPorVenta = useMemo(() => {
        const m = new Map<string, SerialLocal[]>();
        serialesNegocio.forEach(s => {
            if (!s.venta_id) return;
            const arr = m.get(s.venta_id) || [];
            arr.push(s);
            m.set(s.venta_id, arr);
        });
        return m;
    }, [serialesNegocio]);

    const productosArr = useProductosTenant();
    const prodNombres = useMemo(() => {
        const m = new Map<string, string>();
        productosArr.forEach(p => m.set(p.id, p.nombre));
        return m;
    }, [productosArr]);

    const ventasFiltradas = useMemo(() => {
        if (filtroMetodo === 'todos') return ventas;
        return ventas.filter(v => v.metodo_pago === filtroMetodo);
    }, [ventas, filtroMetodo]);

    useEffect(() => { setPagina(1); }, [filtroMetodo, vista, movFiltro]);

    const ventasPaginadas = useMemo(() => {
        const inicio = (pagina - 1) * ITEMS_POR_PAGINA;
        return ventasFiltradas.slice(inicio, inicio + ITEMS_POR_PAGINA);
    }, [ventasFiltradas, pagina]);
    const totalPaginas = Math.ceil(ventasFiltradas.length / ITEMS_POR_PAGINA);

    const movimientosPaginados = useMemo(() => {
        const inicio = (pagina - 1) * ITEMS_POR_PAGINA;
        return movimientosFiltrados.slice(inicio, inicio + ITEMS_POR_PAGINA);
    }, [movimientosFiltrados, pagina]);
    const totalPaginasMov = Math.ceil(movimientosFiltrados.length / ITEMS_POR_PAGINA);

    const abrirDevolucion = (venta: VentaLocal) => {
        const items = detallesPorVenta.get(venta.id) || [];
        setItemsDevolucion(items.map(d => ({
            producto_id: d.producto_id,
            nombre: d.nombre || 'Producto',
            cantidad_original: d.cantidad,
            precio_unitario: d.precio_unitario,
            cantidad_devolver: d.cantidad,
            seleccionado: true,
        })));

        db.productos.bulkGet(items.map(d => d.producto_id)).then(prods => {
            setItemsDevolucion(items.map((d, i) => ({
                producto_id: d.producto_id,
                nombre: d.nombre || prods[i]?.nombre || 'Producto eliminado',
                cantidad_original: d.cantidad,
                precio_unitario: d.precio_unitario,
                cantidad_devolver: d.cantidad,
                seleccionado: true,
            })));
        });

        setModalVenta(venta);
        setRazon(RAZONES[0]);
    };

    const montoDevolucion = useMemo(() => {
        return itemsDevolucion
            .filter(i => i.seleccionado && i.cantidad_devolver > 0)
            .reduce((sum, i) => sum + i.precio_unitario * i.cantidad_devolver, 0);
    }, [itemsDevolucion]);

    const confirmarDevolucion = async () => {
        if (!modalVenta || !negocioId || procesando) return;
        const seleccionados = itemsDevolucion.filter(i => i.seleccionado && i.cantidad_devolver > 0);
        if (seleccionados.length === 0) {
            showToast('Selecciona al menos un ítem para devolver.', 'error');
            return;
        }

        setProcesando(true);
        try {
            const idDevolucion = uuidv4();
            await db.transaction('rw', [db.devoluciones, db.productos, db.composiciones, db.transacciones_fiado, db.movimientos_stock], async () => {
                await db.devoluciones.add({
                    id: idDevolucion,
                    negocio_id: negocioId,
                    venta_id: modalVenta.id,
                    items_devueltos: seleccionados.map(i => ({
                        producto_id: i.producto_id,
                        cantidad: i.cantidad_devolver,
                        precio_unitario: i.precio_unitario,
                    })),
                    monto_devuelto: montoDevolucion,
                    razon,
                    fecha_creacion: Date.now(),
                    estado_sincronizacion: 0,
                });

                for (const item of seleccionados) {
                    const receta = await db.composiciones
                        .where('producto_padre_id').equals(item.producto_id).toArray();

                    if (receta.length > 0) {
                        // Combo devuelto: reponer cada insumo según la receta
                        for (const ing of receta) {
                            await registrarMovimientoStock({
                                productoId: ing.insumo_id,
                                tipo: 'devolucion',
                                delta: ing.cantidad_necesaria * item.cantidad_devolver,
                                referenciaId: idDevolucion,
                            });
                        }
                    } else {
                        await registrarMovimientoStock({
                            productoId: item.producto_id,
                            tipo: 'devolucion',
                            delta: item.cantidad_devolver,
                            referenciaId: idDevolucion,
                        });
                    }
                }

                if (modalVenta.metodo_pago === 'fiado') {
                    const tFiado = await db.transacciones_fiado
                        .where('venta_id').equals(modalVenta.id).first();
                    if (tFiado) {
                        await db.transacciones_fiado.add({
                            id: uuidv4(),
                            negocio_id: negocioId,
                            cliente_id: tFiado.cliente_id,
                            venta_id: modalVenta.id,
                            tipo: 'abono',
                            monto: montoDevolucion,
                            concepto: `Devolución — ${razon}`,
                            fecha_creacion: Date.now(),
                            estado_sincronizacion: 0,
                            fecha_actualizacion: Date.now(),
                        });
                    }
                }
            });

            showToast('Devolución registrada correctamente.', 'success');
            setModalVenta(null);
        } catch (err) {
            console.error('[devolucion]', err);
            showToast('Error al procesar la devolución.', 'error');
        } finally {
            setProcesando(false);
        }
    };

    const formatFecha = (ts: number) =>
        new Date(ts).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' });

    return (
        <PinGuard title="Historial de Ventas">
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <OfflineBanner />

                {/* Ticket oculto para reimpresión */}
                {ventaReimprimiendo && (
                    <div style={{ display: 'none' }}>
                        <TicketVenta
                            ref={ticketReimpresionRef}
                            items={itemsReimpresion}
                            subtotal={itemsReimpresion.reduce((s, i) => s + i.precio_venta * i.cantidad, 0)}
                            itbis={itemsReimpresion.reduce((s, i) => s + i.precio_venta * i.cantidad * (i.tasa_itbis || 0), 0)}
                            total={ventaReimprimiendo.total}
                            metodoPago={ventaReimprimiendo.metodo_pago}
                            montoRecibido={String(ventaReimprimiendo.total)}
                            devuelta={0}
                            nombreNegocio={negocioNombre || 'VentaRD'}
                            rnc={negocioRnc || undefined}
                            direccion={negocioDireccion || undefined}
                            telefono={negocioTelefono || undefined}
                            numeroTicket={ventaReimprimiendo.numero_ticket}
                            cajaCodigo={ventaReimprimiendo.caja_codigo}
                            mensajePie={negocioMensajeTicket || undefined}
                            ncf={ventaReimprimiendo.ncf}
                            logoUrl={logoTicket}
                            clienteNombre={clienteDeVenta(ventaReimprimiendo)}
                            vendedor={ventaReimprimiendo.vendedor_nombre}
                        />
                    </div>
                )}

                <div className="flex-1 p-3 sm:p-6">
                    <div className="max-w-5xl mx-auto">

                        {/* Header */}
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-4 sm:mb-6">
                            <div>
                                <h1 className="text-2xl sm:text-3xl font-display font-extrabold text-white">Historial</h1>
                                <p className="text-vr-gray mt-0.5 text-sm">
                                    {vista === 'ventas' ? `${ventas.length} ventas registradas` : `${movimientosFiltrados.length} movimientos`}
                                </p>
                            </div>
                            {/* Toggle de vista */}
                            <div className="flex bg-navy-2 border border-navy-3 rounded-xl p-1 gap-1 self-start">
                                {([['ventas', 'Ventas'], ['movimientos', 'Movimientos']] as const).map(([k, label]) => (
                                    <button
                                        key={k}
                                        onClick={() => setVista(k)}
                                        className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${vista === k ? 'bg-gold text-navy' : 'text-vr-gray hover:text-white'}`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Filtros de método (solo vista Ventas) */}
                        {vista === 'ventas' && (
                        <div className="flex gap-1.5 sm:gap-2 mb-4 sm:mb-6 flex-wrap">
                            {['todos', 'efectivo', 'tarjeta', 'transferencia', 'fiado', 'mixto'].map(m => (
                                <button
                                    key={m}
                                    onClick={() => setFiltroMetodo(m)}
                                    className={`px-3 sm:px-4 py-1.5 rounded-full text-xs sm:text-sm font-bold border transition-all capitalize ${
                                        filtroMetodo === m
                                            ? 'bg-gold/15 border-gold text-gold'
                                            : 'border-navy-3 text-vr-gray hover:text-white'
                                    }`}
                                >
                                    {m === 'todos' ? 'Todos' : METODO_LABEL[m] || m}
                                </button>
                            ))}
                        </div>
                        )}

                        {/* Chips de tipo (solo vista Movimientos) */}
                        {vista === 'movimientos' && (
                        <div className="flex gap-1.5 sm:gap-2 mb-4 sm:mb-6 flex-wrap">
                            {([
                                ['todo', 'Todo'], ['venta', 'Ventas'],
                                ...(esPro ? [['reparacion', 'Reparaciones'], ['apartado', 'Apartados']] as const : []),
                                ['devolucion', 'Devoluciones'], ['gasto', 'Gastos'],
                            ] as const).map(([k, label]) => (
                                <button
                                    key={k}
                                    onClick={() => setMovFiltro(k as MovTipo | 'todo')}
                                    className={`px-3 sm:px-4 py-1.5 rounded-full text-xs sm:text-sm font-bold border transition-all ${
                                        movFiltro === k ? 'bg-gold/15 border-gold text-gold' : 'border-navy-3 text-vr-gray hover:text-white'
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        )}

                        {/* Tabla de ventas */}
                        {vista === 'ventas' && (
                        <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                            {isLoading ? (
                                <table className="w-full">
                                    <tbody><SkeletonTable rows={8} cols={5} /></tbody>
                                </table>
                            ) : ventasFiltradas.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-20 text-vr-gray">
                                    <span className="text-4xl mb-3">🗒️</span>
                                    <p className="font-medium">No hay ventas registradas</p>
                                </div>
                            ) : (
                                <>
                                <div className="overflow-x-auto">
                                <table className="w-full text-left">
                                    <thead>
                                        <tr className="border-b border-navy-3 text-vr-gray text-xs uppercase tracking-wider">
                                            <th className="p-3 sm:p-4 font-semibold">Ticket</th>
                                            <th className="p-3 sm:p-4 font-semibold hidden sm:table-cell">Fecha</th>
                                            <th className="p-3 sm:p-4 font-semibold hidden md:table-cell">Método</th>
                                            <th className="p-3 sm:p-4 font-semibold">Total</th>
                                            <th className="p-3 sm:p-4 font-semibold text-right">Acciones</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {ventasPaginadas.map(venta => {
                                            const yaDevuelta = devolucionesMap.has(venta.id);
                                            const isExpanded = ventaExpandida === venta.id;
                                            const items = detallesPorVenta.get(venta.id) || [];

                                            return (
                                                <React.Fragment key={venta.id}>
                                                    <tr
                                                        className="border-b border-navy-3/50 hover:bg-navy-3/20 transition-colors cursor-pointer"
                                                        onClick={() => setVentaExpandida(isExpanded ? null : venta.id)}
                                                    >
                                                        <td className="p-3 sm:p-4">
                                                            <span className="font-mono font-bold text-white text-sm block">
                                                                #{formatTicket(venta.numero_ticket, venta.caja_codigo)}
                                                            </span>
                                                            {/* Show method badge on mobile (hidden on md+) */}
                                                            <span className={`md:hidden mt-1 inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border ${METODO_COLOR[venta.metodo_pago] || 'text-vr-gray border-navy-3'}`}>
                                                                {METODO_LABEL[venta.metodo_pago] || venta.metodo_pago}
                                                            </span>
                                                            {/* Show date on xs (hidden on sm+) */}
                                                            <span className="sm:hidden block text-xs text-vr-gray mt-0.5">{formatFecha(venta.fecha_creacion)}</span>
                                                        </td>
                                                        <td className="p-3 sm:p-4 text-vr-gray text-sm hidden sm:table-cell">{formatFecha(venta.fecha_creacion)}</td>
                                                        <td className="p-3 sm:p-4 hidden md:table-cell">
                                                            <span className={`px-2 py-0.5 rounded text-xs font-bold border ${METODO_COLOR[venta.metodo_pago] || 'text-vr-gray'}`}>
                                                                {METODO_LABEL[venta.metodo_pago] || venta.metodo_pago}
                                                            </span>
                                                            {venta.metodo_pago === 'fiado' && venta.cliente_id && (
                                                                <span className="ml-2 text-xs text-vr-gray">{clientesMap.get(venta.cliente_id) || ''}</span>
                                                            )}
                                                        </td>
                                                        <td className="p-3 sm:p-4 font-mono font-bold text-gold text-sm">{formatDOP(venta.total)}</td>
                                                        <td className="p-3 sm:p-4 text-right" onClick={e => e.stopPropagation()}>
                                                            <div className="flex items-center justify-end gap-1.5 sm:gap-2">
                                                                <button
                                                                    onClick={() => abrirReimpresion(venta)}
                                                                    className="text-vr-gray hover:text-white text-xs font-bold border border-navy-3 px-2 sm:px-3 py-1.5 rounded-lg hover:bg-navy-3 transition-all"
                                                                    title="Reimprimir ticket"
                                                                >
                                                                    🖨️
                                                                </button>
                                                                {yaDevuelta ? (
                                                                    <span className="text-xs text-vr-gray italic px-2 sm:px-3 py-1.5 border border-navy-3 rounded-lg">Devuelta</span>
                                                                ) : (
                                                                    <button
                                                                        onClick={() => abrirDevolucion(venta)}
                                                                        className="text-vr-red hover:text-vr-red/80 text-xs sm:text-sm font-bold border border-vr-red/20 px-2 sm:px-3 py-1.5 rounded-lg hover:bg-vr-red/10 transition-all whitespace-nowrap"
                                                                    >
                                                                        Devolver
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </td>
                                                    </tr>

                                                    {isExpanded && (
                                                        <tr className="bg-navy/40">
                                                            <td colSpan={5} className="px-4 sm:px-6 py-3">
                                                                {items.length === 0 ? (
                                                                    <p className="text-xs text-vr-gray italic">Sin detalles disponibles</p>
                                                                ) : (
                                                                    <div className="space-y-1">
                                                                        {items.map(d => (
                                                                            <div key={d.id} className="flex justify-between text-xs text-vr-gray">
                                                                                <span>{d.cantidad}x <span className="text-white font-medium">{d.nombre || prodNombres.get(d.producto_id) || 'Producto eliminado'}</span></span>
                                                                                <span className="font-mono">{formatDOP(d.subtotal)}</span>
                                                                            </div>
                                                                        ))}
                                                                        {(serialesPorVenta.get(venta.id) || []).length > 0 && (
                                                                            <div className="mt-2 pt-2 border-t border-navy-3 space-y-0.5">
                                                                                {serialesPorVenta.get(venta.id)!.map(s => (
                                                                                    <div key={s.id} className="flex items-center gap-2 text-xs">
                                                                                        <span className="text-vr-gray">📱 IMEI/Serie:</span>
                                                                                        <span className="font-mono font-bold text-gold">{s.numero_serial}</span>
                                                                                    </div>
                                                                                ))}
                                                                            </div>
                                                                        )}
                                                                        {venta.ncf && (
                                                                            <div className="mt-2 pt-2 border-t border-navy-3 flex items-center gap-2 text-xs">
                                                                                <span className="text-vr-gray">NCF:</span>
                                                                                <span className="font-mono font-bold text-blue-300">{venta.ncf}</span>
                                                                            </div>
                                                                        )}
                                                                        {venta.metodo_pago === 'mixto' && (
                                                                            <div className="mt-2 pt-2 border-t border-navy-3 flex flex-wrap gap-3 text-xs">
                                                                                {venta.monto_efectivo != null && <span className="text-vr-green">Efectivo: {formatDOP(venta.monto_efectivo)}</span>}
                                                                                {venta.monto_transferencia != null && <span className="text-purple-400">Transfer.: {formatDOP(venta.monto_transferencia)}</span>}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    )}
                                                </React.Fragment>
                                            );
                                        })}
                                    </tbody>
                                </table>
                                </div>
                                <Pagination
                                    pagina={pagina}
                                    totalPaginas={totalPaginas}
                                    onCambiar={setPagina}
                                    totalItems={ventasFiltradas.length}
                                    itemsPorPagina={ITEMS_POR_PAGINA}
                                />
                                </>
                            )}
                        </div>
                        )}

                        {/* Feed unificado de movimientos */}
                        {vista === 'movimientos' && (
                        <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                            {isLoading ? (
                                <table className="w-full"><tbody><SkeletonTable rows={8} cols={3} /></tbody></table>
                            ) : movimientosFiltrados.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-20 text-vr-gray">
                                    <span className="text-4xl mb-3">🧾</span>
                                    <p className="font-medium">No hay movimientos en esta vista</p>
                                </div>
                            ) : (
                                <>
                                <div className="divide-y divide-navy-3/50">
                                    {movimientosPaginados.map(m => {
                                        const meta = MOV_META[m.tipo];
                                        const contenido = (
                                            <div className="flex items-center gap-3 px-3 sm:px-4 py-3 hover:bg-navy-3/20 transition-colors">
                                                <span className="text-lg shrink-0">{meta.icono}</span>
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-bold text-white truncate">{m.titulo}</p>
                                                    <p className="text-[11px] text-vr-gray truncate">
                                                        {meta.label}{m.sub ? ` · ${m.sub}` : ''} · {formatFecha(m.fecha)}
                                                        {m.estado ? ` · ${m.estado}` : ''}
                                                    </p>
                                                </div>
                                                <span className={`font-mono font-black text-sm whitespace-nowrap shrink-0 ${m.signo === 'out' ? 'text-vr-red' : 'text-vr-green'}`}>
                                                    {m.signo === 'out' ? '−' : '+'}{formatDOP(m.monto)}
                                                </span>
                                            </div>
                                        );
                                        return m.href
                                            ? <Link key={m.key} href={m.href} className="block">{contenido}</Link>
                                            : <div key={m.key}>{contenido}</div>;
                                    })}
                                </div>
                                <Pagination
                                    pagina={pagina}
                                    totalPaginas={totalPaginasMov}
                                    onCambiar={setPagina}
                                    totalItems={movimientosFiltrados.length}
                                    itemsPorPagina={ITEMS_POR_PAGINA}
                                />
                                </>
                            )}
                        </div>
                        )}
                    </div>
                </div>

                {/* MODAL DEVOLUCIÓN — full screen on mobile */}
                {modalVenta && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                        <div className="bg-navy-2 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden max-h-[95vh] sm:max-h-[90vh] flex flex-col animate-scale-in">

                            <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                <div>
                                    <h2 className="text-lg sm:text-xl font-display font-bold text-white">Devolución</h2>
                                    <p className="text-sm text-vr-gray mt-0.5">
                                        Ticket #{formatTicket(modalVenta.numero_ticket, modalVenta.caja_codigo)} — {formatDOP(modalVenta.total)}
                                    </p>
                                </div>
                                <button onClick={() => setModalVenta(null)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                            </div>

                            <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4 sm:space-y-5">
                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-3 uppercase tracking-wider">Ítems a devolver</label>
                                    <div className="space-y-2">
                                        {itemsDevolucion.map((item, idx) => (
                                            <div key={item.producto_id} className={`flex items-center gap-2 sm:gap-3 p-3 rounded-xl border transition-all ${item.seleccionado ? 'border-vr-red/30 bg-vr-red/5' : 'border-navy-3 opacity-50'}`}>
                                                <input
                                                    type="checkbox"
                                                    checked={item.seleccionado}
                                                    onChange={e => {
                                                        const copy = [...itemsDevolucion];
                                                        copy[idx] = { ...copy[idx], seleccionado: e.target.checked };
                                                        setItemsDevolucion(copy);
                                                    }}
                                                    className="w-4 h-4 accent-vr-red shrink-0"
                                                />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-bold text-white truncate">{item.nombre}</p>
                                                    <p className="text-xs text-vr-gray font-mono">{formatDOP(item.precio_unitario)} × {item.cantidad_original}</p>
                                                </div>
                                                <div className="flex items-center gap-1 shrink-0">
                                                    <button
                                                        type="button"
                                                        disabled={!item.seleccionado || item.cantidad_devolver <= 1}
                                                        onClick={() => {
                                                            const copy = [...itemsDevolucion];
                                                            copy[idx] = { ...copy[idx], cantidad_devolver: copy[idx].cantidad_devolver - 1 };
                                                            setItemsDevolucion(copy);
                                                        }}
                                                        className="w-7 h-7 flex items-center justify-center bg-navy-3 rounded font-bold text-white disabled:opacity-30"
                                                    >-</button>
                                                    <span className="w-7 text-center font-mono font-bold text-white text-sm">{item.cantidad_devolver}</span>
                                                    <button
                                                        type="button"
                                                        disabled={!item.seleccionado || item.cantidad_devolver >= item.cantidad_original}
                                                        onClick={() => {
                                                            const copy = [...itemsDevolucion];
                                                            copy[idx] = { ...copy[idx], cantidad_devolver: copy[idx].cantidad_devolver + 1 };
                                                            setItemsDevolucion(copy);
                                                        }}
                                                        className="w-7 h-7 flex items-center justify-center bg-navy-3 rounded font-bold text-white disabled:opacity-30"
                                                    >+</button>
                                                </div>
                                                <span className="font-mono font-bold text-vr-red text-sm w-16 sm:w-20 text-right shrink-0">
                                                    {item.seleccionado ? formatDOP(item.precio_unitario * item.cantidad_devolver) : '-'}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-2 uppercase tracking-wider">Motivo</label>
                                    <select
                                        className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none"
                                        value={razon}
                                        onChange={e => setRazon(e.target.value)}
                                    >
                                        {RAZONES.map(r => <option key={r} value={r}>{r}</option>)}
                                    </select>
                                </div>

                                <div className="bg-navy rounded-xl p-4 flex justify-between items-center border border-navy-3">
                                    <span className="text-sm font-bold text-vr-gray">Monto a devolver</span>
                                    <span className="font-mono font-black text-vr-red text-xl">{formatDOP(montoDevolucion)}</span>
                                </div>

                                {modalVenta.metodo_pago === 'fiado' && (
                                    <div className="bg-vr-orange/5 border border-vr-orange/20 rounded-xl p-3 text-xs text-vr-orange font-bold">
                                        Esta venta era fiado — se creará un abono automático por {formatDOP(montoDevolucion)}.
                                    </div>
                                )}
                            </div>

                            <div className="p-4 sm:p-6 border-t border-navy-3 flex gap-3">
                                <button
                                    onClick={() => setModalVenta(null)}
                                    className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors"
                                >
                                    Cancelar
                                </button>
                                <button
                                    onClick={() => {
                                        // Devolución = dinero que sale: si no es admin, pedir autorización
                                        if (rolUsuario === 'admin') confirmarDevolucion();
                                        else setConfirmDevolucionPin(true);
                                    }}
                                    disabled={procesando || montoDevolucion === 0}
                                    className="flex-1 py-3 bg-vr-red/80 hover:bg-vr-red text-white font-extrabold rounded-xl transition-all disabled:opacity-40"
                                >
                                    {procesando ? 'Procesando...' : 'Confirmar'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Autorización del administrador para devoluciones de empleados */}
                <ConfirmModal
                    isOpen={confirmDevolucionPin}
                    title="Autorizar devolución"
                    mensaje="Una devolución reintegra dinero y repone stock. Requiere la autorización del administrador."
                    confirmLabel="Autorizar y devolver"
                    requierePinAdmin
                    procesando={procesando}
                    onConfirm={() => { setConfirmDevolucionPin(false); confirmarDevolucion(); }}
                    onClose={() => setConfirmDevolucionPin(false)}
                />
            </div>
        </PinGuard>
    );
}
