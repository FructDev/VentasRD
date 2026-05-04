// src/components/shared/OfflineBanner.tsx
'use client';

import { useConfigStore } from '@/store/useConfigStore';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db/dexie';

export default function OfflineBanner() {
    const { isOnline } = useConfigStore();

    const ventasPendientes = useLiveQuery(
        () => db.ventas.where('estado_sincronizacion').equals(0).count(),
        []
    ) ?? 0;

    const productosPendientes = useLiveQuery(
        () => db.productos.where('estado_sincronizacion').equals(0).count(),
        []
    ) ?? 0;

    const clientesPendientes = useLiveQuery(
        () => db.clientes.where('estado_sincronizacion').equals(0).count(),
        []
    ) ?? 0;

    const cajasPendientes = useLiveQuery(
        () => db.cajas.filter(c => (c.estado_sincronizacion ?? 0) === 0).count(),
        []
    ) ?? 0;

    if (isOnline) return null;

    const totalPendiente = ventasPendientes + productosPendientes + clientesPendientes + cajasPendientes;

    const partes: string[] = [];
    if (ventasPendientes > 0) partes.push(`${ventasPendientes} venta${ventasPendientes !== 1 ? 's' : ''}`);
    if (productosPendientes > 0) partes.push(`${productosPendientes} producto${productosPendientes !== 1 ? 's' : ''}`);
    if (clientesPendientes > 0) partes.push(`${clientesPendientes} cliente${clientesPendientes !== 1 ? 's' : ''}`);
    if (cajasPendientes > 0) partes.push(`${cajasPendientes} caja${cajasPendientes !== 1 ? 's' : ''}`);

    return (
        <div className="bg-vr-red/10 border-b border-vr-red/20 px-4 py-2 flex items-center justify-center gap-3 animate-slide-down flex-wrap">
            <div className="w-2 h-2 rounded-full bg-vr-red animate-pulse flex-shrink-0" />
            <span className="text-sm font-bold text-vr-red">
                Sin conexión a internet
            </span>
            {totalPendiente > 0 && (
                <span className="text-xs text-vr-red/70 font-medium">
                    • Pendiente de sync: {partes.join(', ')}
                </span>
            )}
            <span className="text-xs text-vr-gray">
                Puedes seguir vendiendo normalmente
            </span>
        </div>
    );
}
