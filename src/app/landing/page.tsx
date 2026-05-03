// src/app/landing/page.tsx
'use client';

import Link from 'next/link';
import {
    ShoppingCart, Smartphone, Zap, CloudOff, ShieldCheck,
    TrendingUp, ChevronRight, Wifi, WifiOff, CheckCircle,
    MessageCircle, Clock, Star, BarChart2, Package
} from 'lucide-react';

const PAIN_POINTS = [
    { emoji: '📴', text: 'Se va el internet y tu caja se congela' },
    { emoji: '📒', text: 'Llevas los fiados en una libreta que nadie entiende' },
    { emoji: '😤', text: 'Capacitar un cajero nuevo te toma horas' },
    { emoji: '📊', text: 'No sabes cuánto vendiste hasta que cuadras caja a medianoche' },
    { emoji: '💸', text: 'Clientes te deben y no tienes forma de cobrarles fácil' },
];

const BUSINESS_TYPES = [
    { icon: '☕', label: 'Cafetería' },
    { icon: '🍗', label: 'Picapollo' },
    { icon: '🏪', label: 'Colmado' },
    { icon: '👗', label: 'Ropa' },
    { icon: '💊', label: 'Farmacia' },
    { icon: '🔧', label: 'Ferretería' },
    { icon: '💼', label: 'Tu negocio' },
];

const FEATURES = [
    {
        icon: CloudOff,
        color: 'text-vr-green',
        bg: 'bg-vr-green/10',
        title: '100% Offline-First',
        desc: 'Se va la luz, se va el internet — VentaRD sigue cobrando. Todo se guarda en el dispositivo y sincroniza solo cuando vuelve la señal. Sin perder una sola venta.',
    },
    {
        icon: Zap,
        color: 'text-gold',
        bg: 'bg-gold/10',
        title: 'Venta en segundos',
        desc: 'Busca el producto con 3 letras, toca y está en el carrito. Cobra en efectivo, tarjeta o transferencia. Atajos de teclado para cajeros que necesitan velocidad real.',
    },
    {
        icon: MessageCircle,
        color: 'text-blue-400',
        bg: 'bg-blue-500/10',
        title: 'Fiado digital por WhatsApp',
        desc: 'Olvídate de la libreta. Registra créditos, controla quién te debe y mándale el estado de cuenta al cliente directo por WhatsApp con un toque.',
    },
    {
        icon: ShieldCheck,
        color: 'text-vr-orange',
        bg: 'bg-vr-orange/10',
        title: 'Cuadre de caja perfecto',
        desc: 'El sistema te guía billete por billete. Cuenta los RD$2,000, los $1,000, los $500... y te dice al instante si cuadra o hay faltante. Sin matemáticas, sin estrés.',
    },
];

const STATS = [
    { num: '< 10s', label: 'para completar una venta' },
    { num: '5 min', label: 'y tu cajero ya lo sabe usar' },
    { num: '0', label: 'ventas perdidas por falta de luz' },
    { num: '30', label: 'días gratis, sin tarjeta' },
];

const TESTIMONIALS = [
    {
        name: 'Carlos M.',
        business: 'Colmado El Progreso, SDQ',
        text: 'Antes cuando se iba la luz perdía todas las ventas. Ahora no paro. El sistema sigue y sincroniza solo.',
        stars: 5,
    },
    {
        name: 'Mariela R.',
        business: 'Tienda de Ropa, Santiago',
        text: 'Los fiados eran un desastre. Ahora sé exactamente quién me debe y les mando el estado de cuenta por WhatsApp.',
        stars: 5,
    },
    {
        name: 'José P.',
        business: 'Picapollo Don Pepe, LP',
        text: 'En 5 minutos mi cajero ya estaba cobrando. No tuve que explicar nada. Eso vale oro.',
        stars: 5,
    },
];

export default function LandingPage() {
    return (
        <div className="min-h-screen bg-navy text-white font-sans selection:bg-gold selection:text-navy overflow-hidden">

            {/* ── HEADER ── */}
            <header className="container mx-auto px-6 py-6 flex justify-between items-center relative z-20">
                <div className="flex items-center gap-2">
                    <div className="w-10 h-10 bg-gold-gradient rounded-xl flex items-center justify-center shadow-lg shadow-gold/20">
                        <ShoppingCart className="w-6 h-6 text-navy" />
                    </div>
                    <span className="text-2xl font-display font-extrabold tracking-tight text-white">VentaRD</span>
                </div>
                <div className="flex items-center gap-4">
                    <Link href="/login" className="text-vr-gray hover:text-white font-bold transition-colors">
                        Iniciar Sesión
                    </Link>
                    <Link href="/registro" className="bg-gold-gradient text-navy px-6 py-2.5 rounded-full font-bold shadow-[0_0_15px_rgba(212,160,23,0.3)] hover:shadow-[0_0_25px_rgba(212,160,23,0.5)] transition-all transform hover:-translate-y-0.5">
                        Probar Gratis
                    </Link>
                </div>
            </header>

            {/* ── HERO ── */}
            <section className="relative pt-16 pb-24 overflow-hidden">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-gold/5 rounded-full blur-[120px] pointer-events-none" />
                <div className="absolute top-0 right-0 w-96 h-96 bg-vr-green/5 rounded-full blur-[100px] pointer-events-none" />

                <div className="container mx-auto px-6 relative z-10 text-center">
                    <div className="inline-block mb-6 px-4 py-1.5 rounded-full border border-gold/30 bg-gold/5 text-gold text-sm font-bold tracking-wide backdrop-blur-sm">
                        🇩🇴 El POS hecho en RD para los negocios de RD
                    </div>

                    <h1 className="text-5xl md:text-7xl font-display font-black tracking-tight leading-tight mb-6">
                        Tu negocio no para.<br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-gold to-[#fcd34d]">
                            Ni cuando se va la luz.
                        </span>
                    </h1>

                    <p className="text-xl text-vr-gray max-w-2xl mx-auto mb-4 leading-relaxed">
                        VentaRD es el sistema de punto de ventas que funciona aunque no haya internet,
                        maneja los fiados por WhatsApp y cualquier cajero lo aprende en 5 minutos.
                    </p>

                    {/* Offline indicator live -->*/}
                    <div className="flex items-center justify-center gap-3 mb-10">
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-vr-green/10 border border-vr-green/30 text-vr-green text-sm font-semibold">
                            <span className="w-2 h-2 rounded-full bg-vr-green animate-pulse" />
                            Con internet
                        </div>
                        <span className="text-vr-gray text-sm">y también</span>
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gold/10 border border-gold/30 text-gold text-sm font-semibold">
                            <WifiOff className="w-3.5 h-3.5" />
                            Sin internet
                        </div>
                    </div>

                    <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-20">
                        <Link
                            href="/registro"
                            className="w-full sm:w-auto bg-gold-gradient text-navy px-8 py-4 rounded-full font-extrabold text-lg flex items-center justify-center gap-2 hover:scale-105 transition-transform shadow-[0_0_30px_rgba(212,160,23,0.3)]"
                        >
                            Empezar gratis — 30 días <ChevronRight className="w-5 h-5" />
                        </Link>
                        <Link
                            href="/login"
                            className="w-full sm:w-auto px-8 py-4 rounded-full border border-navy-3 hover:border-gold hover:bg-gold/5 text-white font-bold transition-all flex items-center justify-center"
                        >
                            Ya tengo cuenta
                        </Link>
                    </div>

                    {/* Dashboard Mockup */}
                    <div className="relative mx-auto max-w-5xl">
                        <div className="absolute inset-0 bg-gradient-to-t from-navy via-transparent to-transparent z-10 rounded-2xl" />
                        <div className="rounded-2xl border border-navy-3 bg-navy-2 p-2 shadow-2xl">
                            <div className="bg-navy rounded-xl border border-navy-3 aspect-[16/9] relative overflow-hidden group">
                                {/* Top bar */}
                                <div className="absolute top-0 left-0 w-full h-12 bg-navy-2 border-b border-navy-3 flex items-center px-4 gap-2">
                                    <div className="w-3 h-3 rounded-full bg-vr-red/80" />
                                    <div className="w-3 h-3 rounded-full bg-gold/80" />
                                    <div className="w-3 h-3 rounded-full bg-vr-green/80" />
                                    <div className="ml-4 flex items-center gap-2">
                                        <ShoppingCart className="w-4 h-4 text-gold" />
                                        <span className="text-xs font-bold text-vr-gray">VentaRD — Punto de Ventas</span>
                                    </div>
                                    <div className="ml-auto flex items-center gap-2 text-vr-green text-xs font-semibold">
                                        <span className="w-1.5 h-1.5 rounded-full bg-vr-green" />
                                        Caja abierta · RD$2,500
                                    </div>
                                </div>
                                {/* POS layout mockup */}
                                <div className="w-full h-full pt-12 flex">
                                    {/* Product grid */}
                                    <div className="flex-1 p-4 space-y-3">
                                        <div className="h-8 bg-navy-2 border border-navy-3 rounded-lg w-full" />
                                        <div className="grid grid-cols-4 gap-2">
                                            {['Arroz 5lb', 'Aceite 1L', 'Leche', 'Coca-Cola', 'Pollo', 'Jabón', 'Pan', 'Agua'].map((p) => (
                                                <div key={p} className="bg-navy-2 border border-navy-3 rounded-lg p-2 aspect-square flex flex-col justify-between">
                                                    <div className="text-xs text-vr-gray truncate">{p}</div>
                                                    <div className="text-xs font-bold text-gold">RD$</div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                    {/* Cart sidebar */}
                                    <div className="w-48 bg-navy-2 border-l border-navy-3 p-3 flex flex-col gap-2">
                                        <div className="text-xs font-bold text-white">Carrito (3)</div>
                                        <div className="space-y-1.5 flex-1">
                                            {['Arroz 5lb · $250', 'Aceite · $195', 'Leche · $125'].map((i) => (
                                                <div key={i} className="text-[10px] text-vr-gray bg-navy rounded px-2 py-1">{i}</div>
                                            ))}
                                        </div>
                                        <div className="border-t border-navy-3 pt-2">
                                            <div className="flex justify-between text-[10px] text-vr-gray mb-1">
                                                <span>ITBIS</span><span>RD$81</span>
                                            </div>
                                            <div className="flex justify-between text-xs font-bold text-white mb-2">
                                                <span>TOTAL</span><span className="text-gold">RD$651</span>
                                            </div>
                                            <div className="w-full bg-gold text-navy text-[10px] font-black py-1.5 rounded-lg text-center">
                                                COBRAR
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                {/* Hover overlay */}
                                <div className="absolute inset-0 flex items-center justify-center bg-navy/60 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity">
                                    <Link href="/registro" className="bg-gold-gradient text-navy px-6 py-3 rounded-full font-bold">
                                        Probar ahora — es gratis
                                    </Link>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ── PAIN POINTS ── */}
            <section className="py-20 bg-navy-2 border-t border-navy-3">
                <div className="container mx-auto px-6">
                    <div className="text-center mb-12">
                        <h2 className="text-3xl md:text-4xl font-display font-black text-white mb-4">
                            ¿Te suena familiar alguno de estos?
                        </h2>
                        <p className="text-vr-gray text-lg">Si dijiste sí a uno, VentaRD es para ti.</p>
                    </div>
                    <div className="max-w-2xl mx-auto space-y-4">
                        {PAIN_POINTS.map((p, i) => (
                            <div
                                key={i}
                                className="flex items-center gap-4 bg-navy border border-navy-3 rounded-2xl px-6 py-4 hover:border-gold/30 transition-colors"
                            >
                                <span className="text-2xl flex-shrink-0">{p.emoji}</span>
                                <span className="text-white font-medium">{p.text}</span>
                                <div className="ml-auto w-6 h-6 rounded-full bg-vr-green/10 border border-vr-green/30 flex items-center justify-center flex-shrink-0">
                                    <CheckCircle className="w-4 h-4 text-vr-green" />
                                </div>
                            </div>
                        ))}
                    </div>
                    <p className="text-center mt-8 text-gold font-bold text-lg">
                        VentaRD resuelve todos estos problemas. Hoy mismo.
                    </p>
                </div>
            </section>

            {/* ── PARA QUÉ NEGOCIOS ── */}
            <section className="py-20 border-t border-navy-3">
                <div className="container mx-auto px-6 text-center">
                    <h2 className="text-3xl md:text-4xl font-display font-black text-white mb-4">
                        ¿Tienes un negocio o emprendimiento?
                    </h2>
                    <p className="text-vr-gray text-xl mb-12">
                        No importa el tipo. <span className="text-gold font-bold">VentaRD es pa' ti.</span>
                    </p>
                    <div className="flex flex-wrap justify-center gap-4 mb-10">
                        {BUSINESS_TYPES.map((b) => (
                            <div
                                key={b.label}
                                className="flex flex-col items-center gap-2 bg-navy-2 border border-navy-3 rounded-2xl px-6 py-5 hover:border-gold/40 hover:bg-gold/5 transition-all cursor-default"
                            >
                                <span className="text-3xl">{b.icon}</span>
                                <span className="text-sm font-semibold text-white">{b.label}</span>
                            </div>
                        ))}
                    </div>
                    <p className="text-vr-gray text-base max-w-xl mx-auto">
                        Si cobras por productos o servicios, VentaRD se adapta a ti.
                        Desde un colmado de barrio hasta una cadena de tiendas con múltiples sucursales.
                    </p>
                </div>
            </section>

            {/* ── STATS ── */}
            <section className="py-16 bg-gold relative overflow-hidden border-t border-gold/20">
                <div className="absolute inset-0 opacity-10 pointer-events-none"
                    style={{ backgroundImage: 'radial-gradient(circle at 80% 50%, #0D1B2E 0%, transparent 60%)' }} />
                <div className="container mx-auto px-6 relative z-10">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
                        {STATS.map((s) => (
                            <div key={s.label}>
                                <div className="text-4xl md:text-5xl font-display font-black text-navy mb-2">{s.num}</div>
                                <div className="text-navy/70 font-medium text-sm">{s.label}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ── FEATURES ── */}
            <section className="py-24 bg-navy-2 border-t border-navy-3">
                <div className="container mx-auto px-6">
                    <div className="text-center mb-16">
                        <h2 className="text-3xl md:text-5xl font-display font-black text-white mb-4">
                            Todo lo que necesita tu negocio
                        </h2>
                        <p className="text-vr-gray text-lg max-w-2xl mx-auto">
                            Sin funciones de más. Sin complicaciones. Solo lo que un negocio dominicano necesita de verdad.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                        {FEATURES.map((f) => (
                            <div
                                key={f.title}
                                className="bg-navy p-8 rounded-3xl border border-navy-3 hover:border-gold/50 transition-colors group"
                            >
                                <div className={`w-14 h-14 ${f.bg} rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform`}>
                                    <f.icon className={`w-7 h-7 ${f.color}`} />
                                </div>
                                <h3 className="text-xl font-display font-bold text-white mb-3">{f.title}</h3>
                                <p className="text-vr-gray leading-relaxed">{f.desc}</p>
                            </div>
                        ))}
                    </div>

                    {/* Wide PWA card */}
                    <div className="bg-navy md:col-span-2 p-8 rounded-3xl border border-navy-3 hover:border-gold/50 transition-colors overflow-hidden relative group">
                        <div className="absolute right-0 bottom-0 w-64 h-64 bg-gold/5 rounded-full blur-[80px]" />
                        <div className="relative z-10 flex flex-col md:flex-row items-center gap-8">
                            <div className="flex-1">
                                <div className="w-14 h-14 bg-white/5 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                                    <Smartphone className="w-7 h-7 text-white" />
                                </div>
                                <h3 className="text-xl font-display font-bold text-white mb-3">
                                    PC, tablet y celular — sin instalar nada
                                </h3>
                                <p className="text-vr-gray leading-relaxed">
                                    VentaRD es una PWA: funciona en el browser y se instala en cualquier dispositivo como una app nativa.
                                    Sin App Store, sin Google Play, sin técnicos. Abre el browser y ya.
                                </p>
                            </div>
                            <div className="hidden md:flex w-48 h-48 bg-navy-2 border border-navy-3 rounded-2xl items-center justify-center shadow-xl">
                                <div className="text-center">
                                    <div className="w-16 h-16 bg-gold-gradient rounded-xl mx-auto mb-3 shadow-lg shadow-gold/20 flex items-center justify-center">
                                        <ShoppingCart className="w-8 h-8 text-navy" />
                                    </div>
                                    <div className="text-xs font-bold text-vr-gray">VentaRD POS</div>
                                    <div className="mt-2 text-[10px] bg-gold/10 border border-gold/30 text-gold px-2 py-1 rounded inline-block">
                                        + Instalar App
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ── CÓMO FUNCIONA ── */}
            <section className="py-24 border-t border-navy-3">
                <div className="container mx-auto px-6">
                    <div className="text-center mb-16">
                        <h2 className="text-3xl md:text-4xl font-display font-black text-white mb-4">
                            Una venta en 3 pasos
                        </h2>
                        <p className="text-vr-gray text-lg">Así de simple es cobrar con VentaRD.</p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto">
                        {[
                            {
                                num: '1',
                                icon: Package,
                                title: 'Busca el producto',
                                desc: 'Escribe las primeras letras o escanea el código de barras con la cámara. Resultado instantáneo.',
                                color: 'text-gold',
                                bg: 'bg-gold/10',
                            },
                            {
                                num: '2',
                                icon: ShoppingCart,
                                title: 'Toca y al carrito',
                                desc: 'Un toque agrega el producto. Ajusta cantidades, agrega descuentos o combina métodos de pago.',
                                color: 'text-blue-400',
                                bg: 'bg-blue-500/10',
                            },
                            {
                                num: '3',
                                icon: CheckCircle,
                                title: 'Cobra y listo',
                                desc: 'El sistema calcula el cambio. Ticket por WhatsApp o impresora térmica. Venta registrada.',
                                color: 'text-vr-green',
                                bg: 'bg-vr-green/10',
                            },
                        ].map((step) => (
                            <div key={step.num} className="text-center">
                                <div className="relative inline-block mb-6">
                                    <div className={`w-16 h-16 ${step.bg} rounded-2xl flex items-center justify-center mx-auto`}>
                                        <step.icon className={`w-8 h-8 ${step.color}`} />
                                    </div>
                                    <div className="absolute -top-2 -right-2 w-6 h-6 bg-gold rounded-full flex items-center justify-center text-navy text-xs font-black">
                                        {step.num}
                                    </div>
                                </div>
                                <h3 className="text-lg font-display font-bold text-white mb-2">{step.title}</h3>
                                <p className="text-vr-gray text-sm leading-relaxed">{step.desc}</p>
                            </div>
                        ))}
                    </div>
                    <div className="text-center mt-12">
                        <p className="text-gold font-bold text-lg">
                            Total: menos de 10 segundos por venta. ⚡
                        </p>
                    </div>
                </div>
            </section>

            {/* ── TESTIMONIOS ── */}
            <section className="py-24 bg-navy-2 border-t border-navy-3">
                <div className="container mx-auto px-6">
                    <div className="text-center mb-16">
                        <h2 className="text-3xl md:text-4xl font-display font-black text-white mb-4">
                            Negocios que ya usan VentaRD
                        </h2>
                        <p className="text-vr-gray text-lg">Lo que dicen los dueños.</p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {TESTIMONIALS.map((t) => (
                            <div key={t.name} className="bg-navy border border-navy-3 rounded-3xl p-6 hover:border-gold/30 transition-colors">
                                <div className="flex gap-1 mb-4">
                                    {Array.from({ length: t.stars }).map((_, i) => (
                                        <Star key={i} className="w-4 h-4 text-gold fill-gold" />
                                    ))}
                                </div>
                                <p className="text-white leading-relaxed mb-6 text-sm">"{t.text}"</p>
                                <div className="border-t border-navy-3 pt-4">
                                    <div className="font-bold text-white text-sm">{t.name}</div>
                                    <div className="text-vr-gray text-xs mt-0.5">{t.business}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ── CTA FINAL ── */}
            <section className="py-24 relative overflow-hidden border-t border-navy-3">
                <div className="absolute inset-0 bg-gold/5" />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-gold/8 rounded-full blur-[100px] pointer-events-none" />
                <div className="container mx-auto px-6 relative z-10 text-center">
                    <div className="inline-block mb-6 px-4 py-1.5 rounded-full border border-gold/30 bg-gold/5 text-gold text-sm font-bold">
                        Sin tarjeta · Sin contrato · Sin técnicos
                    </div>
                    <h2 className="text-4xl md:text-5xl font-display font-black text-white mb-6">
                        Pruébalo hoy.<br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-gold to-[#fcd34d]">
                            30 días completamente gratis.
                        </span>
                    </h2>
                    <p className="text-vr-gray text-xl mb-4 max-w-xl mx-auto">
                        Regístrate, sube tus productos y empieza a cobrar hoy mismo.
                        Si no te convence, no pagas nada. Así de simple.
                    </p>
                    <p className="text-gold font-bold mb-10">
                        👇 Comenta INFO y te escribimos, o entra directo:
                    </p>
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                        <Link
                            href="/registro"
                            className="w-full sm:w-auto bg-gold-gradient text-navy px-10 py-5 rounded-full font-extrabold text-xl inline-flex items-center justify-center gap-2 hover:scale-105 transition-transform shadow-[0_0_40px_rgba(212,160,23,0.4)]"
                        >
                            Crear mi cuenta gratis <ChevronRight className="w-6 h-6" />
                        </Link>
                        <Link
                            href="/login"
                            className="w-full sm:w-auto px-10 py-5 rounded-full border border-navy-3 hover:border-gold hover:bg-gold/5 text-white font-bold transition-all inline-flex items-center justify-center"
                        >
                            Ya tengo cuenta
                        </Link>
                    </div>
                </div>
            </section>

            {/* ── FOOTER ── */}
            <footer className="bg-navy border-t border-navy-3 py-12">
                <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-4">
                    <div className="flex items-center gap-2">
                        <ShoppingCart className="w-5 h-5 text-gold" />
                        <span className="text-xl font-display font-bold text-white">VentaRD</span>
                    </div>
                    <div className="flex gap-6 text-sm text-vr-gray">
                        <span>Funciona sin internet</span>
                        <span>·</span>
                        <span>Fiado digital</span>
                        <span>·</span>
                        <span>Hecho para RD</span>
                    </div>
                    <p className="text-vr-gray text-sm">
                        © {new Date().getFullYear()} VentaRD. El POS hecho para RD.
                    </p>
                </div>
            </footer>

        </div>
    );
}