// src/components/providers/ThemeApplier.tsx
// Sincroniza la preferencia de tema (store) con la clase 'light' en <html>.
'use client';

import { useEffect } from 'react';
import { useConfigStore } from '@/store/useConfigStore';

export default function ThemeApplier() {
    const tema = useConfigStore(s => s.tema);
    useEffect(() => {
        const el = document.documentElement;
        if (tema === 'claro') el.classList.add('light');
        else el.classList.remove('light');
    }, [tema]);
    return null;
}
