// src/components/shared/ResumenDiario.tsx
// Tarjeta de "Resumen de ayer" que aparece una vez al día en el Dashboard.
// Calcula todo localmente desde Dexie y permite enviarlo por WhatsApp con un
// toque (wa.me sin número fijo: el dueño elige a quién mandárselo).
'use client';

import { useMemo, useState, useEffect } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import {
    useVentasRangoTenant, useVentaDetallesPorVentas, useGastosRangoTenant,
    useProductosTenant, useTransaccionesFiadoTenant,
} from '@/lib/db/tenantQuery';
import { formatDOP } from '@/lib/utils';

const STORAGE_KEY = 'vrd_resumen_diario_visto';

function rangoAyer() {
    const now = new Date();
    const desde = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0).getTime();
    const hasta = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999).getTime();
    return { desde, hasta };
}

export default function ResumenDiario() {
    const { negocioNombre } = useConfigStore();
    const { desde, hasta } = useMemo(() => rangoAyer(), []);

    const ventas = useVentasRangoTenant(desde, hasta);
    const detalles = useVentaDetallesPorVentas(useMemo(() => ventas.map(v => v.id), [ventas]));
    const gastos = useGastosRangoTenant(desde, hasta);
    const productos = useProductosTenant();
    const transacciones = useTransaccionesFiadoTenant();

    const hoyStr = new Date().toISOString().slice(0, 10);
    const [dismissed, setDismissed] = useState(true); // true inicial evita parpadeo

    useEffect(() => {
        setDismissed(localStorage.getItem(STORAGE_KEY) === hoyStr);
    }, [hoyStr]);

    const datos = useMemo(() => {
        const totalVendido = ventas.reduce((s, v) => s + v.total, 0);
        const prodMap = new Map(productos.map(p => [p.id, p]));
        const gananciaBruta = detalles.reduce((acc, d) => {
            const p = prodMap.get(d.producto_id);
            return p ? acc + (p.precio_venta - p.costo) * d.cantidad : acc;
        }, 0);
        const totalGastos = gastos.reduce((s, g) => s + g.monto, 0);
        const gananciaNeta = gananciaBruta - totalGastos;

        // Deuda total de fiados (balance corriente, no solo de ayer)
        const cargos = transacciones.filter(t => t.tipo === 'cargo').reduce((s, t) => s + t.monto, 0);
        const abonos = transacciones.filter(t => t.tipo === 'abono').reduce((s, t) => s + t.monto, 0);
        const deudaFiados = cargos - abonos;

        // Productos por agotarse (vendibles bajo el mínimo)
        const porAgotarse = productos.filter(p => p.tipo === 'simple' && p.stock_actual <= p.stock_minimo);

        return { totalVendido, cantidad: ventas.length, gananciaNeta, totalGastos, deudaFiados, porAgotarse };
    }, [ventas, detalles, gastos, productos, transacciones]);

    const fechaAyer = useMemo(() =>
        new Date(desde).toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long' }),
        [desde]
    );

    // No mostrar si ya se descartó hoy o si ayer no hubo actividad
    if (dismissed) return null;
    if (datos.cantidad === 0 && datos.totalGastos === 0) return null;

    const descartar = () => {
        localStorage.setItem(STORAGE_KEY, hoyStr);
        setDismissed(true);
    };

    const enviarWhatsApp = () => {
        const agotarseStr = datos.porAgotarse.length > 0
            ? `\n⚠️ *Por agotarse:* ${datos.porAgotarse.slice(0, 6).map(p => p.nombre).join(', ')}${datos.porAgotarse.length > 6 ? `… (+${datos.porAgotarse.length - 6})` : ''}`
            : '';
        const msg =
            `☀️ *Resumen de ayer* — ${negocioNombre || 'Mi Negocio'}\n` +
            `📅 ${fechaAyer}\n\n` +
            `💰 Vendido: ${formatDOP(datos.totalVendido)} (${datos.cantidad} venta${datos.cantidad === 1 ? '' : 's'})\n` +
            (datos.totalGastos > 0 ? `💸 Gastos: ${formatDOP(datos.totalGastos)}\n` : '') +
            `📈 Ganancia neta: ${formatDOP(datos.gananciaNeta)}\n` +
            (datos.deudaFiados > 0 ? `🧾 Te deben (fiados): ${formatDOP(datos.deudaFiados)}\n` : '') +
            agotarseStr +
            `\n\n_Enviado desde VentaRD_`;
        window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
        descartar();
    };

    return (
        <div className="bg-gradient-to-br from-navy-2 to-navy-2 border border-gold/25 rounded-2xl overflow-hidden mb-6 animate-fade-in">
            <div className="px-4 sm:px-5 py-3 border-b border-navy-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="text-sm font-display font-bold text-gold">☀️ Resumen de ayer</h2>
                    <p className="text-[11px] text-vr-gray capitalize truncate">{fechaAyer}</p>
                </div>
                <button onClick={descartar} className="text-vr-gray hover:text-white font-bold text-lg px-1 shrink-0 transition-colors" title="Ocultar por hoy">✕</button>
            </div>

            <div className="p-4 sm:p-5">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-4">
                    <div>
                        <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Vendido</p>
                        <p className="text-lg sm:text-xl font-black font-mono text-gold mt-0.5 truncate">{formatDOP(datos.totalVendido)}</p>
                        <p className="text-[10px] text-vr-gray">{datos.cantidad} venta{datos.cantidad === 1 ? '' : 's'}</p>
                    </div>
                    <div>
                        <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Ganancia Neta</p>
                        <p className={`text-lg sm:text-xl font-black font-mono mt-0.5 truncate ${datos.gananciaNeta >= 0 ? 'text-vr-green' : 'text-vr-red'}`}>{formatDOP(datos.gananciaNeta)}</p>
                        {datos.totalGastos > 0 && <p className="text-[10px] text-vr-gray">− {formatDOP(datos.totalGastos)} gastos</p>}
                    </div>
                    <div>
                        <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Te Deben</p>
                        <p className={`text-lg sm:text-xl font-black font-mono mt-0.5 truncate ${datos.deudaFiados > 0 ? 'text-vr-orange' : 'text-vr-green'}`}>{formatDOP(datos.deudaFiados)}</p>
                        <p className="text-[10px] text-vr-gray">en fiados</p>
                    </div>
                    <div>
                        <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Por Agotarse</p>
                        <p className={`text-lg sm:text-xl font-black font-mono mt-0.5 ${datos.porAgotarse.length > 0 ? 'text-vr-red' : 'text-vr-green'}`}>{datos.porAgotarse.length}</p>
                        <p className="text-[10px] text-vr-gray">producto{datos.porAgotarse.length === 1 ? '' : 's'}</p>
                    </div>
                </div>

                <button
                    onClick={enviarWhatsApp}
                    className="w-full sm:w-auto px-5 py-2.5 bg-vr-green/15 text-vr-green font-bold rounded-xl border border-vr-green/25 hover:bg-vr-green/25 transition-all flex items-center justify-center gap-2 text-sm"
                >
                    📲 Enviar por WhatsApp
                </button>
            </div>
        </div>
    );
}
