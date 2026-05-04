'use client';

import { useEffect, useState } from 'react';

export default function OfflinePage() {
    const [intentando, setIntentando] = useState(false);

    useEffect(() => {
        // Si vuelve la conexión, redirigir automáticamente
        const handleOnline = () => {
            window.location.href = '/';
        };
        window.addEventListener('online', handleOnline);
        return () => window.removeEventListener('online', handleOnline);
    }, []);

    const reintentar = () => {
        setIntentando(true);
        if (navigator.onLine) {
            window.location.href = '/';
        } else {
            setTimeout(() => setIntentando(false), 1500);
        }
    };

    return (
        <div style={{
            minHeight: '100vh',
            background: '#0D1B2E',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'sans-serif',
            textAlign: 'center',
            padding: 24,
        }}>
            {/* Logo */}
            <div style={{
                width: 72, height: 72,
                background: '#D4A017',
                borderRadius: 18,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 32,
                marginBottom: 24,
            }}>
                📴
            </div>

            <h1 style={{ color: '#FFFFFF', fontSize: 28, fontWeight: 800, marginBottom: 8 }}>
                VentaRD
            </h1>
            <p style={{ color: '#D4A017', fontSize: 16, fontWeight: 600, marginBottom: 16 }}>
                Sin conexión
            </p>
            <p style={{ color: '#8899AA', fontSize: 15, maxWidth: 300, lineHeight: 1.6, marginBottom: 32 }}>
                No hay internet en este momento. Cuando vuelva la señal,
                VentaRD se reconecta automáticamente.
            </p>

            <button
                onClick={reintentar}
                disabled={intentando}
                style={{
                    background: intentando ? '#1E3352' : '#D4A017',
                    color: intentando ? '#8899AA' : '#0D1B2E',
                    border: 'none',
                    borderRadius: 12,
                    padding: '14px 32px',
                    fontSize: 15,
                    fontWeight: 700,
                    cursor: intentando ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s',
                }}
            >
                {intentando ? 'Verificando...' : 'Reintentar conexión'}
            </button>
        </div>
    );
}