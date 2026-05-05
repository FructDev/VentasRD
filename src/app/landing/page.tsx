'use client';

import Link from 'next/link';
import { ShoppingCart, WifiOff, MessageCircle, BarChart2, Package, ChevronRight, Check } from 'lucide-react';

const PRODUCTOS_DEMO = [
    { nombre: 'Arroz 5lb', precio: '250' },
    { nombre: 'Aceite 1L', precio: '195' },
    { nombre: 'Leche', precio: '120' },
    { nombre: 'Coca-Cola', precio: '85' },
    { nombre: 'Pollo lb', precio: '145' },
    { nombre: 'Jabón', precio: '65' },
];

export default function LandingPage() {
    return (
        <div className="min-h-screen bg-navy text-white selection:bg-gold selection:text-navy overflow-x-hidden">

            {/* ── NAV ── */}
            <nav className="border-b border-white/5 sticky top-0 z-50 bg-navy/90 backdrop-blur-md">
                <div className="max-w-6xl mx-auto px-5 h-14 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div className="w-7 h-7 bg-gold rounded-md flex items-center justify-center">
                            <ShoppingCart className="w-3.5 h-3.5 text-navy" strokeWidth={2.5} />
                        </div>
                        <span className="font-bold text-base tracking-tight text-white">VentaRD</span>
                    </div>
                    <div className="flex items-center gap-5">
                        <Link href="/login" className="text-sm text-vr-gray hover:text-white transition-colors hidden sm:block">
                            Iniciar sesión
                        </Link>
                        <Link
                            href="/registro"
                            className="text-sm bg-gold text-navy px-4 py-2 rounded-lg font-bold hover:bg-gold/90 transition-colors"
                        >
                            Empezar gratis
                        </Link>
                    </div>
                </div>
            </nav>

            {/* ── HERO ── */}
            <section className="max-w-6xl mx-auto px-5 pt-14 pb-10 md:pt-20 md:pb-16">
                <div className="grid md:grid-cols-2 gap-10 items-center">

                    {/* Texto */}
                    <div>
                        <p className="text-xs font-semibold text-gold tracking-widest uppercase mb-5">
                            Hecho en República Dominicana
                        </p>
                        <h1 className="text-3xl sm:text-4xl md:text-4xl lg:text-5xl font-bold leading-tight tracking-tight mb-4 text-white">
                            El POS que sigue<br />
                            funcionando aunque<br />
                            <span className="text-gold">se vaya la luz.</span>
                        </h1>
                        <p className="text-vr-gray text-base leading-relaxed mb-8 max-w-md">
                            VentaRD guarda todo en el dispositivo. Cobras, registras fiados
                            y cuadras caja aunque no haya internet. Cuando vuelve la señal, sincroniza solo.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-3">
                            <Link
                                href="/registro"
                                className="inline-flex items-center justify-center gap-2 bg-gold text-navy px-5 py-3 rounded-lg font-bold text-sm hover:bg-gold/90 transition-colors"
                            >
                                Crear cuenta gratis
                                <ChevronRight className="w-4 h-4" strokeWidth={2.5} />
                            </Link>
                            <Link
                                href="/login"
                                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg border border-white/10 hover:border-white/20 text-white font-medium text-sm transition-colors"
                            >
                                Ya tengo cuenta
                            </Link>
                        </div>

                        {/* Trust line */}
                        <p className="text-xs text-vr-gray mt-6">
                            Sin tarjeta. Sin contrato. Sin técnicos.
                        </p>
                    </div>

                    {/* Mockup POS */}
                    <div className="rounded-xl border border-white/8 bg-navy-2 overflow-hidden shadow-2xl">
                        {/* Barra del browser */}
                        <div className="h-9 bg-navy border-b border-white/5 flex items-center px-3 gap-2">
                            <div className="flex gap-1.5">
                                <div className="w-2.5 h-2.5 rounded-full bg-white/10" />
                                <div className="w-2.5 h-2.5 rounded-full bg-white/10" />
                                <div className="w-2.5 h-2.5 rounded-full bg-white/10" />
                            </div>
                            <div className="flex-1 h-5 bg-white/5 rounded mx-2 flex items-center px-2">
                                <span className="text-[10px] text-vr-gray">ventard.app</span>
                            </div>
                            <div className="flex items-center gap-1 text-[10px] text-gold font-medium">
                                <WifiOff className="w-2.5 h-2.5" />
                                <span>Offline</span>
                            </div>
                        </div>

                        {/* POS interface */}
                        <div className="flex" style={{ height: 260 }}>
                            {/* Productos */}
                            <div className="flex-1 p-3 border-r border-white/5 overflow-hidden">
                                <div className="h-7 bg-white/5 rounded-md mb-3 border border-white/8" />
                                <div className="grid grid-cols-3 gap-1.5">
                                    {PRODUCTOS_DEMO.map((p, i) => (
                                        <div
                                            key={p.nombre}
                                            className={`border rounded-lg p-2 flex flex-col gap-1 ${i === 1 ? 'border-gold/50 bg-gold/8' : 'border-white/8 bg-white/3'}`}
                                        >
                                            <div className="w-5 h-5 bg-white/5 rounded" />
                                            <div className="text-[9px] text-vr-gray truncate leading-none">{p.nombre}</div>
                                            <div className="text-[9px] font-bold text-gold leading-none">RD${p.precio}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Carrito */}
                            <div className="w-36 p-3 flex flex-col gap-2 bg-navy">
                                <div className="text-[9px] font-bold text-vr-gray uppercase tracking-wider">Carrito</div>
                                <div className="space-y-1.5 flex-1">
                                    {[
                                        { n: 'Arroz 5lb', p: '$250' },
                                        { n: 'Aceite 1L', p: '$195' },
                                        { n: 'Leche', p: '$120' },
                                    ].map(item => (
                                        <div key={item.n} className="flex justify-between items-center bg-white/3 border border-white/5 rounded px-1.5 py-1">
                                            <span className="text-[9px] text-white truncate">{item.n}</span>
                                            <span className="text-[9px] text-gold font-bold ml-1 flex-shrink-0">{item.p}</span>
                                        </div>
                                    ))}
                                </div>
                                <div className="border-t border-white/8 pt-2 space-y-1">
                                    <div className="flex justify-between text-[9px] text-vr-gray">
                                        <span>ITBIS</span><span>RD$64</span>
                                    </div>
                                    <div className="flex justify-between text-[10px] font-bold">
                                        <span>Total</span>
                                        <span className="text-gold">RD$629</span>
                                    </div>
                                    <div className="w-full bg-gold text-navy text-[9px] font-black py-1.5 rounded text-center mt-1">
                                        COBRAR
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ── DIVIDER OFFLINE ── */}
            <div className="border-t border-white/5 bg-navy-2">
                <div className="max-w-6xl mx-auto px-5 py-5 flex flex-wrap items-center gap-6">
                    <div className="flex items-center gap-2 text-sm text-vr-gray">
                        <div className="w-1.5 h-1.5 rounded-full bg-vr-green" />
                        Con internet: sincroniza en tiempo real
                    </div>
                    <div className="flex items-center gap-2 text-sm text-vr-gray">
                        <div className="w-1.5 h-1.5 rounded-full bg-gold" />
                        Sin internet: sigue vendiendo sin parar
                    </div>
                    <div className="flex items-center gap-2 text-sm text-vr-gray">
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                        Fiados por WhatsApp en un toque
                    </div>
                </div>
            </div>

            {/* ── PROBLEMAS / SOLUCIONES ── */}
            <section className="max-w-6xl mx-auto px-5 py-16 md:py-20">
                <div className="max-w-xl mb-12">
                    <h2 className="text-2xl md:text-3xl font-bold text-white mb-3 leading-snug">
                        Los mismos problemas de siempre.<br />Por fin resueltos.
                    </h2>
                    <p className="text-vr-gray text-base">
                        VentaRD nació de hablar con dueños de colmados, tiendas y restaurantes en RD.
                    </p>
                </div>

                <div className="space-y-px rounded-xl overflow-hidden border border-white/5">
                    {[
                        {
                            icon: WifiOff,
                            iconColor: 'text-gold',
                            iconBg: 'bg-gold/10',
                            problema: 'Se va la luz o el internet y la caja se congela',
                            solucion: 'VentaRD vive en el dispositivo. Funciona sin internet, sin servidor, sin nada. Cuando vuelve la señal, sincroniza solo. No se pierde ninguna venta.',
                        },
                        {
                            icon: MessageCircle,
                            iconColor: 'text-blue-400',
                            iconBg: 'bg-blue-500/10',
                            problema: 'Los fiados en una libreta que nadie entiende',
                            solucion: 'Registra el crédito en segundos. El sistema lleva el saldo de cada cliente y le envía el estado de cuenta por WhatsApp con un toque.',
                        },
                        {
                            icon: BarChart2,
                            iconColor: 'text-vr-green',
                            iconBg: 'bg-vr-green/10',
                            problema: 'No sabes lo que vendiste hasta medianoche',
                            solucion: 'El dashboard se actualiza venta a venta. Ventas del día, ganancia bruta, método de pago — visible en tiempo real desde cualquier dispositivo.',
                        },
                        {
                            icon: Package,
                            iconColor: 'text-vr-orange',
                            iconBg: 'bg-vr-orange/10',
                            problema: 'Capacitar un cajero nuevo te toma horas',
                            solucion: 'Busca, toca, cobra. Tres pasos. Sin manuales, sin entrenamientos. La mayoría de cajeros están vendiendo en su primera venta.',
                        },
                    ].map((item, i) => (
                        <div key={i} className="bg-navy-2 p-6 md:p-8 flex gap-5 items-start hover:bg-navy-3/50 transition-colors">
                            <div className={`w-9 h-9 ${item.iconBg} rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5`}>
                                <item.icon className={`w-4 h-4 ${item.iconColor}`} />
                            </div>
                            <div className="min-w-0">
                                <p className="text-vr-gray text-sm line-through decoration-vr-gray/40 mb-1.5">
                                    {item.problema}
                                </p>
                                <p className="text-white text-sm leading-relaxed">
                                    {item.solucion}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {/* ── PARA QUÉ NEGOCIOS ── */}
            <section className="border-t border-white/5 bg-navy-2">
                <div className="max-w-6xl mx-auto px-5 py-12 md:py-16">
                    <p className="text-xs font-semibold text-vr-gray uppercase tracking-widest mb-4">
                        Para cualquier negocio
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {['Colmado', 'Cafetería', 'Picapollo', 'Farmacia', 'Ferretería', 'Tienda de ropa', 'Salón de belleza', 'Lavandería', 'Restaurante', 'Supermercado', 'El tuyo'].map((tipo) => (
                            <span
                                key={tipo}
                                className={`px-3 py-1.5 border rounded-full text-sm transition-colors ${tipo === 'El tuyo' ? 'border-gold/40 text-gold bg-gold/5' : 'border-white/8 text-vr-gray hover:border-white/20 hover:text-white'}`}
                            >
                                {tipo}
                            </span>
                        ))}
                    </div>
                </div>
            </section>

            {/* ── FUNCIONA EN TODO ── */}
            <section className="max-w-6xl mx-auto px-5 py-16 md:py-20">
                <div className="grid md:grid-cols-2 gap-10 items-start">
                    <div>
                        <h2 className="text-2xl md:text-3xl font-bold text-white mb-4 leading-snug">
                            PC, tablet o celular.<br />Sin instalar nada.
                        </h2>
                        <p className="text-vr-gray text-base leading-relaxed mb-6">
                            VentaRD es una app web. Funciona en cualquier browser y se puede instalar
                            en el dispositivo como si fuera una app nativa. Sin App Store, sin Google Play.
                        </p>
                        <p className="text-vr-gray text-base leading-relaxed">
                            Abre el browser, entra a la URL y ya estás vendiendo.
                        </p>
                    </div>
                    <div className="divide-y divide-white/5 border border-white/8 rounded-xl overflow-hidden">
                        {[
                            { device: 'Computadora', note: 'Con atajos de teclado para cajeros rápidos' },
                            { device: 'Tablet', note: 'Ideal para el mostrador — pantalla grande, táctil' },
                            { device: 'Celular', note: 'Para vender desde cualquier lugar' },
                            { device: 'Sin internet', note: 'Este es el punto — sigue funcionando igual' },
                        ].map((row) => (
                            <div key={row.device} className="flex items-center gap-4 px-5 py-4 bg-navy-2">
                                <div className="w-5 h-5 rounded-full bg-vr-green/15 border border-vr-green/30 flex items-center justify-center flex-shrink-0">
                                    <Check className="w-3 h-3 text-vr-green" strokeWidth={3} />
                                </div>
                                <div>
                                    <div className="text-white text-sm font-medium">{row.device}</div>
                                    <div className="text-vr-gray text-xs mt-0.5">{row.note}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ── CTA FINAL ── */}
            <section className="border-t border-white/5 bg-navy-2">
                <div className="max-w-6xl mx-auto px-5 py-16 md:py-20">
                    <div className="max-w-lg">
                        <h2 className="text-2xl md:text-3xl font-bold text-white mb-3 leading-snug">
                            Empieza gratis.<br />Sin tarjeta, sin contratos.
                        </h2>
                        <p className="text-vr-gray text-base leading-relaxed mb-2">
                            Crea tu cuenta, sube tus productos y empieza a vender hoy.
                            Cuando termine el período de prueba, hablamos por WhatsApp y te activamos.
                        </p>
                        <p className="text-vr-gray text-sm mb-8">
                            Sin cobros automáticos. Sin sorpresas.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-3">
                            <Link
                                href="/registro"
                                className="inline-flex items-center justify-center gap-2 bg-gold text-navy px-5 py-3 rounded-lg font-bold text-sm hover:bg-gold/90 transition-colors"
                            >
                                Crear mi cuenta gratis
                                <ChevronRight className="w-4 h-4" strokeWidth={2.5} />
                            </Link>
                            <a
                                href="https://wa.me/18091234567?text=Hola%2C%20quiero%20saber%20m%C3%A1s%20sobre%20VentaRD"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg border border-white/10 hover:border-white/20 text-white font-medium text-sm transition-colors"
                            >
                                <MessageCircle className="w-4 h-4" />
                                Preguntar por WhatsApp
                            </a>
                        </div>
                    </div>
                </div>
            </section>

            {/* ── FOOTER ── */}
            <footer className="border-t border-white/5">
                <div className="max-w-6xl mx-auto px-5 py-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div className="flex items-center gap-2">
                        <div className="w-6 h-6 bg-gold rounded flex items-center justify-center">
                            <ShoppingCart className="w-3 h-3 text-navy" strokeWidth={2.5} />
                        </div>
                        <span className="font-bold text-sm text-white">VentaRD</span>
                    </div>
                    <div className="flex gap-5 text-sm text-vr-gray">
                        <Link href="/login" className="hover:text-white transition-colors">Iniciar sesión</Link>
                        <Link href="/registro" className="hover:text-white transition-colors">Crear cuenta</Link>
                    </div>
                    <p className="text-vr-gray text-xs">
                        © {new Date().getFullYear()} VentaRD
                    </p>
                </div>
            </footer>
        </div>
    );
}
