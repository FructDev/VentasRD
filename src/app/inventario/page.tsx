// src/app/inventario/page.tsx
'use client';

import { useMemo, useState } from 'react';
import { db } from '@/lib/db/dexie';
import { useProductosTenant, useComposicionesTenant } from '@/lib/db/tenantQuery';
import { useConfigStore } from '@/store/useConfigStore';
import { ProductoLocal, ComposicionLocal } from '@/types/database';
import { formatDOP } from '@/lib/utils';
import { v4 as uuidv4 } from 'uuid';
import { useLiveQuery } from 'dexie-react-hooks';
import PinGuard from '@/components/ui/PinGuard';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';
import { SkeletonTable } from '@/components/ui/Skeleton';
import Pagination from '@/components/ui/Pagination';

export default function InventarioPage() {
    const { negocioId } = useConfigStore();
    const productosRaw = useLiveQuery(
        () => negocioId ? db.productos.where('negocio_id').equals(negocioId).toArray() : [],
        [negocioId]
    );
    const isLoading = productosRaw === undefined;
    const productos = useProductosTenant();
    const composiciones = useComposicionesTenant();

    const productosConCosto = useMemo(() => {
        return productos.map(prod => {
            if ((prod as any).tipo === 'combo') {
                const receta = composiciones.filter(c => c.producto_padre_id === prod.id);
                let costoCalculado = 0;
                let stockVirtual = Infinity;

                if (receta.length === 0) stockVirtual = 0;

                receta.forEach(comp => {
                    const insumo = productos.find(p => p.id === comp.insumo_id);
                    costoCalculado += ((insumo?.costo || 0) * comp.cantidad_necesaria);
                    if (insumo && comp.cantidad_necesaria > 0) {
                        const posible = Math.floor(insumo.stock_actual / comp.cantidad_necesaria);
                        if (posible < stockVirtual) stockVirtual = posible;
                    } else {
                        stockVirtual = 0;
                    }
                });

                return {
                    ...prod,
                    costo: costoCalculado,
                    stock_actual: stockVirtual === Infinity ? 0 : stockVirtual
                };
            }
            return prod;
        });
    }, [productos, composiciones]);

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [productoEditando, setProductoEditando] = useState<ProductoLocal | null>(null);
    const [busquedaInsumo, setBusquedaInsumo] = useState('');

    const [isAjusteOpen, setIsAjusteOpen] = useState(false);
    const [productoAjustando, setProductoAjustando] = useState<ProductoLocal | null>(null);
    const [tipoAjuste, setTipoAjuste] = useState<'entrada' | 'merma' | 'conteo'>('entrada');
    const [cantidadAjuste, setCantidadAjuste] = useState('');

    const [formData, setFormData] = useState({
        nombre: '',
        tipo: 'simple' as 'simple' | 'insumo' | 'combo',
        codigo_barras: '',
        precio_venta: '',
        costo: '',
        stock_actual: '',
        stock_minimo: '',
        tasa_itbis: '0.18',
        ingredientes: [] as { insumo_id: string, nombre: string, cantidad: number }[]
    });

    const ITEMS_POR_PAGINA = 20;
    const [pagina, setPagina] = useState(1);
    const productosPaginados = useMemo(() => {
        const inicio = (pagina - 1) * ITEMS_POR_PAGINA;
        return productosConCosto.slice(inicio, inicio + ITEMS_POR_PAGINA);
    }, [productosConCosto, pagina]);
    const totalPaginas = Math.ceil(productosConCosto.length / ITEMS_POR_PAGINA);

    const insights = useMemo(() => {
        if (productosConCosto.length === 0) return null;

        const vendibles = productosConCosto.filter(p => (p as any).tipo === 'simple');
        const agotados = vendibles.filter(p => p.stock_actual <= 0);
        const porAgotarse = vendibles.filter(p => p.stock_actual > 0 && p.stock_actual <= p.stock_minimo);
        const inversionTotal = productosConCosto
            .filter(p => (p as any).tipo !== 'combo')
            .reduce((acc, p) => acc + (p.costo * p.stock_actual), 0);

        const mejorMargen = [...productosConCosto]
            .filter(p => (p as any).tipo === 'simple')
            .sort((a, b) => (b.precio_venta - b.costo) - (a.precio_venta - a.costo))[0];

        return {
            agotados: agotados.length,
            porAgotarse: porAgotarse.length,
            inversionTotal,
            mejorMargen
        };
    }, [productosConCosto]);

    const abrirModalNuevo = () => {
        setProductoEditando(null);
        setFormData({ nombre: '', tipo: 'simple', codigo_barras: '', precio_venta: '', costo: '', stock_actual: '', stock_minimo: '', tasa_itbis: '0.18', ingredientes: [] });
        setIsModalOpen(true);
    };

    const abrirModalEditar = async (producto: ProductoLocal) => {
        setProductoEditando(producto);

        let ingredientesCargados: any[] = [];
        if ((producto as any).tipo === 'combo') {
            const receta = await db.composiciones.where('producto_padre_id').equals(producto.id).toArray();
            ingredientesCargados = await Promise.all(receta.map(async (r) => {
                const insumo = await db.productos.get(r.insumo_id);
                return { insumo_id: r.insumo_id, nombre: insumo?.nombre || 'Insumo Eliminado', cantidad: r.cantidad_necesaria };
            }));
        }

        setFormData({
            nombre: producto.nombre,
            tipo: (producto as any).tipo || 'simple',
            codigo_barras: producto.codigo_barras || '',
            precio_venta: producto.precio_venta.toString(),
            costo: producto.costo.toString(),
            stock_actual: producto.stock_actual.toString(),
            stock_minimo: producto.stock_minimo.toString(),
            tasa_itbis: producto.tasa_itbis?.toString() || '0.18',
            ingredientes: ingredientesCargados
        });
        setIsModalOpen(true);
    };

    const guardarProducto = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId) return;
        const idProducto = productoEditando ? productoEditando.id : uuidv4();

        try {
            await db.transaction('rw', db.productos, db.composiciones, async () => {
                await db.productos.put({
                    id: idProducto,
                    negocio_id: negocioId,
                    nombre: formData.nombre,
                    tipo: formData.tipo,
                    codigo_barras: formData.codigo_barras,
                    precio_venta: formData.tipo === 'insumo' ? 0 : (parseFloat(formData.precio_venta) || 0),
                    costo: formData.tipo === 'combo' ? 0 : (parseFloat(formData.costo) || 0),
                    stock_actual: parseInt(formData.stock_actual) || 0,
                    stock_minimo: parseInt(formData.stock_minimo) || 0,
                    tasa_itbis: parseFloat(formData.tasa_itbis),
                    estado_sincronizacion: 0,
                    fecha_actualizacion: Date.now(),
                } as any);

                if (formData.tipo === 'combo') {
                    await db.composiciones.where('producto_padre_id').equals(idProducto).delete();
                    const nuevasComposiciones: ComposicionLocal[] = formData.ingredientes.map(ing => ({
                        id: uuidv4(),
                        producto_padre_id: idProducto,
                        insumo_id: ing.insumo_id,
                        cantidad_necesaria: ing.cantidad,
                        estado_sincronizacion: 0,
                        fecha_actualizacion: Date.now()
                    }));
                    await db.composiciones.bulkAdd(nuevasComposiciones);
                }
            });
            setIsModalOpen(false);
        } catch (error) {
            console.error("Error:", error);
        }
    };

    const eliminarProducto = async (id: string) => {
        if (confirm("¿Estás seguro de eliminar este producto?")) {
            const ahora = Date.now();
            await db.transaction('rw', db.productos, db.composiciones, async () => {
                // Soft delete: ocultar en UI y marcar para eliminar en Supabase al próximo sync
                await db.productos.update(id, { eliminado: true, estado_sincronizacion: 0, fecha_actualizacion: ahora });
                // Las composiciones huérfanas se limpian en el worker cuando el producto sea confirmado borrado
            });
        }
    };

    const abrirModalAjuste = (producto: ProductoLocal) => {
        setProductoAjustando(producto);
        setTipoAjuste('entrada');
        setCantidadAjuste('');
        setIsAjusteOpen(true);
    };

    const guardarAjuste = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!productoAjustando) return;
        const cantidad = parseFloat(cantidadAjuste);
        if (isNaN(cantidad) || cantidad < 0) return;

        const stockActual = productoAjustando.stock_actual;
        let nuevoStock: number;
        if (tipoAjuste === 'entrada') nuevoStock = stockActual + cantidad;
        else if (tipoAjuste === 'merma') nuevoStock = Math.max(0, stockActual - cantidad);
        else nuevoStock = cantidad;

        await db.productos.update(productoAjustando.id, {
            stock_actual: nuevoStock,
            estado_sincronizacion: 0,
            fecha_actualizacion: Date.now(),
        } as any);
        setIsAjusteOpen(false);
    };

    const insumosDisponibles = productos.filter(p => (p as any).tipo === 'insumo');

    return (
        <PinGuard title="Gestión de Inventario">
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <OfflineBanner />
                <div className="flex-1 p-3 sm:p-6 lg:p-8">
                <div className="max-w-7xl mx-auto">

                    <div className="flex justify-between items-center mb-4 sm:mb-8">
                        <div>
                            <h1 className="text-2xl sm:text-3xl font-display font-extrabold text-white">Inventario</h1>
                            <p className="text-vr-gray mt-0.5 text-sm hidden sm:block">Gestión inteligente de productos y recetas</p>
                        </div>
                        <button onClick={abrirModalNuevo} className="px-4 sm:px-6 py-2.5 sm:py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all shadow-md text-sm sm:text-base">
                            + Nuevo
                        </button>
                    </div>

                    {insights && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-4 sm:mb-8">
                            <div className={`p-3 sm:p-5 rounded-2xl border ${insights.porAgotarse > 0 ? 'border-vr-orange/30 bg-vr-orange/5' : 'border-navy-3 bg-navy-2'}`}>
                                <p className="text-xs font-bold text-vr-gray uppercase tracking-wider leading-tight">Alertas Stock</p>
                                <h3 className="text-xl sm:text-2xl font-black font-mono mt-1 text-white">
                                    {insights.porAgotarse} <span className="text-xs font-normal text-vr-gray">por agotarse</span>
                                </h3>
                            </div>

                            <div className="p-3 sm:p-5 rounded-2xl border border-navy-3 bg-navy-2">
                                <p className="text-xs font-bold text-vr-gray uppercase tracking-wider leading-tight">Capital Estante</p>
                                <h3 className="text-lg sm:text-2xl font-black font-mono mt-1 text-gold truncate">{formatDOP(insights.inversionTotal)}</h3>
                            </div>

                            <div className="p-3 sm:p-5 rounded-2xl border border-navy-3 bg-navy-2">
                                <p className="text-xs font-bold text-vr-gray uppercase tracking-wider leading-tight">Mayor Ganancia</p>
                                <h3 className="text-base sm:text-lg font-black mt-1 text-white truncate">{insights.mejorMargen?.nombre || 'N/A'}</h3>
                                <p className="text-xs text-vr-green mt-0.5 font-bold font-mono">+{formatDOP(insights.mejorMargen ? insights.mejorMargen.precio_venta - insights.mejorMargen.costo : 0)}</p>
                            </div>

                            <div className="p-3 sm:p-5 rounded-2xl border border-gold/15 bg-gold/5">
                                <p className="text-xs font-bold text-gold uppercase tracking-wider italic leading-tight">Consejo</p>
                                <p className="text-xs sm:text-sm mt-1 sm:mt-2 leading-tight text-vr-gray">
                                    {insights.agotados > 0 ? `${insights.agotados} productos en cero. ¡Estás perdiendo ventas!` : "Tu inventario está sano. ¡Buen trabajo!"}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* TABLE */}
                    <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                        <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="border-b border-navy-3 text-vr-gray text-xs uppercase tracking-wider">
                                    <th className="p-3 sm:p-4 font-semibold">Producto</th>
                                    <th className="p-3 sm:p-4 font-semibold hidden sm:table-cell">Precio</th>
                                    <th className="p-3 sm:p-4 font-semibold hidden md:table-cell">Costo</th>
                                    <th className="p-3 sm:p-4 font-semibold hidden md:table-cell">Margen</th>
                                    <th className="p-3 sm:p-4 font-semibold">Stock</th>
                                    <th className="p-3 sm:p-4 font-semibold text-right">Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {isLoading ? (
                                    <SkeletonTable rows={6} cols={6} />
                                ) : productosConCosto.length === 0 ? (
                                    <tr>
                                        <td colSpan={6} className="py-20 text-center text-vr-gray">
                                            <span className="text-4xl block mb-3">📦</span>
                                            <p className="font-medium">Sin productos aún. Agrega tu primer producto.</p>
                                        </td>
                                    </tr>
                                ) : productosPaginados.map((prod) => {
                                    const tipo = (prod as any).tipo as string;
                                    const esCombo = tipo === 'combo';
                                    const esInsumo = tipo === 'insumo';
                                    const stockClass = esCombo
                                        ? 'bg-purple-500/10 text-purple-300'
                                        : esInsumo
                                        ? 'bg-vr-orange/10 text-vr-orange'
                                        : prod.stock_actual <= prod.stock_minimo
                                        ? 'bg-vr-red/15 text-vr-red'
                                        : 'bg-vr-green/15 text-vr-green';
                                    return (
                                    <tr key={prod.id} className="border-b border-navy-3/50 hover:bg-navy-3/30 transition-colors">
                                        <td className="p-3 sm:p-4">
                                            <span className="font-bold text-white text-sm block">{prod.nombre}</span>
                                            {/* Type badge inline on mobile */}
                                            <span className={`mt-1 inline-block px-1.5 py-0.5 rounded text-[10px] font-black uppercase ${esCombo ? 'bg-purple-500/15 text-purple-400' : esInsumo ? 'bg-vr-orange/15 text-vr-orange' : 'bg-gold/15 text-gold'}`}>
                                                {tipo || 'simple'}
                                            </span>
                                            {/* Price on mobile */}
                                            <span className="sm:hidden ml-2 text-xs font-mono text-vr-green">
                                                {esInsumo ? '' : formatDOP(prod.precio_venta)}
                                            </span>
                                        </td>
                                        <td className="p-3 sm:p-4 font-medium font-mono text-vr-green text-sm hidden sm:table-cell">{esInsumo ? '-' : formatDOP(prod.precio_venta)}</td>
                                        <td className="p-3 sm:p-4 text-vr-gray font-mono text-sm hidden md:table-cell">{formatDOP(prod.costo)} {esCombo && <span className="text-[10px] italic ml-1">(calc)</span>}</td>
                                        <td className="p-3 sm:p-4 font-bold font-mono text-sm hidden md:table-cell">
                                            {esInsumo ? '-' : (
                                                <span className={(prod.precio_venta - prod.costo) > 0 ? 'text-vr-green' : 'text-vr-red'}>
                                                    {prod.precio_venta > 0 ? ((prod.precio_venta - prod.costo) / prod.precio_venta * 100).toFixed(0) : '0'}%
                                                </span>
                                            )}
                                        </td>
                                        <td className="p-3 sm:p-4">
                                            <span className={`px-2 py-1 rounded-md text-sm font-bold font-mono ${stockClass}`}>
                                                {parseFloat(Number(prod.stock_actual).toFixed(3))}
                                                {esCombo && <span className="text-[10px] ml-1 opacity-60">calc.</span>}
                                                {esInsumo && <span className="text-[10px] ml-1 opacity-60">ing.</span>}
                                            </span>
                                        </td>
                                        <td className="p-3 sm:p-4 text-right">
                                            <div className="flex items-center justify-end gap-2 sm:gap-3">
                                                {!esCombo && (
                                                    <button onClick={() => abrirModalAjuste(prod)} className="text-vr-green hover:text-vr-green/80 text-xs sm:text-sm font-bold transition-colors whitespace-nowrap">Ajuste</button>
                                                )}
                                                <button onClick={() => abrirModalEditar(prod)} className="text-gold hover:text-gold-2 text-xs sm:text-sm font-bold transition-colors">Editar</button>
                                                <button onClick={() => eliminarProducto(prod.id)} className="text-vr-red hover:text-vr-red/80 text-xs sm:text-sm font-bold transition-colors">Eliminar</button>
                                            </div>
                                        </td>
                                    </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        </div>
                        <Pagination
                            pagina={pagina}
                            totalPaginas={totalPaginas}
                            onCambiar={p => { setPagina(p); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                            totalItems={productosConCosto.length}
                            itemsPorPagina={ITEMS_POR_PAGINA}
                        />
                    </div>
                </div>

                {/* MODAL AJUSTE DE STOCK — full screen on mobile */}
                {isAjusteOpen && productoAjustando && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                        <div className="bg-navy-2 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                            <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                <div>
                                    <h2 className="text-xl font-display font-bold text-white">Ajuste de Stock</h2>
                                    <p className="text-sm text-vr-gray mt-0.5 truncate">{productoAjustando.nombre}</p>
                                </div>
                                <button onClick={() => setIsAjusteOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                            </div>
                            <form onSubmit={guardarAjuste} className="p-4 sm:p-6 space-y-5">
                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-2">Tipo de Ajuste</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {([
                                            { key: 'entrada', label: 'Entrada', color: 'text-vr-green border-vr-green bg-vr-green/10' },
                                            { key: 'merma', label: 'Merma', color: 'text-vr-red border-vr-red bg-vr-red/10' },
                                            { key: 'conteo', label: 'Conteo', color: 'text-gold border-gold bg-gold/10' },
                                        ] as const).map(({ key, label, color }) => (
                                            <button key={key} type="button"
                                                onClick={() => setTipoAjuste(key)}
                                                className={`py-2.5 rounded-lg border font-bold text-sm transition-all ${tipoAjuste === key ? color : 'border-navy-3 text-vr-gray hover:text-white'}`}>
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                    <p className="text-xs text-vr-gray mt-2">
                                        {tipoAjuste === 'entrada' && 'Suma unidades al stock actual.'}
                                        {tipoAjuste === 'merma' && 'Resta unidades al stock actual.'}
                                        {tipoAjuste === 'conteo' && 'Establece el stock según conteo físico.'}
                                    </p>
                                </div>

                                <div className="flex justify-between items-center bg-navy-3 rounded-xl px-4 py-3">
                                    <span className="text-sm text-vr-gray font-bold">Stock actual</span>
                                    <span className="font-mono font-black text-white text-lg">{parseFloat(Number(productoAjustando.stock_actual).toFixed(3))}</span>
                                </div>

                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">
                                        {tipoAjuste === 'conteo' ? 'Nuevo stock físico' : 'Cantidad'}
                                    </label>
                                    <input
                                        type="number" step="any" min="0" required
                                        autoFocus
                                        className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono text-xl focus:border-gold outline-none transition-all text-center"
                                        value={cantidadAjuste}
                                        onChange={e => setCantidadAjuste(e.target.value)}
                                        placeholder="0"
                                    />
                                </div>

                                {cantidadAjuste !== '' && !isNaN(parseFloat(cantidadAjuste)) && (
                                    <div className="flex justify-between items-center bg-navy rounded-xl px-4 py-3 border border-navy-3">
                                        <span className="text-sm text-vr-gray font-bold">Resultado</span>
                                        <span className={`font-mono font-black text-lg ${tipoAjuste === 'merma' ? 'text-vr-red' : tipoAjuste === 'entrada' ? 'text-vr-green' : 'text-gold'}`}>
                                            {tipoAjuste === 'entrada' && `${parseFloat(Number(productoAjustando.stock_actual + parseFloat(cantidadAjuste)).toFixed(3))}`}
                                            {tipoAjuste === 'merma' && `${parseFloat(Number(Math.max(0, productoAjustando.stock_actual - parseFloat(cantidadAjuste))).toFixed(3))}`}
                                            {tipoAjuste === 'conteo' && `${parseFloat(Number(parseFloat(cantidadAjuste)).toFixed(3))}`}
                                        </span>
                                    </div>
                                )}

                                <div className="flex gap-3">
                                    <button type="button" onClick={() => setIsAjusteOpen(false)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                                    <button type="submit" className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all">Aplicar</button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}

                {/* MODAL PRODUCTO — full screen on mobile */}
                {isModalOpen && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                        <div className="bg-navy-2 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden max-h-[95vh] sm:max-h-[90vh] flex flex-col animate-scale-in">
                            <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                <h2 className="text-xl font-display font-bold text-white">{productoEditando ? 'Editar Producto' : 'Nuevo Producto'}</h2>
                                <button onClick={() => setIsModalOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                            </div>

                            <form onSubmit={guardarProducto} className="p-4 sm:p-6 space-y-4 overflow-y-auto">
                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-2">Tipo de Producto</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {['simple', 'insumo', 'combo'].map((t) => (
                                            <button key={t} type="button" onClick={() => setFormData({ ...formData, tipo: t as any })}
                                                className={`py-2.5 rounded-lg border font-bold capitalize transition-all text-sm ${formData.tipo === t ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}>
                                                {t === 'simple' ? 'Venta' : t}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">Nombre del Producto *</label>
                                    <input required type="text" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" value={formData.nombre} onChange={e => setFormData({ ...formData, nombre: e.target.value })} />
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    {formData.tipo !== 'insumo' ? (
                                        <div>
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Precio Venta (RD$)</label>
                                            <input type="number" step="0.01" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono focus:border-gold outline-none transition-all" value={formData.precio_venta} onChange={e => setFormData({ ...formData, precio_venta: e.target.value })} />
                                        </div>
                                    ) : (
                                        <div>
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Precio Venta</label>
                                            <div className="w-full bg-navy-3/50 text-vr-gray font-bold rounded-xl p-3 text-sm">No aplica</div>
                                        </div>
                                    )}
                                    {formData.tipo !== 'combo' ? (
                                        <div>
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Costo (RD$)</label>
                                            <input type="number" step="0.01" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono focus:border-gold outline-none transition-all" value={formData.costo} onChange={e => setFormData({ ...formData, costo: e.target.value })} />
                                        </div>
                                    ) : (
                                        <div>
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Costo Calculado</label>
                                            <div className="w-full bg-navy-3/50 text-gold font-bold font-mono rounded-xl p-3">
                                                {formData.ingredientes.reduce((acc, ing) => {
                                                    const insumo = productos.find(p => p.id === ing.insumo_id);
                                                    return acc + ((insumo?.costo || 0) * ing.cantidad);
                                                }, 0).toFixed(2)}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div className="grid grid-cols-3 gap-3">
                                    {formData.tipo !== 'combo' ? (
                                        <div>
                                            <label className="block text-xs font-bold text-vr-gray mb-1.5">Stock Actual</label>
                                            <input type="number" step="any" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono focus:border-gold outline-none transition-all" value={formData.stock_actual} onChange={e => setFormData({ ...formData, stock_actual: e.target.value })} />
                                        </div>
                                    ) : (
                                        <div>
                                            <label className="block text-xs font-bold text-vr-gray mb-1.5">Stock Posible</label>
                                            <div className="w-full bg-navy-3/50 border border-navy-3 text-vr-gray text-sm font-bold rounded-xl p-3 truncate">
                                                {parseFloat(Number(formData.stock_actual).toFixed(3))} <span className="font-normal italic text-xs">(calc)</span>
                                            </div>
                                        </div>
                                    )}
                                    <div>
                                        <label className="block text-xs font-bold text-vr-gray mb-1.5">Mínimo</label>
                                        <input type="number" step="any" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono focus:border-gold outline-none transition-all" value={formData.stock_minimo} onChange={e => setFormData({ ...formData, stock_minimo: e.target.value })} />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-vr-gray mb-1.5">ITBIS</label>
                                        <select className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" value={formData.tasa_itbis} onChange={e => setFormData({ ...formData, tasa_itbis: e.target.value })}>
                                            <option value="0">0%</option>
                                            <option value="0.18">18%</option>
                                        </select>
                                    </div>
                                </div>

                                {/* ARMADOR DE COMBOS */}
                                {formData.tipo === 'combo' && (
                                    <div className="p-4 bg-purple-500/10 rounded-xl border border-purple-500/20">
                                        <h3 className="text-sm font-bold text-purple-400 mb-3 uppercase tracking-wider italic">Composición del Combo</h3>
                                        <div className="relative mb-3">
                                            <input type="text" placeholder="Añadir ingrediente..." className="w-full p-2.5 text-sm bg-navy-3 border border-navy-3 rounded-lg outline-none text-white focus:border-purple-400 transition-all" value={busquedaInsumo} onChange={(e) => setBusquedaInsumo(e.target.value)} />
                                            {busquedaInsumo && (
                                                <div className="absolute z-50 w-full bg-navy shadow-xl rounded-lg mt-1 border border-navy-3 max-h-48 overflow-y-auto">
                                                    {insumosDisponibles.filter(i => i.nombre.toLowerCase().includes(busquedaInsumo.toLowerCase())).map(ins => (
                                                        <button key={ins.id} type="button" onClick={() => {
                                                            if (!formData.ingredientes.find(x => x.insumo_id === ins.id)) {
                                                                setFormData({ ...formData, ingredientes: [...formData.ingredientes, { insumo_id: ins.id, nombre: ins.nombre, cantidad: 1 }] });
                                                            }
                                                            setBusquedaInsumo('');
                                                        }} className="w-full text-left p-3 hover:bg-navy-3 text-xs font-bold border-b border-navy-3 last:border-0 text-white">+ {ins.nombre}</button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                        <div className="space-y-2">
                                            {formData.ingredientes.map((ing, index) => (
                                                <div key={ing.insumo_id} className="flex items-center justify-between bg-navy-3 p-2 rounded-lg text-xs">
                                                    <span className="font-bold text-white truncate flex-1 mr-2">{ing.nombre}</span>
                                                    <div className="flex items-center gap-2 shrink-0">
                                                        <input type="number" step="0.01" className="w-16 bg-transparent border-b border-purple-400 text-center outline-none text-white font-mono" value={ing.cantidad} onChange={e => {
                                                            const newIngs = [...formData.ingredientes];
                                                            newIngs[index].cantidad = parseFloat(e.target.value);
                                                            setFormData({ ...formData, ingredientes: newIngs });
                                                        }} />
                                                        <button type="button" onClick={() => setFormData({ ...formData, ingredientes: formData.ingredientes.filter(i => i.insumo_id !== ing.insumo_id) })} className="text-vr-red font-bold text-base">✕</button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <div className="pt-4 border-t border-navy-3 flex gap-3">
                                    <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                                    <button type="submit" className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all">Guardar</button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}
            </div>
        </div>
        </PinGuard>
    );
}
