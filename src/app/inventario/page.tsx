// src/app/inventario/page.tsx
'use client';

import { useMemo, useState, useRef, lazy, Suspense } from 'react';
import Link from 'next/link';
import { db } from '@/lib/db/dexie';
import { registrarMovimientoStock } from '@/lib/db/stock';
import { comprimirImagen, miniatura } from '@/lib/imagen';
import ConfirmModal from '@/components/ui/ConfirmModal';
import { useProductosTenant, useComposicionesTenant, useVentasPeriodoTenant, useVentaDetallesPorVentas } from '@/lib/db/tenantQuery';
import { useConfigStore } from '@/store/useConfigStore';
import { ProductoLocal, ComposicionLocal, MovimientoStockLocal } from '@/types/database';
import { formatDOP } from '@/lib/utils';
import { v4 as uuidv4 } from 'uuid';
import { useLiveQuery } from 'dexie-react-hooks';
import PinGuard from '@/components/ui/PinGuard';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';
import { SkeletonTable } from '@/components/ui/Skeleton';
import Pagination from '@/components/ui/Pagination';

const BarcodeScanner = lazy(() => import('@/components/ui/BarcodeScanner'));

// Normaliza texto para búsqueda: minúsculas y sin tildes (la gente busca "cafe", no "café")
const norm = (s: string | null | undefined): string =>
    (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

type FiltroInventario = 'todos' | 'por_agotarse' | 'agotados' | 'simple' | 'insumo' | 'combo';
type OrdenInventario = 'nombre' | 'stock' | 'margen';

// Etiquetas y colores por tipo de movimiento de stock (para el historial)
const META_MOVIMIENTO: Record<MovimientoStockLocal['tipo'], { label: string; icono: string; color: string }> = {
    venta:       { label: 'Venta',         icono: '🛒', color: 'text-vr-red' },
    merma:       { label: 'Merma',         icono: '📉', color: 'text-vr-red' },
    devolucion:  { label: 'Devolución',    icono: '↩️', color: 'text-vr-green' },
    entrada:     { label: 'Entrada',       icono: '📦', color: 'text-vr-green' },
    conteo:      { label: 'Conteo físico', icono: '🔢', color: 'text-gold' },
    importacion: { label: 'Importación',   icono: '📥', color: 'text-gold' },
    reparacion:  { label: 'Reparación',    icono: '🔧', color: 'text-vr-red' },
    apartado:    { label: 'Apartado',      icono: '🔖', color: 'text-vr-red' },
};

// Input de edición rápida en línea (Enter guarda, Escape cancela, blur guarda)
function CeldaEditInput({ valor, onValor, onGuardar, onCancelar }: {
    valor: string;
    onValor: (v: string) => void;
    onGuardar: () => void;
    onCancelar: () => void;
}) {
    return (
        <input
            type="number" step="any" min="0" autoFocus
            value={valor}
            onChange={e => onValor(e.target.value)}
            onBlur={onGuardar}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); onGuardar(); }
                else if (e.key === 'Escape') { e.preventDefault(); onCancelar(); }
            }}
            className="w-20 bg-navy border border-gold rounded-md px-2 py-1 text-white font-mono text-sm outline-none text-right"
        />
    );
}

export default function InventarioPage() {
    const { negocioId, showToast, isOnline } = useConfigStore();
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
    // Foto del producto: data URL (nueva, pendiente de subir) o URL http (existente)
    const [fotoProducto, setFotoProducto] = useState<string | null>(null);
    const fotoInputRef = useRef<HTMLInputElement>(null);
    const [busquedaInsumo, setBusquedaInsumo] = useState('');
    const [isScannerOpen, setIsScannerOpen] = useState(false);

    const [isAjusteOpen, setIsAjusteOpen] = useState(false);
    const [productoAjustando, setProductoAjustando] = useState<ProductoLocal | null>(null);
    // Historial de movimientos de un producto (entradas, mermas, ventas, conteos…)
    const [productoHistorial, setProductoHistorial] = useState<ProductoLocal | null>(null);
    const movimientosHistorial = useLiveQuery(
        async () => {
            if (!productoHistorial) return [];
            const movs = await db.movimientos_stock.where('producto_id').equals(productoHistorial.id).toArray();
            movs.sort((a, b) => b.fecha_creacion - a.fecha_creacion);
            return movs.slice(0, 50);
        },
        [productoHistorial?.id]
    ) || [];
    const [tipoAjuste, setTipoAjuste] = useState<'entrada' | 'merma' | 'conteo'>('entrada');
    const [cantidadAjuste, setCantidadAjuste] = useState('');
    const [serialesEntrada, setSerialesEntrada] = useState<string[]>(['']); // inputs de seriales en entrada
    const [scannerSerialIdx, setScannerSerialIdx] = useState<number | null>(null); // índice del campo que está escaneando

    const [formData, setFormData] = useState({
        nombre: '',
        tipo: 'simple' as 'simple' | 'insumo' | 'combo',
        codigo_barras: '',
        ubicacion: '',
        serializable: false,
        precio_venta: '',
        precio_2: '',
        precio_3: '',
        costo: '',
        stock_actual: '',
        stock_minimo: '',
        tasa_itbis: '0.18',
        ingredientes: [] as { insumo_id: string, nombre: string, cantidad: number }[]
    });

    // ─── Búsqueda, filtros y orden ────────────────────────────────────────
    const [busqueda, setBusqueda] = useState('');
    const [filtro, setFiltro] = useState<FiltroInventario>('todos');
    const [orden, setOrden] = useState<OrdenInventario>('nombre');
    const [isBusquedaScanOpen, setIsBusquedaScanOpen] = useState(false);

    // ─── Edición rápida en línea (precio y stock) ──────────────────────────
    // Precio: escritura directa del campo. Stock: movimiento de conteo (mantiene
    // la auditoría y el sync atómico — nunca se escribe el stock a mano).
    const [celdaEdit, setCeldaEdit] = useState<{ id: string; campo: 'precio' | 'stock' } | null>(null);
    const [valorEdit, setValorEdit] = useState('');

    const iniciarEdicion = (prod: ProductoLocal, campo: 'precio' | 'stock') => {
        setCeldaEdit({ id: prod.id, campo });
        setValorEdit(String(campo === 'precio' ? prod.precio_venta : prod.stock_actual));
    };

    const cancelarEdicion = () => { setCeldaEdit(null); setValorEdit(''); };

    const guardarEdicion = async (prod: ProductoLocal) => {
        if (!celdaEdit || celdaEdit.id !== prod.id) return;
        const campo = celdaEdit.campo;
        const num = parseFloat(valorEdit);
        if (isNaN(num) || num < 0) { cancelarEdicion(); return; }
        // Manejador de evento (blur/Enter), no se ejecuta en render: Date.now() es seguro.
        // (onGuardar es un prop personalizado, por eso el linter no lo reconoce como handler.)
        // eslint-disable-next-line react-hooks/purity
        const ahora = Date.now();
        try {
            if (campo === 'precio') {
                if (num !== prod.precio_venta) {
                    await db.productos.update(prod.id, { precio_venta: num, estado_sincronizacion: 0, fecha_actualizacion: ahora });
                    showToast('Precio actualizado.', 'success');
                }
            } else {
                if (num !== prod.stock_actual) {
                    await registrarMovimientoStock({ productoId: prod.id, tipo: 'conteo', valorAbsoluto: num });
                    showToast('Stock ajustado por conteo.', 'success');
                }
            }
        } catch (e) {
            console.error('[edicion rapida]', e);
            showToast('No se pudo guardar el cambio.', 'error');
        }
        cancelarEdicion();
    };

    const productosFiltrados = useMemo(() => {
        const q = norm(busqueda).trim();
        const terminos = q ? q.split(/\s+/) : [];

        const lista = productosConCosto.filter(p => {
            const tipo = p.tipo || 'simple';

            // Filtro por categoría / estado de stock
            if (filtro === 'simple' && tipo !== 'simple') return false;
            if (filtro === 'insumo' && tipo !== 'insumo') return false;
            if (filtro === 'combo' && tipo !== 'combo') return false;
            if (filtro === 'agotados' && !(tipo === 'simple' && p.stock_actual <= 0)) return false;
            if (filtro === 'por_agotarse' && !(tipo === 'simple' && p.stock_actual > 0 && p.stock_actual <= p.stock_minimo)) return false;

            // Búsqueda por texto (nombre + código de barras + ubicación). Todos los términos deben coincidir.
            if (terminos.length > 0) {
                const heno = norm(`${p.nombre} ${p.codigo_barras || ''} ${p.ubicacion || ''}`);
                if (!terminos.every(t => heno.includes(t))) return false;
            }
            return true;
        });

        const ordenada = [...lista];
        if (orden === 'nombre') {
            ordenada.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
        } else if (orden === 'stock') {
            ordenada.sort((a, b) => a.stock_actual - b.stock_actual);
        } else if (orden === 'margen') {
            const margen = (p: typeof lista[number]) => p.precio_venta - p.costo;
            ordenada.sort((a, b) => margen(b) - margen(a));
        }
        return ordenada;
    }, [productosConCosto, busqueda, filtro, orden]);

    const ITEMS_POR_PAGINA = 20;
    const [pagina, setPagina] = useState(1);
    // Al cambiar búsqueda/filtro/orden, volver a la primera página.
    // Patrón de "ajustar estado durante el render" (sin useEffect): comparamos
    // una firma de los filtros con la anterior y reseteamos si cambió.
    const firmaFiltros = `${busqueda}|${filtro}|${orden}`;
    const [firmaPrev, setFirmaPrev] = useState(firmaFiltros);
    if (firmaFiltros !== firmaPrev) {
        setFirmaPrev(firmaFiltros);
        setPagina(1);
    }

    const productosPaginados = useMemo(() => {
        const inicio = (pagina - 1) * ITEMS_POR_PAGINA;
        return productosFiltrados.slice(inicio, inicio + ITEMS_POR_PAGINA);
    }, [productosFiltrados, pagina]);
    const totalPaginas = Math.ceil(productosFiltrados.length / ITEMS_POR_PAGINA);

    // Conteos para las pastillas de filtro (sobre el catálogo completo, no el filtrado)
    const conteos = useMemo(() => {
        const simples = productosConCosto.filter(p => (p.tipo || 'simple') === 'simple');
        return {
            todos: productosConCosto.length,
            por_agotarse: simples.filter(p => p.stock_actual > 0 && p.stock_actual <= p.stock_minimo).length,
            agotados: simples.filter(p => p.stock_actual <= 0).length,
            simple: simples.length,
            insumo: productosConCosto.filter(p => p.tipo === 'insumo').length,
            combo: productosConCosto.filter(p => p.tipo === 'combo').length,
        };
    }, [productosConCosto]);

    // ─── Reorden inteligente ──────────────────────────────────────────────
    // Velocidad de venta de los últimos 14 días → "te quedan ~X días de stock".
    // Los combos se expanden a sus insumos vía recetas para que el consumo
    // de ingredientes también cuente.
    const DIAS_VENTANA = 14;
    const DIAS_COBERTURA = 14; // cuánto stock comprar (2 semanas)
    const UMBRAL_DIAS = 7;     // alertar cuando queden ≤7 días

    const ventas14 = useVentasPeriodoTenant(DIAS_VENTANA);
    const detalles14 = useVentaDetallesPorVentas(useMemo(() => ventas14.map(v => v.id), [ventas14]));

    const sugerenciasReorden = useMemo(() => {
        if (detalles14.length === 0) return [];

        // Recetas indexadas por combo
        const recetasPorCombo = new Map<string, ComposicionLocal[]>();
        composiciones.forEach(c => {
            const arr = recetasPorCombo.get(c.producto_padre_id) ?? [];
            arr.push(c);
            recetasPorCombo.set(c.producto_padre_id, arr);
        });

        // Consumo real por producto (combos → insumos)
        const consumo = new Map<string, number>();
        detalles14.forEach(d => {
            const receta = recetasPorCombo.get(d.producto_id);
            if (receta && receta.length > 0) {
                receta.forEach(ing => {
                    consumo.set(ing.insumo_id, (consumo.get(ing.insumo_id) ?? 0) + ing.cantidad_necesaria * d.cantidad);
                });
            } else {
                consumo.set(d.producto_id, (consumo.get(d.producto_id) ?? 0) + d.cantidad);
            }
        });

        return productos
            .filter(p => p.tipo !== 'combo') // los combos no se compran, se arman
            .map(p => {
                const vendido = consumo.get(p.id) ?? 0;
                if (vendido <= 0) return null;
                const velocidad = vendido / DIAS_VENTANA; // unidades por día
                const diasRestantes = p.stock_actual > 0 ? p.stock_actual / velocidad : 0;
                if (diasRestantes > UMBRAL_DIAS) return null;
                const sugerido = Math.max(1, Math.ceil(velocidad * DIAS_COBERTURA - p.stock_actual));
                return { producto: p, velocidad, diasRestantes, sugerido };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null)
            .sort((a, b) => a.diasRestantes - b.diasRestantes)
            .slice(0, 15);
    }, [productos, composiciones, detalles14]);

    // Exporta los productos actualmente filtrados a Excel, con las mismas columnas
    // que acepta el importador (se puede exportar, editar en Excel y reimportar).
    const exportarInventario = async () => {
        if (productosFiltrados.length === 0) { showToast('No hay productos para exportar.', 'info'); return; }
        try {
            const XLSX = await import('xlsx');
            const datos = [
                ['Nombre', 'Precio Venta', 'Costo', 'Stock', 'Stock Minimo', 'Codigo de Barras', 'Ubicacion', 'Tipo'],
                ...productosFiltrados.map(p => [
                    p.nombre,
                    p.tipo === 'insumo' ? 0 : p.precio_venta,
                    p.costo,
                    parseFloat(Number(p.stock_actual).toFixed(3)),
                    p.stock_minimo,
                    p.codigo_barras || '',
                    p.ubicacion || '',
                    p.tipo || 'simple',
                ]),
            ];
            const ws = XLSX.utils.aoa_to_sheet(datos);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Inventario');
            const fecha = new Date().toISOString().slice(0, 10);
            XLSX.writeFile(wb, `inventario_ventard_${fecha}.xlsx`);
            showToast(`${productosFiltrados.length} productos exportados.`, 'success');
        } catch (e) {
            console.error('[exportar]', e);
            showToast('No se pudo exportar el inventario.', 'error');
        }
    };

    // Resalta en amarillo los términos buscados dentro de un texto (el nombre).
    const resaltar = (texto: string): React.ReactNode => {
        const raw = busqueda.trim();
        if (!raw) return texto;
        const crudos = raw.split(/\s+/).filter(Boolean);
        if (crudos.length === 0) return texto;
        const escapados = crudos.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const re = new RegExp(`(${escapados.join('|')})`, 'gi');
        const bajos = new Set(crudos.map(t => t.toLowerCase()));
        return texto.split(re).map((parte, i) =>
            bajos.has(parte.toLowerCase())
                ? <mark key={i} className="bg-gold/25 text-gold rounded px-0.5">{parte}</mark>
                : <span key={i}>{parte}</span>
        );
    };

    const enviarListaCompras = () => {
        const lineas = sugerenciasReorden.map(s =>
            `• ${s.producto.nombre} — comprar ~${s.sugerido} (quedan ${parseFloat(s.producto.stock_actual.toFixed(1))})`
        );
        const msg = `🛒 *Lista de compras sugerida*\n\n${lineas.join('\n')}\n\nGenerada por VentaRD según las ventas de los últimos ${DIAS_VENTANA} días.`;
        window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
    };

    const insights = useMemo(() => {
        if (productosConCosto.length === 0) return null;

        const vendibles = productosConCosto.filter(p => (p as any).tipo === 'simple');
        const agotados = vendibles.filter(p => p.stock_actual <= 0);
        const porAgotarse = vendibles.filter(p => p.stock_actual > 0 && p.stock_actual <= p.stock_minimo);
        const inversionTotal = productosConCosto
            .filter(p => (p as any).tipo !== 'combo')
            .reduce((acc, p) => acc + (p.costo * p.stock_actual), 0);

        // Ganancia potencial: lo que ganarías si vendieras todo el stock actual
        // (solo productos vendibles con stock positivo).
        const gananciaPotencial = vendibles
            .filter(p => p.stock_actual > 0)
            .reduce((acc, p) => acc + ((p.precio_venta - p.costo) * p.stock_actual), 0);

        const mejorMargen = [...productosConCosto]
            .filter(p => (p as any).tipo === 'simple')
            .sort((a, b) => (b.precio_venta - b.costo) - (a.precio_venta - a.costo))[0];

        return {
            agotados: agotados.length,
            porAgotarse: porAgotarse.length,
            inversionTotal,
            gananciaPotencial,
            mejorMargen
        };
    }, [productosConCosto]);

    const abrirModalNuevo = () => {
        setProductoEditando(null);
        setFormData({ nombre: '', tipo: 'simple', codigo_barras: '', ubicacion: '', serializable: false, precio_venta: '', precio_2: '', precio_3: '', costo: '', stock_actual: '', stock_minimo: '', tasa_itbis: '0.18', ingredientes: [] });
        setFotoProducto(null);
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
            ubicacion: producto.ubicacion || '',
            serializable: producto.serializable ?? false,
            precio_venta: producto.precio_venta.toString(),
            precio_2: producto.precio_2?.toString() || '',
            precio_3: producto.precio_3?.toString() || '',
            costo: producto.costo.toString(),
            stock_actual: producto.stock_actual.toString(),
            stock_minimo: producto.stock_minimo.toString(),
            tasa_itbis: producto.tasa_itbis?.toString() || '0.18',
            ingredientes: ingredientesCargados
        });
        setFotoProducto(producto.imagen_url ?? null);
        setIsModalOpen(true);
    };

    const guardarProducto = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId) return;
        const idProducto = productoEditando ? productoEditando.id : uuidv4();

        try {
            // Foto: si es nueva (data URL), subirla a Cloudinary antes de guardar
            let imagenFinal: string | undefined = fotoProducto || undefined;
            if (fotoProducto?.startsWith('data:')) {
                if (navigator.onLine) {
                    try {
                        const res = await fetch('/api/upload/producto', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ dataUrl: fotoProducto, productoId: idProducto }),
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error);
                        imagenFinal = data.url;
                    } catch (err) {
                        console.error('[foto producto]', err);
                        showToast('No se pudo subir la foto — el producto se guardó sin ella.', 'info');
                        imagenFinal = productoEditando?.imagen_url;
                    }
                } else {
                    showToast('Sin internet: el producto se guardó sin la foto. Súbela de nuevo cuando tengas conexión.', 'info');
                    imagenFinal = productoEditando?.imagen_url;
                }
            }

            await db.transaction('rw', db.productos, db.composiciones, db.movimientos_stock, async () => {
                const precio2 = parseFloat(formData.precio_2) || undefined;
                const precio3 = parseFloat(formData.precio_3) || undefined;
                const stockFormulario = parseInt(formData.stock_actual) || 0;
                // El stock NO se escribe directo: se registra como movimiento
                // (entrada inicial si es nuevo, conteo si cambió en edición)
                const stockPrevio = productoEditando?.stock_actual ?? 0;
                await db.productos.put({
                    id: idProducto,
                    negocio_id: negocioId,
                    nombre: formData.nombre,
                    tipo: formData.tipo,
                    codigo_barras: formData.codigo_barras,
                    ...(formData.ubicacion && { ubicacion: formData.ubicacion }),
                    ...(imagenFinal && { imagen_url: imagenFinal }),
                    serializable: formData.serializable || undefined,
                    precio_venta: formData.tipo === 'insumo' ? 0 : (parseFloat(formData.precio_venta) || 0),
                    ...(formData.tipo !== 'insumo' && precio2 && { precio_2: precio2 }),
                    ...(formData.tipo !== 'insumo' && precio3 && { precio_3: precio3 }),
                    costo: formData.tipo === 'combo' ? 0 : (parseFloat(formData.costo) || 0),
                    stock_actual: stockPrevio,
                    stock_minimo: parseInt(formData.stock_minimo) || 0,
                    tasa_itbis: parseFloat(formData.tasa_itbis),
                    estado_sincronizacion: 0,
                    fecha_actualizacion: Date.now(),
                } as any);

                if (formData.tipo !== 'combo') {
                    if (!productoEditando && stockFormulario > 0) {
                        // Producto nuevo con stock inicial
                        await registrarMovimientoStock({ productoId: idProducto, tipo: 'entrada', delta: stockFormulario });
                    } else if (productoEditando && stockFormulario !== stockPrevio) {
                        // Edición con cambio manual de stock = conteo
                        await registrarMovimientoStock({ productoId: idProducto, tipo: 'conteo', valorAbsoluto: stockFormulario });
                    }
                }

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

    const [productoAEliminar, setProductoAEliminar] = useState<ProductoLocal | null>(null);

    const eliminarProducto = async () => {
        if (!productoAEliminar) return;
        const ahora = Date.now();
        await db.transaction('rw', db.productos, db.composiciones, async () => {
            // Soft delete: ocultar en UI y marcar para eliminar en Supabase al próximo sync
            await db.productos.update(productoAEliminar.id, { eliminado: true, estado_sincronizacion: 0, fecha_actualizacion: ahora });
            // Las composiciones huérfanas se limpian en el worker cuando el producto sea confirmado borrado
        });
        setProductoAEliminar(null);
        showToast('Producto eliminado.', 'info');
    };

    const abrirModalAjuste = (producto: ProductoLocal) => {
        setProductoAjustando(producto);
        setTipoAjuste('entrada');
        setCantidadAjuste('');
        setSerialesEntrada(['']);
        setScannerSerialIdx(null);
        setIsAjusteOpen(true);
    };

    const guardarAjuste = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!productoAjustando || !negocioId) return;

        // Producto serializable + entrada: validar que los seriales estén completos
        const esSerializable = productoAjustando.serializable;
        if (esSerializable && tipoAjuste === 'entrada') {
            const seriales = serialesEntrada.map(s => s.trim()).filter(Boolean);
            if (seriales.length === 0) return;
            // Guardar cada serial en Dexie
            await Promise.all(seriales.map(num =>
                db.seriales.add({
                    id: uuidv4(),
                    negocio_id: negocioId,
                    producto_id: productoAjustando.id,
                    numero_serial: num,
                    estado: 'disponible',
                    venta_id: null,
                    fecha_venta: null,
                    estado_sincronizacion: 0,
                    fecha_actualizacion: Date.now(),
                })
            ));
            // Entrada de seriales: delta = cantidad de seriales nuevos
            await registrarMovimientoStock({
                productoId: productoAjustando.id,
                tipo: 'entrada',
                delta: seriales.length,
            });
            setIsAjusteOpen(false);
            return;
        }

        const cantidad = parseFloat(cantidadAjuste);
        if (isNaN(cantidad) || cantidad < 0) return;

        if (tipoAjuste === 'entrada') {
            await registrarMovimientoStock({ productoId: productoAjustando.id, tipo: 'entrada', delta: cantidad });
        } else if (tipoAjuste === 'merma') {
            const aRestar = Math.min(cantidad, productoAjustando.stock_actual);
            await registrarMovimientoStock({ productoId: productoAjustando.id, tipo: 'merma', delta: -aRestar });
        } else {
            // Conteo físico: establece el stock exacto
            await registrarMovimientoStock({ productoId: productoAjustando.id, tipo: 'conteo', valorAbsoluto: cantidad });
        }
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
                        <div className="flex items-center gap-2">
                            <Link
                                href="/inventario/importar"
                                className="px-3 sm:px-5 py-2.5 sm:py-3 bg-navy-2 border border-navy-3 text-vr-gray hover:text-gold hover:border-gold/40 font-bold rounded-xl transition-all text-sm sm:text-base whitespace-nowrap"
                            >
                                📥 <span className="hidden sm:inline">Importar</span>
                            </Link>
                            <button
                                onClick={exportarInventario}
                                disabled={productosConCosto.length === 0}
                                className="px-3 sm:px-5 py-2.5 sm:py-3 bg-navy-2 border border-navy-3 text-vr-gray hover:text-gold hover:border-gold/40 font-bold rounded-xl transition-all text-sm sm:text-base whitespace-nowrap disabled:opacity-30 disabled:cursor-not-allowed"
                                title="Exportar a Excel"
                            >
                                📤 <span className="hidden sm:inline">Exportar</span>
                            </button>
                            <button onClick={abrirModalNuevo} className="px-4 sm:px-6 py-2.5 sm:py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all shadow-md text-sm sm:text-base whitespace-nowrap">
                                + Nuevo
                            </button>
                        </div>
                    </div>

                    {insights && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-4 sm:mb-8">
                            <button
                                type="button"
                                onClick={() => { setFiltro('por_agotarse'); setBusqueda(''); }}
                                className={`text-left p-3 sm:p-5 rounded-2xl border transition-all hover:brightness-110 ${insights.porAgotarse > 0 ? 'border-vr-orange/30 bg-vr-orange/5' : 'border-navy-3 bg-navy-2'} ${filtro === 'por_agotarse' ? 'ring-2 ring-gold/50' : ''}`}
                                title="Ver productos por agotarse"
                            >
                                <p className="text-xs font-bold text-vr-gray uppercase tracking-wider leading-tight">Alertas Stock</p>
                                <h3 className="text-xl sm:text-2xl font-black font-mono mt-1 text-white">
                                    {insights.porAgotarse} <span className="text-xs font-normal text-vr-gray">por agotarse</span>
                                </h3>
                            </button>

                            <div className="p-3 sm:p-5 rounded-2xl border border-navy-3 bg-navy-2">
                                <p className="text-xs font-bold text-vr-gray uppercase tracking-wider leading-tight">Capital Estante</p>
                                <h3 className="text-lg sm:text-2xl font-black font-mono mt-1 text-gold truncate">{formatDOP(insights.inversionTotal)}</h3>
                                {insights.gananciaPotencial > 0 && (
                                    <p className="text-[11px] text-vr-green mt-0.5 font-bold font-mono truncate" title="Ganancia si vendes todo el stock">
                                        +{formatDOP(insights.gananciaPotencial)} <span className="font-normal text-vr-gray">al vender todo</span>
                                    </p>
                                )}
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

                    {/* REORDEN INTELIGENTE */}
                    {sugerenciasReorden.length > 0 && (
                        <div className="bg-navy-2 rounded-2xl border border-gold/20 overflow-hidden mb-4 sm:mb-8">
                            <div className="px-4 py-3 border-b border-navy-3 flex items-center justify-between gap-3 flex-wrap">
                                <div>
                                    <h2 className="text-sm font-display font-bold text-gold">🧠 Reorden Inteligente</h2>
                                    <p className="text-[11px] text-vr-gray mt-0.5">Según tus ventas de los últimos 14 días</p>
                                </div>
                                <button
                                    onClick={enviarListaCompras}
                                    className="px-3 py-1.5 bg-vr-green/10 text-vr-green font-bold rounded-lg hover:bg-vr-green/20 text-xs border border-vr-green/20 transition-all whitespace-nowrap"
                                >
                                    📱 Enviar lista de compras
                                </button>
                            </div>
                            <div className="divide-y divide-navy-3/50">
                                {sugerenciasReorden.map(({ producto: p, velocidad, diasRestantes, sugerido }) => {
                                    const diasRedondeados = Math.floor(diasRestantes);
                                    const urgencia = diasRestantes <= 2
                                        ? 'bg-vr-red/15 text-vr-red border-vr-red/20'
                                        : diasRestantes <= 5
                                            ? 'bg-vr-orange/15 text-vr-orange border-vr-orange/20'
                                            : 'bg-gold/15 text-gold border-gold/20';
                                    return (
                                        <div key={p.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-navy-3/20 transition-colors">
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-bold text-white truncate">{p.nombre}</p>
                                                <p className="text-[11px] text-vr-gray">
                                                    Vendes ~{velocidad >= 1 ? Math.round(velocidad) : velocidad.toFixed(1)}/día · quedan {parseFloat(p.stock_actual.toFixed(1))}
                                                </p>
                                            </div>
                                            <span className={`px-2 py-1 rounded-md text-[11px] font-black border whitespace-nowrap shrink-0 ${urgencia}`}>
                                                {p.stock_actual <= 0
                                                    ? 'AGOTADO'
                                                    : diasRedondeados === 0 ? 'Se acaba HOY' : `~${diasRedondeados} día${diasRedondeados === 1 ? '' : 's'}`}
                                            </span>
                                            <span className="font-mono font-black text-vr-green text-sm whitespace-nowrap shrink-0">
                                                +{sugerido}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* BÚSQUEDA + FILTROS */}
                    {(productosConCosto.length > 0 || busqueda || filtro !== 'todos') && (
                        <div className="mb-3 sm:mb-4 space-y-3">
                            {/* Barra de búsqueda */}
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-vr-gray pointer-events-none">
                                        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                                        </svg>
                                    </span>
                                    <input
                                        type="text"
                                        inputMode="search"
                                        placeholder="Buscar por nombre, código o ubicación…"
                                        className="w-full bg-navy-2 border border-navy-3 rounded-xl pl-11 pr-10 py-3 text-white placeholder-vr-gray/50 focus:border-gold outline-none transition-all"
                                        value={busqueda}
                                        onChange={e => setBusqueda(e.target.value)}
                                    />
                                    {busqueda && (
                                        <button
                                            type="button"
                                            onClick={() => setBusqueda('')}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-vr-gray hover:text-white font-bold transition-colors"
                                            title="Limpiar"
                                        >
                                            ✕
                                        </button>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setIsBusquedaScanOpen(true)}
                                    title="Escanear para buscar"
                                    className="px-3.5 bg-navy-2 border border-navy-3 rounded-xl text-vr-gray hover:text-gold hover:border-gold/50 transition-all flex items-center shrink-0"
                                >
                                    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" />
                                        <path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" />
                                        <line x1="7" y1="12" x2="7" y2="12.01" /><line x1="12" y1="12" x2="17" y2="12" />
                                        <line x1="7" y1="8" x2="7" y2="16" /><line x1="12" y1="8" x2="12" y2="16" />
                                        <line x1="17" y1="8" x2="17" y2="16" />
                                    </svg>
                                </button>
                            </div>

                            {/* Pastillas de filtro + orden */}
                            <div className="flex items-center gap-2 flex-wrap">
                                <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 pb-1 flex-1 scrollbar-none">
                                    {([
                                        { key: 'todos', label: 'Todos', n: conteos.todos },
                                        { key: 'por_agotarse', label: 'Por agotarse', n: conteos.por_agotarse },
                                        { key: 'agotados', label: 'Agotados', n: conteos.agotados },
                                        { key: 'simple', label: 'Venta', n: conteos.simple },
                                        { key: 'insumo', label: 'Insumos', n: conteos.insumo },
                                        { key: 'combo', label: 'Combos', n: conteos.combo },
                                    ] as const)
                                        // Ocultar pastillas vacías (excepto Todos) para no saturar
                                        .filter(c => c.key === 'todos' || c.n > 0)
                                        .map(({ key, label, n }) => {
                                            const activo = filtro === key;
                                            const esAlerta = (key === 'por_agotarse' || key === 'agotados') && n > 0;
                                            return (
                                                <button
                                                    key={key}
                                                    type="button"
                                                    onClick={() => setFiltro(key)}
                                                    className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all border shrink-0 ${activo
                                                        ? 'bg-gold/15 text-gold border-gold/40'
                                                        : esAlerta
                                                            ? 'bg-vr-orange/10 text-vr-orange border-vr-orange/20 hover:border-vr-orange/40'
                                                            : 'bg-navy-2 text-vr-gray border-navy-3 hover:text-white'}`}
                                                >
                                                    {label}
                                                    <span className={`ml-1.5 ${activo ? 'text-gold/70' : 'opacity-60'}`}>{n}</span>
                                                </button>
                                            );
                                        })}
                                </div>
                                <select
                                    value={orden}
                                    onChange={e => setOrden(e.target.value as OrdenInventario)}
                                    className="bg-navy-2 border border-navy-3 rounded-lg py-1.5 pl-2.5 pr-7 text-xs font-bold text-vr-gray focus:border-gold outline-none transition-all shrink-0 cursor-pointer"
                                    title="Ordenar"
                                >
                                    <option value="nombre">A–Z</option>
                                    <option value="stock">Menos stock</option>
                                    <option value="margen">Mayor ganancia</option>
                                </select>
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
                                    <th className="p-3 sm:p-4 font-semibold hidden lg:table-cell">Mínimo</th>
                                    <th className="p-3 sm:p-4 font-semibold text-right">Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {isLoading ? (
                                    <SkeletonTable rows={6} cols={7} />
                                ) : productosConCosto.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} className="py-20 text-center text-vr-gray">
                                            <span className="text-4xl block mb-3">📦</span>
                                            <p className="font-medium">Sin productos aún. Agrega tu primer producto.</p>
                                        </td>
                                    </tr>
                                ) : productosFiltrados.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} className="py-20 text-center text-vr-gray">
                                            <span className="text-4xl block mb-3">🔍</span>
                                            <p className="font-medium">No se encontraron productos.</p>
                                            <button
                                                type="button"
                                                onClick={() => { setBusqueda(''); setFiltro('todos'); }}
                                                className="mt-3 text-gold hover:text-gold-2 text-sm font-bold transition-colors"
                                            >
                                                Limpiar búsqueda y filtros
                                            </button>
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
                                            <div className="flex items-center gap-2.5">
                                                {prod.imagen_url && (
                                                    // eslint-disable-next-line @next/next/no-img-element
                                                    <img src={miniatura(prod.imagen_url, 72)} alt="" loading="lazy" className="w-9 h-9 rounded-lg object-cover bg-white border border-navy-3 shrink-0 hidden sm:block" />
                                                )}
                                                <span className="font-bold text-white text-sm block">{resaltar(prod.nombre)}</span>
                                            </div>
                                            <div className="flex items-center flex-wrap gap-1.5 mt-1">
                                                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-black uppercase ${esCombo ? 'bg-purple-500/15 text-purple-400' : esInsumo ? 'bg-vr-orange/15 text-vr-orange' : 'bg-gold/15 text-gold'}`}>
                                                    {tipo || 'simple'}
                                                </span>
                                                {prod.ubicacion && (
                                                    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-navy-3 text-vr-gray border border-navy-3">
                                                        📍 {prod.ubicacion}
                                                    </span>
                                                )}
                                            </div>
                                            {!esInsumo && (
                                                <span className="sm:hidden block text-xs font-mono text-vr-green mt-0.5">
                                                    {(celdaEdit?.id === prod.id && celdaEdit.campo === 'precio')
                                                        ? <CeldaEditInput valor={valorEdit} onValor={setValorEdit} onGuardar={() => guardarEdicion(prod)} onCancelar={cancelarEdicion} />
                                                        : <button type="button" onClick={() => iniciarEdicion(prod, 'precio')} className="underline decoration-dotted decoration-vr-green/40 underline-offset-2" title="Editar precio">{formatDOP(prod.precio_venta)}</button>}
                                                </span>
                                            )}
                                        </td>
                                        <td className="p-3 sm:p-4 font-medium font-mono text-vr-green text-sm hidden sm:table-cell">
                                            {esInsumo ? '-' : (celdaEdit?.id === prod.id && celdaEdit.campo === 'precio')
                                                ? <CeldaEditInput valor={valorEdit} onValor={setValorEdit} onGuardar={() => guardarEdicion(prod)} onCancelar={cancelarEdicion} />
                                                : <button type="button" onClick={() => iniciarEdicion(prod, 'precio')} className="hover:text-gold underline decoration-dotted decoration-transparent hover:decoration-gold/60 underline-offset-4 transition-colors" title="Editar precio">{formatDOP(prod.precio_venta)}</button>}
                                        </td>
                                        <td className="p-3 sm:p-4 text-vr-gray font-mono text-sm hidden md:table-cell">{formatDOP(prod.costo)} {esCombo && <span className="text-[10px] italic ml-1">(calc)</span>}</td>
                                        <td className="p-3 sm:p-4 font-bold font-mono text-sm hidden md:table-cell">
                                            {esInsumo ? '-' : (
                                                <span className={(prod.precio_venta - prod.costo) > 0 ? 'text-vr-green' : 'text-vr-red'}>
                                                    {prod.precio_venta > 0 ? ((prod.precio_venta - prod.costo) / prod.precio_venta * 100).toFixed(0) : '0'}%
                                                </span>
                                            )}
                                        </td>
                                        <td className="p-3 sm:p-4">
                                            {(celdaEdit?.id === prod.id && celdaEdit.campo === 'stock')
                                                ? <CeldaEditInput valor={valorEdit} onValor={setValorEdit} onGuardar={() => guardarEdicion(prod)} onCancelar={cancelarEdicion} />
                                                : (
                                                    <button
                                                        type="button"
                                                        disabled={esCombo}
                                                        onClick={() => { if (!esCombo) iniciarEdicion(prod, 'stock'); }}
                                                        className={`px-2 py-1 rounded-md text-sm font-bold font-mono ${stockClass} ${esCombo ? 'cursor-default' : 'hover:ring-1 hover:ring-gold/50 transition-all'}`}
                                                        title={esCombo ? '' : 'Editar stock (conteo físico)'}
                                                    >
                                                        {parseFloat(Number(prod.stock_actual).toFixed(3))}
                                                        {esCombo && <span className="text-[10px] ml-1 opacity-60">calc.</span>}
                                                        {esInsumo && <span className="text-[10px] ml-1 opacity-60">ing.</span>}
                                                    </button>
                                                )}
                                        </td>
                                        <td className="p-3 sm:p-4 hidden lg:table-cell text-vr-gray font-mono text-sm">
                                            {esCombo ? '—' : prod.stock_minimo}
                                        </td>
                                        <td className="p-3 sm:p-4 text-right">
                                            <div className="flex items-center justify-end gap-2 sm:gap-3">
                                                {!esCombo && (
                                                    <button onClick={() => abrirModalAjuste(prod)} className="text-vr-green hover:text-vr-green/80 text-xs sm:text-sm font-bold transition-colors whitespace-nowrap">Ajuste</button>
                                                )}
                                                <button onClick={() => abrirModalEditar(prod)} className="text-gold hover:text-gold-2 text-xs sm:text-sm font-bold transition-colors">Editar</button>
                                                <button onClick={() => setProductoAEliminar(prod)} className="text-vr-red hover:text-vr-red/80 text-xs sm:text-sm font-bold transition-colors">Eliminar</button>
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
                            totalItems={productosFiltrados.length}
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

                                <button
                                    type="button"
                                    onClick={() => setProductoHistorial(productoAjustando)}
                                    className="w-full -mt-2 text-xs font-bold text-gold/80 hover:text-gold transition-colors text-center py-1"
                                >
                                    🕑 Ver historial de movimientos
                                </button>

                                {/* Entrada serializable: inputs de números de serie */}
                                {productoAjustando?.serializable && tipoAjuste === 'entrada' ? (
                                    <div>
                                        <div className="flex items-center justify-between mb-2">
                                            <label className="text-sm font-bold text-vr-gray">Números de serie a ingresar</label>
                                            <span className="text-xs font-bold text-gold">{serialesEntrada.filter(s => s.trim()).length} unidades</span>
                                        </div>
                                        <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                                            {serialesEntrada.map((s, i) => (
                                                <div key={i} className="flex gap-2">
                                                    <input
                                                        type="text"
                                                        autoFocus={i === 0}
                                                        placeholder={`Serie / IMEI #${i + 1}`}
                                                        className="flex-1 bg-navy-3 border border-navy-3 rounded-xl p-2.5 text-white font-mono text-sm focus:border-gold outline-none transition-all placeholder-vr-gray/40"
                                                        value={s}
                                                        onChange={e => {
                                                            const copy = [...serialesEntrada];
                                                            copy[i] = e.target.value;
                                                            setSerialesEntrada(copy);
                                                        }}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') {
                                                                e.preventDefault();
                                                                setSerialesEntrada(prev => [...prev, '']);
                                                            }
                                                        }}
                                                    />
                                                    {/* Botón cámara para escanear este serial */}
                                                    <button
                                                        type="button"
                                                        onClick={() => setScannerSerialIdx(i)}
                                                        className="px-2.5 bg-navy-3 border border-navy-3 rounded-xl text-vr-gray hover:text-gold hover:border-gold/50 transition-all"
                                                        title="Escanear con cámara"
                                                    >
                                                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                                            <path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/>
                                                            <path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
                                                            <line x1="7" y1="12" x2="7" y2="12.01"/><line x1="12" y1="12" x2="17" y2="12"/>
                                                            <line x1="7" y1="8" x2="7" y2="16"/><line x1="12" y1="8" x2="12" y2="16"/>
                                                            <line x1="17" y1="8" x2="17" y2="16"/>
                                                        </svg>
                                                    </button>
                                                    {serialesEntrada.length > 1 && (
                                                        <button type="button" onClick={() => setSerialesEntrada(prev => prev.filter((_, idx) => idx !== i))} className="text-vr-red font-bold px-2 hover:text-vr-red/70 transition-colors">✕</button>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setSerialesEntrada(prev => [...prev, ''])}
                                            className="mt-2 w-full py-2 border border-dashed border-navy-3 hover:border-gold/40 text-vr-gray hover:text-gold rounded-xl text-xs font-bold transition-all"
                                        >
                                            + Agregar otro serial (o presiona Enter)
                                        </button>
                                    </div>
                                ) : (
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
                                )}

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

                {/* MODAL HISTORIAL DE MOVIMIENTOS */}
                {productoHistorial && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[60] flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                        <div className="bg-navy-2 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden max-h-[85vh] flex flex-col animate-scale-in">
                            <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                <div className="min-w-0">
                                    <h2 className="text-xl font-display font-bold text-white">Movimientos</h2>
                                    <p className="text-sm text-vr-gray mt-0.5 truncate">{productoHistorial.nombre}</p>
                                </div>
                                <button onClick={() => setProductoHistorial(null)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors shrink-0">✕</button>
                            </div>
                            <div className="overflow-y-auto p-3 sm:p-4">
                                {movimientosHistorial.length === 0 ? (
                                    <div className="py-12 text-center text-vr-gray">
                                        <span className="text-3xl block mb-2">🕑</span>
                                        <p className="text-sm">Aún no hay movimientos registrados.</p>
                                    </div>
                                ) : (
                                    <div className="space-y-1.5">
                                        {movimientosHistorial.map(m => {
                                            const meta = META_MOVIMIENTO[m.tipo];
                                            const esConteo = m.valor_absoluto !== undefined;
                                            const texto = esConteo
                                                ? `= ${parseFloat(Number(m.valor_absoluto).toFixed(3))}`
                                                : `${m.delta > 0 ? '+' : ''}${parseFloat(Number(m.delta).toFixed(3))}`;
                                            const fecha = new Date(m.fecha_creacion).toLocaleString('es-DO', {
                                                day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                                            });
                                            return (
                                                <div key={m.id} className="flex items-center gap-3 bg-navy-3/40 rounded-xl px-3 py-2.5">
                                                    <span className="text-base shrink-0">{meta.icono}</span>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-bold text-white">{meta.label}</p>
                                                        <p className="text-[11px] text-vr-gray">{fecha}</p>
                                                    </div>
                                                    <span className={`font-mono font-black text-sm whitespace-nowrap shrink-0 ${meta.color}`}>{texto}</span>
                                                </div>
                                            );
                                        })}
                                        {movimientosHistorial.length >= 50 && (
                                            <p className="text-[11px] text-vr-gray text-center pt-2">Mostrando los 50 más recientes</p>
                                        )}
                                    </div>
                                )}
                            </div>
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

                                {/* Foto del producto (no aplica a insumos) */}
                                {formData.tipo !== 'insumo' && (
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">
                                            Foto
                                            <span className="ml-2 text-[10px] font-normal text-vr-gray/60 uppercase tracking-wide">(opcional — se ve en la caja)</span>
                                        </label>
                                        <input
                                            ref={fotoInputRef}
                                            type="file"
                                            accept="image/*"
                                            className="hidden"
                                            onChange={async e => {
                                                const f = e.target.files?.[0];
                                                e.target.value = '';
                                                if (!f) return;
                                                if (!f.type.startsWith('image/')) { showToast('El archivo debe ser una imagen.', 'error'); return; }
                                                try { setFotoProducto(await comprimirImagen(f, 360)); }
                                                catch { showToast('No se pudo procesar la imagen.', 'error'); }
                                            }}
                                        />
                                        <div className="flex items-center gap-3">
                                            {fotoProducto ? (
                                                <>
                                                    <div className="w-16 h-16 rounded-xl bg-white border border-navy-3 overflow-hidden flex items-center justify-center shrink-0">
                                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                                        <img src={fotoProducto} alt="Foto del producto" className="w-full h-full object-cover" />
                                                    </div>
                                                    <button type="button" onClick={() => fotoInputRef.current?.click()} className="px-3 py-2 bg-navy-3 border border-navy-3 hover:border-gold/40 text-vr-gray hover:text-gold font-bold rounded-xl text-xs transition-all">Cambiar</button>
                                                    <button type="button" onClick={() => setFotoProducto(null)} className="px-3 py-2 text-vr-red hover:bg-vr-red/10 font-bold rounded-xl text-xs transition-all">Quitar</button>
                                                </>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => fotoInputRef.current?.click()}
                                                    className="w-full py-3 bg-navy-3/50 border border-dashed border-navy-3 hover:border-gold/50 text-vr-gray hover:text-gold font-bold rounded-xl text-sm transition-all"
                                                >
                                                    📷 Agregar foto
                                                </button>
                                            )}
                                        </div>
                                        {!isOnline && fotoProducto?.startsWith('data:') && (
                                            <p className="text-xs text-vr-orange mt-1.5">Sin internet: la foto necesita conexión para subirse.</p>
                                        )}
                                    </div>
                                )}

                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">
                                        Código de Barras
                                        <span className="ml-2 text-[10px] font-normal text-vr-gray/60 uppercase tracking-wide">(opcional)</span>
                                    </label>
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            placeholder="Escribe o escanea con el lector…"
                                            className="flex-1 bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono placeholder-vr-gray/40 focus:border-gold outline-none transition-all"
                                            value={formData.codigo_barras}
                                            onChange={e => setFormData({ ...formData, codigo_barras: e.target.value })}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setIsScannerOpen(true)}
                                            title="Escanear con cámara"
                                            className="px-3.5 bg-navy-3 border border-navy-3 rounded-xl text-vr-gray hover:text-gold hover:border-gold/50 transition-all flex items-center"
                                        >
                                            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" />
                                                <path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" />
                                                <line x1="7" y1="12" x2="7" y2="12.01" /><line x1="12" y1="12" x2="17" y2="12" />
                                                <line x1="7" y1="8" x2="7" y2="16" /><line x1="12" y1="8" x2="12" y2="16" />
                                                <line x1="17" y1="8" x2="17" y2="16" />
                                            </svg>
                                        </button>
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">
                                        Ubicación en tienda
                                        <span className="ml-2 text-[10px] font-normal text-vr-gray/60 uppercase tracking-wide">(opcional)</span>
                                    </label>
                                    <input
                                        type="text"
                                        placeholder="Ej: Pasillo 2-A, Nevera, Bodega…"
                                        className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white placeholder-vr-gray/40 focus:border-gold outline-none transition-all"
                                        value={formData.ubicacion}
                                        onChange={e => setFormData({ ...formData, ubicacion: e.target.value })}
                                    />
                                </div>

                                {/* Solo para productos vendibles */}
                                {formData.tipo !== 'insumo' && formData.tipo !== 'combo' && (
                                    <button
                                        type="button"
                                        onClick={() => setFormData({ ...formData, serializable: !formData.serializable })}
                                        className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${formData.serializable ? 'border-gold/40 bg-gold/10 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}
                                    >
                                        <div>
                                            <p className="text-sm font-bold text-left">Producto con número de serie</p>
                                            <p className="text-xs font-normal opacity-70 text-left">Cada unidad requiere IMEI, serie u otro código único</p>
                                        </div>
                                        <div className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-3 ${formData.serializable ? 'bg-gold' : 'bg-navy-3'}`}>
                                            <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${formData.serializable ? 'translate-x-5' : ''}`} />
                                        </div>
                                    </button>
                                )}

                                <div className="grid grid-cols-2 gap-3">
                                    {formData.tipo !== 'insumo' ? (
                                        <div>
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Precio 1 — Menudeo (RD$)</label>
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

                                {/* Precios adicionales (solo para productos vendibles) */}
                                {formData.tipo !== 'insumo' && (
                                    <div className="p-3 bg-navy rounded-xl border border-navy-3">
                                        <p className="text-xs font-bold text-vr-gray uppercase tracking-wider mb-2">Precios Mayoreo / Especiales <span className="font-normal normal-case">(opcional)</span></p>
                                        <div className="grid grid-cols-2 gap-3">
                                            <div>
                                                <label className="block text-xs font-bold text-vr-gray mb-1.5">Precio 2 — Mayoreo</label>
                                                <input
                                                    type="number" step="0.01" min="0"
                                                    placeholder="—"
                                                    className="w-full bg-navy-3 border border-navy-3 rounded-xl p-2.5 text-white font-mono focus:border-gold outline-none transition-all text-sm"
                                                    value={formData.precio_2}
                                                    onChange={e => setFormData({ ...formData, precio_2: e.target.value })}
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-xs font-bold text-vr-gray mb-1.5">Precio 3 — Especial</label>
                                                <input
                                                    type="number" step="0.01" min="0"
                                                    placeholder="—"
                                                    className="w-full bg-navy-3 border border-navy-3 rounded-xl p-2.5 text-white font-mono focus:border-gold outline-none transition-all text-sm"
                                                    value={formData.precio_3}
                                                    onChange={e => setFormData({ ...formData, precio_3: e.target.value })}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                )}

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
        {/* Confirmación de eliminación de producto */}
        <ConfirmModal
            isOpen={!!productoAEliminar}
            title="Eliminar producto"
            mensaje={<>¿Eliminar <span className="font-bold text-white">{productoAEliminar?.nombre}</span>? Desaparecerá del catálogo y del POS en todas las cajas.</>}
            confirmLabel="Eliminar"
            onConfirm={eliminarProducto}
            onClose={() => setProductoAEliminar(null)}
        />

        {/* Scanner código de barras de producto */}
        {isScannerOpen && (
            <Suspense fallback={null}>
                <BarcodeScanner
                    onScan={(code) => {
                        setFormData(prev => ({ ...prev, codigo_barras: code }));
                        setIsScannerOpen(false);
                    }}
                    onClose={() => setIsScannerOpen(false)}
                />
            </Suspense>
        )}

        {/* Scanner de búsqueda — escanea un código y filtra la lista */}
        {isBusquedaScanOpen && (
            <Suspense fallback={null}>
                <BarcodeScanner
                    onScan={(code) => {
                        setBusqueda(code);
                        setFiltro('todos');
                        setIsBusquedaScanOpen(false);
                    }}
                    onClose={() => setIsBusquedaScanOpen(false)}
                />
            </Suspense>
        )}

        {/* Scanner serial/IMEI — rellena el campo del índice activo */}
        {scannerSerialIdx !== null && (
            <Suspense fallback={null}>
                <BarcodeScanner
                    onScan={(code) => {
                        setSerialesEntrada(prev => {
                            const copy = [...prev];
                            copy[scannerSerialIdx] = code;
                            // Auto-agrega una línea vacía para el siguiente
                            if (scannerSerialIdx === copy.length - 1) copy.push('');
                            return copy;
                        });
                        setScannerSerialIdx(null);
                    }}
                    onClose={() => setScannerSerialIdx(null)}
                />
            </Suspense>
        )}
        </PinGuard>
    );
}
