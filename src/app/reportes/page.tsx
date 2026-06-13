'use client';

import { useState } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import TopBar from '@/components/shared/TopBar';
import PinGuard from '@/components/ui/PinGuard';
import { FileSpreadsheet, FileText, TrendingUp, Package, Users, Receipt, Loader2, AlertCircle } from 'lucide-react';
import { getReporteVentas, getReporteInventario, getReporteFiado, getReporteNcf, getReporte607 } from '@/lib/exports/queries';
import { descargarExcel } from '@/lib/exports/excel';
import { descargarPdf } from '@/lib/exports/pdf';

// ── Helpers de rango ─────────────────────────────────────────────────────────
function rangoDesde(opcion: string): { desde: number; hasta: number; label: string } {
    const hoy = new Date();
    hoy.setHours(23, 59, 59, 999);
    const hasta = hoy.getTime();

    if (opcion === 'hoy') {
        const d = new Date(); d.setHours(0, 0, 0, 0);
        return { desde: d.getTime(), hasta, label: 'Hoy' };
    }
    if (opcion === 'semana') {
        const d = new Date(); d.setDate(d.getDate() - 6); d.setHours(0, 0, 0, 0);
        return { desde: d.getTime(), hasta, label: 'Últimos 7 días' };
    }
    if (opcion === 'mes') {
        const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
        return { desde: d.getTime(), hasta, label: 'Este mes' };
    }
    if (opcion === 'mes_anterior') {
        const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
        const fin = new Date(d.getTime() - 1);
        const ini = new Date(fin); ini.setDate(1); ini.setHours(0, 0, 0, 0);
        return { desde: ini.getTime(), hasta: fin.getTime(), label: 'Mes anterior' };
    }
    // año
    const d = new Date(hoy.getFullYear(), 0, 1);
    return { desde: d.getTime(), hasta, label: 'Este año' };
}

// ── Componente tarjeta de reporte ────────────────────────────────────────────
function TarjetaReporte({
    icono: Icono, titulo, descripcion, color,
    onExcel, onPdf, cargando,
}: {
    icono: React.ElementType; titulo: string; descripcion: string; color: string;
    onExcel: () => void; onPdf: () => void; cargando: boolean;
}) {
    return (
        <div className="bg-navy-2 border border-navy-3 rounded-2xl p-5 flex flex-col gap-4">
            <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`}>
                    <Icono className="w-5 h-5" />
                </div>
                <div>
                    <h3 className="font-bold text-white text-base">{titulo}</h3>
                    <p className="text-xs text-vr-gray mt-0.5">{descripcion}</p>
                </div>
            </div>
            <div className="flex gap-2">
                <button
                    onClick={onExcel} disabled={cargando}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-vr-green/10 text-vr-green border border-vr-green/20 rounded-xl text-xs font-bold hover:bg-vr-green/20 transition-all disabled:opacity-40"
                >
                    {cargando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
                    Excel
                </button>
                <button
                    onClick={onPdf} disabled={cargando}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-vr-red/10 text-vr-red border border-vr-red/20 rounded-xl text-xs font-bold hover:bg-vr-red/20 transition-all disabled:opacity-40"
                >
                    {cargando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                    PDF
                </button>
            </div>
        </div>
    );
}

// ── Página principal ─────────────────────────────────────────────────────────
export default function ReportesPage() {
    const { negocioId, negocioNombre, negocioRnc, negocioDireccion, ncf: ncfConfig } = useConfigStore();
    const [periodo, setPeriodo] = useState('mes');
    const [cargando, setCargando] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Mes fiscal para el 607 (por defecto el mes anterior, que es el que se declara)
    const mesAnterior = (() => {
        const d = new Date();
        d.setMonth(d.getMonth() - 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    const [mes607, setMes607] = useState(mesAnterior);

    const negocio = { nombre: negocioNombre || 'Mi Negocio', rnc: negocioRnc, direccion: negocioDireccion };

    const ejecutar = async (id: string, fn: () => Promise<void>) => {
        if (!negocioId) return;
        setCargando(id);
        setError(null);
        try { await fn(); } catch (e) {
            console.error(e);
            setError('Error al generar el reporte. Intenta de nuevo.');
        } finally { setCargando(null); }
    };

    // ── VENTAS EXCEL ─────────────────────────────────────────────────────────
    const ventasExcel = () => ejecutar('ventas', async () => {
        const { desde, hasta, label } = rangoDesde(periodo);
        const r = await getReporteVentas(negocioId!, desde, hasta);
        const nombreArchivo = `VentaRD_Ventas_${label.replace(/ /g, '_')}`;

        descargarExcel(nombreArchivo, [
            {
                nombre: 'Resumen',
                columnas: ['Métrica', 'Valor'],
                filas: [
                    ['Período', label],
                    ['Total ventas', r.resumen.count],
                    ['Ingresos totales', r.fmtDOP(r.resumen.total)],
                    ['ITBIS total', r.fmtDOP(r.resumen.itbis)],
                    ['Ticket promedio', r.fmtDOP(r.resumen.promedio)],
                    ...Object.entries(r.porMetodo).map(([m, v]) => [
                        `  ${r.METODOS[m] || m}`, `${v.count} venta(s) — ${r.fmtDOP(v.total)}`
                    ]),
                ],
            },
            {
                nombre: 'Detalle ventas',
                columnas: ['Fecha', 'Hora', 'Ticket #', 'NCF', 'Método pago', 'Total'],
                filas: r.ventas.map(v => [
                    r.fmtFecha(v.fecha_creacion),
                    r.fmtHora(v.fecha_creacion),
                    v.numero_ticket ? String(v.numero_ticket).padStart(5, '0') : '—',
                    v.ncf || '—',
                    r.METODOS[v.metodo_pago] || v.metodo_pago,
                    v.total,
                ]),
            },
            {
                nombre: 'Top productos',
                columnas: ['Producto', 'Cantidad vendida', 'Ingresos'],
                filas: r.topProductos.map(p => [p.nombre, p.cantidad, p.ingresos]),
            },
        ]);
    });

    // ── VENTAS PDF ───────────────────────────────────────────────────────────
    const ventasPdf = () => ejecutar('ventas', async () => {
        const { desde, hasta, label } = rangoDesde(periodo);
        const r = await getReporteVentas(negocioId!, desde, hasta);

        descargarPdf(
            `VentaRD_Ventas_${label.replace(/ /g, '_')}`,
            [
                {
                    titulo: `Resumen · ${label}`,
                    columnas: ['Métrica', 'Valor'],
                    filas: [
                        ['Total ventas', r.resumen.count],
                        ['Ingresos totales', r.fmtDOP(r.resumen.total)],
                        ['ITBIS total', r.fmtDOP(r.resumen.itbis)],
                        ['Ticket promedio', r.fmtDOP(r.resumen.promedio)],
                        ...Object.entries(r.porMetodo).map(([m, v]) => [
                            r.METODOS[m] || m, `${v.count} venta(s) — ${r.fmtDOP(v.total)}`
                        ]),
                    ],
                },
                {
                    titulo: 'Detalle de ventas',
                    columnas: ['Fecha', 'Hora', 'Ticket #', 'NCF', 'Método', 'Total'],
                    filas: r.ventas.map(v => [
                        r.fmtFecha(v.fecha_creacion),
                        r.fmtHora(v.fecha_creacion),
                        v.numero_ticket ? String(v.numero_ticket).padStart(5, '0') : '—',
                        v.ncf || '—',
                        r.METODOS[v.metodo_pago] || v.metodo_pago,
                        r.fmtDOP(v.total),
                    ]),
                },
                {
                    titulo: 'Productos más vendidos',
                    columnas: ['Producto', 'Cantidad', 'Ingresos'],
                    filas: r.topProductos.slice(0, 20).map(p => [
                        p.nombre, p.cantidad, r.fmtDOP(p.ingresos)
                    ]),
                },
            ],
            negocio,
            label,
        );
    });

    // ── INVENTARIO EXCEL ─────────────────────────────────────────────────────
    const inventarioExcel = () => ejecutar('inventario', async () => {
        const r = await getReporteInventario(negocioId!);
        descargarExcel('VentaRD_Inventario', [
            {
                nombre: 'Resumen',
                columnas: ['Métrica', 'Valor'],
                filas: [
                    ['Total productos', r.productos.length],
                    ['Valor del inventario', r.fmtDOP(r.valorTotal)],
                    ['Bajo stock', r.bajoStock],
                    ['Sin stock', r.sinStock],
                ],
            },
            {
                nombre: 'Inventario completo',
                columnas: ['Producto', 'Tipo', 'Stock', 'Stock mínimo', 'Costo unit.', 'Precio venta', 'Valor total'],
                filas: r.productos.map(p => [
                    p.nombre,
                    r.TIPOS[p.tipo] || p.tipo,
                    p.stock_actual,
                    p.stock_minimo,
                    p.costo,
                    p.precio_venta,
                    parseFloat((p.costo * p.stock_actual).toFixed(2)),
                ]),
            },
        ]);
    });

    // ── INVENTARIO PDF ───────────────────────────────────────────────────────
    const inventarioPdf = () => ejecutar('inventario', async () => {
        const r = await getReporteInventario(negocioId!);
        descargarPdf(
            'VentaRD_Inventario',
            [
                {
                    titulo: 'Inventario actual',
                    columnas: ['Producto', 'Tipo', 'Stock', 'Mín.', 'Costo', 'P. Venta', 'Valor total'],
                    filas: r.productos.map(p => [
                        p.nombre,
                        r.TIPOS[p.tipo] || p.tipo,
                        p.stock_actual,
                        p.stock_minimo,
                        r.fmtDOP(p.costo),
                        r.fmtDOP(p.precio_venta),
                        r.fmtDOP(p.costo * p.stock_actual),
                    ]),
                    pieTabla: `Valor total del inventario: ${r.fmtDOP(r.valorTotal)} · Bajo stock: ${r.bajoStock} · Sin stock: ${r.sinStock}`,
                },
            ],
            negocio,
            'Inventario completo',
        );
    });

    // ── FIADO EXCEL ──────────────────────────────────────────────────────────
    const fiadoExcel = () => ejecutar('fiado', async () => {
        const r = await getReporteFiado(negocioId!);
        descargarExcel('VentaRD_Fiado', [
            {
                nombre: 'Balance por cliente',
                columnas: ['Cliente', 'Teléfono', 'Total cargos', 'Total abonos', 'Balance pendiente'],
                filas: r.balances.map(c => [
                    c.nombre,
                    c.telefono || '—',
                    r.fmtDOP(c.cargos),
                    r.fmtDOP(c.abonos),
                    r.fmtDOP(c.balance),
                ]),
            },
        ]);
    });

    // ── FIADO PDF ────────────────────────────────────────────────────────────
    const fiadoPdf = () => ejecutar('fiado', async () => {
        const r = await getReporteFiado(negocioId!);
        descargarPdf(
            'VentaRD_Fiado',
            [
                {
                    titulo: 'Balance de cuentas por cobrar (fiado)',
                    columnas: ['Cliente', 'Teléfono', 'Cargos', 'Abonos', 'Balance'],
                    filas: r.balances.map(c => [
                        c.nombre,
                        c.telefono || '—',
                        r.fmtDOP(c.cargos),
                        r.fmtDOP(c.abonos),
                        r.fmtDOP(c.balance),
                    ]),
                    pieTabla: `Total pendiente por cobrar: ${r.fmtDOP(r.totalDeuda)}`,
                },
            ],
            negocio,
            'Cuentas por cobrar',
        );
    });

    // ── NCF EXCEL ────────────────────────────────────────────────────────────
    const ncfExcel = () => ejecutar('ncf', async () => {
        const { desde, hasta, label } = rangoDesde(periodo);
        const r = await getReporteNcf(negocioId!, desde, hasta);
        descargarExcel(`VentaRD_NCF_${label.replace(/ /g, '_')}`, [
            {
                nombre: 'NCF emitidos',
                columnas: ['Fecha', 'Hora', 'NCF', 'Ticket #', 'Método', 'Total'],
                filas: r.ventas.map(v => [
                    r.fmtFecha(v.fecha_creacion),
                    r.fmtHora(v.fecha_creacion),
                    v.ncf || '—',
                    v.numero_ticket ? String(v.numero_ticket).padStart(5, '0') : '—',
                    r.METODOS[v.metodo_pago] || v.metodo_pago,
                    v.total,
                ]),
            },
        ]);
    });

    // ── NCF PDF ──────────────────────────────────────────────────────────────
    const ncfPdf = () => ejecutar('ncf', async () => {
        const { desde, hasta, label } = rangoDesde(periodo);
        const r = await getReporteNcf(negocioId!, desde, hasta);
        descargarPdf(
            `VentaRD_NCF_${label.replace(/ /g, '_')}`,
            [
                {
                    titulo: `Comprobantes Fiscales emitidos · ${label}`,
                    columnas: ['Fecha', 'Hora', 'NCF', 'Ticket #', 'Método', 'Total'],
                    filas: r.ventas.map(v => [
                        r.fmtFecha(v.fecha_creacion),
                        r.fmtHora(v.fecha_creacion),
                        v.ncf || '—',
                        v.numero_ticket ? String(v.numero_ticket).padStart(5, '0') : '—',
                        r.METODOS[v.metodo_pago] || v.metodo_pago,
                        r.fmtDOP(v.total),
                    ]),
                    pieTabla: `Total comprobantes: ${r.ventas.length}`,
                },
            ],
            negocio,
            label,
        );
    });

    // ── 607 DGII (Excel) ─────────────────────────────────────────────────────
    const reporte607 = () => ejecutar('607', async () => {
        const [anioStr, mesStr] = mes607.split('-');
        const anio = parseInt(anioStr, 10);
        const mes = parseInt(mesStr, 10);
        const r = await getReporte607(negocioId!, anio, mes);

        if (r.cantidad === 0) {
            setError('No hay comprobantes fiscales (NCF) emitidos en ese mes.');
            return;
        }

        const periodoFiscal = `${anioStr}${mesStr}`; // AAAAMM
        descargarExcel(`607_${negocioRnc || 'RNC'}_${periodoFiscal}`, [
            {
                nombre: '607',
                columnas: [
                    'RNC/Cédula', 'Tipo Id', 'NCF', 'NCF Modificado', 'Tipo Ingreso',
                    'Fecha Comprobante', 'Monto Facturado', 'ITBIS Facturado',
                    'Efectivo', 'Cheque/Transf./Depósito', 'Tarjeta Débito/Crédito', 'Venta a Crédito',
                ],
                filas: r.filas.map(f => [
                    f.rncCliente, f.tipoId, f.ncf, f.ncfModificado, f.tipoIngreso,
                    f.fechaComprobante, f.montoFacturado, f.itbisFacturado,
                    f.efectivo, f.chequeTransferencia, f.tarjeta, f.ventaCredito,
                ]),
            },
            {
                nombre: 'Resumen',
                columnas: ['Concepto', 'Valor'],
                filas: [
                    ['Negocio', negocioNombre || ''],
                    ['RNC', negocioRnc || ''],
                    ['Período fiscal', periodoFiscal],
                    ['Cantidad de registros', r.cantidad],
                    ['Total monto facturado', r.totales.facturado],
                    ['Total ITBIS facturado', r.totales.itbis],
                ],
            },
        ]);
    });

    const PERIODOS = [
        { key: 'hoy', label: 'Hoy' },
        { key: 'semana', label: '7 días' },
        { key: 'mes', label: 'Este mes' },
        { key: 'mes_anterior', label: 'Mes anterior' },
        { key: 'año', label: 'Este año' },
    ];

    return (
        <PinGuard>
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <div className="flex-1 p-4 sm:p-8">
                    <div className="max-w-4xl mx-auto">

                        {/* Header */}
                        <div className="mb-6">
                            <h1 className="text-2xl sm:text-3xl font-display font-black text-white">Reportes</h1>
                            <p className="text-vr-gray mt-1 text-sm">Exporta tus datos en Excel o PDF para análisis y contabilidad.</p>
                        </div>

                        {/* Selector de período */}
                        <div className="bg-navy-2 border border-navy-3 rounded-2xl p-4 mb-6">
                            <p className="text-xs font-bold text-vr-gray uppercase tracking-wider mb-3">Período para reportes de ventas y NCF</p>
                            <div className="flex flex-wrap gap-2">
                                {PERIODOS.map(p => (
                                    <button
                                        key={p.key}
                                        onClick={() => setPeriodo(p.key)}
                                        className={`px-4 py-2 rounded-xl text-sm font-bold border transition-all ${
                                            periodo === p.key
                                                ? 'bg-gold/15 border-gold/30 text-gold'
                                                : 'bg-navy border-navy-3 text-vr-gray hover:text-white hover:border-navy-4'
                                        }`}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Error */}
                        {error && (
                            <div className="flex items-center gap-2 bg-vr-red/10 border border-vr-red/20 rounded-xl p-3 mb-4 text-sm text-vr-red">
                                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                                {error}
                            </div>
                        )}

                        {/* Tarjetas */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <TarjetaReporte
                                icono={TrendingUp}
                                titulo="Reporte de Ventas"
                                descripcion={`Detalle de ventas, métodos de pago y productos más vendidos. Período: ${PERIODOS.find(p => p.key === periodo)?.label}`}
                                color="bg-gold/10 text-gold"
                                onExcel={ventasExcel}
                                onPdf={ventasPdf}
                                cargando={cargando === 'ventas'}
                            />

                            <TarjetaReporte
                                icono={Package}
                                titulo="Inventario"
                                descripcion="Stock actual, costos y valor total del inventario. Incluye alertas de bajo stock."
                                color="bg-blue-400/10 text-blue-400"
                                onExcel={inventarioExcel}
                                onPdf={inventarioPdf}
                                cargando={cargando === 'inventario'}
                            />

                            <TarjetaReporte
                                icono={Users}
                                titulo="Cuentas por Cobrar (Fiado)"
                                descripcion="Balance pendiente por cliente, total de cargos y abonos."
                                color="bg-purple-400/10 text-purple-400"
                                onExcel={fiadoExcel}
                                onPdf={fiadoPdf}
                                cargando={cargando === 'fiado'}
                            />

                            {ncfConfig.habilitado && (
                                <TarjetaReporte
                                    icono={Receipt}
                                    titulo="Comprobantes Fiscales (NCF)"
                                    descripcion={`Listado de NCF emitidos para declaración DGII. Período: ${PERIODOS.find(p => p.key === periodo)?.label}`}
                                    color="bg-vr-red/10 text-vr-red"
                                    onExcel={ncfExcel}
                                    onPdf={ncfPdf}
                                    cargando={cargando === 'ncf'}
                                />
                            )}
                        </div>

                        {/* Reporte 607 DGII — tiene su propio selector de mes fiscal */}
                        {ncfConfig.habilitado && (
                            <div className="bg-navy-2 border border-vr-red/20 rounded-2xl p-5 mt-4">
                                <div className="flex items-start gap-3 mb-4">
                                    <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-vr-red/10 text-vr-red">
                                        <Receipt className="w-5 h-5" />
                                    </div>
                                    <div>
                                        <h3 className="font-bold text-white text-base">Reporte 607 — DGII</h3>
                                        <p className="text-xs text-vr-gray mt-0.5">
                                            Formato oficial de ventas para subir a la Oficina Virtual de la DGII. Incluye solo ventas con NCF, con el monto sin ITBIS (base imponible).
                                        </p>
                                    </div>
                                </div>
                                <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                                    <div className="flex-1">
                                        <label className="block text-xs font-bold text-vr-gray uppercase tracking-wider mb-1.5">Mes fiscal a declarar</label>
                                        <input
                                            type="month"
                                            value={mes607}
                                            max={mesAnterior}
                                            onChange={e => { setMes607(e.target.value); setError(null); }}
                                            className="w-full sm:w-48 bg-navy border border-navy-3 rounded-xl p-2.5 text-white focus:border-gold outline-none transition-all"
                                        />
                                    </div>
                                    <button
                                        onClick={reporte607}
                                        disabled={cargando === '607'}
                                        className="flex items-center justify-center gap-1.5 py-2.5 px-5 bg-vr-red/10 text-vr-red border border-vr-red/20 rounded-xl text-sm font-bold hover:bg-vr-red/20 transition-all disabled:opacity-40 whitespace-nowrap"
                                    >
                                        {cargando === '607' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
                                        Generar 607 (Excel)
                                    </button>
                                </div>
                                {!negocioRnc && (
                                    <p className="text-[11px] text-vr-orange mt-2.5">
                                        ⚠️ No tienes RNC configurado. Agrégalo en Ajustes para que el archivo lo incluya.
                                    </p>
                                )}
                            </div>
                        )}

                        <p className="text-xs text-vr-gray/50 text-center mt-8">
                            Los reportes se generan localmente desde tu dispositivo. No se envían datos a ningún servidor externo.
                        </p>
                    </div>
                </div>
            </div>
        </PinGuard>
    );
}
