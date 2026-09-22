'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { registrarMetrica } from '@/lib/rendimiento';

// Mide navegación percibida entre módulos y tareas largas del navegador.
// Es observación local únicamente; no modifica el enrutamiento.
export function RendimientoProvider({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const inicioNavegacion = useRef<{ ruta: string; inicio: number } | null>(null);

    useEffect(() => {
        const capturarInicio = (event: MouseEvent) => {
            const objetivo = event.target as Element | null;
            const enlace = objetivo?.closest('a[href]') as HTMLAnchorElement | null;
            if (!enlace || enlace.origin !== window.location.origin) return;
            // Un clic en la ruta actual no es una navegación. Antes dejaba el
            // cronómetro abierto y lo atribuía erróneamente al próximo cambio.
            if (enlace.pathname === window.location.pathname) return;
            inicioNavegacion.current = { ruta: enlace.pathname, inicio: performance.now() };
        };
        document.addEventListener('click', capturarInicio, true);
        return () => document.removeEventListener('click', capturarInicio, true);
    }, []);

    useEffect(() => {
        const pendiente = inicioNavegacion.current;
        if (!pendiente) return;
        if (pendiente.ruta !== pathname) {
            inicioNavegacion.current = null;
            return;
        }
        const id = requestAnimationFrame(() => requestAnimationFrame(() => {
            registrarMetrica('navegacion.modulo', performance.now() - pendiente.inicio, 'ok', {
                ruta: pathname,
            });
            inicioNavegacion.current = null;
        }));
        return () => cancelAnimationFrame(id);
    }, [pathname]);

    useEffect(() => {
        if (typeof PerformanceObserver === 'undefined') return;
        let observer: PerformanceObserver | null = null;
        try {
            observer = new PerformanceObserver(lista => {
                for (const entrada of lista.getEntries()) {
                    registrarMetrica('ui.tarea_larga', entrada.duration, 'ok');
                }
            });
            observer.observe({ type: 'longtask', buffered: true });
        } catch { /* navegador sin Long Tasks API */ }
        return () => observer?.disconnect();
    }, []);

    return <>{children}</>;
}
