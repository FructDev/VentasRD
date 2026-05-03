// src/app/dashboard/page.tsx
'use client';

import { useMemo } from 'react';
import { formatDOP } from '@/lib/utils';
import {
    useVentasHoyTenant, useProductosBajoStockTenant, useProductosTenant,
    useVentaDetallesTenant, useClientesTenant, useTransaccionesFiadoTenant, useVentasPeriodoTenant
} from '@/lib/db/tenantQuery';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';
import Link from 'next/link';
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
    PieChart, Pie, Cell, Legend
} from 'recharts';

const CHART_COLORS = ['#D4A017', '#22c55e', '#3b82f6', '#f97316'];

export default function DashboardPage() {
    // === QUERIES AISLADAS POR NEGOCIO ===
    const ventasHoy = useVentasHoyTenant();
    const ventas7d = useVentasPeriodoTenant(7);
    const productosBajoStock = useProductosBajoStockTenant();
    const productos = useProductosTenant();
    const detalles = useVentaDetallesTenant();
    const clientes = useClientesTenant();
    const transacciones = useTransaccionesFiadoTenant();

    // === KPIs CALCULADOS ===
    const totalVentas = ventasHoy.reduce((acc, v) => acc + v.total, 0);
    const ticketPromedio = ventasHoy.length > 0 ? totalVentas / ventasHoy.length : 0;

    // Ganancia bruta del día (precio_venta - costo) * cantidad
    const gananciaBruta = useMemo(() => {
        const productoMap = new Map(productos.map(p => [p.id, p]));
        const detallesHoy = detalles.filter(d => {
            const venta = ventasHoy.find(v => v.id === d.venta_id);
            return !!venta;
        });
        return detallesHoy.reduce((acc, d) => {
            const prod = productoMap.get(d.producto_id);
            if (!prod) return acc;
            return acc + ((prod.precio_venta - prod.costo) * d.cantidad);
        }, 0);
    }, [ventasHoy, detalles, productos]);

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

    // Productos sin movimiento (stock > 0, 0 ventas en 7d)
    const productosSinMovimiento = useMemo(() => {
        const idsVendidos7d = new Set(
            detalles.filter(d => ventas7d.find(v => v.id === d.venta_id)).map(d => d.producto_id)
        );
        return productos.filter(p =>
            p.tipo !== 'insumo' && p.stock_actual > 0 && !idsVendidos7d.has(p.id)
        );
    }, [productos, detalles, ventas7d]);

    // Data: Ventas por hora
    const ventasPorHora = useMemo(() => {
        const horas: Record<number, number> = {};
        for (let i = 6; i < 24; i++) horas[i] = 0;
        ventasHoy.forEach(v => {
            const hora = new Date(v.fecha_creacion).getHours();
            horas[hora] = (horas[hora] || 0) + v.total;
        });
        return Object.entries(horas).map(([hora, monto]) => ({
            hora: `${hora}:00`, ventas: Math.round(monto),
        }));
    }, [ventasHoy]);

    // Data: Ventas por método de pago
    const ventasPorMetodo = useMemo(() => {
        const metodos: Record<string, number> = {};
        ventasHoy.forEach(v => { metodos[v.metodo_pago] = (metodos[v.metodo_pago] || 0) + v.total; });
        const labels: Record<string, string> = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', fiado: 'Fiado' };
        return Object.entries(metodos).map(([m, monto]) => ({ name: labels[m] || m, value: Math.round(monto) }));
    }, [ventasHoy]);

    return (
        <div className="min-h-screen bg-navy flex flex-col">
            <TopBar />
            <OfflineBanner />

            <div className="flex-1 p-8 overflow-y-auto">
                <div className="max-w-6xl mx-auto">
                    <header className="flex justify-between items-center mb-8">
                        <div>
                            <h1 className="text-3xl font-display font-extrabold text-white">Resumen de Hoy</h1>
                            <p className="text-vr-gray font-medium mt-1">Inteligencia de negocio en tiempo real.</p>
                        </div>
                        <Link href="/" className="bg-navy-2 border border-navy-3 px-6 py-3 rounded-xl font-bold text-vr-gray hover:text-white hover:border-navy-4 transition-all">
                            Ir a la Caja
                        </Link>
                    </header>

                    {/* KPI Cards - Row 1 */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                        <div className="bg-navy-2 p-5 rounded-2xl border border-navy-3 relative overflow-hidden glow-gold">
                            <div className="relative z-10">
                                <p className="text-vr-gray font-bold uppercase text-[10px] tracking-widest">Vendido Hoy</p>
                                <h2 className="text-2xl font-black font-mono mt-2 text-gold">{formatDOP(totalVentas)}</h2>
                                <p className="mt-1 text-vr-green text-xs font-bold">↑ {ventasHoy.length} transacciones</p>
                            </div>
                            <div className="absolute -right-4 -bottom-4 w-16 h-16 bg-gold/5 rounded-full"></div>
                        </div>

                        <div className="bg-navy-2 p-5 rounded-2xl border border-navy-3">
                            <p className="text-vr-gray font-bold uppercase text-[10px] tracking-widest">Ganancia Bruta</p>
                            <h2 className="text-2xl font-black font-mono mt-2 text-vr-green">{formatDOP(gananciaBruta)}</h2>
                            <p className="mt-1 text-vr-gray text-xs">{totalVentas > 0 ? `${((gananciaBruta / totalVentas) * 100).toFixed(0)}% margen` : '-'}</p>
                        </div>

                        <div className="bg-navy-2 p-5 rounded-2xl border border-navy-3">
                            <p className="text-vr-gray font-bold uppercase text-[10px] tracking-widest">Ticket Promedio</p>
                            <h2 className="text-2xl font-black font-mono mt-2 text-white">{formatDOP(ticketPromedio)}</h2>
                        </div>

                        <div className={`bg-navy-2 p-5 rounded-2xl border ${balanceFiados > 0 ? 'border-vr-orange/30' : 'border-navy-3'}`}>
                            <p className="text-vr-gray font-bold uppercase text-[10px] tracking-widest">Te Deben (Fiados)</p>
                            <h2 className={`text-2xl font-black font-mono mt-2 ${balanceFiados > 0 ? 'text-vr-orange' : 'text-vr-green'}`}>{formatDOP(balanceFiados)}</h2>
                            <p className="mt-1 text-vr-gray text-xs">{clientes.length} clientes</p>
                        </div>
                    </div>

                    {/* Charts Row */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                        {/* Ventas por Hora */}
                        <div className="lg:col-span-2 bg-navy-2 p-6 rounded-2xl border border-navy-3">
                            <h3 className="text-white font-display font-bold mb-4">Ventas por Hora</h3>
                            {ventasHoy.length === 0 ? (
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

                        {/* Ventas por Método */}
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

                    {/* BI Row: Top Clientes + Productos Sin Movimiento + Stock Crítico */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                        {/* Top Clientes */}
                        <div className="bg-navy-2 p-6 rounded-2xl border border-navy-3">
                            <h3 className="text-white font-display font-bold mb-3">🏆 Top Clientes</h3>
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

                        {/* Productos Sin Movimiento */}
                        <div className="bg-navy-2 p-6 rounded-2xl border border-navy-3">
                            <h3 className="text-white font-display font-bold mb-3">😴 Sin Movimiento <span className="text-vr-gray text-xs font-normal">(7 días)</span></h3>
                            {productosSinMovimiento.length === 0 ? (
                                <p className="text-vr-green text-sm font-bold">✓ Todos los productos se están vendiendo</p>
                            ) : (
                                <div className="space-y-2 max-h-48 overflow-y-auto">
                                    {productosSinMovimiento.slice(0, 8).map(p => (
                                        <div key={p.id} className="flex justify-between items-center py-1.5 border-b border-navy-3/50 last:border-0">
                                            <span className="text-white text-sm truncate max-w-[140px]">{p.nombre}</span>
                                            <div className="text-right">
                                                <span className="text-vr-orange font-mono text-xs font-bold">{p.stock_actual} uds</span>
                                                <span className="text-vr-gray text-[10px] ml-1">({formatDOP(p.costo * p.stock_actual)})</span>
                                            </div>
                                        </div>
                                    ))}
                                    {productosSinMovimiento.length > 8 && (
                                        <p className="text-vr-gray text-xs text-center pt-1">+{productosSinMovimiento.length - 8} más</p>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Stock Crítico */}
                        <div className="bg-navy-2 p-6 rounded-2xl border border-navy-3">
                            <h3 className="text-white font-display font-bold mb-3">🔴 Stock Crítico</h3>
                            {productosBajoStock.length === 0 ? (
                                <p className="text-vr-green text-sm font-bold">✓ Inventario sano</p>
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

                    {/* Consejo Inteligente */}
                    <div className="bg-gold/5 border border-gold/15 p-6 rounded-2xl">
                        <h3 className="text-gold font-display font-bold mb-2">💡 Consejo del Asistente VentaRD</h3>
                        <p className="text-vr-gray leading-relaxed text-sm">
                            {productosSinMovimiento.length > 3
                                ? `Tienes ${productosSinMovimiento.length} productos sin movimiento en 7 días, con ${formatDOP(productosSinMovimiento.reduce((s, p) => s + p.costo * p.stock_actual, 0))} de capital estancado. Considera una promoción para liberarlo.`
                                : balanceFiados > 5000
                                ? `Tienes ${formatDOP(balanceFiados)} en fiados pendientes. Es buen momento para recordar a tus clientes con pagos atrasados.`
                                : totalVentas > 5000
                                ? "¡Excelente ritmo! Revisa tu inventario para asegurar que los productos estrella no se agoten."
                                : ventasHoy.length > 0
                                ? "Las ventas van arrancando. Podrías aplicar una oferta relámpago en productos con mucho stock."
                                : "Aún no hay ventas hoy. ¡Prepárate revisando el inventario y organizando los productos estrella!"}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}