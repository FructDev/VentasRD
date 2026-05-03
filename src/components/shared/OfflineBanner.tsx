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
    ) || 0;

    if (isOnline) return null;

    return (
        <div className="bg-vr-red/10 border-b border-vr-red/20 px-4 py-2 flex items-center justify-center gap-3 animate-slide-down">
            <div className="w-2 h-2 rounded-full bg-vr-red animate-pulse" />
            <span className="text-sm font-bold text-vr-red">
                Sin conexión a internet
            </span>
            {ventasPendientes > 0 && (
                <span className="text-xs text-vr-red/70 font-medium">
                    • {ventasPendientes} venta{ventasPendientes > 1 ? 's' : ''} esperando sincronización
                </span>
            )}
            <span className="text-xs text-vr-gray ml-2">
                Puedes seguir vendiendo normalmente
            </span>
        </div>
    );
}
