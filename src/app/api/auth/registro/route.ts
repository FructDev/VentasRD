// src/app/api/auth/registro/route.ts
// Registra al dueño de un negocio SIN email de confirmación.
// Crea el usuario ya confirmado con el service role (mismo patrón que la
// activación de empleados), eliminando la dependencia del correo de Supabase.
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function POST(req: NextRequest) {
    try {
        const { email, password, nombreNegocio } = await req.json();

        if (!email || !password || !nombreNegocio) {
            return NextResponse.json({ error: 'Completa todos los campos.' }, { status: 400 });
        }
        if (String(password).length < 6) {
            return NextResponse.json({ error: 'La contraseña debe tener al menos 6 caracteres.' }, { status: 400 });
        }

        // Crea el usuario ya confirmado — no se envía ningún correo.
        // El trigger handle_new_user crea el negocio usando nombre_negocio.
        const { error: createErr } = await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { nombre_negocio: nombreNegocio },
        });

        if (createErr) {
            const msg = /already|exist|registered|duplicate/i.test(createErr.message)
                ? 'Ya existe una cuenta con este correo. Inicia sesión.'
                : createErr.message;
            return NextResponse.json({ error: msg }, { status: 400 });
        }

        return NextResponse.json({ ok: true });
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Error al crear la cuenta';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
