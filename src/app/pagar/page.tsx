// src/app/pagar/page.tsx
// Página pública que abre el QR de cobro: muestra los datos de transferencia
// con formato claro y botón de copiar cuenta. Los datos vienen en el
// fragmento #d=... (el navegador nunca lo envía al servidor).
'use client';

import { useEffect, useState } from 'react';
import { leerLinkPago, DatosLinkPago } from '@/lib/linkPago';

export default function PagarPage() {
    const [datos, setDatos] = useState<DatosLinkPago | null | 'invalido'>(null);
    const [copiado, setCopiado] = useState(false);

    useEffect(() => {
        const d = leerLinkPago(window.location.hash);
        setDatos(d ?? 'invalido');
    }, []);

    const copiarCuenta = async () => {
        if (!datos || datos === 'invalido') return;
        try {
            await navigator.clipboard.writeText(datos.cuenta);
            setCopiado(true);
            setTimeout(() => setCopiado(false), 2000);
        } catch { /* sin clipboard */ }
    };

    if (datos === null) {
        return (
            <div className="min-h-screen bg-navy flex items-center justify-center">
                <div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    if (datos === 'invalido') {
        return (
            <div className="min-h-screen bg-navy flex flex-col items-center justify-center p-8 text-center">
                <p className="text-4xl mb-4">❓</p>
                <h1 className="text-xl font-display font-black text-white mb-2">Enlace de pago inválido</h1>
                <p className="text-vr-gray text-sm">Pide que te reenvíen el código QR o el enlace.</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-navy flex items-center justify-center p-4">
            <div className="w-full max-w-sm">
                <div className="bg-navy-2 border border-gold/30 rounded-3xl p-7 text-center shadow-2xl">
                    <p className="text-[11px] font-black text-gold uppercase tracking-widest mb-1">Datos para transferir</p>
                    <h1 className="font-display font-black text-xl text-white mb-6">{datos.nombre || 'Pago'}</h1>

                    <div className="bg-navy rounded-2xl border border-navy-3 p-5 mb-4 space-y-3 text-left">
                        <div>
                            <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Banco</p>
                            <p className="text-white font-bold">{datos.banco || '—'}</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Número de cuenta</p>
                            <div className="flex items-center justify-between gap-2">
                                <p className="text-gold font-mono font-bold text-lg break-all">{datos.cuenta}</p>
                                <button
                                    onClick={copiarCuenta}
                                    className="shrink-0 px-3 py-1.5 bg-navy-3 border border-navy-3 hover:border-gold/40 text-vr-gray hover:text-gold rounded-lg text-xs font-bold transition-all"
                                >
                                    {copiado ? '✓' : 'Copiar'}
                                </button>
                            </div>
                        </div>
                        <div>
                            <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Titular</p>
                            <p className="text-white font-bold">{datos.titular || '—'}</p>
                        </div>
                    </div>

                    <div className="bg-gold/10 border border-gold/25 rounded-2xl py-4 mb-5">
                        <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Monto a transferir</p>
                        <p className="font-display font-black text-3xl text-gold">
                            RD${datos.monto.toLocaleString('es-DO', { minimumFractionDigits: 2 })}
                        </p>
                    </div>

                    <p className="text-xs text-vr-gray leading-relaxed">
                        Copia la cuenta, abre la app de tu banco y transfiere el monto exacto. Luego envía el comprobante.
                    </p>
                </div>

                <p className="text-center text-[11px] text-vr-gray/60 mt-4">
                    Generado con <span className="font-bold text-gold">VentaRD</span>
                </p>
            </div>
        </div>
    );
}
