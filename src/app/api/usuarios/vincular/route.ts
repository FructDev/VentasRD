// src/app/api/usuarios/vincular/route.ts
// Vincula un user_id al registro pendiente de usuarios_negocio
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function POST(req: NextRequest) {
    try {
        const { token, userId } = await req.json();
        if (!token || !userId) {
            return NextResponse.json({ error: 'Datos incompletos' }, { status: 400 });
        }

        const { error } = await supabaseAdmin
            .from('usuarios_negocio')
            .update({ user_id: userId })
            .eq('invite_token', token)
            .is('user_id', null);

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        return NextResponse.json({ ok: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
