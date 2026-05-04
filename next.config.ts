import type { NextConfig } from "next";
import withPWAInit from "@ducanh2912/next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  reloadOnOnline: true,
  // Eliminamos swcMinify de aquí
  disable: process.env.NODE_ENV === "development",
  fallbacks: {
    // Si falla la red al abrir la PWA, inyectar directamente la raíz (el POS)
    document: "/",
  },
  workboxOptions: {
    disableDevLogs: true,
  },
});

const nextConfig: NextConfig = {
  // turbopack: {},
  /* config options here */
};

export default withPWA(nextConfig);
