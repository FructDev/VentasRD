// src/app/api/sync/inventario/route.ts
// Server-side endpoint that uses the service role key (bypasses RLS) to upsert
// inventory records. The service role key MUST stay server-side only.
// Requiere sesión: solo un miembro del negocio puede escribir, y únicamente
// sobre sucursales de SU negocio.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin, leerJson, usuarioDesdeToken, noAutorizado, prohibido } from '@/lib/api/guardia';

const BodySchema = z.object({
    items: z.array(z.object({
        sucursal_id: z.string().uuid(),
        producto_id: z.string().uuid(),
        stock_actual: z.number().finite(),
        stock_minimo: z.number().finite(),
        estado_sincronizacion: z.number(),
        fecha_actualizacion: z.number(),
    })).max(2000),
});

export async function POST(req: NextRequest) {
    try {
        const user = await usuarioDesdeToken(req);
        if (!user) return noAutorizado();

        const r = await leerJson(req, BodySchema);
        if (r.resp) return r.resp;
        const { items } = r.data;

        if (items.length === 0) return NextResponse.json({ ok: true, count: 0 });

        // Negocio del usuario: dueño o empleado activo
        let negocioId: string | null = null;
        const { data: propio } = await supabaseAdmin
            .from('negocios').select('id').eq('dueño_id', user.id)
            .order('onboarding_completado', { ascending: false }).limit(1).maybeSingle();
        if (propio) negocioId = propio.id;
        else {
            const { data: emp } = await supabaseAdmin
                .from('usuarios_negocio').select('negocio_id').eq('user_id', user.id).eq('activo', true).maybeSingle();
            negocioId = emp?.negocio_id ?? null;
        }
        if (!negocioId) return prohibido();

        // Todas las sucursales referidas deben ser de ese negocio
        const sucursalesRef = [...new Set(items.map(i => i.sucursal_id))];
        const { data: sucursales } = await supabaseAdmin
            .from('sucursales').select('id').eq('negocio_id', negocioId).in('id', sucursalesRef);
        if ((sucursales?.length ?? 0) !== sucursalesRef.length) return prohibido();

        const { error } = await supabaseAdmin
            .from('inventario_sucursales')
            .upsert(items, { onConflict: 'sucursal_id,producto_id' });

        if (error) {
            console.error('[api/sync/inventario] error:', error.message);
            return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
        }

        return NextResponse.json({ ok: true, count: items.length });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return NextResponse.json({ ok: false, error: msg }, { status: 500 });
    }
}
