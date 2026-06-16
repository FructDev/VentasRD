// src/app/api/superadmin/negocios/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

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
    if ('trial_hasta' in body) updateData.trial_hasta = body.trial_hasta;
    if ('acceso_hasta' in body) updateData.acceso_hasta = body.acceso_hasta;

    if (Object.keys(updateData).length === 0) {
        return NextResponse.json({ error: 'Nada que actualizar' }, { status: 400 });
    }

    const { error } = await admin.from('negocios').update(updateData).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Bitácora de pagos (best-effort: no rompe la acción si la tabla no existe)
    if ('acceso_hasta' in body) {
        try {
            await admin.from('pagos_log').insert({
                negocio_id: id,
                dias: typeof body.dias === 'number' ? body.dias : null,
                nuevo_acceso_hasta: body.acceso_hasta ?? null,
                nota: typeof body.nota === 'string' ? body.nota : null,
            });
        } catch { /* tabla pagos_log no creada aún */ }
    }

    return NextResponse.json({ ok: true });
}
