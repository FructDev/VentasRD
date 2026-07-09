// src/components/shared/EstadoSistema.tsx
// "🩺 Estado del sistema": diagnóstico del dispositivo en una pantalla.
// Cuando un usuario reporta lentitud o problemas de sync, se le pide una
// captura de esta sección (o que toque "Copiar diagnóstico" y lo pegue por
// WhatsApp) — soporte sin scripts ni preguntas técnicas.
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { db } from '@/lib/db/dexie';
import { useConfigStore } from '@/store/useConfigStore';

interface Diagnostico {
    memoriaGB: number | null;
    usoMB: number | null;
    cuotaMB: number | null;
    productos: number;
    ventas: number;
    detalles: number;
    movimientos: number;
    pendientesSync: number;
    online: boolean;
}

export default function EstadoSistema() {
    const { negocioId, dispositivoId, aperturasSinServidor, showToast } = useConfigStore();
    const [d, setD] = useState<Diagnostico | null>(null);

    useEffect(() => {
        let vivo = true;
        (async () => {
            try {
                const nav = navigator as Navigator & { deviceMemory?: number };
                const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
                const [productos, ventas, detalles, movimientos, pendVentas, pendProd] = await Promise.all([
                    db.productos.count(), db.ventas.count(), db.venta_detalles.count(), db.movimientos_stock.count(),
                    db.ventas.where('estado_sincronizacion').equals(0).count(),
                    db.productos.where('estado_sincronizacion').equals(0).count(),
                ]);
                if (!vivo) return;
                setD({
                    memoriaGB: nav.deviceMemory ?? null,
                    usoMB: est?.usage != null ? Math.round(est.usage / 1048576) : null,
                    cuotaMB: est?.quota != null ? Math.round(est.quota / 1048576) : null,
                    productos, ventas, detalles, movimientos,
                    pendientesSync: pendVentas + pendProd,
                    online: navigator.onLine,
                });
            } catch { /* Dexie no disponible: sección vacía */ }
        })();
        return () => { vivo = false; };
    }, []);

    const filas: [string, string][] = d ? [
        ['Conexión', d.online ? '🟢 Online' : '🔴 Offline'],
        ['Memoria del equipo', d.memoriaGB != null ? `${d.memoriaGB} GB${d.memoriaGB <= 2 ? ' ⚠️ baja' : ''}` : 'No disponible'],
        ['Almacenamiento usado', d.usoMB != null && d.cuotaMB != null ? `${d.usoMB} MB de ${d.cuotaMB} MB${d.cuotaMB - d.usoMB < 200 ? ' ⚠️ casi lleno' : ''}` : 'No disponible'],
        ['Productos locales', String(d.productos)],
        ['Ventas locales', String(d.ventas)],
        ['Detalles de venta', String(d.detalles)],
        ['Movimientos de stock', String(d.movimientos)],
        ['Pendientes de sincronizar', `${d.pendientesSync}${d.pendientesSync > 20 ? ' ⚠️' : ''}`],
        ['Aperturas sin servidor', String(aperturasSinServidor)],
        ['Caja', dispositivoId || '—'],
        ['Negocio', negocioId ? `${negocioId.slice(0, 8)}…` : '—'],
    ] : [];

    const copiar = async () => {
        const texto = `🩺 Diagnóstico VentaRD\n${filas.map(([k, v]) => `${k}: ${v}`).join('\n')}\nFecha: ${new Date().toLocaleString('es-DO')}`;
        try { await navigator.clipboard.writeText(texto); showToast('Diagnóstico copiado. Pégalo en el chat de soporte.', 'success'); }
        catch { showToast('No se pudo copiar.', 'error'); }
    };

    return (
        <div className="pt-4">
            <h3 className="text-lg font-bold text-vr-gray mb-1 border-b border-navy-3 pb-2">🩺 Estado del Sistema</h3>
            <p className="text-xs text-vr-gray mb-4">
                Si algo anda lento o no sincroniza, envía este diagnóstico a soporte. ¿Dudas de uso? Visita el{' '}
                <Link href="/ayuda" className="text-gold hover:underline">Centro de Ayuda</Link>.
            </p>
            {!d ? (
                <p className="text-vr-gray text-sm">Cargando…</p>
            ) : (
                <div className="bg-navy rounded-xl border border-navy-3 p-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                        {filas.map(([k, v]) => (
                            <div key={k} className="flex items-center justify-between text-sm py-1.5 border-b border-navy-3/40">
                                <span className="text-vr-gray">{k}</span>
                                <span className="font-mono font-bold text-white text-xs">{v}</span>
                            </div>
                        ))}
                    </div>
                    <button type="button" onClick={copiar} className="mt-4 w-full py-2.5 bg-navy-3 border border-navy-3 hover:border-gold/40 text-vr-gray hover:text-gold font-bold rounded-xl text-sm transition-all">
                        📋 Copiar diagnóstico
                    </button>
                </div>
            )}
        </div>
    );
}
