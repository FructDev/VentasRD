// src/app/catalogo/[negocioId]/page.tsx
// Catálogo público (sin sesión). El cliente arma un pedido y lo envía por
// WhatsApp al negocio. Cada pedido lleva branding "Hecho con VentaRD".
'use client';

import { useEffect, useMemo, useState, use } from 'react';
import { formatDOP } from '@/lib/utils';
import { linkWhatsApp } from '@/lib/whatsapp';
import { PALETAS, PALETA_DEFAULT } from '@/lib/marca';

interface ProdPub { id: string; nombre: string; precio_venta: number; imagen_url?: string | null; }
interface CatData {
    negocio: { nombre: string; whatsapp: string | null; direccion: string | null; logo_url: string | null; color_marca: string };
    productos: ProdPub[];
}

export default function CatalogoPublico({ params }: { params: Promise<{ negocioId: string }> }) {
    const { negocioId } = use(params);
    const [data, setData] = useState<CatData | null>(null);
    const [estado, setEstado] = useState<'cargando' | 'ok' | 'error'>('cargando');
    const [busqueda, setBusqueda] = useState('');
    const [cant, setCant] = useState<Record<string, number>>({});

    useEffect(() => {
        fetch(`/api/catalogo/${negocioId}`)
            .then(r => r.ok ? r.json() : Promise.reject())
            .then((d: CatData) => {
                setData(d);
                setEstado('ok');
                const p = PALETAS[d.negocio.color_marca] || PALETAS[PALETA_DEFAULT];
                document.documentElement.style.setProperty('--color-gold', p.gold);
                document.documentElement.style.setProperty('--color-gold-2', p.gold2);
            })
            .catch(() => setEstado('error'));
    }, [negocioId]);

    const productos = useMemo(() => {
        if (!data) return [];
        const q = busqueda.trim().toLowerCase();
        return q ? data.productos.filter(p => p.nombre.toLowerCase().includes(q)) : data.productos;
    }, [data, busqueda]);

    const setQty = (id: string, delta: number) =>
        setCant(c => { const n = Math.max(0, (c[id] || 0) + delta); const next = { ...c }; if (n === 0) delete next[id]; else next[id] = n; return next; });

    const seleccion = useMemo(() => {
        if (!data) return [] as { p: ProdPub; n: number }[];
        return Object.entries(cant).map(([id, n]) => ({ p: data.productos.find(x => x.id === id)!, n })).filter(x => x.p);
    }, [cant, data]);

    const totalPedido = seleccion.reduce((s, { p, n }) => s + p.precio_venta * n, 0);
    const totalItems = seleccion.reduce((s, { n }) => s + n, 0);

    const enviarPedido = () => {
        if (!data || seleccion.length === 0) return;
        const lineas = seleccion.map(({ p, n }) => `• ${n}x ${p.nombre} — ${formatDOP(p.precio_venta * n)}`).join('\n');
        const msg =
            `Hola *${data.negocio.nombre}* 👋, quiero hacer este pedido:\n\n` +
            `${lineas}\n` +
            `${'—'.repeat(18)}\n` +
            `*Total: ${formatDOP(totalPedido)}*\n\n` +
            `_Pedido desde su catálogo · Hecho con VentaRD_`;
        window.open(linkWhatsApp(msg, data.negocio.whatsapp), '_blank');
    };

    if (estado === 'cargando') {
        return <div className="min-h-screen bg-navy flex items-center justify-center">
            <div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" />
        </div>;
    }

    if (estado === 'error' || !data) {
        return <div className="min-h-screen bg-navy flex flex-col items-center justify-center p-8 text-center">
            <p className="text-4xl mb-4">🔒</p>
            <h1 className="text-xl font-display font-black text-white mb-2">Catálogo no disponible</h1>
            <p className="text-vr-gray text-sm">Este negocio no tiene su catálogo público activo.</p>
        </div>;
    }

    const { negocio } = data;

    return (
        <div className="min-h-screen bg-navy pb-28">
            {/* Encabezado del negocio */}
            <header className="bg-navy-2 border-b border-navy-3 px-4 py-5 sticky top-0 z-30">
                <div className="max-w-3xl mx-auto flex items-center gap-3">
                    {negocio.logo_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={negocio.logo_url} alt={negocio.nombre} className="w-12 h-12 rounded-xl object-contain bg-white border border-navy-3 shrink-0" />
                    ) : (
                        <div className="w-12 h-12 rounded-xl bg-gold-gradient flex items-center justify-center text-navy font-black text-xl shrink-0">
                            {(negocio.nombre.trim()[0] || 'V').toUpperCase()}
                        </div>
                    )}
                    <div className="min-w-0">
                        <h1 className="font-display font-black text-xl text-white truncate">{negocio.nombre}</h1>
                        {negocio.direccion && <p className="text-xs text-vr-gray truncate">📍 {negocio.direccion}</p>}
                    </div>
                </div>
                <div className="max-w-3xl mx-auto mt-3">
                    <input
                        value={busqueda}
                        onChange={e => setBusqueda(e.target.value)}
                        placeholder="Buscar producto…"
                        className="w-full bg-navy-3 border border-navy-3 rounded-xl px-4 py-2.5 text-white placeholder-vr-gray text-sm focus:border-gold outline-none"
                    />
                </div>
            </header>

            {/* Grid de productos */}
            <main className="max-w-3xl mx-auto p-4">
                {productos.length === 0 ? (
                    <p className="text-center text-vr-gray py-16">No hay productos que coincidan.</p>
                ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {productos.map(p => {
                            const n = cant[p.id] || 0;
                            return (
                                <div key={p.id} className="bg-navy-2 border border-navy-3 rounded-2xl overflow-hidden flex flex-col">
                                    <div className="aspect-square bg-white/5 flex items-center justify-center overflow-hidden">
                                        {p.imagen_url ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img src={p.imagen_url} alt={p.nombre} className="w-full h-full object-cover" />
                                        ) : (
                                            <span className="text-4xl opacity-40">📦</span>
                                        )}
                                    </div>
                                    <div className="p-3 flex flex-col flex-1">
                                        <p className="text-sm font-bold text-white leading-tight line-clamp-2 mb-1">{p.nombre}</p>
                                        <p className="font-mono font-black text-gold mb-2">{formatDOP(p.precio_venta)}</p>
                                        <div className="mt-auto">
                                            {n === 0 ? (
                                                <button onClick={() => setQty(p.id, 1)} className="w-full py-2 bg-gold-gradient text-navy font-extrabold rounded-xl text-sm hover:brightness-110 transition-all">
                                                    Agregar
                                                </button>
                                            ) : (
                                                <div className="flex items-center justify-between bg-navy-3 rounded-xl">
                                                    <button onClick={() => setQty(p.id, -1)} className="px-3 py-2 text-gold font-black text-lg">−</button>
                                                    <span className="font-mono font-bold text-white">{n}</span>
                                                    <button onClick={() => setQty(p.id, 1)} className="px-3 py-2 text-gold font-black text-lg">+</button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </main>

            {/* Barra de pedido */}
            {totalItems > 0 && (
                <div className="fixed bottom-0 inset-x-0 bg-navy-2 border-t border-navy-3 p-3 z-40">
                    <div className="max-w-3xl mx-auto flex items-center gap-3">
                        <div className="min-w-0">
                            <p className="text-xs text-vr-gray">{totalItems} artículo{totalItems > 1 ? 's' : ''}</p>
                            <p className="font-mono font-black text-white">{formatDOP(totalPedido)}</p>
                        </div>
                        <button onClick={enviarPedido} className="flex-1 py-3 bg-vr-green text-white font-extrabold rounded-xl hover:brightness-110 transition-all flex items-center justify-center gap-2">
                            📱 Pedir por WhatsApp
                        </button>
                    </div>
                </div>
            )}

            <footer className="text-center py-6">
                <p className="text-[11px] text-vr-gray-2">Hecho con <span className="font-bold text-gold">VentaRD</span></p>
            </footer>
        </div>
    );
}
