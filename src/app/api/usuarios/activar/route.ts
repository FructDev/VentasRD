// src/app/api/usuarios/activar/route.ts
// GET  — verifica el token y devuelve nombre/email del empleado pendiente
// POST — crea la cuenta con contraseña y la vincula al negocio
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

// GET /api/usuarios/activar?token=XXX
export async function GET(req: NextRequest) {
    const token = req.nextUrl.searchParams.get('token');
    if (!token) return NextResponse.json({ error: 'Token requerido' }, { status: 400 });

    const { data, error } = await supabaseAdmin
        .from('usuarios_negocio')
        .select('nombre, email')
        .eq('invite_token', token)
        .eq('activo', true)
        .is('user_id', null)
        .maybeSingle();

    if (error || !data) {
        return NextResponse.json({ error: 'Token inválido o ya utilizado' }, { status: 404 });
    }

    return NextResponse.json({ nombre: data.nombre, email: data.email });
}

// POST /api/usuarios/activar  { token, password }
export async function POST(req: NextRequest) {
    try {
        const { token, password } = await req.json();
        if (!token || !password) return NextResponse.json({ error: 'Datos incompletos' }, { status: 400 });

        // 1. Obtener el empleado pendiente
        const { data: pendiente, error: fetchErr } = await supabaseAdmin
            .from('usuarios_negocio')
            .select('id, nombre, email, negocio_id')
            .eq('invite_token', token)
            .eq('activo', true)
            .is('user_id', null)
            .maybeSingle();

        if (fetchErr || !pendiente) {
            return NextResponse.json({ error: 'Token inválido o ya utilizado' }, { status: 404 });
        }

        // 2. Crear usuario en Supabase Auth con email ya confirmado
        //    is_empleado=true → el trigger handle_new_user omite la creación del negocio
        const { data: authData, error: createErr } = await supabaseAdmin.auth.admin.createUser({
            email: pendiente.email,
            password,
            email_confirm: true,
            user_metadata: { nombre_empleado: pendiente.nombre, is_empleado: true },
        });

        if (createErr) return NextResponse.json({ error: createErr.message }, { status: 500 });

        // 3. Vincular user_id al registro pendiente
        const { error: updateErr } = await supabaseAdmin
            .from('usuarios_negocio')
            .update({ user_id: authData.user.id })
            .eq('id', pendiente.id);

        if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

        return NextResponse.json({ ok: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
