// src/app/landing/page.tsx
'use client';

import Link from 'next/link';
import { ShoppingCart, WifiOff, MessageCircle, BarChart2, Package, ChevronRight, Check, UserPlus, Shield, Clock } from 'lucide-react';

const PRODUCTOS_MOCKUP = [
    { name: 'Arroz 5lb',  price: '250' },
    { name: 'Aceite 1L',  price: '195' },
    { name: 'Leche',      price: '120' },
    { name: 'Coca-Cola',  price: '85'  },
    { name: 'Pollo lb',   price: '180' },
    { name: 'Jabón',      price: '65'  },
];

const CARRITO_MOCKUP = [
    { nombre: 'Arroz 5lb', precio: 'RD$250' },
    { nombre: 'Aceite 1L', precio: 'RD$195' },
    { nombre: 'Leche',     precio: 'RD$120' },
];

const PROBLEMAS = [
    {
        icon: WifiOff,
        color: 'text-gold',
        bg: 'bg-gold/10',
        problema: 'Se va la luz o el internet y la caja se congela',
        solucion: 'VentaRD vive en el dispositivo. Sin internet, sin servidor, sin problema. Todo se guarda local y sincroniza cuando vuelve la señal.',
    },
    {
        icon: MessageCircle,
        color: 'text-blue-400',
        bg: 'bg-blue-400/10',
        problema: 'Los fiados en una libreta que nadie entiende',
        solucion: 'Registra el crédito al momento de la venta. El sistema lleva el saldo actualizado y le manda el estado de cuenta al cliente por WhatsApp.',
    },
    {
        icon: BarChart2,
        color: 'text-vr-green',
        bg: 'bg-vr-green/10',
        problema: 'No sabes cuánto vendiste hasta que cuadras a medianoche',
        solucion: 'El dashboard se actualiza venta por venta, en tiempo real. Ventas del día, ganancia, productos más vendidos — disponible en cualquier momento.',
    },
    {
        icon: Package,
        color: 'text-orange-400',
        bg: 'bg-orange-400/10',
        problema: 'Capacitar un cajero nuevo toma demasiado tiempo',
        solucion: 'Busca el producto, toca para agregar, selecciona el método de pago y cobra. No hay más pasos. Un cajero nuevo lo aprende en la primera venta.',
    },
];

const PASOS = [
    {
        num: '01',
        icon: UserPlus,
        titulo: 'Creas tu cuenta',
        desc: 'Entra a VentaRD desde el browser de tu teléfono, tablet o computadora. Sin descargas, sin App Store.',
    },
    {
        num: '02',
        icon: Package,
        titulo: 'Agregas tus productos',
        desc: 'Escribe el nombre y el precio de cada artículo. En 10 minutos tienes tu catálogo listo para vender.',
    },
    {
        num: '03',
        icon: ShoppingCart,
        titulo: 'Cobras tu primera venta',
        desc: 'Toca el producto, selecciona cómo paga el cliente y listo. Así de fácil — la primera venta toma menos de un minuto.',
    },
];

const NEGOCIOS = [
    { emoji: '🛒', label: 'Colmado' },
    { emoji: '☕', label: 'Cafetería' },
    { emoji: '🍗', label: 'Picapollo' },
    { emoji: '💊', label: 'Farmacia' },
    { emoji: '🔧', label: 'Ferretería' },
    { emoji: '👗', label: 'Tienda de ropa' },
    { emoji: '✂️', label: 'Salón de belleza' },
    { emoji: '👕', label: 'Lavandería' },
];

const FAQS = [
    {
        q: '¿Funciona en mi teléfono Android?',
        a: 'Sí. Abre Chrome, entra a la URL y ya. Puedes instalarlo como app directamente desde el browser sin ir al Play Store.',
    },
    {
        q: '¿Qué pasa con mis datos si no tengo internet?',
        a: 'Todo se guarda en el teléfono o computadora que usas. Cuando vuelve internet, sincroniza automáticamente con la nube. Nunca pierdes nada.',
    },
    {
        q: '¿Cuánto cuesta después del período de prueba?',
        a: 'Nos escribes por WhatsApp cuando termines la prueba y acordamos un precio justo para tu negocio. Sin sorpresas, sin cobros automáticos.',
    },
];

export default function LandingPage() {
    return (
        <div className="min-h-screen bg-navy text-white selection:bg-gold selection:text-navy">

            {/* ─── NAV ─── */}
            <nav className="border-b border-white/5 sticky top-0 z-50 bg-navy/80 backdrop-blur-md">
                <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 bg-gold rounded-lg flex items-center justify-center">
                            <ShoppingCart className="w-4 h-4 text-navy" />
                        </div>
                        <span className="font-display font-extrabold text-lg tracking-tight">VentaRD</span>
                    </div>
                    <div className="flex items-center gap-4 sm:gap-6">
                        <Link href="/login" className="hidden sm:inline text-sm text-vr-gray hover:text-white transition-colors font-medium">
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

            {/* ─── HERO ─── */}
            <section className="relative overflow-hidden">
                {/* Resplandor decorativo detrás del mockup */}
                <div className="absolute top-0 right-0 w-[700px] h-[700px] rounded-full bg-gold/[0.04] blur-3xl pointer-events-none -translate-y-1/3 translate-x-1/4" />

                <div className="relative max-w-6xl mx-auto px-6 pt-16 pb-20 md:pt-24 md:pb-28">
                    <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">

                        {/* Columna izquierda */}
                        <div>
                            <div className="inline-flex items-center gap-2 text-xs font-semibold text-gold bg-gold/10 border border-gold/20 px-3 py-1.5 rounded-full mb-6">
                                <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
                                Hecho en República Dominicana
                            </div>

                            <h1 className="font-display font-extrabold text-4xl md:text-5xl lg:text-[3.25rem] leading-[1.08] tracking-[-0.02em] mb-5">
                                El POS que no se cae<br />
                                <span className="text-gold drop-shadow-[0_0_24px_rgba(212,160,23,0.5)]">
                                    cuando se va la luz.
                                </span>
                            </h1>

                            <p className="text-vr-gray text-base md:text-lg leading-[1.7] mb-7">
                                VentaRD guarda todo en el dispositivo. Vendes, registras fiados
                                y cuadras caja aunque no haya internet. Cuando vuelve la señal,
                                sincroniza solo.
                            </p>

                            {/* Trust pills */}
                            <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 mb-8">
                                {[
                                    { icon: WifiOff,       label: 'Funciona sin internet' },
                                    { icon: Check,         label: 'Sin App Store' },
                                    { icon: Check,         label: 'Prueba gratis' },
                                    { icon: MessageCircle, label: 'Soporte por WhatsApp' },
                                ].map(({ icon: Icon, label }) => (
                                    <span key={label} className="inline-flex items-center gap-1.5 text-xs font-semibold text-vr-gray bg-white/4 border border-white/8 rounded-full px-3 py-1.5 hover:border-gold/30 transition-colors cursor-default">
                                        <Icon className="w-3 h-3 text-gold flex-shrink-0" />
                                        {label}
                                    </span>
                                ))}
                            </div>

                            <div className="flex flex-col sm:flex-row gap-3">
                                <Link
                                    href="/registro"
                                    className="inline-flex items-center justify-center gap-2 bg-gold-gradient text-navy px-6 py-3 rounded-xl font-extrabold text-sm hover:brightness-105 transition-all shadow-[0_4px_20px_rgba(212,160,23,0.25)]"
                                >
                                    Crear cuenta gratis
                                    <ChevronRight className="w-4 h-4" />
                                </Link>
                                <Link
                                    href="/login"
                                    className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl border border-white/10 hover:border-white/20 text-white font-bold text-sm transition-colors"
                                >
                                    Ya tengo cuenta
                                </Link>
                            </div>
                        </div>

                        {/* Columna derecha: mockup del POS */}
                        <div className="rounded-2xl border border-white/10 bg-navy overflow-hidden glow-gold shadow-2xl">
                            {/* Barra del browser */}
                            <div className="h-9 bg-navy-2 border-b border-white/5 flex items-center px-3 gap-2 flex-shrink-0">
                                <div className="flex gap-1.5">
                                    <div className="w-2.5 h-2.5 rounded-full bg-white/10" />
                                    <div className="w-2.5 h-2.5 rounded-full bg-white/10" />
                                    <div className="w-2.5 h-2.5 rounded-full bg-white/10" />
                                </div>
                                <div className="ml-2 flex items-center gap-1.5 min-w-0">
                                    <ShoppingCart className="w-3 h-3 text-gold flex-shrink-0" />
                                    <span className="text-[11px] text-vr-gray font-medium truncate">VentaRD — Punto de Ventas</span>
                                </div>
                                <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                                    <WifiOff className="w-3 h-3 text-gold animate-pulse" />
                                    <span className="text-[11px] text-gold font-bold">Sin internet</span>
                                </div>
                            </div>
                            {/* POS */}
                            <div className="flex" style={{ minHeight: 260 }}>
                                <div className="flex-1 p-4 border-r border-white/5 min-w-0">
                                    <div className="flex items-center gap-2 mb-3">
                                        <div className="flex-1 h-7 bg-navy-2 border border-white/8 rounded-lg" />
                                        <div className="h-7 w-7 bg-navy-2 border border-white/8 rounded-lg flex-shrink-0" />
                                    </div>
                                    <div className="grid grid-cols-3 gap-2">
                                        {PRODUCTOS_MOCKUP.map(({ name, price }, i) => (
                                            <div key={name} className={`border rounded-xl p-2.5 aspect-square flex flex-col justify-between ${i === 0 ? 'border-gold/40 bg-gold/5' : 'border-white/8 bg-navy-2'}`}>
                                                <div className="w-4 h-4 bg-white/5 rounded-md" />
                                                <div>
                                                    <div className="text-[9px] text-vr-gray truncate">{name}</div>
                                                    <div className="text-[9px] font-bold text-white">RD$<span className="text-gold">{price}</span></div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                {/* Carrito */}
                                <div className="w-40 p-3 flex flex-col gap-2 flex-shrink-0">
                                    <div className="text-[9px] font-bold text-vr-gray uppercase tracking-wider">Carrito · 3 items</div>
                                    <div className="space-y-1.5 flex-1">
                                        {CARRITO_MOCKUP.map(item => (
                                            <div key={item.nombre} className="flex items-center justify-between bg-navy-2 border border-white/5 rounded-lg px-2 py-1.5">
                                                <span className="text-[9px] text-white truncate mr-1">{item.nombre}</span>
                                                <span className="text-[9px] text-gold font-bold flex-shrink-0">{item.precio}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="border-t border-white/8 pt-2 space-y-1">
                                        <div className="flex justify-between text-[9px] text-vr-gray">
                                            <span>ITBIS</span><span>RD$64</span>
                                        </div>
                                        <div className="flex justify-between text-[11px] font-extrabold">
                                            <span>Total</span><span className="text-gold">RD$629</span>
                                        </div>
                                        <button className="w-full bg-gold-gradient text-navy text-[9px] font-black py-2 rounded-lg mt-1">
                                            COBRAR
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <p className="lg:col-start-2 text-center text-xs text-vr-gray -mt-8">
                            Así se ve VentaRD — funciona igual sin internet
                        </p>

                    </div>
                </div>
            </section>

            {/* ─── BARRA DE CONFIANZA ─── */}
            <section className="bg-navy-2 border-t border-b border-white/5">
                <div className="max-w-6xl mx-auto px-6 py-8">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-0">
                        {[
                            { num: '50+',      desc: 'negocios activos en RD' },
                            { num: 'RD$0',     desc: 'para empezar' },
                            { num: '100%',     desc: 'funciona sin internet' },
                            { num: '< 1 min',  desc: 'para la primera venta' },
                        ].map(({ num, desc }, i) => (
                            <div key={desc} className={`text-center ${i < 3 ? 'md:border-r border-white/5' : ''} md:px-6`}>
                                <div className="font-display font-extrabold text-2xl md:text-3xl text-gold leading-none mb-1">{num}</div>
                                <div className="text-xs text-vr-gray">{desc}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ─── LOS 4 PROBLEMAS ─── */}
            <section className="max-w-6xl mx-auto px-6 py-20 md:py-28">
                <div className="mb-12">
                    <h2 className="font-display font-extrabold text-2xl md:text-3xl lg:text-4xl text-white leading-[1.12] tracking-[-0.015em] mb-3">
                        ¿Tu caja depende del internet?<br />
                        <span className="text-vr-gray font-bold">Te entendemos.</span>
                    </h2>
                    <p className="text-vr-gray text-base md:text-lg">VentaRD resuelve los cuatro problemas más comunes de los negocios en RD.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/5 border border-white/5 rounded-2xl overflow-hidden">
                    {PROBLEMAS.map(({ icon: Icon, color, bg, problema, solucion }) => (
                        <div key={problema} className="bg-navy p-6 md:p-8">
                            <div className={`w-11 h-11 rounded-xl ${bg} flex items-center justify-center mb-5`}>
                                <Icon className={`w-5 h-5 ${color}`} />
                            </div>
                            <p className="text-[10px] uppercase tracking-widest text-vr-gray/60 font-semibold mb-1">El problema</p>
                            <p className="text-sm text-vr-gray/60 line-through decoration-white/15 mb-4 leading-snug">{problema}</p>
                            <div className="border-t border-white/5 pt-4">
                                <p className="text-white text-sm md:text-base leading-relaxed">{solucion}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {/* ─── CÓMO FUNCIONA ─── */}
            <section className="bg-navy-2 border-t border-white/5">
                <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
                    <div className="text-center mb-14">
                        <h2 className="font-display font-extrabold text-2xl md:text-3xl lg:text-4xl text-white leading-[1.12] tracking-[-0.015em] mb-3">
                            Empiezas a vender en minutos.
                        </h2>
                        <p className="text-vr-gray text-base md:text-lg max-w-xl mx-auto">
                            Sin técnicos, sin instalaciones, sin complicaciones.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative">
                        {/* Conectores entre cards en desktop */}
                        <div className="hidden md:flex absolute top-10 left-[33%] right-[33%] items-center justify-center pointer-events-none">
                            <div className="w-full border-t border-dashed border-white/10" />
                        </div>

                        {PASOS.map(({ num, icon: Icon, titulo, desc }) => (
                            <div key={num} className="relative bg-navy border border-white/5 rounded-2xl p-6 md:p-8 overflow-hidden">
                                {/* Número decorativo */}
                                <span className="absolute top-4 right-4 font-display font-extrabold text-5xl text-white/[0.04] leading-none select-none">{num}</span>
                                <div className="w-11 h-11 rounded-xl bg-gold/10 flex items-center justify-center mb-5">
                                    <Icon className="w-5 h-5 text-gold" />
                                </div>
                                <h3 className="font-display font-extrabold text-lg text-white mb-2 tracking-[-0.01em]">{titulo}</h3>
                                <p className="text-sm text-vr-gray leading-relaxed">{desc}</p>
                            </div>
                        ))}
                    </div>

                    <p className="text-center text-sm text-vr-gray mt-10">
                        ¿Dudas?{' '}
                        <a href="https://wa.me/18294515303?text=Hola%2C%20quiero%20configurar%20VentaRD" target="_blank" rel="noopener noreferrer" className="text-gold underline underline-offset-2 hover:text-gold/80 transition-colors">
                            Escríbenos por WhatsApp
                        </a>{' '}
                        y te ayudamos a configurar todo.
                    </p>
                </div>
            </section>

            {/* ─── PARA QUÉ NEGOCIOS ─── */}
            <section className="max-w-6xl mx-auto px-6 py-20 md:py-28">
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-10">
                    <h2 className="font-display font-extrabold text-2xl md:text-3xl lg:text-4xl text-white leading-[1.12] tracking-[-0.015em]">
                        Cualquier negocio que<br />venda productos o servicios.
                    </h2>
                    <p className="text-vr-gray text-base max-w-xs md:text-right flex-shrink-0">
                        Desde un colmado de barrio hasta una cadena con múltiples sucursales.
                    </p>
                </div>
                <div className="flex flex-wrap gap-2.5">
                    {NEGOCIOS.map(({ emoji, label }) => (
                        <span
                            key={label}
                            className="inline-flex items-center gap-2 px-4 py-2 border border-white/10 rounded-full text-sm text-vr-gray hover:border-gold/30 hover:text-white transition-colors"
                        >
                            <span>{emoji}</span> {label}
                        </span>
                    ))}
                    <span className="inline-flex items-center gap-2 px-4 py-2 border border-dashed border-gold/30 rounded-full text-sm text-gold hover:bg-gold/5 transition-colors">
                        + Tu negocio
                    </span>
                </div>
                <p className="mt-6 text-sm text-vr-gray">Si vendes algo, VentaRD funciona para ti.</p>
            </section>

            {/* ─── PC / TABLET / CELULAR ─── */}
            <section className="bg-navy-2 border-t border-white/5">
                <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
                    <div className="grid md:grid-cols-2 gap-12 items-center">
                        <div>
                            <h2 className="font-display font-extrabold text-2xl md:text-3xl lg:text-4xl text-white leading-[1.12] tracking-[-0.015em] mb-5">
                                PC, tablet, celular.<br />Sin instalar nada.
                            </h2>
                            <p className="text-vr-gray text-base md:text-lg leading-[1.7] mb-5">
                                VentaRD funciona en cualquier navegador y se puede instalar
                                como app en el dispositivo. Sin App Store, sin Google Play,
                                sin técnicos que llamen.
                            </p>
                            <p className="text-vr-gray text-base leading-[1.7] mb-6">
                                Abre el browser, entra a la URL y ya. Si quieres instalarlo,
                                el navegador te pregunta solo.
                            </p>
                            {/* Callout offline */}
                            <div className="flex items-start gap-3 bg-gold/5 border border-gold/15 rounded-xl p-4">
                                <WifiOff className="w-5 h-5 text-gold flex-shrink-0 mt-0.5" />
                                <p className="text-sm text-vr-gray leading-relaxed">
                                    Sin conexión, sin problema. VentaRD guarda todo en el dispositivo y sincroniza automáticamente cuando vuelve internet — aunque Claro se caiga.
                                </p>
                            </div>
                        </div>

                        <div className="bg-navy border border-white/8 rounded-2xl p-6 md:p-8 space-y-1">
                            <div className="text-xs uppercase tracking-widest text-vr-gray font-semibold mb-5">Funciona en:</div>
                            {[
                                { device: 'Computadora de escritorio', note: 'Con teclado y atajos rápidos' },
                                { device: 'Tablet o iPad',             note: 'Perfecto para la caja del mostrador' },
                                { device: 'Celular Android o iPhone',  note: 'Para vender desde cualquier lugar' },
                            ].map(({ device, note }) => (
                                <div key={device} className="flex items-start gap-4 py-3 border-b border-white/5">
                                    <Check className="w-4 h-4 text-vr-green flex-shrink-0 mt-0.5" />
                                    <div>
                                        <div className="text-white text-sm font-semibold">{device}</div>
                                        <div className="text-vr-gray text-xs mt-0.5">{note}</div>
                                    </div>
                                </div>
                            ))}
                            {/* Ítem especial: sin internet */}
                            <div className="flex items-start gap-4 py-3 bg-gold/5 rounded-xl px-3 -mx-3 mt-1">
                                <Check className="w-4 h-4 text-gold flex-shrink-0 mt-0.5" />
                                <div>
                                    <div className="text-white text-sm font-semibold">Sin internet</div>
                                    <div className="text-vr-gray text-xs mt-0.5">Sigue funcionando — ese es el punto</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ─── CTA FINAL ─── */}
            <section className="relative overflow-hidden border-t border-white/5">
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-[600px] h-[400px] rounded-full bg-gold/[0.04] blur-3xl" />
                </div>
                <div className="relative max-w-3xl mx-auto px-6 py-24 md:py-32 text-center">
                    <div className="inline-flex items-center gap-2 text-xs font-bold text-vr-green bg-vr-green/10 border border-vr-green/20 px-3 py-1.5 rounded-full mb-6">
                        <Check className="w-3 h-3" />
                        Sin tarjeta de crédito · Sin contratos
                    </div>

                    <h2 className="font-display font-extrabold text-3xl md:text-4xl lg:text-5xl text-white leading-[1.08] tracking-[-0.02em] mb-4">
                        Empieza a vender hoy.
                    </h2>
                    <p className="text-vr-gray text-base md:text-lg leading-[1.7] mb-3 max-w-xl mx-auto">
                        Crea tu cuenta, agrega tus productos y cobra tu primera venta hoy mismo.
                        Durante el período de prueba usas todo sin límites.
                    </p>
                    <p className="text-vr-gray text-sm mb-10">
                        Cuando quieras activarlo, nos escribes por WhatsApp y definimos un plan a tu medida.
                    </p>

                    <div className="flex flex-col sm:flex-row gap-3 justify-center mb-10">
                        <Link
                            href="/registro"
                            className="inline-flex items-center justify-center gap-2 bg-gold-gradient text-navy px-8 py-3.5 rounded-xl font-extrabold text-base hover:brightness-105 transition-all shadow-[0_4px_24px_rgba(212,160,23,0.3)]"
                        >
                            Crear mi cuenta gratis
                            <ChevronRight className="w-4 h-4" />
                        </Link>
                        <a
                            href="https://wa.me/18294515303?text=Hola%2C%20quiero%20saber%20m%C3%A1s%20sobre%20VentaRD"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center gap-2 px-8 py-3.5 rounded-xl border border-white/10 hover:border-white/20 text-white font-bold text-base transition-colors"
                        >
                            <MessageCircle className="w-4 h-4" />
                            Preguntar por WhatsApp
                        </a>
                    </div>

                    {/* Micro-garantías */}
                    <div className="grid grid-cols-3 gap-4 max-w-sm mx-auto mb-6">
                        {[
                            { icon: Shield,       label: 'Tus datos son tuyos' },
                            { icon: WifiOff,      label: 'Funciona sin internet' },
                            { icon: MessageCircle, label: 'Soporte por WhatsApp' },
                        ].map(({ icon: Icon, label }) => (
                            <div key={label} className="flex flex-col items-center gap-1.5 text-center">
                                <Icon className="w-4 h-4 text-vr-gray" />
                                <span className="text-[10px] text-vr-gray leading-tight">{label}</span>
                            </div>
                        ))}
                    </div>

                    <p className="text-xs text-vr-gray">
                        ¿Preguntas antes de registrarte?{' '}
                        <a href="https://wa.me/18294515303?text=Hola%2C%20tengo%20una%20pregunta%20sobre%20VentaRD" target="_blank" rel="noopener noreferrer" className="text-gold underline underline-offset-2 hover:text-gold/80 transition-colors">
                            Escríbenos aquí
                        </a>
                    </p>
                </div>
            </section>

            {/* ─── FAQ ─── */}
            <section className="bg-navy-2 border-t border-white/5">
                <div className="max-w-2xl mx-auto px-6 py-16 md:py-20">
                    <h2 className="font-display font-extrabold text-xl md:text-2xl text-white text-center mb-10 tracking-[-0.01em]">
                        Preguntas frecuentes
                    </h2>
                    <div>
                        {FAQS.map(({ q, a }, i) => (
                            <div key={q} className={`py-5 ${i < FAQS.length - 1 ? 'border-b border-white/5' : ''}`}>
                                <p className="text-sm font-bold text-white mb-2">{q}</p>
                                <p className="text-sm text-vr-gray leading-relaxed">{a}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ─── FOOTER ─── */}
            <footer className="border-t border-white/5">
                <div className="max-w-6xl mx-auto px-6 py-10">
                    <div className="grid md:grid-cols-3 gap-8 mb-8">
                        {/* Col 1: marca */}
                        <div>
                            <div className="flex items-center gap-2 mb-3">
                                <div className="w-6 h-6 bg-gold rounded-md flex items-center justify-center">
                                    <ShoppingCart className="w-3.5 h-3.5 text-navy" />
                                </div>
                                <span className="font-display font-extrabold text-white">VentaRD</span>
                            </div>
                            <p className="text-xs text-vr-gray leading-relaxed mb-3">
                                El POS offline-first para negocios dominicanos.
                            </p>
                            <a
                                href="https://wa.me/18294515303?text=Hola%2C%20quiero%20saber%20m%C3%A1s%20sobre%20VentaRD"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 text-xs text-gold hover:text-gold/80 transition-colors"
                            >
                                <MessageCircle className="w-3.5 h-3.5" />
                                Escríbenos por WhatsApp
                            </a>
                        </div>

                        {/* Col 2: links */}
                        <div className="flex flex-col gap-2">
                            <p className="text-xs font-semibold text-vr-gray uppercase tracking-widest mb-1">Acceso</p>
                            <Link href="/login" className="text-sm text-vr-gray hover:text-white transition-colors">Iniciar sesión</Link>
                            <Link href="/registro" className="text-sm text-vr-gray hover:text-white transition-colors">Crear cuenta</Link>
                        </div>

                        {/* Col 3: tagline */}
                        <div className="md:text-right">
                            <p className="text-xs text-vr-gray leading-relaxed">
                                Hecho con 🇩🇴 para colmados, tiendas
                                y negocios de todo el país.
                            </p>
                        </div>
                    </div>

                    <div className="border-t border-white/5 pt-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                        <p className="text-xs text-vr-gray">© {new Date().getFullYear()} VentaRD</p>
                        <p className="text-xs text-vr-gray">República Dominicana</p>
                    </div>
                </div>
            </footer>

        </div>
    );
}
