// src/lib/useCandado.ts
// Candado anti doble-submit para handlers que crean registros.
// En equipos lentos el usuario toca dos veces (o Enter + clic) y el handler
// corría dos veces completas → registros duplicados (ventas, productos...).
// El ref bloquea la segunda llamada AL INSTANTE (el estado tarda un render);
// el estado sirve para deshabilitar el botón y mostrar "Guardando…".
//
// Uso:
//   const { ocupado, conCandado } = useCandado();
//   const guardar = conCandado(async (e) => { ... });
//   <button disabled={ocupado}>{ocupado ? 'Guardando…' : 'Guardar'}</button>
'use client';

import { useRef, useState, useCallback } from 'react';

export function useCandado() {
    const ref = useRef(false);
    const [ocupado, setOcupado] = useState(false);

    const conCandado = useCallback(<A extends unknown[]>(fn: (...args: A) => Promise<void> | void) => {
        return async (...args: A) => {
            if (ref.current) return;
            ref.current = true;
            setOcupado(true);
            try {
                await fn(...args);
            } finally {
                ref.current = false;
                setOcupado(false);
            }
        };
    }, []);

    return { ocupado, conCandado };
}
