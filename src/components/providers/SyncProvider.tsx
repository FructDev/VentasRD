// src/components/providers/SyncProvider.tsx
'use client';

import { useEffect } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { startSyncWorker, stopSyncWorker } from '@/lib/db/worker';

export function SyncProvider({ children }: { children: React.ReactNode }) {
    const setConnection = useConfigStore((state) => state.setConnection);

    useEffect(() => {
        // Definimos las funciones que actualizan el estado global
        const handleOnline = () => {
            console.log("🟢 Conexión recuperada. Listo para sincronizar.");
            setConnection(true);
        };

        const handleOffline = () => {
            console.log("🔴 Conexión perdida. Cambiando a modo Offline-First.");
            setConnection(false);
        };

        // Le decimos al navegador que nos avise de los cambios
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        startSyncWorker();

        // Verificamos el estado real al montar el componente
        setConnection(navigator.onLine);

        // Limpieza al desmontar: el singleton garantiza que solo haya un worker activo
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
            stopSyncWorker();
        };
    }, [setConnection]);

    return <>{children}</>;
}