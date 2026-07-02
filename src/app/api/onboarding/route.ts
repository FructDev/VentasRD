// src/app/api/onboarding/route.ts
// Completa el onboarding del dueño con el service role (ignora RLS), operando
// SIEMPRE sobre el negocio del usuario autenticado (por dueño_id). Esto evita el
// fallo "new row violates row-level security policy" cuando el negocio quedó con
// un dueño_id inconsistente o el cliente tenía un negocioId viejo cacheado.
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function POST(req: NextRequest) {
    try {
        const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!token) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        // Verificar al usuario por su token de sesión
        const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token);
        if (userErr || !user) return NextResponse.json({ error: 'Sesión inválida' }, { status: 401 });

        const { tipo_negocio, telefono, direccion, nombre_sucursal } = await req.json();
        const ahora = Date.now();

        // 1. Buscar el negocio del usuario (por dueño). Si no existe, crearlo.
        let negocioId: string;
        const { data: negExistente } = await supabaseAdmin
            .from('negocios')
            .select('id')
            .eq('dueño_id', user.id)
            .maybeSingle();

        if (negExistente?.id) {
            negocioId = negExistente.id;
            const { error: updErr } = await supabaseAdmin
                .from('negocios')
                .update({ telefono, tipo_negocio, direccion, onboarding_completado: true })
                .eq('id', negocioId);
            if (updErr) throw updErr;
        } else {
            const nombreInicial = (user.user_metadata?.nombre_negocio as string) || 'Mi Negocio';
            const { data: nuevo, error: insErr } = await supabaseAdmin
                .from('negocios')
                .insert({
                    dueño_id: user.id,
                    nombre: nombreInicial,
                    telefono,
                    tipo_negocio,
                    direccion,
                    pin_admin: '1234',
                    plan_activo: false,
                    trial_hasta: ahora + 30 * 24 * 60 * 60 * 1000,
                    onboarding_completado: true,
                })
                .select('id')
                .single();
            if (insErr) throw insErr;
            negocioId = nuevo.id;
        }

        // 2. Crear la primera sucursal (service role → sin bloqueo de RLS)
        const sucursalNombre = (nombre_sucursal || '').trim() || 'Local Principal';
        const sucursalId = uuidv4();
        const { error: sucErr } = await supabaseAdmin
            .from('sucursales')
            .insert({ id: sucursalId, negocio_id: negocioId, nombre: sucursalNombre, direccion, fecha_creacion: ahora });
        if (sucErr) throw sucErr;

        return NextResponse.json({ ok: true, negocioId, sucursalId, sucursalNombre, fecha_creacion: ahora });
    } catch (e: unknown) {
        const err = e as { message?: string; code?: string };
        console.error('[onboarding api]', err?.code, err?.message);
        return NextResponse.json({ error: err?.message || 'Error al guardar', code: err?.code }, { status: 500 });
    }
}
