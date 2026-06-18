// src/app/api/usuarios/invitar/route.ts
// Crea un empleado pendiente con un token propio — sin emails ni links de Supabase
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

// Dominio base para el link de invitación. Robusto: prioriza la env var explícita,
// si no, usa el dominio real del request (en Vercel coincide con el dominio del
// usuario), luego VERCEL_URL, y solo en desarrollo cae a localhost.
function getBaseUrl(req: NextRequest): string {
    const explicit = process.env.NEXT_PUBLIC_SITE_URL;
    if (explicit) return explicit.replace(/\/$/, '');

    const origin = req.headers.get('origin');
    if (origin) return origin.replace(/\/$/, '');

    const host = req.headers.get('host');
    if (host) {
        const proto = req.headers.get('x-forwarded-proto') || (host.startsWith('localhost') ? 'http' : 'https');
        return `${proto}://${host}`;
    }

    const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    if (vercel) return `https://${vercel}`;

    return 'http://localhost:3000';
}

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

        const inviteLink = `${getBaseUrl(req)}/unirse?token=${nuevo.invite_token}`;

        return NextResponse.json({ ok: true, inviteLink });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
