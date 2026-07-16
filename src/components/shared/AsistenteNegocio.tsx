// src/components/shared/AsistenteNegocio.tsx
// Tarjeta "🧠 Tu día" del Dashboard: insights del negocio generados por el
// motor de reglas local (src/lib/asistente.ts). Funciona offline y se puede
// compartir por WhatsApp con un toque.
'use client';

import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db/dexie';
import { useConfigStore } from '@/store/useConfigStore';
import { generarInsights, insightsParaWhatsApp } from '@/lib/asistente';
import { linkWhatsApp } from '@/lib/whatsapp';

const DIA = 24 * 60 * 60 * 1000;

export default function AsistenteNegocio() {
    const { negocioId, negocioNombre } = useConfigStore();

    // Datos de los últimos 28 días (usa el índice [negocio_id+fecha_creacion])
    const datos = useLiveQuery(async () => {
        if (!negocioId) return null;
        const ahora = Date.now();
        const desde = ahora - 28 * DIA;

        const ventas = await db.ventas
            .where('[negocio_id+fecha_creacion]').between([negocioId, desde], [negocioId, ahora])
            .toArray();
        const idsVentas = new Set(ventas.map(v => v.id));
        const detalles = (await db.venta_detalles.where('negocio_id').equals(negocioId).toArray())
            .filter(d => idsVentas.has(d.venta_id));
        const [productos, clientes, transacciones] = await Promise.all([
            db.productos.where('negocio_id').equals(negocioId).toArray(),
            db.clientes.where('negocio_id').equals(negocioId).toArray(),
            db.transacciones_fiado.where('negocio_id').equals(negocioId).toArray(),
        ]);

        return {
            ventas: ventas.map(v => ({ total: v.total, fecha_creacion: v.fecha_creacion })),
            detalles: detalles.map(d => ({ producto_id: d.producto_id, cantidad: d.cantidad, fecha_creacion: d.fecha_creacion, precio_unitario: d.precio_unitario })),
            productos: productos.map(p => ({ id: p.id, nombre: p.nombre, stock_actual: p.stock_actual, tipo: p.tipo, eliminado: p.eliminado, costo: p.costo })),
            clientes: clientes.map(c => ({ id: c.id, nombre: c.nombre })),
            transacciones: transacciones.map(t => ({ cliente_id: t.cliente_id, tipo: t.tipo, monto: t.monto, fecha_creacion: t.fecha_creacion })),
            ahora,
        };
    }, [negocioId]);

    const insights = useMemo(() => (datos ? generarInsights(datos) : []), [datos]);

    if (!datos || insights.length === 0) return null; // sin datos suficientes: cero ruido

    const compartir = () => {
        const texto = insightsParaWhatsApp(insights, negocioNombre || 'Mi Negocio', datos.ahora);
        window.open(linkWhatsApp(texto), '_blank');
    };

    return (
        <div className="bg-navy-2 rounded-2xl border border-gold/25 p-4 sm:p-5 mb-6 glow-gold">
            <div className="flex items-center justify-between mb-3">
                <h2 className="font-display font-black text-white text-base sm:text-lg">🧠 Tu día</h2>
                <button
                    onClick={compartir}
                    className="px-3 py-1.5 bg-vr-green/15 text-vr-green border border-vr-green/20 rounded-lg text-xs font-bold hover:bg-vr-green/25 transition-all"
                >
                    📱 Enviar a WhatsApp
                </button>
            </div>
            <div className="space-y-2.5">
                {insights.slice(0, 5).map((ins, i) => (
                    <div key={i} className="flex items-start gap-2.5 bg-navy rounded-xl border border-navy-3 px-3.5 py-2.5">
                        <span className="text-lg shrink-0">{ins.emoji}</span>
                        <p className="text-sm text-white leading-relaxed">{ins.texto}</p>
                    </div>
                ))}
            </div>
        </div>
    );
}
