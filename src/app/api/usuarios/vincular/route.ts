// src/app/api/usuarios/vincular/route.ts
// Vincula un user_id al registro pendiente de usuarios_negocio
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin, leerJson, excedeLimite, demasiadasPeticiones } from '@/lib/api/guardia';

const BodySchema = z.object({
    token: z.string().uuid(),
    userId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
    try {
        if (excedeLimite(req, 'vincular', 10, 15 * 60 * 1000)) return demasiadasPeticiones();
        const r = await leerJson(req, BodySchema);
        if (r.resp) return r.resp;
        const { token, userId } = r.data;

        const { error } = await supabaseAdmin
            .from('usuarios_negocio')
            .update({ user_id: userId })
            .eq('invite_token', token)
            .is('user_id', null);

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        return NextResponse.json({ ok: true });
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Error inesperado';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
