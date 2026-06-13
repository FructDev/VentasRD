// src/app/layout.tsx
import type { Metadata, Viewport } from "next";
import { Syne, DM_Sans, DM_Mono } from "next/font/google";
import "./globals.css";
import { SyncProvider } from "@/components/providers/SyncProvider";
import { AuthProvider } from "@/components/providers/AuthProvider";
import GlobalToast from "@/components/ui/GlobalToast";
import TutorialChecklist from "@/components/ui/TutorialChecklist";
import Novedades from "@/components/ui/Novedades";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

const syne = Syne({
  subsets: ["latin"],
  variable: "--font-syne",
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  variable: "--font-dm-mono",
  display: "swap",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "VentaRD — POS Offline First",
  description: "El punto de venta sin fricción para negocios dominicanos.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192x192.png",  sizes: "192x192", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#0D1B2E",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={`${syne.variable} ${dmSans.variable} ${dmMono.variable}`}>
      <body className="font-body antialiased">
        <ErrorBoundary>
          <SyncProvider>
            <AuthProvider>
              {children}
              <GlobalToast />
              <TutorialChecklist />
              <Novedades />
            </AuthProvider>
          </SyncProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}