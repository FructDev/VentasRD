// src/components/providers/SyncProvider.tsx
'use client';

import { useEffect } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { startSyncWorker } from '@/lib/db/worker';

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

        const workerInterval = startSyncWorker();

        // Verificamos el estado real al montar el componente
        setConnection(navigator.onLine);

        // Limpieza al desmontar (buenas prácticas)
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
            clearInterval(workerInterval);
        };
    }, [setConnection]);

    return <>{children}</>;
}