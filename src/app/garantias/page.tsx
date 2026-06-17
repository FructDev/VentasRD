// src/app/garantias/page.tsx
'use client';

import { useMemo, useState, useRef, lazy, Suspense } from 'react';
import { db } from '@/lib/db/dexie';
import { useConfigStore } from '@/store/useConfigStore';
import { useLiveQuery } from 'dexie-react-hooks';
import { SerialLocal } from '@/types/database';
import { formatDOP } from '@/lib/utils';
import { useReactToPrint } from 'react-to-print';
import { TicketGarantia } from '@/components/TicketGarantia';
import PinGuard from '@/components/ui/PinGuard';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';

const BarcodeScanner = lazy(() => import('@/components/ui/BarcodeScanner'));
const DIA = 24 * 60 * 60 * 1000;
const WHATSAPP_NUMBER_SOPORTE = '18294515303';

const norm = (s: string | null | undefined): string =>
    (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

type EstadoGarantia = { label: string; color: string; dias: number };

function estadoGarantia(s: SerialLocal): EstadoGarantia {
    if (s.estado !== 'vendido') return { label: 'No vendido', color: 'bg-navy-3 text-vr-gray border-navy-3', dias: 0 };
    if (!s.garantia_hasta) return { label: 'Sin garantía', color: 'bg-navy-3 text-vr-gray border-navy-3', dias: 0 };
    const restante = Math.ceil((s.garantia_hasta - Date.now()) / DIA);
    if (restante >= 0) return { label: `En garantía · ${restante}d`, color: 'bg-vr-green/15 text-vr-green border-vr-green/30', dias: restante };
    return { label: 'Garantía vencida', color: 'bg-vr-red/15 text-vr-red border-vr-red/30', dias: restante };
}

export default function GarantiasPage() {
    const { negocioId, planTier, showToast, negocioNombre, negocioRnc, negocioDireccion, negocioTelefono, garantiaDiasDefault, setGarantiaDiasDefault } = useConfigStore();

    const [busqueda, setBusqueda] = useState('');
    const [scanOpen, setScanOpen] = useState(false);

    // Ajuste de garantía
    const [ajustando, setAjustando] = useState<SerialLocal | null>(null);
    const [diasAjuste, setDiasAjuste] = useState('');

    // Impresión del certificado
    const ticketRef = useRef<HTMLDivElement>(null);
    const [cert, setCert] = useState<{ serial: SerialLocal; nombre: string } | null>(null);
    const handlePrint = useReactToPrint({ contentRef: ticketRef });

    const seriales = useLiveQuery(
        () => negocioId ? db.seriales.where('negocio_id').equals(negocioId).toArray() : [],
        [negocioId]
    ) ?? [];

    const productosMap = useLiveQuery(async () => {
        if (!negocioId) return new Map<string, string>();
        const prods = await db.productos.where('negocio_id').equals(negocioId).toArray();
        return new Map(prods.map(p => [p.id, p.nombre]));
    }, [negocioId]) ?? new Map<string, string>();

    const nombreProducto = (id: string) => productosMap.get(id) ?? 'Producto';

    const q = norm(busqueda).trim();
    const buscando = q.length >= 2;

    const resultados = useMemo(() => {
        // Sin búsqueda: mostrar los equipos VENDIDOS recientes (para encontrarlos
        // por producto/fecha/cliente cuando no recuerdas el IMEI).
        if (!buscando) {
            return seriales
                .filter(s => s.estado === 'vendido')
                .sort((a, b) => (b.fecha_venta ?? 0) - (a.fecha_venta ?? 0))
                .slice(0, 30);
        }
        return seriales
            .filter(s => norm(s.numero_serial).includes(q) || norm(s.cliente_nombre).includes(q) || norm(nombreProducto(s.producto_id)).includes(q))
            .sort((a, b) => (b.fecha_venta ?? 0) - (a.fecha_venta ?? 0))
            .slice(0, 50);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seriales, q, buscando, productosMap]);

    const imprimirCert = (s: SerialLocal) => {
        setCert({ serial: s, nombre: nombreProducto(s.producto_id) });
        setTimeout(() => handlePrint(), 120);
    };

    const guardarAjuste = async () => {
        if (!ajustando) return;
        const dias = parseInt(diasAjuste) || 0;
        const base = ajustando.fecha_venta ?? Date.now();
        await db.seriales.update(ajustando.id, {
            garantia_dias: dias,
            garantia_hasta: dias > 0 ? base + dias * DIA : null,
            estado_sincronizacion: 0,
            fecha_actualizacion: Date.now(),
        });
        setAjustando(null);
        showToast('Garantía actualizada.', 'success');
    };

    // ─── Candado de plan Pro ──────────────────────────────────────────────
    if (planTier !== 'pro') {
        const linkWa = `https://wa.me/${WHATSAPP_NUMBER_SOPORTE}?text=${encodeURIComponent('Hola, quiero activar Garantías por IMEI (Plan Pro) en VentaRD.')}`;
        return (
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <OfflineBanner />
                <div className="flex-1 flex items-center justify-center p-6">
                    <div className="max-w-lg w-full text-center bg-navy-2 border border-gold/25 rounded-2xl p-8">
                        <span className="text-5xl block mb-4">🛡️</span>
                        <h1 className="text-2xl font-display font-black text-white mb-2">Garantías por IMEI</h1>
                        <p className="text-vr-gray text-sm mb-6">Disponible en el <span className="text-gold font-bold">Plan Pro</span>. Busca cualquier IMEI vendido y ve si está en garantía, con certificado imprimible.</p>
                        <a href={linkWa} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 bg-gold-gradient text-navy px-7 py-3.5 rounded-2xl font-extrabold hover:brightness-110 transition-all">
                            💬 Activar Plan Pro por WhatsApp
                        </a>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <PinGuard title="Garantías">
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <OfflineBanner />
                <div className="flex-1 p-3 sm:p-6 lg:p-8">
                    <div className="max-w-3xl mx-auto">
                        <div className="mb-4 sm:mb-6">
                            <h1 className="text-2xl sm:text-3xl font-display font-extrabold text-white flex items-center gap-2">
                                🛡️ Garantías
                                <span className="text-[10px] font-black bg-gold/15 text-gold px-2 py-0.5 rounded-full uppercase tracking-wider">Pro</span>
                            </h1>
                            <p className="text-vr-gray mt-0.5 text-sm">Busca por IMEI/serie para ver el estado de garantía de un equipo vendido.</p>
                        </div>

                        {/* Garantía por defecto al vender */}
                        <div className="bg-navy-2 border border-navy-3 rounded-xl p-3 mb-4 flex items-center justify-between gap-3 flex-wrap">
                            <div className="min-w-0">
                                <p className="text-sm font-bold text-white">Garantía por defecto al vender</p>
                                <p className="text-[11px] text-vr-gray">Se aplica automáticamente a cada producto con número de serie. 0 = sin garantía.</p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                <input
                                    type="number" min="0"
                                    className="w-20 bg-navy-3 border border-navy-3 rounded-lg p-2 text-white font-mono text-center focus:border-gold outline-none transition-all"
                                    value={garantiaDiasDefault}
                                    onChange={e => setGarantiaDiasDefault(parseInt(e.target.value) || 0)}
                                />
                                <span className="text-sm text-vr-gray font-bold">días</span>
                            </div>
                        </div>

                        {/* Buscador */}
                        <div className="flex gap-2 mb-4">
                            <input
                                type="text"
                                inputMode="search"
                                autoFocus
                                placeholder="Escribe o escanea el IMEI / serie…"
                                className="flex-1 bg-navy-2 border border-navy-3 rounded-xl px-4 py-3 text-white font-mono placeholder-vr-gray/50 focus:border-gold outline-none transition-all"
                                value={busqueda}
                                onChange={e => setBusqueda(e.target.value)}
                            />
                            <button
                                type="button"
                                onClick={() => setScanOpen(true)}
                                title="Escanear IMEI"
                                className="px-3.5 bg-navy-2 border border-navy-3 rounded-xl text-vr-gray hover:text-gold hover:border-gold/50 transition-all flex items-center shrink-0"
                            >
                                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" />
                                    <path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" />
                                    <line x1="7" y1="12" x2="7" y2="12.01" /><line x1="12" y1="12" x2="17" y2="12" />
                                    <line x1="7" y1="8" x2="7" y2="16" /><line x1="12" y1="8" x2="12" y2="16" />
                                    <line x1="17" y1="8" x2="17" y2="16" />
                                </svg>
                            </button>
                        </div>

                        {/* Encabezado de la lista */}
                        <p className="text-xs font-bold text-vr-gray uppercase tracking-wider mb-2">
                            {buscando ? 'Resultados' : 'Vendidos recientes'}
                        </p>

                        {/* Resultados */}
                        {resultados.length === 0 ? (
                            <div className="py-16 text-center text-vr-gray">
                                <span className="text-4xl block mb-3">{buscando ? '🤷' : '📭'}</span>
                                <p className="text-sm">
                                    {buscando
                                        ? 'No se encontró ningún equipo con ese IMEI/serie.'
                                        : 'Aún no hay equipos con número de serie vendidos.'}
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {resultados.map(s => {
                                    const eg = estadoGarantia(s);
                                    return (
                                        <div key={s.id} className="bg-navy-2 rounded-2xl border border-navy-3 p-4">
                                            <div className="flex items-start justify-between gap-3 flex-wrap">
                                                <div className="min-w-0 flex-1">
                                                    <p className="font-bold text-white text-sm truncate">{nombreProducto(s.producto_id)}</p>
                                                    <p className="font-mono text-gold text-sm mt-0.5">{s.numero_serial}</p>
                                                    <p className="text-xs text-vr-gray mt-1">
                                                        {s.estado === 'vendido'
                                                            ? `Vendido: ${s.fecha_venta ? new Date(s.fecha_venta).toLocaleDateString('es-DO') : '—'}`
                                                            : 'En inventario (no vendido)'}
                                                        {s.cliente_nombre ? ` · ${s.cliente_nombre}` : ''}
                                                        {typeof s.precio_venta === 'number' && s.precio_venta > 0 ? ` · ${formatDOP(s.precio_venta)}` : ''}
                                                    </p>
                                                </div>
                                                <span className={`px-2 py-1 rounded-md text-[11px] font-black border whitespace-nowrap shrink-0 ${eg.color}`}>{eg.label}</span>
                                            </div>
                                            {s.estado === 'vendido' && (
                                                <div className="flex items-center gap-2 flex-wrap mt-3">
                                                    <button onClick={() => imprimirCert(s)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-navy-3 text-vr-gray border border-navy-3 hover:text-white transition-all">🖨️ Certificado</button>
                                                    <button onClick={() => { setAjustando(s); setDiasAjuste(String(s.garantia_dias ?? 0)); }} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-gold hover:bg-gold/10 transition-all">Ajustar garantía</button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>

                {/* MODAL AJUSTE */}
                {ajustando && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                        <div className="bg-navy-2 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                            <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                                <div>
                                    <h2 className="text-xl font-display font-bold text-white">Ajustar garantía</h2>
                                    <p className="text-sm text-vr-gray mt-0.5 font-mono truncate">{ajustando.numero_serial}</p>
                                </div>
                                <button onClick={() => setAjustando(null)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                            </div>
                            <div className="p-4 sm:p-6 space-y-4">
                                <div>
                                    <label className="block text-xs font-bold text-vr-gray uppercase tracking-wider mb-1.5">Días de garantía</label>
                                    <input type="number" min="0" autoFocus className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono text-center focus:border-gold outline-none transition-all" value={diasAjuste} onChange={e => setDiasAjuste(e.target.value)} />
                                    <p className="text-[11px] text-vr-gray mt-1">Se cuenta desde la fecha de venta. 0 = sin garantía.</p>
                                </div>
                                <div className="flex gap-3">
                                    <button type="button" onClick={() => setAjustando(null)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                                    <button type="button" onClick={guardarAjuste} className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all">Guardar</button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Certificado oculto para impresión */}
            {cert && (
                <div style={{ display: 'none' }}>
                    <TicketGarantia
                        ref={ticketRef}
                        serial={cert.serial}
                        productoNombre={cert.nombre}
                        nombreNegocio={negocioNombre || 'VentaRD'}
                        rnc={negocioRnc || undefined}
                        direccion={negocioDireccion || undefined}
                        telefono={negocioTelefono || undefined}
                    />
                </div>
            )}

            {/* Scanner IMEI */}
            {scanOpen && (
                <Suspense fallback={null}>
                    <BarcodeScanner
                        onScan={(code) => { setBusqueda(code); setScanOpen(false); }}
                        onClose={() => setScanOpen(false)}
                    />
                </Suspense>
            )}
        </PinGuard>
    );
}
