// src/app/dashboard/page.tsx
'use client';

import { useMemo, useState } from 'react';
import { formatDOP } from '@/lib/utils';
import {
    useVentasRangoTenant, useProductosBajoStockTenant, useProductosTenant,
    useVentaDetallesPorVentas, useClientesTenant, useTransaccionesFiadoTenant, useVentasPeriodoTenant,
    useGastosRangoTenant
} from '@/lib/db/tenantQuery';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';
import Link from 'next/link';
import { SkeletonKPIGrid } from '@/components/ui/Skeleton';
import ResumenDiario from '@/components/shared/ResumenDiario';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db/dexie';
import { useConfigStore } from '@/store/useConfigStore';
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
    PieChart, Pie, Cell, Legend
} from 'recharts';

const CHART_COLORS = ['#D4A017', '#22c55e', '#3b82f6', '#f97316'];

type Periodo = 'hoy' | '7d' | 'mes';

const PERIODOS: { key: Periodo; label: string }[] = [
    { key: 'hoy', label: 'Hoy' },
    { key: '7d', label: '7 días' },
    { key: 'mes', label: 'Este mes' },
];

function getRango(periodo: Periodo): { desde: number; hasta: number } {
    const now = new Date();
    // Use end-of-day (23:59:59.999) so the range doesn't shift every millisecond
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

    if (periodo === 'hoy') {
        return { desde: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), hasta: endOfDay };
    }
    if (periodo === '7d') {
        const startOf7d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
        return { desde: startOf7d, hasta: endOfDay };
    }
    // mes actual
    return { desde: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), hasta: endOfDay };
}

export default function DashboardPage() {
    const { negocioId, rolUsuario, nombreUsuario, planTier } = useConfigStore();
    const [periodo, setPeriodo] = useState<Periodo>('hoy');

    // El vendedor ve un panel restringido: solo SUS ventas, sin ganancias,
    // gastos, fiados ni datos de otros vendedores (información del dueño).
    const esVendedor = rolUsuario === 'vendedor';

    // Detect loading state — undefined = still querying IndexedDB
    const ventasRaw = useLiveQuery(
        () => negocioId ? db.ventas.where('negocio_id').equals(negocioId).limit(1).toArray() : [],
        [negocioId]
    );
    const isLoading = ventasRaw === undefined;
    // Memoize so desde/hasta don't change on every render (useLiveQuery uses them as deps)
    const { desde, hasta } = useMemo(() => getRango(periodo), [periodo]);

    // === QUERIES AISLADAS POR NEGOCIO ===
    const ventasPeriodo = useVentasRangoTenant(desde, hasta);
    const ventas7d = useVentasPeriodoTenant(7);
    const productosBajoStock = useProductosBajoStockTenant();
    const productos = useProductosTenant();
    // Detalles SOLO de las ventas visibles — escala con el período, no con la historia
    const detallesPeriodo = useVentaDetallesPorVentas(useMemo(() => ventasPeriodo.map(v => v.id), [ventasPeriodo]));
    const detalles7d = useVentaDetallesPorVentas(useMemo(() => ventas7d.map(v => v.id), [ventas7d]));
    const clientes = useClientesTenant();
    const transacciones = useTransaccionesFiadoTenant();
    const gastosPeriodo = useGastosRangoTenant(desde, hasta);

    // Ventas que ve el usuario: el vendedor solo las suyas; el dueño/admin todas
    const ventasVista = useMemo(
        () => esVendedor ? ventasPeriodo.filter(v => v.vendedor_nombre === nombreUsuario) : ventasPeriodo,
        [esVendedor, ventasPeriodo, nombreUsuario]
    );

    // === KPIs CALCULADOS ===
    const totalVentas = ventasVista.reduce((acc, v) => acc + v.total, 0);
    const ticketPromedio = ventasVista.length > 0 ? totalVentas / ventasVista.length : 0;

    // Ganancia bruta del período (precio_venta - costo) * cantidad
    const gananciaBruta = useMemo(() => {
        const productoMap = new Map(productos.map(p => [p.id, p]));
        return detallesPeriodo.reduce((acc, d) => {
            const prod = productoMap.get(d.producto_id);
            if (!prod) return acc;
            return acc + ((prod.precio_venta - prod.costo) * d.cantidad);
        }, 0);
    }, [detallesPeriodo, productos]);

    // Balance de fiados consolidado
    const balanceFiados = useMemo(() => {
        const cargos = transacciones.filter(t => t.tipo === 'cargo').reduce((s, t) => s + t.monto, 0);
        const abonos = transacciones.filter(t => t.tipo === 'abono').reduce((s, t) => s + t.monto, 0);
        return cargos - abonos;
    }, [transacciones]);

    // Top 5 clientes por consumo
    const topClientes = useMemo(() => {
        const mapa: Record<string, { nombre: string; total: number }> = {};
        transacciones.filter(t => t.tipo === 'cargo').forEach(t => {
            const cliente = clientes.find(c => c.id === t.cliente_id);
            const nombre = cliente?.nombre || 'Desconocido';
            if (!mapa[t.cliente_id]) mapa[t.cliente_id] = { nombre, total: 0 };
            mapa[t.cliente_id].total += t.monto;
        });
        return Object.values(mapa).sort((a, b) => b.total - a.total).slice(0, 5);
    }, [transacciones, clientes]);

    // Ventas por vendedor del período (las ventas del dueño salen como "Dueño")
    const ventasPorVendedor = useMemo(() => {
        const mapa: Record<string, { nombre: string; total: number; cantidad: number }> = {};
        ventasPeriodo.forEach(v => {
            const nombre = v.vendedor_nombre || 'Dueño';
            if (!mapa[nombre]) mapa[nombre] = { nombre, total: 0, cantidad: 0 };
            mapa[nombre].total += v.total;
            mapa[nombre].cantidad++;
        });
        return Object.values(mapa).sort((a, b) => b.total - a.total);
    }, [ventasPeriodo]);

    // Productos sin movimiento (stock > 0, 0 ventas en 7d)
    const productosSinMovimiento = useMemo(() => {
        const idsVendidos7d = new Set(detalles7d.map(d => d.producto_id));
        return productos.filter(p =>
            p.tipo !== 'insumo' && p.stock_actual > 0 && !idsVendidos7d.has(p.id)
        );
    }, [productos, detalles7d]);

    // Data: Ventas por hora (solo relevante en vista "hoy", para otros períodos agrupamos por día)
    const ventasPorHora = useMemo(() => {
        if (periodo === 'hoy') {
            const horas: Record<number, number> = {};
            for (let i = 6; i < 24; i++) horas[i] = 0;
            ventasVista.forEach(v => {
                const hora = new Date(v.fecha_creacion).getHours();
                horas[hora] = (horas[hora] || 0) + v.total;
            });
            return Object.entries(horas).map(([hora, monto]) => ({
                hora: `${hora}:00`, ventas: Math.round(monto),
            }));
        } else {
            // Agrupar por día
            const dias: Record<string, number> = {};
            ventasVista.forEach(v => {
                const d = new Date(v.fecha_creacion);
                const key = `${d.getDate()}/${d.getMonth() + 1}`;
                dias[key] = (dias[key] || 0) + v.total;
            });
            return Object.entries(dias).map(([hora, ventas]) => ({ hora, ventas: Math.round(ventas) }));
        }
    }, [ventasVista, periodo]);

    // Data: Ventas por método de pago
    const ventasPorMetodo = useMemo(() => {
        const metodos: Record<string, number> = {};
        ventasVista.forEach(v => { metodos[v.metodo_pago] = (metodos[v.metodo_pago] || 0) + v.total; });
        const labels: Record<string, string> = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', fiado: 'Fiado' };
        return Object.entries(metodos).map(([m, monto]) => ({ name: labels[m] || m, value: Math.round(monto) }));
    }, [ventasPeriodo]);

    const chartLabel = periodo === 'hoy' ? 'Ventas por Hora' : 'Ventas por Día';

    // ── Pro: Reparaciones y Apartados del período ─────────────────────────────
    const esPro = planTier === 'pro' && !esVendedor;
    const reparacionesAllRaw = useLiveQuery(
        () => (esPro && negocioId) ? db.reparaciones.where('negocio_id').equals(negocioId).toArray() : [],
        [esPro, negocioId]
    );
    const apartadosAllRaw = useLiveQuery(
        () => (esPro && negocioId) ? db.apartados.where('negocio_id').equals(negocioId).toArray() : [],
        [esPro, negocioId]
    );
    const reparacionesAll = useMemo(() => reparacionesAllRaw ?? [], [reparacionesAllRaw]);
    const apartadosAll = useMemo(() => apartadosAllRaw ?? [], [apartadosAllRaw]);

    const resumenPro = useMemo(() => {
        const repEntregadas = reparacionesAll.filter(r => r.estado === 'entregado' && r.fecha_entrega && r.fecha_entrega >= desde && r.fecha_entrega <= hasta);
        const repIngreso = repEntregadas.reduce((s, r) => s + r.total, 0);
        const repGanancia = repEntregadas.reduce((s, r) => s + (r.total - r.repuestos.reduce((sr, x) => sr + x.costo * x.cantidad, 0)), 0);
        const repEnProceso = reparacionesAll.filter(r => r.estado !== 'entregado' && r.estado !== 'cancelado').length;

        const apAbonado = apartadosAll.reduce((s, a) => s + a.abonos.filter(ab => ab.fecha >= desde && ab.fecha <= hasta).reduce((sa, ab) => sa + ab.monto, 0), 0);
        const apActivos = apartadosAll.filter(a => a.estado === 'activo');
        const apPorCobrar = apActivos.reduce((s, a) => s + Math.max(0, a.total - a.abonado), 0);

        // Ganancia de apartados completados en el período (precio - costo del producto)
        const prodCost = new Map(productos.map(p => [p.id, p.costo]));
        const apCompletados = apartadosAll.filter(a => a.estado === 'completado' && a.fecha_completado && a.fecha_completado >= desde && a.fecha_completado <= hasta);
        const apGanancia = apCompletados.reduce((s, a) => s + a.items.reduce((si, it) => si + (it.precio_unitario - (prodCost.get(it.producto_id) ?? 0)) * it.cantidad, 0), 0);

        return { repEntregadas: repEntregadas.length, repIngreso, repGanancia, repEnProceso, apAbonado, apActivos: apActivos.length, apPorCobrar, apGanancia };
    }, [reparacionesAll, apartadosAll, productos, desde, hasta]);

    return (
        <div className="min-h-screen bg-navy flex flex-col">
            <TopBar />
            <OfflineBanner />

            <div className="flex-1 p-4 md:p-8 overflow-y-auto">
                <div className="max-w-6xl mx-auto">
                    <header className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
                        <div>
                            <h1 className="text-2xl md:text-3xl font-display font-extrabold text-white">{esVendedor ? 'Mis Ventas' : 'Dashboard'}</h1>
                            <p className="text-vr-gray font-medium mt-1 text-sm">{esVendedor ? 'Tu desempeño' : 'Resumen de tu negocio'}</p>
                        </div>
                        <div className="flex items-center gap-3">
                            {/* Period selector */}
                            <div className="flex bg-navy-2 border border-navy-3 rounded-xl p-1 gap-1">
                                {PERIODOS.map(p => (
                                    <button
                                        key={p.key}
                                        onClick={() => setPeriodo(p.key)}
                                        className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${
                                            periodo === p.key
                                                ? 'bg-gold text-navy'
                                                : 'text-vr-gray hover:text-white'
                                        }`}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                            <button
                                onClick={() => window.dispatchEvent(new Event('abrir-novedades'))}
                                className="bg-navy-2 border border-gold/20 px-3 py-2 rounded-xl font-bold text-gold hover:bg-gold/10 transition-all text-sm whitespace-nowrap"
                                title="Ver las novedades"
                            >
                                ✨ <span className="hidden sm:inline">Novedades</span>
                            </button>
                            <Link href="/" className="bg-navy-2 border border-navy-3 px-4 py-2 rounded-xl font-bold text-vr-gray hover:text-white hover:border-navy-4 transition-all text-sm hidden sm:block">
                                Ir a la Caja
                            </Link>
                        </div>
                    </header>

                    {/* Resumen de ayer — solo para el dueño/admin (tiene ganancia y fiados) */}
                    {!esVendedor && <ResumenDiario />}

                    {/* KPI Cards */}
                    {isLoading ? (
                        <div className="mb-6"><SkeletonKPIGrid /></div>
                    ) : (
                    <div className={`grid grid-cols-2 gap-4 mb-6 ${esVendedor ? 'md:grid-cols-2 max-w-xl' : 'md:grid-cols-4'}`}>
                        <div className="bg-navy-2 p-5 rounded-2xl border border-navy-3 relative overflow-hidden glow-gold">
                            <div className="relative z-10">
                                <p className="text-vr-gray font-bold uppercase text-[10px] tracking-widest">Vendido</p>
                                <h2 className="text-2xl font-black font-mono mt-2 text-gold">{formatDOP(totalVentas)}</h2>
                                <p className="mt-1 text-vr-green text-xs font-bold">↑ {ventasVista.length} transacciones</p>
                            </div>
                            <div className="absolute -right-4 -bottom-4 w-16 h-16 bg-gold/5 rounded-full"></div>
                        </div>

                        {!esVendedor && (
                        <div className="bg-navy-2 p-5 rounded-2xl border border-navy-3">
                            <p className="text-vr-gray font-bold uppercase text-[10px] tracking-widest">Ganancia Neta</p>
                            {(() => {
                                const totalGastos = gastosPeriodo.reduce((s, g) => s + g.monto, 0);
                                const gananciaServicios = resumenPro.repGanancia + resumenPro.apGanancia; // 0 si no es Pro
                                const brutaTotal = gananciaBruta + gananciaServicios;
                                const neta = brutaTotal - totalGastos;
                                return (
                                    <>
                                        <h2 className={`text-2xl font-black font-mono mt-2 ${neta >= 0 ? 'text-vr-green' : 'text-vr-red'}`}>{formatDOP(neta)}</h2>
                                        <p className="mt-1 text-vr-gray text-xs">
                                            {totalGastos > 0
                                                ? <>Bruta {formatDOP(brutaTotal)} − <Link href="/gastos" className="text-vr-red hover:underline">gastos {formatDOP(totalGastos)}</Link></>
                                                : gananciaServicios > 0
                                                    ? <>Ventas {formatDOP(gananciaBruta)} + servicios {formatDOP(gananciaServicios)}</>
                                                    : totalVentas > 0 ? `${((gananciaBruta / totalVentas) * 100).toFixed(0)}% margen` : '-'}
                                        </p>
                                    </>
                                );
                            })()}
                        </div>
                        )}

                        <div className="bg-navy-2 p-5 rounded-2xl border border-navy-3">
                            <p className="text-vr-gray font-bold uppercase text-[10px] tracking-widest">Ticket Promedio</p>
                            <h2 className="text-2xl font-black font-mono mt-2 text-white">{formatDOP(ticketPromedio)}</h2>
                        </div>

                        {!esVendedor && (
                        <div className={`bg-navy-2 p-5 rounded-2xl border ${balanceFiados > 0 ? 'border-vr-orange/30' : 'border-navy-3'}`}>
                            <p className="text-vr-gray font-bold uppercase text-[10px] tracking-widest">Te Deben (Fiados)</p>
                            <h2 className={`text-2xl font-black font-mono mt-2 ${balanceFiados > 0 ? 'text-vr-orange' : 'text-vr-green'}`}>{formatDOP(balanceFiados)}</h2>
                            <p className="mt-1 text-vr-gray text-xs">{clientes.length} clientes</p>
                        </div>
                        )}
                    </div>
                    )}

                    {/* Charts Row */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                        <div className="lg:col-span-2 bg-navy-2 p-6 rounded-2xl border border-navy-3">
                            <h3 className="text-white font-display font-bold mb-4">{chartLabel}</h3>
                            {ventasVista.length === 0 ? (
                                <div className="h-48 flex items-center justify-center text-vr-gray text-sm">
                                    <span>Sin datos aún — las ventas aparecerán aquí en tiempo real</span>
                                </div>
                            ) : (
                                <ResponsiveContainer width="100%" height={200}>
                                    <BarChart data={ventasPorHora}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#1E3A5F20" />
                                        <XAxis dataKey="hora" tick={{ fill: '#7A8BA0', fontSize: 10 }} axisLine={false} tickLine={false} />
                                        <YAxis tick={{ fill: '#7A8BA0', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                                        <Tooltip
                                            contentStyle={{ backgroundColor: '#0D1B2E', border: '1px solid #1E3A5F', borderRadius: '12px', color: '#fff' }}
                                            formatter={(value: any) => [formatDOP(Number(value)), 'Ventas']}
                                            labelStyle={{ color: '#D4A017', fontWeight: 'bold' }}
                                        />
                                        <Bar dataKey="ventas" fill="#D4A017" radius={[6, 6, 0, 0]} />
                                    </BarChart>
                                </ResponsiveContainer>
                            )}
                        </div>

                        <div className="bg-navy-2 p-6 rounded-2xl border border-navy-3">
                            <h3 className="text-white font-display font-bold mb-4">Métodos de Pago</h3>
                            {ventasPorMetodo.length === 0 ? (
                                <div className="h-48 flex items-center justify-center text-vr-gray text-sm"><span>Sin datos</span></div>
                            ) : (
                                <ResponsiveContainer width="100%" height={200}>
                                    <PieChart>
                                        <Pie data={ventasPorMetodo} cx="50%" cy="50%" innerRadius={45} outerRadius={70} paddingAngle={4} dataKey="value">
                                            {ventasPorMetodo.map((_, index) => (
                                                <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                                            ))}
                                        </Pie>
                                        <Tooltip
                                            contentStyle={{ backgroundColor: '#0D1B2E', border: '1px solid #1E3A5F', borderRadius: '12px', color: '#fff' }}
                                            formatter={(value: any) => [formatDOP(Number(value))]}
                                        />
                                        <Legend verticalAlign="bottom" formatter={(value: string) => <span style={{ color: '#A0AABB', fontSize: '11px' }}>{value}</span>} />
                                    </PieChart>
                                </ResponsiveContainer>
                            )}
                        </div>
                    </div>

                    {/* BI Row + Consejo — datos del negocio, solo dueño/admin */}
                    {!esVendedor && (<>
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6 mb-6">
                        <div className="bg-navy-2 p-6 rounded-2xl border border-navy-3">
                            <h3 className="text-white font-display font-bold mb-3">Por Vendedor</h3>
                            {ventasPorVendedor.length === 0 ? (
                                <p className="text-vr-gray text-sm">Sin ventas en este período</p>
                            ) : (
                                <div className="space-y-2 max-h-48 overflow-y-auto">
                                    {ventasPorVendedor.map((v, i) => (
                                        <div key={v.nombre} className="flex justify-between items-center py-2 border-b border-navy-3/50 last:border-0">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span className={`text-xs font-black w-5 h-5 rounded flex items-center justify-center shrink-0 ${i === 0 ? 'bg-vr-green/15 text-vr-green' : 'bg-navy-3 text-vr-gray'}`}>{i + 1}</span>
                                                <div className="min-w-0">
                                                    <p className="text-white text-sm font-medium truncate">{v.nombre}</p>
                                                    <p className="text-vr-gray text-[10px]">{v.cantidad} venta{v.cantidad === 1 ? '' : 's'}</p>
                                                </div>
                                            </div>
                                            <span className="text-vr-green font-mono font-bold text-sm shrink-0">{formatDOP(v.total)}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="bg-navy-2 p-6 rounded-2xl border border-navy-3">
                            <h3 className="text-white font-display font-bold mb-3">Top Clientes</h3>
                            {topClientes.length === 0 ? (
                                <p className="text-vr-gray text-sm">Sin datos de clientes aún</p>
                            ) : (
                                <div className="space-y-2">
                                    {topClientes.map((c, i) => (
                                        <div key={i} className="flex justify-between items-center py-2 border-b border-navy-3/50 last:border-0">
                                            <div className="flex items-center gap-2">
                                                <span className={`text-xs font-black w-5 h-5 rounded flex items-center justify-center ${i === 0 ? 'bg-gold/15 text-gold' : 'bg-navy-3 text-vr-gray'}`}>{i + 1}</span>
                                                <span className="text-white text-sm font-medium truncate max-w-[120px]">{c.nombre}</span>
                                            </div>
                                            <span className="text-gold font-mono font-bold text-sm">{formatDOP(c.total)}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="bg-navy-2 p-6 rounded-2xl border border-navy-3">
                            <h3 className="text-white font-display font-bold mb-3">Sin Movimiento <span className="text-vr-gray text-xs font-normal">(7 días)</span></h3>
                            {productosSinMovimiento.length === 0 ? (
                                <p className="text-vr-green text-sm font-bold">Todos los productos se están vendiendo</p>
                            ) : (
                                <div className="space-y-2 max-h-48 overflow-y-auto">
                                    {productosSinMovimiento.slice(0, 8).map(p => (
                                        <div key={p.id} className="flex justify-between items-center py-1.5 border-b border-navy-3/50 last:border-0">
                                            <span className="text-white text-sm truncate max-w-[140px]">{p.nombre}</span>
                                            <div className="text-right">
                                                <span className="text-vr-orange font-mono text-xs font-bold">{p.stock_actual} uds</span>
                                            </div>
                                        </div>
                                    ))}
                                    {productosSinMovimiento.length > 8 && (
                                        <p className="text-vr-gray text-xs text-center pt-1">+{productosSinMovimiento.length - 8} más</p>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="bg-navy-2 p-6 rounded-2xl border border-navy-3">
                            <h3 className="text-white font-display font-bold mb-3">Stock Crítico</h3>
                            {productosBajoStock.length === 0 ? (
                                <p className="text-vr-green text-sm font-bold">Inventario sano</p>
                            ) : (
                                <div className="space-y-2 max-h-48 overflow-y-auto">
                                    {productosBajoStock.slice(0, 8).map(p => (
                                        <div key={p.id} className="flex justify-between items-center py-1.5 border-b border-navy-3/50 last:border-0">
                                            <span className="text-white text-sm truncate max-w-[140px]">{p.nombre}</span>
                                            <span className={`font-mono text-xs font-bold ${p.stock_actual <= 0 ? 'text-vr-red' : 'text-vr-orange'}`}>
                                                {p.stock_actual <= 0 ? 'AGOTADO' : `${p.stock_actual} uds`}
                                            </span>
                                        </div>
                                    ))}
                                    {productosBajoStock.length > 8 && (
                                        <Link href="/inventario" className="text-gold text-xs font-bold hover:underline block text-center pt-1">
                                            Ver {productosBajoStock.length - 8} más →
                                        </Link>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Pro: Reparaciones y Apartados */}
                    {esPro && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                            <div className="bg-navy-2 p-6 rounded-2xl border border-navy-3">
                                <h3 className="text-white font-display font-bold mb-4 flex items-center gap-2">
                                    🔧 Reparaciones
                                    <span className="text-[9px] font-black bg-gold/15 text-gold px-1.5 py-0.5 rounded-full uppercase tracking-wider">Pro</span>
                                    <Link href="/reparaciones" className="ml-auto text-xs font-bold text-gold hover:underline">Ver →</Link>
                                </h3>
                                <div className="grid grid-cols-2 gap-3">
                                    <div><p className="text-vr-gray text-[10px] font-bold uppercase tracking-widest">Entregadas</p><p className="text-xl font-black font-mono text-white mt-1">{resumenPro.repEntregadas}</p></div>
                                    <div><p className="text-vr-gray text-[10px] font-bold uppercase tracking-widest">En proceso</p><p className="text-xl font-black font-mono text-vr-orange mt-1">{resumenPro.repEnProceso}</p></div>
                                    <div><p className="text-vr-gray text-[10px] font-bold uppercase tracking-widest">Ingreso</p><p className="text-lg font-black font-mono text-vr-green mt-1">{formatDOP(resumenPro.repIngreso)}</p></div>
                                    <div><p className="text-vr-gray text-[10px] font-bold uppercase tracking-widest">Ganancia</p><p className="text-lg font-black font-mono text-gold mt-1">{formatDOP(resumenPro.repGanancia)}</p></div>
                                </div>
                            </div>

                            <div className="bg-navy-2 p-6 rounded-2xl border border-navy-3">
                                <h3 className="text-white font-display font-bold mb-4 flex items-center gap-2">
                                    🔖 Apartados
                                    <span className="text-[9px] font-black bg-gold/15 text-gold px-1.5 py-0.5 rounded-full uppercase tracking-wider">Pro</span>
                                    <Link href="/apartados" className="ml-auto text-xs font-bold text-gold hover:underline">Ver →</Link>
                                </h3>
                                <div className="grid grid-cols-2 gap-3">
                                    <div><p className="text-vr-gray text-[10px] font-bold uppercase tracking-widest">Activos</p><p className="text-xl font-black font-mono text-white mt-1">{resumenPro.apActivos}</p></div>
                                    <div><p className="text-vr-gray text-[10px] font-bold uppercase tracking-widest">Abonado ({periodo === 'hoy' ? 'hoy' : 'período'})</p><p className="text-lg font-black font-mono text-vr-green mt-1">{formatDOP(resumenPro.apAbonado)}</p></div>
                                    <div className="col-span-2"><p className="text-vr-gray text-[10px] font-bold uppercase tracking-widest">Por cobrar (activos)</p><p className="text-lg font-black font-mono text-vr-orange mt-1">{formatDOP(resumenPro.apPorCobrar)}</p></div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Consejo */}
                    <div className="bg-gold/5 border border-gold/15 p-6 rounded-2xl">
                        <h3 className="text-gold font-display font-bold mb-2">Consejo del Asistente VentaRD</h3>
                        <p className="text-vr-gray leading-relaxed text-sm">
                            {productosSinMovimiento.length > 3
                                ? `Tienes ${productosSinMovimiento.length} productos sin movimiento en 7 días. Considera una promoción para mover ese inventario.`
                                : balanceFiados > 5000
                                ? `Tienes ${formatDOP(balanceFiados)} en fiados pendientes. Es buen momento para recordar a tus clientes con pagos atrasados.`
                                : totalVentas > 5000
                                ? "¡Excelente ritmo! Revisa tu inventario para asegurar que los productos estrella no se agoten."
                                : ventasPeriodo.length > 0
                                ? "Las ventas van bien. Podrías aplicar una oferta en productos con mucho stock para moverlos."
                                : "Aún no hay ventas en este período. ¡Prepárate revisando el inventario!"}
                        </p>
                    </div>
                    </>)}
                </div>
            </div>
        </div>
    );
}
