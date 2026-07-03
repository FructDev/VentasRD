// src/app/api/upload/logo/route.ts
// Sube el logo del negocio a Cloudinary (firmado server-side, el API secret nunca
// llega al navegador). Recibe un data URL ya comprimido por el cliente.
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { z } from 'zod';
import { leerJson, usuarioDesdeToken, rolEnNegocio, noAutorizado, prohibido } from '@/lib/api/guardia';

const BodySchema = z.object({
    // El cliente comprime a ~240px; un data URL razonable no pasa de ~500KB
    dataUrl: z.string().startsWith('data:image/').max(2_000_000),
    negocioId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
    try {
        const r = await leerJson(req, BodySchema);
        if (r.resp) return r.resp;
        const { dataUrl, negocioId } = r.data;

        // Solo un miembro del negocio puede cambiar su logo
        const user = await usuarioDesdeToken(req);
        if (!user) return noAutorizado();
        if (!(await rolEnNegocio(user.id, negocioId))) return prohibido();

        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;
        if (!cloudName || !apiKey || !apiSecret) {
            return NextResponse.json({ error: 'Cloudinary no está configurado en el servidor' }, { status: 500 });
        }

        // Un logo por negocio: mismo public_id → cada subida reemplaza la anterior
        const publicId = `ventard/logos/${negocioId}`;
        const timestamp = Math.floor(Date.now() / 1000);

        // Firma: sha1 de los parámetros ordenados alfabéticamente + api_secret
        const paramsToSign = `overwrite=true&public_id=${publicId}&timestamp=${timestamp}`;
        const signature = crypto.createHash('sha1').update(paramsToSign + apiSecret).digest('hex');

        const form = new FormData();
        form.append('file', dataUrl);
        form.append('public_id', publicId);
        form.append('overwrite', 'true');
        form.append('timestamp', String(timestamp));
        form.append('api_key', apiKey);
        form.append('signature', signature);

        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
            method: 'POST',
            body: form,
        });
        const data = await res.json();

        if (!res.ok) {
            console.error('[upload/logo] Cloudinary error:', data?.error?.message);
            return NextResponse.json({ error: data?.error?.message || 'Error al subir la imagen' }, { status: 502 });
        }

        return NextResponse.json({ ok: true, url: data.secure_url });
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
