// src/instrumentation.ts
// Next.js carga esto al arrancar el servidor — inicializa Sentry según el runtime.
import * as Sentry from '@sentry/nextjs';

export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        await import('../sentry.server.config');
    }
    if (process.env.NEXT_RUNTIME === 'edge') {
        await import('../sentry.edge.config');
    }
}

// Captura errores de las API routes y render de servidor
export const onRequestError = Sentry.captureRequestError;
