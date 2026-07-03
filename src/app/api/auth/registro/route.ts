// src/app/api/auth/registro/route.ts
// Registra al dueño de un negocio SIN email de confirmación.
// Crea el usuario ya confirmado con el service role (mismo patrón que la
// activación de empleados), eliminando la dependencia del correo de Supabase.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin, leerJson } from '@/lib/api/guardia';

const BodySchema = z.object({
    email: z.string().email('Correo inválido.').max(200),
    password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres.').max(200),
    nombreNegocio: z.string().trim().min(1, 'Completa todos los campos.').max(100),
});

export async function POST(req: NextRequest) {
    try {
        const r = await leerJson(req, BodySchema);
        if (r.resp) return r.resp;
        const { email, password, nombreNegocio } = r.data;

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
