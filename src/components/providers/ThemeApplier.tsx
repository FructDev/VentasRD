// src/components/providers/ThemeApplier.tsx
// Sincroniza el tema (clase 'light') y el color de marca (variables CSS) con <html>.
'use client';

import { useEffect } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { aplicarColorMarca, aplicarFuenteMarca } from '@/lib/marca';

export default function ThemeApplier() {
    const tema = useConfigStore(s => s.tema);
    const colorMarca = useConfigStore(s => s.colorMarca);
    const fuenteMarca = useConfigStore(s => s.fuenteMarca);
    useEffect(() => {
        const el = document.documentElement;
        if (tema === 'claro') el.classList.add('light');
        else el.classList.remove('light');
    }, [tema]);
    useEffect(() => {
        aplicarColorMarca(colorMarca);
    }, [colorMarca]);
    useEffect(() => {
        aplicarFuenteMarca(fuenteMarca);
    }, [fuenteMarca]);
    return null;
}
