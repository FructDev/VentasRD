// src/app/api/superadmin/negocios/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import crypto from 'crypto';

function verifyAdmin(req: NextRequest): boolean {
    const secret = req.headers.get('x-superadmin-secret');
    const expected = process.env.SUPERADMIN_SECRET;
    return !!expected && secret === expected;
}

// PATCH /api/superadmin/negocios/[id]
// Body: { plan_activo?: boolean } | { trial_hasta?: number | null }
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    if (!verifyAdmin(req)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const { id } = await params;
    const body = await req.json();
    const admin = createAdminClient();

    const updateData: Record<string, unknown> = {};
    if (typeof body.plan_activo === 'boolean') updateData.plan_activo = body.plan_activo;
    if (body.plan_tier === 'pro' || body.plan_tier === 'basico') updateData.plan_tier = body.plan_tier;
    if ('trial_hasta' in body) updateData.trial_hasta = body.trial_hasta;
    if ('acceso_hasta' in body) updateData.acceso_hasta = body.acceso_hasta;
    if ('nota_operador' in body) updateData.nota_operador = body.nota_operador;
    // Reseteo de PIN: el operador manda 4 dígitos en claro; se guarda hasheado (SHA-256)
    if (typeof body.pin_nuevo === 'string' && /^\d{4}$/.test(body.pin_nuevo)) {
        updateData.pin_admin = crypto.createHash('sha256').update(body.pin_nuevo).digest('hex');
    }

    if (Object.keys(updateData).length === 0) {
        return NextResponse.json({ error: 'Nada que actualizar' }, { status: 400 });
    }

    const { error } = await admin.from('negocios').update(updateData).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Bitácora de pagos (best-effort: no rompe la acción si la tabla no existe).
    // monto/metodo/plan convierten la bitácora en libro de facturación.
    if ('acceso_hasta' in body) {
        try {
            await admin.from('pagos_log').insert({
                negocio_id: id,
                dias: typeof body.dias === 'number' ? body.dias : null,
                nuevo_acceso_hasta: body.acceso_hasta ?? null,
                nota: typeof body.nota === 'string' ? body.nota : null,
                monto: typeof body.monto === 'number' && body.monto > 0 ? body.monto : null,
                metodo: typeof body.metodo === 'string' ? body.metodo : null,
                plan: typeof body.plan === 'string' ? body.plan : null,
            });
        } catch { /* tabla pagos_log no creada aún */ }
    }

    return NextResponse.json({ ok: true });
}
