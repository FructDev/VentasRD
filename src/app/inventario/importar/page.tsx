// src/app/inventario/importar/page.tsx
'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { db } from '@/lib/db/dexie';
import { registrarMovimientoStock } from '@/lib/db/stock';
import { useConfigStore } from '@/store/useConfigStore';
import { ProductoLocal } from '@/types/database';
import { formatDOP } from '@/lib/utils';
import { v4 as uuidv4 } from 'uuid';
import PinGuard from '@/components/ui/PinGuard';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';

// ─── Campos importables ───────────────────────────────────────────────────────
type CampoImportable = 'nombre' | 'precio_venta' | 'costo' | 'stock_actual' | 'stock_minimo' | 'codigo_barras' | 'ubicacion';

const CAMPOS: { key: CampoImportable; label: string; requerido: boolean; hint: string }[] = [
    { key: 'nombre',        label: 'Nombre del producto', requerido: true,  hint: 'Único campo obligatorio' },
    { key: 'precio_venta',  label: 'Precio de venta',     requerido: false, hint: 'Si falta, queda en RD$0' },
    { key: 'costo',         label: 'Costo',               requerido: false, hint: 'Para calcular tu ganancia' },
    { key: 'stock_actual',  label: 'Stock actual',        requerido: false, hint: 'Cantidad en existencia' },
    { key: 'stock_minimo',  label: 'Stock mínimo',        requerido: false, hint: 'Para alertas de reposición' },
    { key: 'codigo_barras', label: 'Código de barras',    requerido: false, hint: 'Para escanear en el POS' },
    { key: 'ubicacion',     label: 'Ubicación',           requerido: false, hint: 'Ej: Pasillo 2, Nevera' },
];

// Patrones para auto-detectar columnas por su encabezado
const PATRONES: Record<CampoImportable, RegExp> = {
    nombre:        /nombre|descrip|producto|art[ií]culo|item|detalle/i,
    precio_venta:  /precio|venta|pvp|p\.?\s*v/i,
    costo:         /costo|compra|cost/i,
    stock_actual:  /stock|cantidad|existencia|inventario|qty|cant/i,
    stock_minimo:  /m[ií]nimo|min\b/i,
    codigo_barras: /c[oó]digo|barra|barcode|ean|upc|sku|ref/i,
    ubicacion:     /ubicaci[oó]n|pasillo|estante|lugar/i,
};

/** Limpia valores numéricos sucios: "RD$1,500.00" → 1500 */
function limpiarNumero(valor: unknown): number {
    if (typeof valor === 'number') return isNaN(valor) ? 0 : valor;
    if (typeof valor !== 'string') return 0;
    const limpio = valor.replace(/[^0-9.\-]/g, '');
    const n = parseFloat(limpio);
    return isNaN(n) ? 0 : n;
}

interface FilaError { fila: number; motivo: string; }
interface Resultado { creados: number; actualizados: number; omitidos: number; errores: FilaError[]; }

export default function ImportarInventarioPage() {
    const { negocioId, showToast } = useConfigStore();
    const inputFileRef = useRef<HTMLInputElement>(null);

    const [paso, setPaso] = useState<'subir' | 'mapear' | 'resultado'>('subir');
    const [nombreArchivo, setNombreArchivo] = useState('');
    const [encabezados, setEncabezados] = useState<string[]>([]);
    const [filas, setFilas] = useState<unknown[][]>([]);
    // mapeo: campo → índice de columna (-1 = no mapeado)
    const [mapeo, setMapeo] = useState<Record<CampoImportable, number>>({
        nombre: -1, precio_venta: -1, costo: -1, stock_actual: -1,
        stock_minimo: -1, codigo_barras: -1, ubicacion: -1,
    });
    const [accionDuplicados, setAccionDuplicados] = useState<'omitir' | 'actualizar'>('actualizar');
    const [procesando, setProcesando] = useState(false);
    const [resultado, setResultado] = useState<Resultado | null>(null);

    // ─── Paso 1: leer el archivo ──────────────────────────────────────────────
    const leerArchivo = async (file: File) => {
        try {
            const XLSX = await import('xlsx');
            const workbook = XLSX.read(await file.arrayBuffer());
            const hoja = workbook.Sheets[workbook.SheetNames[0]];
            const datos: unknown[][] = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: '' });

            // Filtrar filas completamente vacías
            const noVacias = datos.filter(f => f.some(c => String(c).trim() !== ''));
            if (noVacias.length < 2) {
                showToast('El archivo está vacío o solo tiene encabezados.', 'error');
                return;
            }

            const headers = noVacias[0].map(h => String(h).trim());
            const cuerpo = noVacias.slice(1);

            // Auto-detectar mapeo por nombre de columna
            const nuevoMapeo = { ...mapeo };
            (Object.keys(PATRONES) as CampoImportable[]).forEach(campo => {
                const idx = headers.findIndex(h => PATRONES[campo].test(h));
                nuevoMapeo[campo] = idx;
            });
            // Evitar que stock_minimo robe la columna de stock_actual (ambos matchean "stock")
            if (nuevoMapeo.stock_minimo === nuevoMapeo.stock_actual) nuevoMapeo.stock_minimo = -1;

            setNombreArchivo(file.name);
            setEncabezados(headers);
            setFilas(cuerpo);
            setMapeo(nuevoMapeo);
            setPaso('mapear');
        } catch (e) {
            console.error('[importar]', e);
            showToast('No se pudo leer el archivo. Verifica que sea un Excel o CSV válido.', 'error');
        }
    };

    // ─── Descarga de plantilla de ejemplo ─────────────────────────────────────
    const descargarPlantilla = async () => {
        const XLSX = await import('xlsx');
        const datos = [
            ['Nombre', 'Precio Venta', 'Costo', 'Stock', 'Stock Minimo', 'Codigo de Barras', 'Ubicacion'],
            ['Coca Cola 16oz', 75, 50, 24, 6, '7460001234567', 'Nevera 1'],
            ['Galletas Guarina', 25, 15, 50, 10, '', 'Pasillo 2'],
        ];
        const ws = XLSX.utils.aoa_to_sheet(datos);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Inventario');
        XLSX.writeFile(wb, 'plantilla_inventario_ventard.xlsx');
    };

    // ─── Vista previa con el mapeo aplicado ───────────────────────────────────
    const preview = useMemo(() => {
        return filas.slice(0, 5).map(fila => ({
            nombre: mapeo.nombre >= 0 ? String(fila[mapeo.nombre] ?? '').trim() : '',
            precio_venta: mapeo.precio_venta >= 0 ? limpiarNumero(fila[mapeo.precio_venta]) : 0,
            costo: mapeo.costo >= 0 ? limpiarNumero(fila[mapeo.costo]) : 0,
            stock_actual: mapeo.stock_actual >= 0 ? limpiarNumero(fila[mapeo.stock_actual]) : 0,
        }));
    }, [filas, mapeo]);

    const filasValidas = useMemo(() => {
        if (mapeo.nombre < 0) return 0;
        return filas.filter(f => String(f[mapeo.nombre] ?? '').trim() !== '').length;
    }, [filas, mapeo]);

    // ─── Paso 2 → 3: importar a Dexie ─────────────────────────────────────────
    const importar = async () => {
        if (!negocioId || mapeo.nombre < 0) return;
        setProcesando(true);

        try {
            // Índices de productos existentes para detectar duplicados
            const existentes = await db.productos
                .where('negocio_id').equals(negocioId)
                .filter(p => !p.eliminado)
                .toArray();
            const porCodigo = new Map(existentes.filter(p => p.codigo_barras).map(p => [p.codigo_barras, p]));
            const porNombre = new Map(existentes.map(p => [p.nombre.trim().toLowerCase(), p]));

            const res: Resultado = { creados: 0, actualizados: 0, omitidos: 0, errores: [] };
            const aGuardar: ProductoLocal[] = [];
            const movimientosStock: { productoId: string; esNuevo: boolean; stockArchivo: number; stockPrevio: number }[] = [];
            const ahora = Date.now();
            // Nombres ya vistos dentro del mismo archivo (evita duplicar filas repetidas)
            const vistosEnArchivo = new Set<string>();

            filas.forEach((fila, i) => {
                const numFila = i + 2; // +1 por el encabezado, +1 porque Excel cuenta desde 1
                const nombre = String(fila[mapeo.nombre] ?? '').trim();
                if (!nombre) {
                    res.errores.push({ fila: numFila, motivo: 'Sin nombre de producto' });
                    return;
                }

                const codigo = mapeo.codigo_barras >= 0 ? String(fila[mapeo.codigo_barras] ?? '').trim() : '';
                const claveArchivo = codigo || nombre.toLowerCase();
                if (vistosEnArchivo.has(claveArchivo)) {
                    res.omitidos++;
                    res.errores.push({ fila: numFila, motivo: `"${nombre}" repetido en el archivo` });
                    return;
                }
                vistosEnArchivo.add(claveArchivo);

                const existente = (codigo && porCodigo.get(codigo)) || porNombre.get(nombre.toLowerCase());

                if (existente && accionDuplicados === 'omitir') {
                    res.omitidos++;
                    return;
                }

                // El stock no se escribe directo: se registra como movimiento después del bulkPut
                const stockArchivo = mapeo.stock_actual >= 0 ? limpiarNumero(fila[mapeo.stock_actual]) : null;
                const stockPrevio = existente?.stock_actual ?? 0;

                const producto: ProductoLocal = {
                    id: existente ? existente.id : uuidv4(),
                    negocio_id: negocioId,
                    nombre,
                    codigo_barras: codigo || existente?.codigo_barras || '',
                    precio_venta: mapeo.precio_venta >= 0 ? limpiarNumero(fila[mapeo.precio_venta]) : (existente?.precio_venta ?? 0),
                    costo: mapeo.costo >= 0 ? limpiarNumero(fila[mapeo.costo]) : (existente?.costo ?? 0),
                    stock_actual: stockPrevio,
                    stock_minimo: mapeo.stock_minimo >= 0 ? limpiarNumero(fila[mapeo.stock_minimo]) : (existente?.stock_minimo ?? 0),
                    tasa_itbis: existente?.tasa_itbis ?? 0.18,
                    tipo: existente?.tipo ?? 'simple',
                    ...(mapeo.ubicacion >= 0 && String(fila[mapeo.ubicacion] ?? '').trim()
                        ? { ubicacion: String(fila[mapeo.ubicacion]).trim() }
                        : existente?.ubicacion ? { ubicacion: existente.ubicacion } : {}),
                    estado_sincronizacion: 0,
                    fecha_actualizacion: ahora,
                };

                aGuardar.push(producto);
                if (stockArchivo !== null) {
                    movimientosStock.push({
                        productoId: producto.id,
                        esNuevo: !existente,
                        stockArchivo,
                        stockPrevio,
                    });
                }
                if (existente) res.actualizados++;
                else res.creados++;
            });

            if (aGuardar.length > 0) {
                await db.productos.bulkPut(aGuardar);
                // Registrar el stock como movimientos (entrada inicial o conteo)
                for (const m of movimientosStock) {
                    if (m.esNuevo && m.stockArchivo > 0) {
                        await registrarMovimientoStock({ productoId: m.productoId, tipo: 'importacion', delta: m.stockArchivo });
                    } else if (!m.esNuevo && m.stockArchivo !== m.stockPrevio) {
                        await registrarMovimientoStock({ productoId: m.productoId, tipo: 'importacion', valorAbsoluto: m.stockArchivo });
                    }
                }
            }

            setResultado(res);
            setPaso('resultado');
        } catch (e) {
            console.error('[importar]', e);
            showToast('Error al importar los productos.', 'error');
        } finally {
            setProcesando(false);
        }
    };

    const reiniciar = () => {
        setPaso('subir');
        setNombreArchivo('');
        setEncabezados([]);
        setFilas([]);
        setResultado(null);
        if (inputFileRef.current) inputFileRef.current.value = '';
    };

    return (
        <PinGuard title="Importar Inventario">
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <OfflineBanner />

                <div className="flex-1 p-3 sm:p-6 lg:p-8">
                    <div className="max-w-3xl mx-auto">

                        {/* Header */}
                        <div className="flex items-center gap-3 mb-4 sm:mb-6">
                            <Link href="/inventario" className="text-vr-gray hover:text-white font-bold text-xl px-2 py-1 rounded-lg hover:bg-navy-3 transition-all shrink-0">←</Link>
                            <div className="min-w-0">
                                <h1 className="text-xl sm:text-3xl font-display font-extrabold text-white truncate">Importar Inventario</h1>
                                <p className="text-vr-gray text-xs sm:text-sm mt-0.5">Trae tus productos desde Excel o CSV</p>
                            </div>
                        </div>

                        {/* Indicador de pasos */}
                        <div className="flex items-center gap-1.5 sm:gap-2 mb-5 sm:mb-8">
                            {([
                                { key: 'subir',     label: '1. Subir' },
                                { key: 'mapear',    label: '2. Revisar' },
                                { key: 'resultado', label: '3. Listo' },
                            ] as const).map((p, i) => (
                                <div key={p.key} className="flex items-center gap-1.5 sm:gap-2 flex-1">
                                    <div className={`flex-1 text-center py-2 rounded-xl text-xs sm:text-sm font-bold border transition-all ${
                                        paso === p.key
                                            ? 'border-gold bg-gold/15 text-gold'
                                            : (['subir', 'mapear', 'resultado'].indexOf(paso) > i)
                                                ? 'border-vr-green/30 bg-vr-green/10 text-vr-green'
                                                : 'border-navy-3 text-vr-gray'
                                    }`}>
                                        {p.label}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* ─── PASO 1: SUBIR ─────────────────────────────────── */}
                        {paso === 'subir' && (
                            <div className="space-y-4">
                                <input
                                    ref={inputFileRef}
                                    type="file"
                                    accept=".xlsx,.xls,.csv"
                                    className="hidden"
                                    onChange={e => { const f = e.target.files?.[0]; if (f) leerArchivo(f); }}
                                />
                                <button
                                    onClick={() => inputFileRef.current?.click()}
                                    className="w-full bg-navy-2 border-2 border-dashed border-navy-3 hover:border-gold/50 rounded-2xl p-8 sm:p-14 text-center transition-all group"
                                >
                                    <span className="text-4xl sm:text-5xl block mb-3">📂</span>
                                    <p className="font-bold text-white text-base sm:text-lg group-hover:text-gold transition-colors">Toca para elegir tu archivo</p>
                                    <p className="text-vr-gray text-xs sm:text-sm mt-1">Excel (.xlsx, .xls) o CSV</p>
                                </button>

                                <div className="bg-navy-2 rounded-2xl border border-navy-3 p-4 sm:p-5">
                                    <p className="text-sm font-bold text-white mb-1">¿No tienes un archivo aún?</p>
                                    <p className="text-xs text-vr-gray mb-3 leading-relaxed">
                                        Descarga la plantilla, llénala con tus productos y súbela.
                                        Solo el <span className="text-gold font-bold">nombre</span> es obligatorio — lo demás es opcional.
                                    </p>
                                    <button
                                        onClick={descargarPlantilla}
                                        className="w-full sm:w-auto px-5 py-2.5 bg-navy-3 border border-navy-3 hover:border-gold/40 text-vr-gray hover:text-gold font-bold rounded-xl text-sm transition-all"
                                    >
                                        ⬇️ Descargar plantilla de ejemplo
                                    </button>
                                </div>

                                <div className="bg-gold/5 border border-gold/15 rounded-2xl p-4 text-xs text-vr-gray leading-relaxed">
                                    <span className="text-gold font-bold">💡 Consejo:</span> si vienes de otro software,
                                    exporta tu inventario a Excel desde ese programa y súbelo aquí tal cual.
                                    En el siguiente paso podrás indicar qué columna es cada cosa.
                                </div>
                            </div>
                        )}

                        {/* ─── PASO 2: MAPEAR Y REVISAR ──────────────────────── */}
                        {paso === 'mapear' && (
                            <div className="space-y-4 sm:space-y-5">
                                {/* Archivo cargado */}
                                <div className="flex items-center justify-between bg-navy-2 rounded-xl border border-navy-3 px-4 py-3 gap-3">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-lg shrink-0">📄</span>
                                        <div className="min-w-0">
                                            <p className="text-sm font-bold text-white truncate">{nombreArchivo}</p>
                                            <p className="text-xs text-vr-gray">{filas.length} filas encontradas</p>
                                        </div>
                                    </div>
                                    <button onClick={reiniciar} className="text-xs text-vr-red font-bold hover:bg-vr-red/10 px-3 py-1.5 rounded-lg transition-all shrink-0">Cambiar</button>
                                </div>

                                {/* Mapeo de columnas */}
                                <div className="bg-navy-2 rounded-2xl border border-navy-3 p-4 sm:p-5">
                                    <p className="text-sm font-bold text-white mb-1">¿Qué columna es cada cosa?</p>
                                    <p className="text-xs text-vr-gray mb-4">Detectamos automáticamente lo que pudimos. Revisa y corrige si hace falta.</p>
                                    <div className="space-y-3">
                                        {CAMPOS.map(campo => (
                                            <div key={campo.key} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
                                                <div className="sm:w-44 shrink-0">
                                                    <span className="text-sm font-bold text-white">{campo.label}</span>
                                                    {campo.requerido && <span className="text-vr-red ml-1">*</span>}
                                                    <p className="text-[10px] text-vr-gray leading-tight hidden sm:block">{campo.hint}</p>
                                                </div>
                                                <select
                                                    className={`flex-1 bg-navy-3 border rounded-xl p-2.5 text-sm outline-none transition-all ${
                                                        campo.requerido && mapeo[campo.key] < 0
                                                            ? 'border-vr-red/50 text-vr-red'
                                                            : mapeo[campo.key] >= 0 ? 'border-navy-3 text-white' : 'border-navy-3 text-vr-gray'
                                                    } focus:border-gold`}
                                                    value={mapeo[campo.key]}
                                                    onChange={e => setMapeo(prev => ({ ...prev, [campo.key]: parseInt(e.target.value) }))}
                                                >
                                                    <option value={-1}>— No importar —</option>
                                                    {encabezados.map((h, i) => (
                                                        <option key={i} value={i}>{h || `Columna ${i + 1}`}</option>
                                                    ))}
                                                </select>
                                            </div>
                                        ))}
                                    </div>
                                    {mapeo.nombre < 0 && (
                                        <p className="mt-3 text-xs font-bold text-vr-red bg-vr-red/10 border border-vr-red/20 rounded-xl p-3">
                                            Debes indicar cuál columna tiene el nombre del producto.
                                        </p>
                                    )}
                                </div>

                                {/* Vista previa */}
                                {mapeo.nombre >= 0 && (
                                    <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                                        <div className="px-4 py-3 border-b border-navy-3 flex justify-between items-center">
                                            <p className="text-xs font-bold text-vr-gray uppercase tracking-wider">Vista previa</p>
                                            <p className="text-xs font-bold text-vr-green">{filasValidas} productos válidos</p>
                                        </div>
                                        <div className="overflow-x-auto">
                                            <table className="w-full text-left">
                                                <thead>
                                                    <tr className="border-b border-navy-3 text-vr-gray text-[10px] uppercase tracking-wider">
                                                        <th className="px-4 py-2 font-semibold">Nombre</th>
                                                        <th className="px-4 py-2 font-semibold text-right">Precio</th>
                                                        <th className="px-4 py-2 font-semibold text-right">Costo</th>
                                                        <th className="px-4 py-2 font-semibold text-right">Stock</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {preview.map((p, i) => (
                                                        <tr key={i} className="border-b border-navy-3/50 last:border-0">
                                                            <td className="px-4 py-2.5 text-sm font-bold text-white max-w-[160px] truncate">{p.nombre || <span className="text-vr-red italic font-normal">sin nombre</span>}</td>
                                                            <td className="px-4 py-2.5 text-sm font-mono text-gold text-right whitespace-nowrap">{formatDOP(p.precio_venta)}</td>
                                                            <td className="px-4 py-2.5 text-sm font-mono text-vr-gray text-right whitespace-nowrap">{formatDOP(p.costo)}</td>
                                                            <td className="px-4 py-2.5 text-sm font-mono text-white text-right">{p.stock_actual}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                        {filas.length > 5 && (
                                            <p className="px-4 py-2 text-[10px] text-vr-gray border-t border-navy-3">… y {filas.length - 5} filas más</p>
                                        )}
                                    </div>
                                )}

                                {/* Duplicados */}
                                <div className="bg-navy-2 rounded-2xl border border-navy-3 p-4 sm:p-5">
                                    <p className="text-sm font-bold text-white mb-3">Si un producto ya existe en tu inventario…</p>
                                    <div className="grid grid-cols-2 gap-2">
                                        {([
                                            { key: 'actualizar', label: 'Actualizarlo', sub: 'Pisa precio y stock con los del archivo' },
                                            { key: 'omitir',     label: 'Dejarlo igual', sub: 'Solo agrega los productos nuevos' },
                                        ] as const).map(op => (
                                            <button
                                                key={op.key}
                                                onClick={() => setAccionDuplicados(op.key)}
                                                className={`p-3 rounded-xl border text-left transition-all ${
                                                    accionDuplicados === op.key
                                                        ? 'border-gold bg-gold/15'
                                                        : 'border-navy-3 hover:border-navy-4'
                                                }`}
                                            >
                                                <p className={`text-sm font-bold ${accionDuplicados === op.key ? 'text-gold' : 'text-white'}`}>{op.label}</p>
                                                <p className="text-[10px] text-vr-gray mt-0.5 leading-tight">{op.sub}</p>
                                            </button>
                                        ))}
                                    </div>
                                    <p className="text-[10px] text-vr-gray mt-2">Se reconocen por código de barras o por nombre exacto.</p>
                                </div>

                                {/* Acción */}
                                <button
                                    onClick={importar}
                                    disabled={procesando || mapeo.nombre < 0 || filasValidas === 0}
                                    className="w-full py-4 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-30 disabled:cursor-not-allowed text-base sm:text-lg"
                                >
                                    {procesando ? 'Importando…' : `Importar ${filasValidas} producto${filasValidas === 1 ? '' : 's'}`}
                                </button>
                            </div>
                        )}

                        {/* ─── PASO 3: RESULTADO ─────────────────────────────── */}
                        {paso === 'resultado' && resultado && (
                            <div className="space-y-4">
                                <div className="bg-navy-2 rounded-2xl border border-vr-green/30 p-6 sm:p-8 text-center">
                                    <div className="w-16 h-16 bg-vr-green/15 text-vr-green rounded-full flex items-center justify-center text-3xl mx-auto mb-4 border border-vr-green/30 animate-scale-in">✓</div>
                                    <h2 className="text-xl sm:text-2xl font-display font-black text-white mb-1">¡Importación completada!</h2>
                                    <p className="text-vr-gray text-sm">Tus productos ya están en el inventario y se sincronizarán automáticamente.</p>
                                </div>

                                <div className="grid grid-cols-3 gap-2 sm:gap-3">
                                    <div className="bg-navy-2 rounded-xl border border-vr-green/20 p-3 sm:p-4 text-center">
                                        <p className="text-2xl sm:text-3xl font-black font-mono text-vr-green">{resultado.creados}</p>
                                        <p className="text-[10px] sm:text-xs font-bold text-vr-gray uppercase tracking-wider mt-1">Nuevos</p>
                                    </div>
                                    <div className="bg-navy-2 rounded-xl border border-gold/20 p-3 sm:p-4 text-center">
                                        <p className="text-2xl sm:text-3xl font-black font-mono text-gold">{resultado.actualizados}</p>
                                        <p className="text-[10px] sm:text-xs font-bold text-vr-gray uppercase tracking-wider mt-1">Actualizados</p>
                                    </div>
                                    <div className="bg-navy-2 rounded-xl border border-navy-3 p-3 sm:p-4 text-center">
                                        <p className="text-2xl sm:text-3xl font-black font-mono text-vr-gray">{resultado.omitidos}</p>
                                        <p className="text-[10px] sm:text-xs font-bold text-vr-gray uppercase tracking-wider mt-1">Omitidos</p>
                                    </div>
                                </div>

                                {resultado.errores.length > 0 && (
                                    <div className="bg-vr-orange/5 border border-vr-orange/20 rounded-2xl p-4">
                                        <p className="text-sm font-bold text-vr-orange mb-2">{resultado.errores.length} fila{resultado.errores.length === 1 ? '' : 's'} con problemas</p>
                                        <div className="space-y-1 max-h-40 overflow-y-auto">
                                            {resultado.errores.map((err, i) => (
                                                <p key={i} className="text-xs text-vr-gray">
                                                    <span className="font-mono font-bold text-vr-orange">Fila {err.fila}:</span> {err.motivo}
                                                </p>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <div className="flex flex-col sm:flex-row gap-3">
                                    <button
                                        onClick={reiniciar}
                                        className="flex-1 py-3.5 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors"
                                    >
                                        Importar otro archivo
                                    </button>
                                    <Link
                                        href="/inventario"
                                        className="flex-1 py-3.5 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all text-center"
                                    >
                                        Ver mi inventario →
                                    </Link>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </PinGuard>
    );
}
