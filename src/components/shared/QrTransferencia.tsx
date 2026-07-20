// src/components/shared/QrTransferencia.tsx
// QR de cobro por transferencia: el cliente lo escanea con la cámara y ve
// banco/cuenta/titular + el monto exacto — sin dictar números de cuenta.
// El QR es texto plano (funciona offline y con cualquier lector).
'use client';

import { useEffect, useState } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { crearLinkPago } from '@/lib/linkPago';
import { formatDOP } from '@/lib/utils';

export default function QrTransferencia({ monto }: { monto: number }) {
    const datosPago = useConfigStore(s => s.datosPago);
    const negocioNombre = useConfigStore(s => s.negocioNombre);
    const [qr, setQr] = useState<string | null>(null);

    useEffect(() => {
        let vivo = true;
        if (!datosPago?.cuenta) { setQr(null); return; }
        // El QR contiene un LINK a /pagar: los QR de texto con numeros de
        // cuenta los leen mal los celulares (los interpretan como telefono).
        const texto = crearLinkPago({ banco: datosPago.banco, cuenta: datosPago.cuenta, titular: datosPago.titular, monto, nombre: negocioNombre || undefined });
        import('qrcode')
            .then(QR => QR.toDataURL(texto, { width: 280, margin: 1, color: { dark: '#0D1B2E', light: '#FFFFFF' } }))
            .then(url => { if (vivo) setQr(url); })
            .catch(() => { if (vivo) setQr(null); });
        return () => { vivo = false; };
    }, [datosPago, monto, negocioNombre]);

    if (!datosPago?.cuenta) return null;

    return (
        <div className="bg-navy rounded-xl border border-navy-3 p-4 flex flex-col sm:flex-row items-center gap-4">
            {qr ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qr} alt="QR de transferencia" className="w-36 h-36 rounded-lg bg-white p-1 shrink-0" />
            ) : (
                <div className="w-36 h-36 rounded-lg bg-navy-3 animate-pulse shrink-0" />
            )}
            <div className="text-center sm:text-left min-w-0">
                <p className="text-xs font-black text-vr-gray uppercase tracking-wider mb-1">El cliente escanea y transfiere</p>
                <p className="text-sm text-white font-bold truncate">{datosPago.banco || 'Banco'}</p>
                <p className="text-base text-gold font-mono font-bold">{datosPago.cuenta}</p>
                {datosPago.titular && <p className="text-xs text-vr-gray truncate">{datosPago.titular}</p>}
                <p className="text-lg font-black font-mono text-white mt-1">{formatDOP(monto)}</p>
            </div>
        </div>
    );
}
