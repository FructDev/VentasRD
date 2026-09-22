// src/components/providers/SyncProvider.tsx
'use client';

import { useEffect } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { startSyncWorker, stopSyncWorker } from '@/lib/db/worker';
import { precargarRutas } from '@/lib/precarga';

export function SyncProvider({ children }: { children: React.ReactNode }) {
    const setConnection = useConfigStore((state) => state.setConnection);
    const negocioId = useConfigStore((state) => state.negocioId);
    const rolUsuario = useConfigStore((state) => state.rolUsuario);

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

        // Pedir almacenamiento persistente: sin esto el navegador puede desalojar
        // IndexedDB bajo presión de espacio y se pierden las ventas que aún no
        // subieron. Se concede sin preguntar si la PWA está instalada o el sitio
        // tiene uso frecuente; si lo niega seguimos igual, solo sin la garantía.
        if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
            navigator.storage.persisted()
                .then(yaEsPersistente => yaEsPersistente || navigator.storage.persist())
                .catch(() => { /* no soportado: seguimos sin la garantía */ });
        }

        // Verificamos el estado real al montar el componente
        setConnection(navigator.onLine);

        // Limpieza al desmontar: el singleton garantiza que solo haya un worker activo
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
            stopSyncWorker();
        };
    }, [setConnection]);

    // Dejar la app lista para abrir sin internet mañana. Esperamos a que el
    // dispositivo tenga negocio y a que la pantalla esté ociosa: es trabajo de
    // fondo, no debe pelear con la carga inicial ni con el sync.
    useEffect(() => {
        if (!negocioId) return;
        const lanzar = () => { precargarRutas(rolUsuario).catch(() => { }); };
        // Safari no tiene requestIdleCallback: caemos a un timer holgado.
        const w = window as Window & {
            requestIdleCallback?: (cb: () => void) => number;
            cancelIdleCallback?: (id: number) => void;
        };
        const ocioso = typeof w.requestIdleCallback === 'function';
        const id = ocioso ? w.requestIdleCallback!(lanzar) : window.setTimeout(lanzar, 8000);
        return () => {
            if (ocioso) w.cancelIdleCallback?.(id);
            else clearTimeout(id);
        };
    }, [negocioId, rolUsuario]);

    return <>{children}</>;
}
