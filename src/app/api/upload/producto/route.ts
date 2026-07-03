// src/app/api/upload/producto/route.ts
// Sube la foto de un producto a Cloudinary (firmado server-side).
// Mismo patrón que /api/upload/logo: un public_id por producto → cada
// subida reemplaza la anterior, sin acumular archivos.
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { z } from 'zod';
import { supabaseAdmin, leerJson, usuarioDesdeToken, rolEnNegocio, noAutorizado, prohibido } from '@/lib/api/guardia';

const BodySchema = z.object({
    dataUrl: z.string().startsWith('data:image/').max(2_000_000),
    productoId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
    try {
        const r = await leerJson(req, BodySchema);
        if (r.resp) return r.resp;
        const { dataUrl, productoId } = r.data;

        // Solo un miembro del negocio dueño del producto puede cambiar su foto.
        // (El producto puede aún no estar sincronizado a la nube: en ese caso
        // basta con que el usuario tenga sesión — el public_id es su UUID local.)
        const user = await usuarioDesdeToken(req);
        if (!user) return noAutorizado();
        const { data: prod } = await supabaseAdmin
            .from('productos').select('negocio_id').eq('id', productoId).maybeSingle();
        if (prod && !(await rolEnNegocio(user.id, prod.negocio_id))) return prohibido();

        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;
        if (!cloudName || !apiKey || !apiSecret) {
            return NextResponse.json({ error: 'Cloudinary no está configurado en el servidor' }, { status: 500 });
        }

        const publicId = `ventard/productos/${productoId}`;
        const timestamp = Math.floor(Date.now() / 1000);
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
            console.error('[upload/producto] Cloudinary error:', data?.error?.message);
            return NextResponse.json({ error: data?.error?.message || 'Error al subir la imagen' }, { status: 502 });
        }

        return NextResponse.json({ ok: true, url: data.secure_url });
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
