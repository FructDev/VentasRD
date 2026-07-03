// src/app/api/usuarios/activar/route.ts
// GET  — verifica el token y devuelve nombre/email del empleado pendiente
// POST — crea la cuenta con contraseña y la vincula al negocio
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin, leerJson, excedeLimite, demasiadasPeticiones } from '@/lib/api/guardia';

const BodySchema = z.object({
    token: z.string().uuid(),
    password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres.').max(200),
});

// GET /api/usuarios/activar?token=XXX
export async function GET(req: NextRequest) {
    // Público (llega por link de invitación): frenar fuerza bruta de tokens
    if (excedeLimite(req, 'activar-get', 20, 5 * 60 * 1000)) return demasiadasPeticiones();
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
        if (excedeLimite(req, 'activar-post', 10, 15 * 60 * 1000)) return demasiadasPeticiones();
        const r = await leerJson(req, BodySchema);
        if (r.resp) return r.resp;
        const { token, password } = r.data;

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
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Error inesperado';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
