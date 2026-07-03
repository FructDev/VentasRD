// src/app/layout.tsx
import type { Metadata, Viewport } from "next";
import { Syne, DM_Sans, DM_Mono, Poppins, Montserrat, Space_Grotesk, Sora, Outfit, Playfair_Display } from "next/font/google";
import "./globals.css";
import { SyncProvider } from "@/components/providers/SyncProvider";
import { AuthProvider } from "@/components/providers/AuthProvider";
import GlobalToast from "@/components/ui/GlobalToast";
import TutorialChecklist from "@/components/ui/TutorialChecklist";
import Novedades from "@/components/ui/Novedades";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import ThemeApplier from "@/components/providers/ThemeApplier";

// Aplica el tema y el color de marca guardados ANTES de pintar (evita parpadeo)
const themeInitScript = `(function(){try{
  var P={dorado:['#D4A017','#EFC84A'],ambar:['#F59E0B','#FBBF24'],naranja:['#FB923C','#FDBA74'],coral:['#FB7185','#FDA4AF'],rosa:['#F472B6','#F9A8D4'],lima:['#84CC16','#A3E635'],esmeralda:['#34D399','#6EE7B7'],turquesa:['#2DD4BF','#5EEAD6'],cielo:['#38BDF8','#7DD3FC']};
  var c=localStorage.getItem('ventard-config');if(!c)return;var s=JSON.parse(c).state||{};var el=document.documentElement;
  if(s.tema==='claro')el.classList.add('light');
  var p=P[s.colorMarca]||P.dorado;el.style.setProperty('--color-gold',p[0]);el.style.setProperty('--color-gold-2',p[1]);
  var F={syne:'--font-syne',poppins:'--font-poppins',montserrat:'--font-montserrat',spacegro:'--font-space-grotesk',sora:'--font-sora',outfit:'--font-outfit',playfair:'--font-playfair'};
  var fv=F[s.fuenteMarca]||F.syne;el.style.setProperty('--font-display','var('+fv+')');
}catch(e){}})();`;

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

// Fuentes de marca opcionales (personalización por tienda)
const poppins = Poppins({ subsets: ["latin"], variable: "--font-poppins", display: "swap", weight: ["600", "700", "800"] });
const montserrat = Montserrat({ subsets: ["latin"], variable: "--font-montserrat", display: "swap", weight: ["600", "700", "800"] });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap", weight: ["500", "600", "700"] });
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", display: "swap", weight: ["600", "700", "800"] });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit", display: "swap", weight: ["600", "700", "800"] });
const playfair = Playfair_Display({ subsets: ["latin"], variable: "--font-playfair", display: "swap", weight: ["600", "700", "800"] });

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
    <html lang="es" className={`${syne.variable} ${dmSans.variable} ${dmMono.variable} ${poppins.variable} ${montserrat.variable} ${spaceGrotesk.variable} ${sora.variable} ${outfit.variable} ${playfair.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="font-body antialiased">
        <ErrorBoundary>
          <SyncProvider>
            <AuthProvider>
              <ThemeApplier />
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