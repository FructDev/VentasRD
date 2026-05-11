// src/app/api/sync/inventario/route.ts
// Server-side endpoint that uses the service role key (bypasses RLS) to upsert
// inventory records. The service role key MUST stay server-side only.
import { createClient } from '@supabase/supabase-js';

interface StockItem {
    sucursal_id: string;
    producto_id: string;
    stock_actual: number;
    stock_minimo: number;
    estado_sincronizacion: number;
    fecha_actualizacion: number;
}

export async function POST(request: Request) {
    try {
        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );

        const { items }: { items: StockItem[] } = await request.json();

        if (!items || items.length === 0) {
            return Response.json({ ok: true, count: 0 });
        }

        const { error } = await supabaseAdmin
            .from('inventario_sucursales')
            .upsert(items, { onConflict: 'sucursal_id,producto_id' });

        if (error) {
            console.error('[api/sync/inventario] error:', error.message);
            return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        return Response.json({ ok: true, count: items.length });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return Response.json({ ok: false, error: msg }, { status: 500 });
    }
}
