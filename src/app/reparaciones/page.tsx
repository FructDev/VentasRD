// src/app/reparaciones/page.tsx
'use client';

import { useMemo, useState, useRef } from 'react';
import { db, getNextFolioReparacion } from '@/lib/db/dexie';
import { registrarMovimientoStock } from '@/lib/db/stock';
import { useConfigStore } from '@/store/useConfigStore';
import { useProductosTenant } from '@/lib/db/tenantQuery';
import { useLiveQuery } from 'dexie-react-hooks';
import { ReparacionLocal, ReparacionEstado, RepuestoReparacion, MetodoPagoReparacion, ProductoLocal } from '@/types/database';
import { formatDOP } from '@/lib/utils';
import { v4 as uuidv4 } from 'uuid';
import { useReactToPrint } from 'react-to-print';
import { TicketReparacion } from '@/components/TicketReparacion';
import PinGuard from '@/components/ui/PinGuard';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';
import ConfirmModal from '@/components/ui/ConfirmModal';
import ClientePicker from '@/components/shared/ClientePicker';
import { SkeletonTable } from '@/components/ui/Skeleton';

const DIA = 24 * 60 * 60 * 1000;
const WHATSAPP_NUMBER_SOPORTE = '18294515303';

const norm = (s: string | null | undefined): string =>
    (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const ESTADOS: { key: ReparacionEstado; label: string; color: string }[] = [
    { key: 'recibido', label: 'Recibido', color: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
    { key: 'diagnostico', label: 'En diagnóstico', color: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
    { key: 'esperando_repuesto', label: 'Esperando repuesto', color: 'bg-vr-orange/15 text-vr-orange border-vr-orange/30' },
    { key: 'listo', label: 'Listo', color: 'bg-vr-green/15 text-vr-green border-vr-green/30' },
    { key: 'entregado', label: 'Entregado', color: 'bg-navy-3 text-vr-gray border-navy-3' },
    { key: 'cancelado', label: 'Cancelado', color: 'bg-vr-red/15 text-vr-red border-vr-red/30' },
];
const estadoMeta = (e: ReparacionEstado) => ESTADOS.find(x => x.key === e) ?? ESTADOS[0];

// Checklist de condición del equipo al recibirlo (común en celulares)
const CONDICION_ITEMS = [
    'Enciende',
    'Pantalla con rayones',
    'Pantalla rota / estrellada',
    'No enciende',
    'Mojado / humedad',
    'Carcasa / tapa dañada',
    'Botones con falla',
    'Con funda / mica',
    'Sin bandeja SIM',
];

const FORM_VACIO = {
    cliente_id: undefined as string | undefined,
    cliente_nombre: '', cliente_telefono: '', guardar_cliente: false,
    equipo_marca: '', equipo_modelo: '', equipo_imei: '', equipo_color: '', patron_clave: '',
    condicion_checklist: [] as string[],
    condicion_entrada: '', accesorios: '',
    problema_reportado: '', diagnostico: '',
    mano_obra: '', abono: '', metodo_abono: 'efectivo' as MetodoPagoReparacion,
    notas: '',
    repuestos: [] as RepuestoReparacion[],
};

export default function ReparacionesPage() {
    const { negocioId, sucursalId, planTier, showToast, negocioNombre, negocioRnc, negocioDireccion, negocioTelefono } = useConfigStore();
    const productos = useProductosTenant();

    const reparaciones = useLiveQuery(
        () => negocioId
            ? db.reparaciones.where('negocio_id').equals(negocioId).reverse().sortBy('fecha_creacion')
            : [],
        [negocioId]
    );
    const isLoading = reparaciones === undefined;
    const lista = useMemo(() => reparaciones ?? [], [reparaciones]);

    const [busqueda, setBusqueda] = useState('');
    const [filtro, setFiltro] = useState<ReparacionEstado | 'todos' | 'activas'>('activas');

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editando, setEditando] = useState<ReparacionLocal | null>(null);
    const [formData, setFormData] = useState(FORM_VACIO);
    const [busquedaRepuesto, setBusquedaRepuesto] = useState('');
    const [guardando, setGuardando] = useState(false);

    // Entrega
    const [entregando, setEntregando] = useState<ReparacionLocal | null>(null);
    const [metodoPagoFinal, setMetodoPagoFinal] = useState<MetodoPagoReparacion>('efectivo');
    const [garantiaDias, setGarantiaDias] = useState('30');

    // Cancelar
    const [cancelando, setCancelando] = useState<ReparacionLocal | null>(null);

    // Despiece: equipo abandonado del que se recuperan piezas para el inventario
    const [despiezando, setDespiezando] = useState<ReparacionLocal | null>(null);
    const [piezas, setPiezas] = useState<{ producto_id?: string; nombre: string; cantidad: number; costo: number }[]>([]);
    const [busquedaPieza, setBusquedaPieza] = useState('');

    // Impresión
    const ticketRef = useRef<HTMLDivElement>(null);
    const [recibo, setRecibo] = useState<{ rep: ReparacionLocal; modo: 'recepcion' | 'entrega' } | null>(null);
    const handlePrint = useReactToPrint({ contentRef: ticketRef });
    const imprimir = (rep: ReparacionLocal, modo: 'recepcion' | 'entrega') => {
        setRecibo({ rep, modo });
        setTimeout(() => handlePrint(), 120);
    };

    // ─── Derivados ────────────────────────────────────────────────────────
    const totalForm = useMemo(() => {
        const repuestos = formData.repuestos.reduce((s, r) => s + r.precio * r.cantidad, 0);
        const mo = parseFloat(formData.mano_obra) || 0;
        return repuestos + mo;
    }, [formData.repuestos, formData.mano_obra]);

    const listaFiltrada = useMemo(() => {
        const q = norm(busqueda).trim();
        const terminos = q ? q.split(/\s+/) : [];
        return lista.filter(r => {
            if (filtro === 'activas') {
                if (r.estado === 'entregado' || r.estado === 'cancelado') return false;
            } else if (filtro !== 'todos') {
                if (r.estado !== filtro) return false;
            }
            if (terminos.length > 0) {
                const heno = norm(`${r.folio} ${r.cliente_nombre} ${r.cliente_telefono || ''} ${r.equipo_marca || ''} ${r.equipo_modelo} ${r.equipo_imei || ''}`);
                if (!terminos.every(t => heno.includes(t))) return false;
            }
            return true;
        });
    }, [lista, busqueda, filtro]);

    const conteoActivas = useMemo(
        () => lista.filter(r => r.estado !== 'entregado' && r.estado !== 'cancelado').length,
        [lista]
    );

    // ─── Acciones ─────────────────────────────────────────────────────────
    const abrirNueva = () => {
        setEditando(null);
        setFormData(FORM_VACIO);
        setBusquedaRepuesto('');
        setIsModalOpen(true);
    };

    const abrirEditar = (r: ReparacionLocal) => {
        setEditando(r);
        setFormData({
            cliente_id: r.cliente_id,
            cliente_nombre: r.cliente_nombre,
            cliente_telefono: r.cliente_telefono || '',
            guardar_cliente: false,
            equipo_marca: r.equipo_marca || '',
            equipo_modelo: r.equipo_modelo,
            equipo_imei: r.equipo_imei || '',
            equipo_color: r.equipo_color || '',
            patron_clave: r.patron_clave || '',
            condicion_checklist: r.condicion_checklist ? [...r.condicion_checklist] : [],
            condicion_entrada: r.condicion_entrada || '',
            accesorios: r.accesorios || '',
            problema_reportado: r.problema_reportado,
            diagnostico: r.diagnostico || '',
            mano_obra: r.mano_obra ? String(r.mano_obra) : '',
            abono: r.abono ? String(r.abono) : '',
            metodo_abono: r.metodo_abono || 'efectivo',
            notas: r.notas || '',
            repuestos: r.repuestos.map(x => ({ ...x })),
        });
        setBusquedaRepuesto('');
        setIsModalOpen(true);
    };

    const agregarRepuestoInventario = (prodId: string) => {
        const prod = productos.find(p => p.id === prodId);
        if (!prod) return;
        if (formData.repuestos.some(r => r.producto_id === prodId)) { setBusquedaRepuesto(''); return; }
        setFormData(f => ({
            ...f,
            repuestos: [...f.repuestos, {
                producto_id: prod.id,
                nombre: prod.nombre,
                cantidad: 1,
                costo: prod.costo || 0,
                precio: prod.precio_venta || prod.costo || 0,
                desde_inventario: true,
                stock_aplicado: false,
            }],
        }));
        setBusquedaRepuesto('');
    };

    const toggleCondicion = (item: string) => {
        setFormData(f => ({
            ...f,
            condicion_checklist: f.condicion_checklist.includes(item)
                ? f.condicion_checklist.filter(x => x !== item)
                : [...f.condicion_checklist, item],
        }));
    };

    const agregarRepuestoManual = () => {
        setFormData(f => ({
            ...f,
            repuestos: [...f.repuestos, { nombre: '', cantidad: 1, costo: 0, precio: 0, desde_inventario: false }],
        }));
    };

    const actualizarRepuesto = (idx: number, campo: keyof RepuestoReparacion, valor: string) => {
        setFormData(f => {
            const reps = [...f.repuestos];
            const r = { ...reps[idx] };
            if (campo === 'nombre') r.nombre = valor;
            else if (campo === 'cantidad') r.cantidad = parseFloat(valor) || 0;
            else if (campo === 'costo') r.costo = parseFloat(valor) || 0;
            else if (campo === 'precio') r.precio = parseFloat(valor) || 0;
            reps[idx] = r;
            return { ...f, repuestos: reps };
        });
    };

    const quitarRepuesto = (idx: number) => {
        setFormData(f => ({ ...f, repuestos: f.repuestos.filter((_, i) => i !== idx) }));
    };

    const guardar = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId) return;
        if (!formData.cliente_nombre.trim() || !formData.equipo_modelo.trim() || !formData.problema_reportado.trim()) {
            showToast('Completa cliente, modelo y problema reportado.', 'error');
            return;
        }
        setGuardando(true);
        try {
            const id = editando ? editando.id : uuidv4();
            const ahora = Date.now();
            const folio = editando ? editando.folio : await getNextFolioReparacion(negocioId);

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

            // Descontar del inventario los repuestos nuevos que salen de stock
            // Reconciliación de stock de repuestos de inventario (maneja altas, bajas
            // y cambios de cantidad al editar): se compara lo ya descontado contra lo
            // deseado y se aplica solo la diferencia. Así el inventario nunca se descuadra.
            const prevAplicado = new Map<string, number>();
            (editando?.repuestos ?? []).forEach(rp => {
                if (rp.desde_inventario && rp.producto_id && rp.stock_aplicado) {
                    prevAplicado.set(rp.producto_id, (prevAplicado.get(rp.producto_id) ?? 0) + rp.cantidad);
                }
            });
            const nuevoDeseado = new Map<string, number>();
            formData.repuestos.forEach(rp => {
                if (rp.desde_inventario && rp.producto_id) {
                    nuevoDeseado.set(rp.producto_id, (nuevoDeseado.get(rp.producto_id) ?? 0) + rp.cantidad);
                }
            });
            for (const pid of new Set([...prevAplicado.keys(), ...nuevoDeseado.keys()])) {
                const diff = (nuevoDeseado.get(pid) ?? 0) - (prevAplicado.get(pid) ?? 0);
                if (diff !== 0) {
                    // diff>0 consume más (salida), diff<0 devuelve al stock (entrada)
                    await registrarMovimientoStock({ productoId: pid, tipo: 'reparacion', delta: -diff, referenciaId: id });
                }
            }
            const repuestosFinal: RepuestoReparacion[] = formData.repuestos.map(rp =>
                rp.desde_inventario && rp.producto_id ? { ...rp, stock_aplicado: true } : rp
            );

            const total = repuestosFinal.reduce((s, r) => s + r.precio * r.cantidad, 0) + (parseFloat(formData.mano_obra) || 0);
            const abono = parseFloat(formData.abono) || 0;

            const rep: ReparacionLocal = {
                id,
                negocio_id: negocioId,
                sucursal_id: sucursalId || undefined,
                folio,
                ...(clienteId && { cliente_id: clienteId }),
                cliente_nombre: formData.cliente_nombre.trim(),
                ...(formData.cliente_telefono.trim() && { cliente_telefono: formData.cliente_telefono.trim() }),
                ...(formData.equipo_marca.trim() && { equipo_marca: formData.equipo_marca.trim() }),
                equipo_modelo: formData.equipo_modelo.trim(),
                ...(formData.equipo_imei.trim() && { equipo_imei: formData.equipo_imei.trim() }),
                ...(formData.equipo_color.trim() && { equipo_color: formData.equipo_color.trim() }),
                ...(formData.patron_clave.trim() && { patron_clave: formData.patron_clave.trim() }),
                ...(formData.condicion_checklist.length > 0 && { condicion_checklist: [...formData.condicion_checklist] }),
                ...(formData.condicion_entrada.trim() && { condicion_entrada: formData.condicion_entrada.trim() }),
                ...(formData.accesorios.trim() && { accesorios: formData.accesorios.trim() }),
                problema_reportado: formData.problema_reportado.trim(),
                ...(formData.diagnostico.trim() && { diagnostico: formData.diagnostico.trim() }),
                estado: editando ? editando.estado : 'recibido',
                repuestos: repuestosFinal,
                mano_obra: parseFloat(formData.mano_obra) || 0,
                total,
                abono,
                metodo_abono: abono > 0 ? formData.metodo_abono : undefined,
                metodo_pago_final: editando?.metodo_pago_final,
                garantia_dias: editando?.garantia_dias,
                garantia_hasta: editando?.garantia_hasta,
                ...(formData.notas.trim() && { notas: formData.notas.trim() }),
                fecha_creacion: editando ? editando.fecha_creacion : ahora,
                fecha_entrega: editando?.fecha_entrega,
                estado_sincronizacion: 0,
                fecha_actualizacion: ahora,
            };

            await db.reparaciones.put(rep);
            setIsModalOpen(false);
            showToast(editando ? 'Reparación actualizada.' : `Reparación ${folio} creada.`, 'success');
            if (!editando) setTimeout(() => imprimir(rep, 'recepcion'), 150);
        } catch (err) {
            console.error('[reparacion]', err);
            showToast('No se pudo guardar la reparación.', 'error');
        }
        setGuardando(false);
    };

    const cambiarEstado = async (r: ReparacionLocal, estado: ReparacionEstado) => {
        // Manejador de evento (onChange del select): Date.now() es seguro aquí.
        // eslint-disable-next-line react-hooks/purity
        const ahora = Date.now();
        await db.reparaciones.update(r.id, { estado, estado_sincronizacion: 0, fecha_actualizacion: ahora });
    };

    const confirmarEntrega = async () => {
        if (!entregando) return;
        const dias = parseInt(garantiaDias) || 0;
        const ahora = Date.now();
        await db.reparaciones.update(entregando.id, {
            estado: 'entregado',
            metodo_pago_final: metodoPagoFinal,
            garantia_dias: dias,
            garantia_hasta: dias > 0 ? ahora + dias * DIA : undefined,
            fecha_entrega: ahora,
            estado_sincronizacion: 0,
            fecha_actualizacion: ahora,
        });
        const actualizada: ReparacionLocal = {
            ...entregando,
            estado: 'entregado',
            metodo_pago_final: metodoPagoFinal,
            garantia_dias: dias,
            garantia_hasta: dias > 0 ? ahora + dias * DIA : undefined,
            fecha_entrega: ahora,
        };
        setEntregando(null);
        showToast('Equipo entregado.', 'success');
        setTimeout(() => imprimir(actualizada, 'entrega'), 150);
    };

    const confirmarCancelar = async () => {
        if (!cancelando) return;
        const ahora = Date.now();
        // Devolver al inventario los repuestos que ya se habían descontado
        for (const rp of cancelando.repuestos) {
            if (rp.desde_inventario && rp.producto_id && rp.stock_aplicado) {
                await registrarMovimientoStock({ productoId: rp.producto_id, tipo: 'reparacion', delta: Math.abs(rp.cantidad), referenciaId: cancelando.id });
            }
        }
        // Marcar cancelada y limpiar la marca de stock (ya se devolvió)
        await db.reparaciones.update(cancelando.id, {
            estado: 'cancelado',
            repuestos: cancelando.repuestos.map(rp => rp.desde_inventario ? { ...rp, stock_aplicado: false } : rp),
            estado_sincronizacion: 0,
            fecha_actualizacion: ahora,
        });
        setCancelando(null);
        showToast('Reparación cancelada. Los repuestos volvieron al inventario.', 'info');
    };

    // ── Despiece de equipo abandonado ────────────────────────────────────────
    const abrirDespiece = (r: ReparacionLocal) => { setDespiezando(r); setPiezas([]); setBusquedaPieza(''); };
    const agregarPiezaInventario = (prodId: string) => {
        const p = productos.find(x => x.id === prodId);
        if (!p || piezas.some(z => z.producto_id === prodId)) { setBusquedaPieza(''); return; }
        setPiezas(prev => [...prev, { producto_id: p.id, nombre: p.nombre, cantidad: 1, costo: p.costo || 0 }]);
        setBusquedaPieza('');
    };
    const agregarPiezaNueva = () => setPiezas(prev => [...prev, { nombre: '', cantidad: 1, costo: 0 }]);
    const actualizarPieza = (idx: number, campo: 'nombre' | 'cantidad' | 'costo', valor: string) => {
        setPiezas(prev => {
            const arr = [...prev];
            arr[idx] = { ...arr[idx], [campo]: campo === 'nombre' ? valor : (parseFloat(valor) || 0) };
            return arr;
        });
    };
    const quitarPieza = (idx: number) => setPiezas(prev => prev.filter((_, i) => i !== idx));

    const piezasInventarioFiltradas = useMemo(() => {
        const q = norm(busquedaPieza).trim();
        if (!q) return [];
        return productos.filter(p => norm(p.nombre).includes(q) || norm(p.codigo_barras).includes(q)).slice(0, 6);
    }, [productos, busquedaPieza]);

    const confirmarDespiece = async () => {
        if (!despiezando || !negocioId) return;
        const ahora = Date.now();
        try {
            // Devolver al inventario los repuestos que la reparación hubiera descontado
            for (const rp of despiezando.repuestos) {
                if (rp.desde_inventario && rp.producto_id && rp.stock_aplicado) {
                    await registrarMovimientoStock({ productoId: rp.producto_id, tipo: 'reparacion', delta: Math.abs(rp.cantidad), referenciaId: despiezando.id });
                }
            }
            // Agregar las piezas recuperadas al inventario (crea el insumo si es nuevo)
            for (const pz of piezas) {
                if (!pz.nombre.trim() || pz.cantidad <= 0) continue;
                let pid = pz.producto_id;
                if (!pid) {
                    pid = uuidv4();
                    await db.productos.put({
                        id: pid, negocio_id: negocioId, nombre: pz.nombre.trim(), tipo: 'insumo',
                        codigo_barras: '', precio_venta: 0, costo: pz.costo || 0,
                        stock_actual: 0, stock_minimo: 0, tasa_itbis: 0,
                        estado_sincronizacion: 0, fecha_actualizacion: ahora,
                    } as ProductoLocal);
                }
                await registrarMovimientoStock({ productoId: pid, tipo: 'entrada', delta: Math.abs(pz.cantidad), referenciaId: despiezando.id });
            }
            await db.reparaciones.update(despiezando.id, {
                estado: 'cancelado',
                notas: `${despiezando.notas ? despiezando.notas + ' · ' : ''}Equipo abandonado y despiezado`,
                repuestos: despiezando.repuestos.map(rp => rp.desde_inventario ? { ...rp, stock_aplicado: false } : rp),
                estado_sincronizacion: 0, fecha_actualizacion: ahora,
            });
            setDespiezando(null);
            showToast('Equipo despiezado: piezas agregadas al inventario.', 'success');
        } catch (err) {
            console.error('[despiece]', err);
            showToast('No se pudo completar el despiece.', 'error');
        }
    };

    const avisarWhatsApp = (r: ReparacionLocal) => {
        const tel = (r.cliente_telefono || '').replace(/\D/g, '');
        if (!tel) { showToast('Esta reparación no tiene teléfono del cliente.', 'info'); return; }
        const saldo = Math.max(0, r.total - r.abono);
        const equipo = [r.equipo_marca, r.equipo_modelo].filter(Boolean).join(' ');
        const msg =
            `Hola ${r.cliente_nombre} 👋, le saluda *${negocioNombre || 'nuestra tienda'}*.\n\n` +
            `Su equipo *${equipo}* (${r.folio}) ya está *listo* para retirar. ✅\n` +
            (saldo > 0 ? `Saldo pendiente: *${formatDOP(saldo)}*.\n` : '') +
            `\n¡Le esperamos!`;
        // Sin API: abrimos WhatsApp con el mensaje prellenado
        const telFull = tel.length === 10 ? `1${tel}` : tel; // RD: anteponer 1 si faltó
        window.open(`https://wa.me/${telFull}?text=${encodeURIComponent(msg)}`, '_blank');
    };

    const repuestosFiltrados = useMemo(() => {
        const q = norm(busquedaRepuesto).trim();
        if (!q) return [];
        return productos
            .filter(p => norm(p.nombre).includes(q) || norm(p.codigo_barras).includes(q))
            .slice(0, 8);
    }, [productos, busquedaRepuesto]);

    // ─── Candado de plan Pro ──────────────────────────────────────────────
    if (planTier !== 'pro') {
        const linkWa = `https://wa.me/${WHATSAPP_NUMBER_SOPORTE}?text=${encodeURIComponent('Hola, quiero activar el módulo de Reparaciones (Plan Pro) en VentaRD.')}`;
        return (
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <OfflineBanner />
                <div className="flex-1 flex items-center justify-center p-6">
                    <div className="max-w-lg w-full text-center bg-navy-2 border border-gold/25 rounded-2xl p-8">
                        <span className="text-5xl block mb-4">🔧</span>
                        <h1 className="text-2xl font-display font-black text-white mb-2">Módulo de Reparaciones</h1>
                        <p className="text-vr-gray text-sm mb-1">Disponible en el <span className="text-gold font-bold">Plan Pro</span>, pensado para tiendas de celulares.</p>
                        <p className="text-vr-gray text-sm mb-6">Recibe equipos, lleva el estado de cada reparación, descuenta repuestos del inventario, da garantía e imprime el recibo.</p>
                        <a href={linkWa} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 bg-gold-gradient text-navy px-7 py-3.5 rounded-2xl font-extrabold hover:brightness-110 transition-all">
                            💬 Activar Plan Pro por WhatsApp
                        </a>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <PinGuard title="Reparaciones">
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <OfflineBanner />
                <div className="flex-1 p-3 sm:p-6 lg:p-8">
                    <div className="max-w-7xl mx-auto">
                        {/* Header */}
                        <div className="flex justify-between items-center mb-4 sm:mb-6">
                            <div>
                                <h1 className="text-2xl sm:text-3xl font-display font-extrabold text-white flex items-center gap-2">
                                    🔧 Reparaciones
                                    <span className="text-[10px] font-black bg-gold/15 text-gold px-2 py-0.5 rounded-full uppercase tracking-wider">Pro</span>
                                </h1>
                                <p className="text-vr-gray mt-0.5 text-sm hidden sm:block">{conteoActivas} reparación{conteoActivas === 1 ? '' : 'es'} en proceso</p>
                            </div>
                            <button onClick={abrirNueva} className="px-4 sm:px-6 py-2.5 sm:py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all shadow-md text-sm sm:text-base whitespace-nowrap">
                                + Nueva
                            </button>
                        </div>

                        {/* Buscador + filtros */}
                        <div className="mb-3 sm:mb-4 space-y-3">
                            <input
                                type="text"
                                inputMode="search"
                                placeholder="Buscar por folio, cliente, teléfono, IMEI o modelo…"
                                className="w-full bg-navy-2 border border-navy-3 rounded-xl px-4 py-3 text-white placeholder-vr-gray/50 focus:border-gold outline-none transition-all"
                                value={busqueda}
                                onChange={e => setBusqueda(e.target.value)}
                            />
                            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                                {([
                                    { key: 'activas', label: 'Activas' },
                                    { key: 'todos', label: 'Todas' },
                                    ...ESTADOS.map(e => ({ key: e.key, label: e.label })),
                                ] as const).map(({ key, label }) => (
                                    <button
                                        key={key}
                                        type="button"
                                        onClick={() => setFiltro(key)}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all border shrink-0 ${filtro === key ? 'bg-gold/15 text-gold border-gold/40' : 'bg-navy-2 text-vr-gray border-navy-3 hover:text-white'}`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Lista */}
                        <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                            {isLoading ? (
                                <table className="w-full"><tbody><SkeletonTable rows={5} cols={4} /></tbody></table>
                            ) : listaFiltrada.length === 0 ? (
                                <div className="py-16 text-center text-vr-gray">
                                    <span className="text-4xl block mb-3">🔧</span>
                                    <p className="font-medium">{lista.length === 0 ? 'Aún no hay reparaciones. Crea la primera.' : 'Sin reparaciones con ese filtro.'}</p>
                                </div>
                            ) : (
                                <div className="divide-y divide-navy-3/50">
                                    {listaFiltrada.map(r => {
                                        const meta = estadoMeta(r.estado);
                                        const saldo = Math.max(0, r.total - r.abono);
                                        const terminada = r.estado === 'entregado' || r.estado === 'cancelado';
                                        return (
                                            <div key={r.id} className="p-3 sm:p-4 hover:bg-navy-3/20 transition-colors">
                                                <div className="flex items-start justify-between gap-3 flex-wrap">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <span className="font-mono font-black text-gold text-sm">{r.folio}</span>
                                                            <span className={`px-2 py-0.5 rounded-md text-[10px] font-black border ${meta.color}`}>{meta.label}</span>
                                                        </div>
                                                        <p className="font-bold text-white text-sm mt-1 truncate">
                                                            {[r.equipo_marca, r.equipo_modelo].filter(Boolean).join(' ')}
                                                            {r.equipo_imei && <span className="text-vr-gray font-normal font-mono text-xs ml-2">IMEI {r.equipo_imei}</span>}
                                                        </p>
                                                        <p className="text-xs text-vr-gray mt-0.5 truncate">
                                                            👤 {r.cliente_nombre}{r.cliente_telefono ? ` · ${r.cliente_telefono}` : ''}
                                                        </p>
                                                        <p className="text-xs text-vr-gray mt-0.5 truncate">📝 {r.problema_reportado}</p>
                                                    </div>
                                                    <div className="text-right shrink-0">
                                                        <p className="font-mono font-black text-white text-sm">{formatDOP(r.total)}</p>
                                                        {saldo > 0 && !terminada && <p className="text-[11px] font-bold text-vr-orange">Saldo {formatDOP(saldo)}</p>}
                                                        {r.estado === 'entregado' && r.garantia_hasta && (
                                                            <p className="text-[10px] text-vr-gray mt-0.5">Garantía: {new Date(r.garantia_hasta).toLocaleDateString('es-DO')}</p>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* Acciones */}
                                                <div className="flex items-center gap-2 flex-wrap mt-3">
                                                    {!terminada && (
                                                        <select
                                                            value={r.estado}
                                                            onChange={e => cambiarEstado(r, e.target.value as ReparacionEstado)}
                                                            className="bg-navy-3 border border-navy-3 rounded-lg py-1.5 pl-2.5 pr-7 text-xs font-bold text-white focus:border-gold outline-none cursor-pointer"
                                                        >
                                                            {ESTADOS.filter(e => e.key !== 'entregado' && e.key !== 'cancelado').map(e => (
                                                                <option key={e.key} value={e.key}>{e.label}</option>
                                                            ))}
                                                        </select>
                                                    )}
                                                    {r.estado === 'listo' && r.cliente_telefono && (
                                                        <button onClick={() => avisarWhatsApp(r)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-vr-green/10 text-vr-green border border-vr-green/20 hover:bg-vr-green/20 transition-all">
                                                            💬 Avisar
                                                        </button>
                                                    )}
                                                    {!terminada && (
                                                        <button onClick={() => { setEntregando(r); setMetodoPagoFinal('efectivo'); setGarantiaDias('30'); }} className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-gold/10 text-gold border border-gold/20 hover:bg-gold/20 transition-all">
                                                            📦 Entregar
                                                        </button>
                                                    )}
                                                    <button onClick={() => imprimir(r, r.estado === 'entregado' ? 'entrega' : 'recepcion')} className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-navy-3 text-vr-gray border border-navy-3 hover:text-white transition-all">
                                                        🖨️ Recibo
                                                    </button>
                                                    {!terminada && (
                                                        <>
                                                            <button onClick={() => abrirEditar(r)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-gold hover:bg-gold/10 transition-all">Editar</button>
                                                            <button onClick={() => abrirDespiece(r)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-vr-gray hover:text-white hover:bg-navy-3 transition-all" title="Equipo abandonado: recuperar piezas al inventario">🧩 Despiezar</button>
                                                            <button onClick={() => setCancelando(r)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-vr-red hover:bg-vr-red/10 transition-all">Cancelar</button>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* MODAL NUEVA / EDITAR */}
                {isModalOpen && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                        <div className="bg-navy-2 w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden max-h-[95vh] sm:max-h-[90vh] flex flex-col animate-scale-in">
                            <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center shrink-0">
                                <h2 className="text-xl font-display font-bold text-white">{editando ? `Editar ${editando.folio}` : 'Nueva reparación'}</h2>
                                <button onClick={() => setIsModalOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                            </div>

                            <form onSubmit={guardar} className="p-4 sm:p-6 space-y-4 overflow-y-auto">
                                {/* Cliente */}
                                <ClientePicker
                                    value={{ clienteId: formData.cliente_id, nombre: formData.cliente_nombre, telefono: formData.cliente_telefono, guardarNuevo: formData.guardar_cliente }}
                                    onChange={v => setFormData({ ...formData, cliente_id: v.clienteId, cliente_nombre: v.nombre, cliente_telefono: v.telefono, guardar_cliente: v.guardarNuevo })}
                                />

                                {/* Equipo */}
                                <div className="p-3 bg-navy rounded-xl border border-navy-3 space-y-3">
                                    <p className="text-xs font-bold text-vr-gray uppercase tracking-wider">Equipo</p>
                                    <div className="grid grid-cols-2 gap-3">
                                        <input type="text" placeholder="Marca (ej: iPhone)" className="bg-navy-3 border border-navy-3 rounded-xl p-2.5 text-white text-sm focus:border-gold outline-none transition-all" value={formData.equipo_marca} onChange={e => setFormData({ ...formData, equipo_marca: e.target.value })} />
                                        <input type="text" placeholder="Modelo * (ej: 13 Pro)" className="bg-navy-3 border border-navy-3 rounded-xl p-2.5 text-white text-sm focus:border-gold outline-none transition-all" value={formData.equipo_modelo} onChange={e => setFormData({ ...formData, equipo_modelo: e.target.value })} />
                                        <input type="text" placeholder="IMEI / Serie" className="bg-navy-3 border border-navy-3 rounded-xl p-2.5 text-white font-mono text-sm focus:border-gold outline-none transition-all" value={formData.equipo_imei} onChange={e => setFormData({ ...formData, equipo_imei: e.target.value })} />
                                        <input type="text" placeholder="Color" className="bg-navy-3 border border-navy-3 rounded-xl p-2.5 text-white text-sm focus:border-gold outline-none transition-all" value={formData.equipo_color} onChange={e => setFormData({ ...formData, equipo_color: e.target.value })} />
                                        <input type="text" placeholder="Clave / patrón de desbloqueo" className="bg-navy-3 border border-navy-3 rounded-xl p-2.5 text-white text-sm focus:border-gold outline-none transition-all" value={formData.patron_clave} onChange={e => setFormData({ ...formData, patron_clave: e.target.value })} />
                                        <input type="text" placeholder="Accesorios (cargador, caja…)" className="bg-navy-3 border border-navy-3 rounded-xl p-2.5 text-white text-sm focus:border-gold outline-none transition-all" value={formData.accesorios} onChange={e => setFormData({ ...formData, accesorios: e.target.value })} />
                                    </div>
                                    {/* Checklist de condición de entrada */}
                                    <div>
                                        <p className="text-[11px] font-bold text-vr-gray uppercase tracking-wider mb-1.5">Condición al recibir</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {CONDICION_ITEMS.map(item => {
                                                const activo = formData.condicion_checklist.includes(item);
                                                return (
                                                    <button
                                                        key={item}
                                                        type="button"
                                                        onClick={() => toggleCondicion(item)}
                                                        className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-all ${activo ? 'bg-gold/15 text-gold border-gold/40' : 'bg-navy-3 text-vr-gray border-navy-3 hover:text-white'}`}
                                                    >
                                                        {activo ? '✓ ' : ''}{item}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                    <input type="text" placeholder="Otros detalles de condición (opcional)" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-2.5 text-white text-sm focus:border-gold outline-none transition-all" value={formData.condicion_entrada} onChange={e => setFormData({ ...formData, condicion_entrada: e.target.value })} />
                                </div>

                                {/* Problema */}
                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">Problema reportado *</label>
                                    <textarea required className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white text-sm focus:border-gold outline-none transition-all resize-none h-16" placeholder="Ej: No carga, pantalla no enciende…" value={formData.problema_reportado} onChange={e => setFormData({ ...formData, problema_reportado: e.target.value })} />
                                </div>

                                {/* Separador: diagnóstico y cotización (opcional ahora) */}
                                <div className="pt-1 border-t border-navy-3">
                                    <p className="text-xs font-bold text-gold uppercase tracking-wider mt-3">Diagnóstico y cotización</p>
                                    <p className="text-[11px] text-vr-gray mb-1">Puedes llenarlo ahora o después, cuando revises el equipo.</p>
                                </div>

                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">Diagnóstico (opcional)</label>
                                    <textarea className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white text-sm focus:border-gold outline-none transition-all resize-none h-14" placeholder="Lo que encontró el técnico" value={formData.diagnostico} onChange={e => setFormData({ ...formData, diagnostico: e.target.value })} />
                                </div>

                                {/* Repuestos */}
                                <div className="p-3 bg-navy rounded-xl border border-navy-3">
                                    <div className="flex items-center justify-between mb-2">
                                        <p className="text-xs font-bold text-vr-gray uppercase tracking-wider">Repuestos</p>
                                        <button type="button" onClick={agregarRepuestoManual} className="text-xs font-bold text-gold hover:text-gold-2">+ Manual</button>
                                    </div>
                                    {/* Buscar en inventario */}
                                    <div className="relative mb-2">
                                        <input type="text" placeholder="Buscar repuesto en inventario…" className="w-full bg-navy-3 border border-navy-3 rounded-lg p-2.5 text-white text-sm focus:border-gold outline-none transition-all" value={busquedaRepuesto} onChange={e => setBusquedaRepuesto(e.target.value)} />
                                        {repuestosFiltrados.length > 0 && (
                                            <div className="absolute z-50 w-full bg-navy shadow-xl rounded-lg mt-1 border border-navy-3 max-h-48 overflow-y-auto">
                                                {repuestosFiltrados.map(p => (
                                                    <button key={p.id} type="button" onClick={() => agregarRepuestoInventario(p.id)} className="w-full text-left p-2.5 hover:bg-navy-3 text-xs border-b border-navy-3 last:border-0 text-white flex justify-between gap-2">
                                                        <span className="truncate">{p.nombre}</span>
                                                        <span className="text-vr-gray font-mono shrink-0">stock {parseFloat(Number(p.stock_actual).toFixed(2))}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    {formData.repuestos.length > 0 && (
                                        <div className="space-y-2">
                                            {formData.repuestos.map((rp, i) => (
                                                <div key={i} className="flex items-center gap-2 bg-navy-3 rounded-lg p-2">
                                                    <div className="flex-1 min-w-0">
                                                        {rp.desde_inventario ? (
                                                            <p className="text-xs font-bold text-white truncate">{rp.nombre} <span className="text-[10px] text-vr-green font-normal">(inventario)</span></p>
                                                        ) : (
                                                            <input type="text" placeholder="Nombre del repuesto" className="w-full bg-transparent border-b border-navy-2 text-white text-xs outline-none focus:border-gold pb-0.5" value={rp.nombre} onChange={e => actualizarRepuesto(i, 'nombre', e.target.value)} />
                                                        )}
                                                    </div>
                                                    <input type="number" step="any" min="0" title="Cantidad" className="w-12 bg-navy-2 border border-navy-2 rounded text-center text-white text-xs font-mono p-1 outline-none focus:border-gold" value={rp.cantidad} onChange={e => actualizarRepuesto(i, 'cantidad', e.target.value)} />
                                                    <input type="number" step="0.01" min="0" title="Precio al cliente" className="w-20 bg-navy-2 border border-navy-2 rounded text-right text-white text-xs font-mono p-1 outline-none focus:border-gold" value={rp.precio} onChange={e => actualizarRepuesto(i, 'precio', e.target.value)} />
                                                    <button type="button" onClick={() => quitarRepuesto(i)} className="text-vr-red font-bold px-1 shrink-0">✕</button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* Mano de obra y abono */}
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Mano de obra (RD$)</label>
                                        <input type="number" step="0.01" min="0" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono focus:border-gold outline-none transition-all" value={formData.mano_obra} onChange={e => setFormData({ ...formData, mano_obra: e.target.value })} />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Abono / adelanto (RD$)</label>
                                        <input type="number" step="0.01" min="0" placeholder="0 (opcional)" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono focus:border-gold outline-none transition-all" value={formData.abono} onChange={e => setFormData({ ...formData, abono: e.target.value })} />
                                    </div>
                                </div>
                                {(parseFloat(formData.abono) || 0) > 0 && (
                                    <div className="grid grid-cols-3 gap-2">
                                        {(['efectivo', 'tarjeta', 'transferencia'] as MetodoPagoReparacion[]).map(m => (
                                            <button key={m} type="button" onClick={() => setFormData({ ...formData, metodo_abono: m })} className={`py-2 rounded-lg border text-xs font-bold capitalize transition-all ${formData.metodo_abono === m ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}>{m}</button>
                                        ))}
                                    </div>
                                )}

                                {/* Total */}
                                <div className="flex justify-between items-center bg-gold/5 border border-gold/15 rounded-xl px-4 py-3">
                                    <span className="text-sm font-bold text-gold">Total estimado</span>
                                    <span className="text-xl font-black font-mono text-gold">{formatDOP(totalForm)}</span>
                                </div>

                                <div className="pt-2 flex gap-3">
                                    <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                                    <button type="submit" disabled={guardando} className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-40">{guardando ? 'Guardando…' : 'Guardar'}</button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}

                {/* MODAL ENTREGA */}
                {entregando && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                        <div className="bg-navy-2 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                            <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                <div>
                                    <h2 className="text-xl font-display font-bold text-white">Entregar equipo</h2>
                                    <p className="text-sm text-vr-gray mt-0.5">{entregando.folio} · {entregando.cliente_nombre}</p>
                                </div>
                                <button onClick={() => setEntregando(null)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                            </div>
                            <div className="p-4 sm:p-6 space-y-4">
                                <div className="flex justify-between items-center bg-navy rounded-xl px-4 py-3 border border-navy-3">
                                    <span className="text-sm text-vr-gray font-bold">Saldo a cobrar</span>
                                    <span className="font-mono font-black text-white text-lg">{formatDOP(Math.max(0, entregando.total - entregando.abono))}</span>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-vr-gray uppercase tracking-wider mb-1.5">Método de pago</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {(['efectivo', 'tarjeta', 'transferencia'] as MetodoPagoReparacion[]).map(m => (
                                            <button key={m} type="button" onClick={() => setMetodoPagoFinal(m)} className={`py-2.5 rounded-lg border text-xs font-bold capitalize transition-all ${metodoPagoFinal === m ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}>{m}</button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-vr-gray uppercase tracking-wider mb-1.5">Garantía de la reparación (días)</label>
                                    <input type="number" min="0" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono text-center focus:border-gold outline-none transition-all" value={garantiaDias} onChange={e => setGarantiaDias(e.target.value)} />
                                    <p className="text-[11px] text-vr-gray mt-1">0 = sin garantía. Se imprime en el recibo de entrega.</p>
                                </div>
                                <div className="flex gap-3 pt-2">
                                    <button type="button" onClick={() => setEntregando(null)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                                    <button type="button" onClick={confirmarEntrega} className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all">Cobrar y entregar</button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Recibo oculto para impresión (montado aunque se cierren los modales) */}
            {recibo && (
                <div style={{ display: 'none' }}>
                    <TicketReparacion
                        ref={ticketRef}
                        reparacion={recibo.rep}
                        modo={recibo.modo}
                        nombreNegocio={negocioNombre || 'VentaRD'}
                        rnc={negocioRnc || undefined}
                        direccion={negocioDireccion || undefined}
                        telefono={negocioTelefono || undefined}
                    />
                </div>
            )}

            {/* MODAL DESPIECE — equipo abandonado → piezas al inventario */}
            {despiezando && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                    <div className="bg-navy-2 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden max-h-[92vh] flex flex-col animate-scale-in">
                        <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center shrink-0">
                            <div>
                                <h2 className="text-xl font-display font-bold text-white">🧩 Despiezar equipo</h2>
                                <p className="text-sm text-vr-gray mt-0.5">{despiezando.folio} · {[despiezando.equipo_marca, despiezando.equipo_modelo].filter(Boolean).join(' ')}</p>
                            </div>
                            <button onClick={() => setDespiezando(null)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                        </div>
                        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto">
                            <p className="text-xs text-vr-gray bg-navy rounded-xl border border-navy-3 p-3">
                                El cliente dejó el equipo. Registra las piezas aprovechables: entrarán al inventario como repuestos y la reparación quedará cancelada.
                            </p>

                            <div className="relative">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-sm font-bold text-vr-gray">Piezas recuperadas</label>
                                    <button type="button" onClick={agregarPiezaNueva} className="text-xs font-bold text-gold hover:text-gold-2">+ Pieza nueva</button>
                                </div>
                                <input type="text" placeholder="Buscar repuesto existente en inventario…" className="w-full bg-navy-3 border border-navy-3 rounded-lg p-2.5 text-white text-sm focus:border-gold outline-none transition-all" value={busquedaPieza} onChange={e => setBusquedaPieza(e.target.value)} />
                                {piezasInventarioFiltradas.length > 0 && (
                                    <div className="absolute z-50 w-full bg-navy shadow-xl rounded-lg mt-1 border border-navy-3 max-h-48 overflow-y-auto">
                                        {piezasInventarioFiltradas.map(p => (
                                            <button key={p.id} type="button" onClick={() => agregarPiezaInventario(p.id)} className="w-full text-left p-2.5 hover:bg-navy-3 text-xs border-b border-navy-3 last:border-0 text-white truncate">{p.nombre}</button>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {piezas.length > 0 && (
                                <div className="space-y-2">
                                    {piezas.map((pz, i) => (
                                        <div key={i} className="flex items-center gap-2 bg-navy-3 rounded-lg p-2">
                                            <div className="flex-1 min-w-0">
                                                {pz.producto_id ? (
                                                    <p className="text-xs font-bold text-white truncate">{pz.nombre} <span className="text-[10px] text-vr-green font-normal">(inventario)</span></p>
                                                ) : (
                                                    <input type="text" placeholder="Nombre de la pieza (ej. Pantalla iPhone 11 usada)" className="w-full bg-transparent border-b border-navy-2 text-white text-xs outline-none focus:border-gold pb-0.5" value={pz.nombre} onChange={e => actualizarPieza(i, 'nombre', e.target.value)} />
                                                )}
                                            </div>
                                            <input type="number" step="any" min="1" title="Cantidad" className="w-12 bg-navy-2 border border-navy-2 rounded text-center text-white text-xs font-mono p-1 outline-none focus:border-gold" value={pz.cantidad} onChange={e => actualizarPieza(i, 'cantidad', e.target.value)} />
                                            <input type="number" step="0.01" min="0" title="Costo estimado" placeholder="costo" className="w-16 bg-navy-2 border border-navy-2 rounded text-right text-white text-xs font-mono p-1 outline-none focus:border-gold" value={pz.costo} onChange={e => actualizarPieza(i, 'costo', e.target.value)} />
                                            <button type="button" onClick={() => quitarPieza(i)} className="text-vr-red font-bold px-1 shrink-0">✕</button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="p-4 sm:p-6 border-t border-navy-3 flex gap-3 shrink-0">
                            <button type="button" onClick={() => setDespiezando(null)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                            <button type="button" onClick={confirmarDespiece} className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all">Despiezar y guardar piezas</button>
                        </div>
                    </div>
                </div>
            )}

            <ConfirmModal
                isOpen={!!cancelando}
                title="Cancelar reparación"
                mensaje={<>¿Cancelar la reparación <span className="font-bold text-white">{cancelando?.folio}</span>? No se borra, queda marcada como cancelada.</>}
                confirmLabel="Sí, cancelar"
                onConfirm={confirmarCancelar}
                onClose={() => setCancelando(null)}
            />
        </PinGuard>
    );
}
