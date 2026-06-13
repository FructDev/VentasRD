// src/app/api/usuarios/invitar/route.ts
// Crea un empleado pendiente con un token propio — sin emails ni links de Supabase
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function POST(req: NextRequest) {
    try {
        const { email, nombre, rol, negocioId } = await req.json();
        if (!email || !nombre || !rol || !negocioId) {
            return NextResponse.json({ error: 'Datos incompletos' }, { status: 400 });
        }

        // Verificar duplicado
        const { data: existe } = await supabaseAdmin
            .from('usuarios_negocio')
            .select('id')
            .eq('negocio_id', negocioId)
            .eq('email', email)
            .maybeSingle();
        if (existe) {
            return NextResponse.json({ error: 'Este email ya está registrado en tu equipo.' }, { status: 409 });
        }

        // Crear registro pendiente — user_id omitido, la BD lo deja null por defecto
        const { data: nuevo, error: insErr } = await supabaseAdmin
            .from('usuarios_negocio')
            .insert({ negocio_id: negocioId, nombre, email, rol, activo: true })
            .select('invite_token')
            .single();

        if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
        const inviteLink = `${siteUrl}/unirse?token=${nuevo.invite_token}`;

        return NextResponse.json({ ok: true, inviteLink });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
