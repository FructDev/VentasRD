// src/app/landing/page.tsx
'use client';

import Link from 'next/link';
import { ShoppingCart, WifiOff, MessageCircle, BarChart2, Package, ChevronRight } from 'lucide-react';

export default function LandingPage() {
    return (
        <div className="min-h-screen bg-navy text-white selection:bg-gold selection:text-navy">

            {/* ── NAV ── */}
            <nav className="border-b border-white/5 sticky top-0 z-50 bg-navy/80 backdrop-blur-md">
                <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 bg-gold rounded-lg flex items-center justify-center">
                            <ShoppingCart className="w-4 h-4 text-navy" />
                        </div>
                        <span className="font-display font-extrabold text-lg tracking-tight">VentaRD</span>
                    </div>
                    <div className="flex items-center gap-6">
                        <Link href="/login" className="text-sm text-vr-gray hover:text-white transition-colors font-medium">
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
            <section className="max-w-6xl mx-auto px-6 pt-20 pb-16 md:pt-28 md:pb-24">
                <div className="max-w-3xl">
                    <div className="inline-flex items-center gap-2 text-xs font-bold text-gold bg-gold/10 border border-gold/20 px-3 py-1.5 rounded-full mb-8">
                        <span className="w-1.5 h-1.5 rounded-full bg-gold" />
                        Hecho en República Dominicana
                    </div>

                    <h1 className="font-display font-black text-5xl md:text-6xl lg:text-7xl leading-[1.05] tracking-tight mb-6">
                        El POS que no se cae<br />
                        <span className="text-gold">cuando se va la luz.</span>
                    </h1>

                    <p className="text-vr-gray text-lg md:text-xl leading-relaxed max-w-xl mb-10">
                        VentaRD guarda todo en el dispositivo. Vendes, registras fiados y cuadras caja
                        aunque no haya internet. Cuando vuelve la señal, sincroniza solo.
                    </p>

                    <div className="flex flex-col sm:flex-row gap-3">
                        <Link
                            href="/registro"
                            className="inline-flex items-center justify-center gap-2 bg-gold text-navy px-6 py-3.5 rounded-xl font-extrabold text-base hover:bg-gold/90 transition-colors"
                        >
                            Crear cuenta gratis
                            <ChevronRight className="w-4 h-4" />
                        </Link>
                        <Link
                            href="/login"
                            className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl border border-white/10 hover:border-white/20 text-white font-bold text-base transition-colors"
                        >
                            Ya tengo cuenta
                        </Link>
                    </div>
                </div>
            </section>

            {/* ── MOCKUP FULL WIDTH ── */}
            <section className="border-t border-white/5 bg-navy-2">
                <div className="max-w-6xl mx-auto px-6 py-16">
                    <div className="rounded-2xl border border-white/8 bg-navy overflow-hidden shadow-2xl">
                        {/* Barra superior del mockup */}
                        <div className="h-10 bg-navy-2 border-b border-white/5 flex items-center px-4 gap-2">
                            <div className="flex gap-1.5">
                                <div className="w-3 h-3 rounded-full bg-white/10" />
                                <div className="w-3 h-3 rounded-full bg-white/10" />
                                <div className="w-3 h-3 rounded-full bg-white/10" />
                            </div>
                            <div className="ml-3 flex items-center gap-2">
                                <ShoppingCart className="w-3.5 h-3.5 text-gold" />
                                <span className="text-xs text-vr-gray font-medium">VentaRD — Punto de Ventas</span>
                            </div>
                            <div className="ml-auto flex items-center gap-1.5 text-xs text-vr-green font-semibold">
                                <WifiOff className="w-3 h-3 text-gold" />
                                <span className="text-gold">Sin internet — vendiendo normal</span>
                            </div>
                        </div>
                        {/* POS layout */}
                        <div className="flex" style={{ minHeight: 320 }}>
                            <div className="flex-1 p-5 border-r border-white/5">
                                <div className="flex items-center gap-2 mb-4">
                                    <div className="flex-1 h-9 bg-navy-2 border border-white/8 rounded-lg" />
                                    <div className="h-9 w-9 bg-navy-2 border border-white/8 rounded-lg" />
                                </div>
                                <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
                                    {['Arroz 5lb', 'Aceite 1L', 'Leche', 'Coca-Cola', 'Pollo lb', 'Jabón', 'Pan', 'Salami'].map((p, i) => (
                                        <div key={p} className={`border rounded-xl p-3 aspect-square flex flex-col justify-between cursor-pointer transition-colors ${i === 0 ? 'border-gold/40 bg-gold/5' : 'border-white/8 bg-navy-2 hover:border-white/20'}`}>
                                            <div className="w-6 h-6 bg-white/5 rounded-md" />
                                            <div>
                                                <div className="text-[11px] text-vr-gray truncate">{p}</div>
                                                <div className="text-[11px] font-bold text-white">RD$<span className="text-gold">{(Math.random() * 300 + 50).toFixed(0)}</span></div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            {/* Carrito */}
                            <div className="w-52 p-4 flex flex-col gap-3">
                                <div className="text-xs font-bold text-vr-gray uppercase tracking-wider">Carrito · 3 items</div>
                                <div className="space-y-2 flex-1">
                                    {[
                                        { nombre: 'Arroz 5lb', precio: 'RD$250' },
                                        { nombre: 'Aceite 1L', precio: 'RD$195' },
                                        { nombre: 'Leche', precio: 'RD$120' },
                                    ].map(item => (
                                        <div key={item.nombre} className="flex items-center justify-between bg-navy-2 border border-white/5 rounded-lg px-2.5 py-2">
                                            <span className="text-[11px] text-white truncate mr-2">{item.nombre}</span>
                                            <span className="text-[11px] text-gold font-bold flex-shrink-0">{item.precio}</span>
                                        </div>
                                    ))}
                                </div>
                                <div className="border-t border-white/8 pt-3 space-y-1.5">
                                    <div className="flex justify-between text-[11px] text-vr-gray">
                                        <span>ITBIS</span><span>RD$64</span>
                                    </div>
                                    <div className="flex justify-between text-sm font-extrabold">
                                        <span>Total</span><span className="text-gold">RD$629</span>
                                    </div>
                                    <button className="w-full bg-gold text-navy text-xs font-black py-2.5 rounded-lg mt-1 hover:bg-gold/90 transition-colors">
                                        COBRAR
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <p className="text-center text-vr-gray text-sm mt-4">
                        El icono de Sin internet no es decorativo — así funciona de verdad cuando no hay señal.
                    </p>
                </div>
            </section>

            {/* ── LOS 4 PROBLEMAS REALES ── */}
            <section className="max-w-6xl mx-auto px-6 py-20 md:py-28">
                <div className="mb-14">
                    <h2 className="font-display font-black text-3xl md:text-4xl text-white mb-3">
                        Cuatro problemas que tienen<br />todos los colmados y tiendas en RD.
                    </h2>
                    <p className="text-vr-gray text-lg">VentaRD los resuelve todos con una sola app.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/5 border border-white/5 rounded-2xl overflow-hidden">
                    {[
                        {
                            icon: WifiOff,
                            color: 'text-gold',
                            problema: 'Se va la luz o el internet y la caja se congela',
                            solucion: 'VentaRD vive en el dispositivo. Sin internet, sin servidor, sin problema. Todo se guarda local y sincroniza cuando vuelve la señal.',
                        },
                        {
                            icon: MessageCircle,
                            color: 'text-blue-400',
                            problema: 'Los fiados en una libreta que nadie entiende',
                            solucion: 'Registra el crédito al momento de la venta. El sistema lleva el saldo actualizado y le manda el estado de cuenta al cliente por WhatsApp.',
                        },
                        {
                            icon: BarChart2,
                            color: 'text-vr-green',
                            problema: 'No sabes cuánto vendiste hasta que cuadras a medianoche',
                            solucion: 'El dashboard se actualiza venta por venta, en tiempo real. Ventas del día, ganancia, productos más vendidos — disponible en cualquier momento.',
                        },
                        {
                            icon: Package,
                            color: 'text-vr-orange',
                            problema: 'Capacitar un cajero nuevo toma demasiado tiempo',
                            solucion: 'Busca el producto, toca para agregar, selecciona el método de pago y cobra. No hay más pasos. Un cajero nuevo lo aprende en la primera venta.',
                        },
                    ].map((item) => (
                        <div key={item.problema} className="bg-navy p-8 md:p-10">
                            <item.icon className={`w-6 h-6 ${item.color} mb-5`} />
                            <p className="text-vr-gray text-sm font-medium mb-3 line-through decoration-white/20">
                                {item.problema}
                            </p>
                            <p className="text-white text-base leading-relaxed">
                                {item.solucion}
                            </p>
                        </div>
                    ))}
                </div>
            </section>

            {/* ── PARA QUÉ NEGOCIOS ── */}
            <section className="bg-navy-2 border-t border-b border-white/5">
                <div className="max-w-6xl mx-auto px-6 py-16 md:py-20">
                    <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
                        <div>
                            <h2 className="font-display font-black text-3xl text-white">
                                Cualquier negocio que venda productos o servicios.
                            </h2>
                        </div>
                        <p className="text-vr-gray text-base max-w-sm md:text-right">
                            Desde un colmado de barrio hasta una cadena con múltiples sucursales.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                        {['Colmado', 'Cafetería', 'Picapollo', 'Farmacia', 'Ferretería', 'Tienda de ropa', 'Salón de belleza', 'Lavandería', 'Tu negocio'].map((tipo) => (
                            <span
                                key={tipo}
                                className="px-4 py-2 border border-white/10 rounded-full text-sm text-vr-gray hover:border-gold/30 hover:text-white transition-colors"
                            >
                                {tipo}
                            </span>
                        ))}
                    </div>
                </div>
            </section>

            {/* ── FUNCIONA EN TODO ── */}
            <section className="max-w-6xl mx-auto px-6 py-20 md:py-28">
                <div className="grid md:grid-cols-2 gap-12 items-center">
                    <div>
                        <h2 className="font-display font-black text-3xl md:text-4xl text-white mb-5">
                            PC, tablet, celular.<br />Sin instalar nada.
                        </h2>
                        <p className="text-vr-gray text-lg leading-relaxed mb-6">
                            VentaRD funciona en cualquier navegador y se puede instalar como app en el
                            dispositivo. Sin App Store, sin Google Play, sin técnicos que llamen.
                        </p>
                        <p className="text-vr-gray text-base leading-relaxed">
                            Abre el browser, entra a la URL y ya. Si quieres instalarlo,
                            el navegador te pregunta solo.
                        </p>
                    </div>
                    <div className="bg-navy-2 border border-white/8 rounded-2xl p-8 space-y-4">
                        {[
                            { device: 'Computadora de escritorio', status: '✓', note: 'Con teclado y atajos rápidos' },
                            { device: 'Tablet o iPad', status: '✓', note: 'Perfecto para la caja del mostrador' },
                            { device: 'Celular Android o iPhone', status: '✓', note: 'Para vender desde cualquier lugar' },
                            { device: 'Sin internet', status: '✓', note: 'Sigue funcionando — ese es el punto' },
                        ].map((row) => (
                            <div key={row.device} className="flex items-start gap-4 py-3 border-b border-white/5 last:border-0">
                                <span className="text-vr-green font-black text-sm mt-0.5 flex-shrink-0">{row.status}</span>
                                <div>
                                    <div className="text-white text-sm font-semibold">{row.device}</div>
                                    <div className="text-vr-gray text-xs mt-0.5">{row.note}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ── PRECIO / CTA ── */}
            <section className="border-t border-white/5 bg-navy-2">
                <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
                    <div className="max-w-2xl">
                        <h2 className="font-display font-black text-3xl md:text-4xl text-white mb-4">
                            Empieza gratis.<br />Sin tarjeta, sin contratos.
                        </h2>
                        <p className="text-vr-gray text-lg mb-3 leading-relaxed">
                            Crea tu cuenta y úsalo sin límites durante el período de prueba.
                            Cuando termines, nos escribes por WhatsApp y te activamos. El precio
                            lo conversamos contigo según tu negocio.
                        </p>
                        <p className="text-vr-gray text-sm mb-10">
                            Sin sorpresas. Sin cobros automáticos.
                        </p>

                        <div className="flex flex-col sm:flex-row gap-3">
                            <Link
                                href="/registro"
                                className="inline-flex items-center justify-center gap-2 bg-gold text-navy px-6 py-3.5 rounded-xl font-extrabold text-base hover:bg-gold/90 transition-colors"
                            >
                                Crear mi cuenta gratis
                                <ChevronRight className="w-4 h-4" />
                            </Link>
                            <a
                                href="https://wa.me/18091234567?text=Hola%2C%20quiero%20saber%20m%C3%A1s%20sobre%20VentaRD"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl border border-white/10 hover:border-white/20 text-white font-bold text-base transition-colors"
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
                <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                    <div className="flex items-center gap-2">
                        <div className="w-6 h-6 bg-gold rounded-md flex items-center justify-center">
                            <ShoppingCart className="w-3.5 h-3.5 text-navy" />
                        </div>
                        <span className="font-display font-bold text-white">VentaRD</span>
                    </div>

                    <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-vr-gray">
                        <Link href="/login" className="hover:text-white transition-colors">Iniciar sesión</Link>
                        <Link href="/registro" className="hover:text-white transition-colors">Crear cuenta</Link>
                    </div>

                    <p className="text-vr-gray text-sm">
                        © {new Date().getFullYear()} VentaRD
                    </p>
                </div>
            </footer>
        </div>
    );
}
