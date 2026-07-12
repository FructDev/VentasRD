// src/app/api/onboarding/route.ts
// Completa el onboarding del dueño con el service role (ignora RLS), operando
// SIEMPRE sobre el negocio del usuario autenticado (por dueño_id). Esto evita el
// fallo "new row violates row-level security policy" cuando el negocio quedó con
// un dueño_id inconsistente o el cliente tenía un negocioId viejo cacheado.
import { NextRequest, NextResponse } from 'next/server';
import { SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { DIAS_REFERIDO, generarCodigoReferido } from '@/lib/referidos';
import { supabaseAdmin, leerJson } from '@/lib/api/guardia';

const BodySchema = z.object({
    tipo_negocio: z.string().trim().max(60).optional(),
    telefono: z.string().trim().max(30).optional(),
    direccion: z.string().trim().max(300).optional(),
    nombre_sucursal: z.string().trim().max(100).optional(),
    ref: z.string().trim().max(20).optional(),
});

const DIA_MS = 24 * 60 * 60 * 1000;

/** Asegura que el negocio tenga un código de referido único; lo devuelve. */
async function asegurarCodigo(db: SupabaseClient, negocioId: string, actual: string | null): Promise<string> {
    if (actual) return actual;
    for (let intento = 0; intento < 5; intento++) {
        const codigo = generarCodigoReferido();
        const { error } = await db.from('negocios').update({ codigo_referido: codigo }).eq('id', negocioId);
        if (!error) return codigo;
    }
    return actual || '';
}

export async function POST(req: NextRequest) {
    try {
        const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!token) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        // Verificar al usuario por su token de sesión
        const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token);
        if (userErr || !user) return NextResponse.json({ error: 'Sesión inválida' }, { status: 401 });

        const r = await leerJson(req, BodySchema);
        if (r.resp) return r.resp;
        const { tipo_negocio, telefono, direccion, nombre_sucursal, ref } = r.data;
        const ahora = Date.now();

        // 1. Buscar el negocio del usuario (por dueño). Si no existe, crearlo.
        // limit(1): tolera negocios duplicados del bug histórico (maybeSingle a
        // secas lanza error con >1 fila y rompía el onboarding).
        let negocioId: string;
        const { data: negExistente } = await supabaseAdmin
            .from('negocios')
            .select('id')
            .eq('dueño_id', user.id)
            .order('onboarding_completado', { ascending: false })
            .limit(1)
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

        // 2. Primera sucursal (service role → sin bloqueo de RLS).
        // IDEMPOTENTE: si el negocio ya tiene una (reintento tras un timeout,
        // o re-entrada al onboarding), se reutiliza — antes cada reintento
        // creaba un "Local Principal" duplicado.
        const sucursalNombre = (nombre_sucursal || '').trim() || 'Local Principal';
        let sucursalId: string;
        let sucursalFecha = ahora;
        const { data: sucExistente } = await supabaseAdmin
            .from('sucursales')
            .select('id, nombre, fecha_creacion')
            .eq('negocio_id', negocioId)
            .limit(1)
            .maybeSingle();

        if (sucExistente) {
            sucursalId = sucExistente.id;
            sucursalFecha = sucExistente.fecha_creacion ?? ahora;
        } else {
            sucursalId = uuidv4();
            const { error: sucErr } = await supabaseAdmin
                .from('sucursales')
                .insert({ id: sucursalId, negocio_id: negocioId, nombre: sucursalNombre, direccion, fecha_creacion: ahora });
            if (sucErr) throw sucErr;
        }

        // 3. Programa de referidos ----------------------------------------------
        // Estado actual del negocio recién finalizado.
        const { data: negActual } = await supabaseAdmin
            .from('negocios')
            .select('id, codigo_referido, referido_acreditado, acceso_hasta, trial_hasta')
            .eq('id', negocioId)
            .maybeSingle();

        // Asegurar que este negocio tenga su propio código para invitar a otros.
        await asegurarCodigo(supabaseAdmin, negocioId, negActual?.codigo_referido ?? null);

        // Canjear el código de quien lo invitó (una sola vez, y no a sí mismo).
        const codigoRef = (ref || '').toString().trim().toUpperCase();
        let referidoAplicado = false;
        if (codigoRef && negActual && !negActual.referido_acreditado) {
            const { data: referente } = await supabaseAdmin
                .from('negocios')
                .select('id, acceso_hasta, trial_hasta')
                .eq('codigo_referido', codigoRef)
                .maybeSingle();

            if (referente && referente.id !== negocioId) {
                const bonus = DIAS_REFERIDO * DIA_MS;
                const nuevoAcceso = (base: number | null | undefined) => Math.max(ahora, base || ahora) + bonus;

                // Acreditar al invitado
                await supabaseAdmin.from('negocios').update({
                    referido_por: codigoRef,
                    referido_acreditado: true,
                    acceso_hasta: nuevoAcceso(negActual.acceso_hasta ?? negActual.trial_hasta),
                }).eq('id', negocioId);

                // Acreditar a quien invitó + sumar a su contador
                const { data: refCount } = await supabaseAdmin
                    .from('negocios').select('referidos_total').eq('id', referente.id).maybeSingle();
                await supabaseAdmin.from('negocios').update({
                    acceso_hasta: nuevoAcceso(referente.acceso_hasta ?? referente.trial_hasta),
                    referidos_total: ((refCount?.referidos_total as number) || 0) + 1,
                }).eq('id', referente.id);

                referidoAplicado = true;
            }
        }

        return NextResponse.json({ ok: true, negocioId, sucursalId, sucursalNombre: sucExistente?.nombre || sucursalNombre, fecha_creacion: sucursalFecha, referidoAplicado, diasReferido: DIAS_REFERIDO });
    } catch (e: unknown) {
        const err = e as { message?: string; code?: string };
        console.error('[onboarding api]', err?.code, err?.message);
        return NextResponse.json({ error: err?.message || 'Error al guardar', code: err?.code }, { status: 500 });
    }
}
