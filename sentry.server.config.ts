// Sentry — lado servidor (API routes, SSR)
// Solo se activa si NEXT_PUBLIC_SENTRY_DSN está definido en .env.local
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        tracesSampleRate: 0.1, // 10% de las transacciones (suficiente y barato)
        enableLogs: false,
    });
}
