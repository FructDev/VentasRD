// src/instrumentation-client.ts
// Sentry en el navegador — errores de UI, sync worker e impresión.
// Solo se activa si NEXT_PUBLIC_SENTRY_DSN está definido.
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        tracesSampleRate: 0.1,

        // No enviar datos personales de clientes finales
        sendDefaultPii: false,

        // Ignorar ruido conocido: errores de red cuando el POS está offline
        // (es el estado normal de la app, no un bug)
        ignoreErrors: [
            'Failed to fetch',
            'NetworkError',
            'Load failed',
            'sync_timeout',
            'The network connection was lost',
        ],

        beforeSend(event) {
            // Etiquetar si el dispositivo estaba offline al momento del error
            event.tags = { ...event.tags, online: String(navigator.onLine) };
            return event;
        },
    });
}

// Hook de navegación del App Router (requerido por @sentry/nextjs)
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
