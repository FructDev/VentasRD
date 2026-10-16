import type { NextConfig } from "next";
import withPWAInit from "@ducanh2912/next-pwa";
import { withSentryConfig } from "@sentry/nextjs";

const withPWA = withPWAInit({
  dest: "public",
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  // NO recargar al volver la señal: en un POS eso borra el carrito, el formulario
  // de fiado o el conteo de efectivo que solo vive en React. El worker de sync
  // ya se pone al día en segundo plano sin tocar la pantalla.
  reloadOnOnline: false,
  disable: process.env.NODE_ENV === "development",
  fallbacks: {
    document: "/offline",
  },
  workboxOptions: {
    disableDevLogs: true,
    runtimeCaching: [
      // Assets del build: cache primero, larga vida (los nombres llevan hash)
      {
        urlPattern: /\/_next\/static\/.*/i,
        handler: "CacheFirst",
        options: {
          cacheName: "ventard-static",
          expiration: {
            maxEntries: 256,
            maxAgeSeconds: 30 * 24 * 60 * 60,
          },
        },
      },
      // TODAS las páginas de la app (documentos y payloads RSC).
      // StaleWhileRevalidate: sirve el cache AL INSTANTE (offline no espera
      // ningún timeout de red) y refresca en segundo plano cuando hay señal.
      // Lecciones del incidente offline: (1) NetworkFirst hacía esperar 3s+
      // por página en redes muertas; (2) el patrón viejo omitía historial,
      // reparaciones, gastos, reportes, configuración… que offline fallaban
      // SIEMPRE; (3) expirar en 24h dejaba la app vacía tras un día sin abrir.
      {
        urlPattern: ({ url, sameOrigin }) => sameOrigin
          && /^https?:$/.test(url.protocol)
          && /^\/($|login|registro|landing|pin|select-branch|onboarding|historial|inventario|clientes|gastos|dashboard|reportes|configuracion|admin|reparaciones|garantias|apartados|ayuda|offline)(\/.*)?$/i.test(url.pathname),
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "ventard-pages",
          expiration: {
            maxEntries: 96,
            maxAgeSeconds: 30 * 24 * 60 * 60,
          },
        },
      },
    ],
  },
});

const nextConfig: NextConfig = {
  // Identidad inmutable del bundle. El cliente la compara con /api/version
  // para detectar cajas que siguen abiertas con un deploy anterior.
  env: {
    NEXT_PUBLIC_VENTARD_BUILD_ID:
      (process.env.VERCEL_GIT_COMMIT_SHA
        || process.env.NEXT_PUBLIC_VENTARD_BUILD_ID
        || 'local').slice(0, 12),
  },
};

export default withSentryConfig(withPWA(nextConfig), {
    // Solo sube source maps al hacer build con token (deploy); en local no molesta
    authToken: process.env.SENTRY_AUTH_TOKEN,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    silent: true,
    widenClientFileUpload: true,
    disableLogger: true,
});
