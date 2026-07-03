// src/lib/api/guardia.ts
// Guardias compartidas de las API routes: validación de entrada (zod) y
// autenticación/autorización. Toda ruta que use el service role DEBE pasar
// por aquí — el service role ignora RLS, así que la ruta es la única defensa.
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

/** Parsea y valida el body JSON contra un esquema zod. */
export async function leerJson<S extends z.ZodTypeAny>(
    req: NextRequest | Request,
    schema: S,
): Promise<{ data: z.infer<S>; resp?: never } | { data?: never; resp: NextResponse }> {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return { resp: NextResponse.json({ error: 'Body JSON inválido' }, { status: 400 }) };
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        const detalle = parsed.error.issues[0];
        return {
            resp: NextResponse.json(
                { error: `Datos inválidos: ${detalle?.path.join('.') || 'body'} — ${detalle?.message || ''}` },
                { status: 400 },
            ),
        };
    }
    return { data: parsed.data };
}

/** Devuelve el usuario autenticado del header Authorization, o null. */
export async function usuarioDesdeToken(req: NextRequest | Request) {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    return error ? null : user;
}

/**
 * Verifica que el usuario sea miembro del negocio (dueño o empleado activo).
 * Devuelve el rol efectivo o null.
 */
export async function rolEnNegocio(userId: string, negocioId: string): Promise<'dueño' | string | null> {
    const { data: negocio } = await supabaseAdmin
        .from('negocios')
        .select('id')
        .eq('id', negocioId)
        .eq('dueño_id', userId)
        .maybeSingle();
    if (negocio) return 'dueño';

    const { data: emp } = await supabaseAdmin
        .from('usuarios_negocio')
        .select('rol')
        .eq('negocio_id', negocioId)
        .eq('user_id', userId)
        .eq('activo', true)
        .maybeSingle();
    return emp?.rol ?? null;
}

/** Respuestas estándar. */
export const noAutorizado = () => NextResponse.json({ error: 'No autorizado' }, { status: 401 });
export const prohibido = () => NextResponse.json({ error: 'Sin permiso para este negocio' }, { status: 403 });

// ── Rate limiting (en memoria) ───────────────────────────────────────────────
// Ventana deslizante simple por IP+ruta. En serverless cada instancia tiene su
// propio contador (no es un límite global exacto), pero frena eficazmente los
// scripts de fuerza bruta y el scraping, que golpean la misma instancia caliente.
// Si algún día hace falta un límite global estricto: Upstash Redis.
const ventanas = new Map<string, number[]>();
let ultimaLimpieza = Date.now();

/**
 * Devuelve true si la petición excede el límite (y debe rechazarse).
 * @param limite máximo de peticiones por ventana
 * @param ventanaMs tamaño de la ventana en ms
 */
export function excedeLimite(req: NextRequest | Request, clave: string, limite: number, ventanaMs: number): boolean {
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
        || req.headers.get('x-real-ip')
        || 'ip-desconocida';
    const k = `${clave}:${ip}`;
    const ahora = Date.now();

    // Limpieza perezosa para que el Map no crezca sin límite
    if (ahora - ultimaLimpieza > 10 * 60 * 1000) {
        for (const [key, ts] of ventanas) {
            if (ts.every(t => ahora - t > ventanaMs)) ventanas.delete(key);
        }
        ultimaLimpieza = ahora;
    }

    const marcas = (ventanas.get(k) || []).filter(t => ahora - t < ventanaMs);
    if (marcas.length >= limite) { ventanas.set(k, marcas); return true; }
    marcas.push(ahora);
    ventanas.set(k, marcas);
    return false;
}

export const demasiadasPeticiones = () =>
    NextResponse.json({ error: 'Demasiadas peticiones. Intenta de nuevo en unos minutos.' }, { status: 429 });
