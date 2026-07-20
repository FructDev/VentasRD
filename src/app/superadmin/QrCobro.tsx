// src/app/superadmin/QrCobro.tsx
// Generador de QR de cobro para el OPERADOR de VentaRD: en vez de dictar la
// cuenta bancaria a cada cliente, genera un QR con banco/cuenta/titular y el
// monto del plan, listo para descargar o compartir por WhatsApp.
// Los datos bancarios se guardan solo en este dispositivo (localStorage).
'use client';

import { useEffect, useState } from 'react';
import { crearLinkPago } from '@/lib/linkPago';

const DATOS_KEY = 'vrd_sa_datos_cobro';

const MONTOS_RAPIDOS = [
    { label: 'Básico mensual', monto: 900 },
    { label: 'Pro mensual', monto: 1200 },
    { label: 'Básico anual', monto: 9000 },
    { label: 'Pro anual', monto: 12000 },
];

interface DatosCobro { banco: string; cuenta: string; titular: string; }

export default function QrCobro() {
    const [abierto, setAbierto] = useState(false);
    const [datos, setDatos] = useState<DatosCobro>({ banco: '', cuenta: '', titular: '' });
    const [monto, setMonto] = useState('900');
    const [qr, setQr] = useState<string | null>(null);

    useEffect(() => {
        try {
            const guardado = JSON.parse(localStorage.getItem(DATOS_KEY) || 'null') as DatosCobro | null;
            if (guardado) setDatos(guardado);
        } catch { /* sin datos guardados */ }
    }, []);

    const actualizar = (d: DatosCobro) => {
        setDatos(d);
        try { localStorage.setItem(DATOS_KEY, JSON.stringify(d)); } catch { /* lleno */ }
    };

    // Regenerar el QR al cambiar datos o monto
    useEffect(() => {
        let vivo = true;
        const m = parseFloat(monto) || 0;
        if (!datos.cuenta.trim() || m <= 0) { setQr(null); return; }
        // El QR contiene un LINK (los QR de texto con numeros de cuenta los
        // leen mal los celulares: los interpretan como telefono)
        const texto = crearLinkPago({ banco: datos.banco.trim(), cuenta: datos.cuenta.trim(), titular: datos.titular.trim(), monto: m, nombre: 'VentaRD' });
        import('qrcode')
            .then(QR => QR.toDataURL(texto, { width: 480, margin: 2, color: { dark: '#0D1B2E', light: '#FFFFFF' } }))
            .then(url => { if (vivo) setQr(url); })
            .catch(() => { if (vivo) setQr(null); });
        return () => { vivo = false; };
    }, [datos, monto]);

    const descargar = () => {
        if (!qr) return;
        const a = document.createElement('a');
        a.href = qr;
        a.download = `cobro-ventard-${monto}.png`;
        a.click();
    };

    const compartir = async () => {
        if (!qr) return;
        try {
            const blob = await (await fetch(qr)).blob();
            const file = new File([blob], `cobro-ventard-${monto}.png`, { type: 'image/png' });
            if (navigator.canShare?.({ files: [file] })) {
                await navigator.share({ files: [file], title: 'Pago VentaRD' });
                return;
            }
        } catch { /* cancelado o no soportado */ }
        descargar(); // fallback: descargar y que lo adjunte a mano
    };

    return (
        <div className="bg-navy-2 border border-navy-3 rounded-2xl mb-6 overflow-hidden">
            <button
                onClick={() => setAbierto(v => !v)}
                className="w-full flex items-center justify-between px-4 sm:px-5 py-3.5 hover:bg-navy-3/40 transition-colors"
            >
                <span className="font-display font-bold text-white text-sm">💳 QR para cobrar VentaRD</span>
                <span className={`text-gold transition-transform ${abierto ? 'rotate-180' : ''}`}>▾</span>
            </button>

            {abierto && (
                <div className="px-4 sm:px-5 pb-5 border-t border-navy-3 pt-4">
                    <p className="text-xs text-vr-gray mb-4">
                        Genera un QR con tus datos bancarios y el monto del plan — se lo envías al cliente por WhatsApp en vez de dictarle la cuenta. Tus datos se guardan solo en este equipo.
                    </p>

                    <div className="grid md:grid-cols-2 gap-5">
                        {/* Formulario */}
                        <div className="space-y-3">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <input type="text" placeholder="Banco"
                                    className="bg-navy border border-navy-3 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-gold"
                                    value={datos.banco} onChange={e => actualizar({ ...datos, banco: e.target.value })} />
                                <input type="text" placeholder="Titular"
                                    className="bg-navy border border-navy-3 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-gold"
                                    value={datos.titular} onChange={e => actualizar({ ...datos, titular: e.target.value })} />
                            </div>
                            <input type="text" placeholder="Número de cuenta"
                                className="w-full bg-navy border border-navy-3 rounded-xl px-3 py-2.5 text-sm text-white font-mono outline-none focus:border-gold"
                                value={datos.cuenta} onChange={e => actualizar({ ...datos, cuenta: e.target.value })} />

                            <div className="flex flex-wrap gap-2">
                                {MONTOS_RAPIDOS.map(m => (
                                    <button key={m.monto}
                                        onClick={() => setMonto(String(m.monto))}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${monto === String(m.monto) ? 'bg-gold/15 text-gold border-gold/40' : 'bg-navy border-navy-3 text-vr-gray hover:text-white'}`}>
                                        {m.label} · RD${m.monto.toLocaleString()}
                                    </button>
                                ))}
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-vr-gray text-sm font-mono">RD$</span>
                                <input type="number" min="0"
                                    className="w-32 bg-navy border border-navy-3 rounded-xl px-3 py-2 text-white font-mono text-sm outline-none focus:border-gold"
                                    value={monto} onChange={e => setMonto(e.target.value)} />
                                <span className="text-[11px] text-vr-gray">monto personalizado</span>
                            </div>
                        </div>

                        {/* QR + acciones */}
                        <div className="flex flex-col items-center justify-center gap-3">
                            {qr ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={qr} alt="QR de cobro" className="w-44 h-44 rounded-xl bg-white p-2" />
                            ) : (
                                <div className="w-44 h-44 rounded-xl bg-navy border border-dashed border-navy-3 flex items-center justify-center text-vr-gray text-xs text-center px-4">
                                    Completa la cuenta y el monto para generar el QR
                                </div>
                            )}
                            <div className="flex gap-2">
                                <button onClick={descargar} disabled={!qr}
                                    className="px-4 py-2 bg-navy-3 border border-navy-4 text-white rounded-xl text-xs font-bold hover:bg-navy-4 transition-all disabled:opacity-40">
                                    ⬇️ Descargar PNG
                                </button>
                                <button onClick={compartir} disabled={!qr}
                                    className="px-4 py-2 bg-vr-green/15 text-vr-green border border-vr-green/20 rounded-xl text-xs font-bold hover:bg-vr-green/25 transition-all disabled:opacity-40">
                                    📱 Compartir
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
