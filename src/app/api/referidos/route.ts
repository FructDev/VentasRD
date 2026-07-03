// src/app/api/referidos/route.ts
// Devuelve (y crea si falta) el código de referido del negocio del usuario,
// junto con cuántos referidos exitosos lleva. Requiere sesión.
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { DIAS_REFERIDO, generarCodigoReferido } from '@/lib/referidos';

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function GET(req: NextRequest) {
    try {
        const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!token) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token);
        if (userErr || !user) return NextResponse.json({ error: 'Sesión inválida' }, { status: 401 });

        const { data: negocio } = await supabaseAdmin
            .from('negocios')
            .select('id, codigo_referido, referidos_total')
            .eq('dueño_id', user.id)
            .maybeSingle();

        if (!negocio) return NextResponse.json({ error: 'Sin negocio' }, { status: 404 });

        let codigo = negocio.codigo_referido as string | null;
        if (!codigo) {
            for (let intento = 0; intento < 5; intento++) {
                const c = generarCodigoReferido();
                const { error } = await supabaseAdmin.from('negocios').update({ codigo_referido: c }).eq('id', negocio.id);
                if (!error) { codigo = c; break; }
            }
        }

        return NextResponse.json({
            codigo,
            total: (negocio.referidos_total as number) || 0,
            dias: DIAS_REFERIDO,
        });
    } catch (e) {
        console.error('[referidos]', e);
        return NextResponse.json({ error: 'Error' }, { status: 500 });
    }
}
