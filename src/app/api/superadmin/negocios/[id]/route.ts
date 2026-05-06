// src/app/api/superadmin/negocios/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

async function verifyAdmin(req: NextRequest) {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return null;

    const admin = createAdminClient();
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return null;

    const superadminEmail = process.env.SUPERADMIN_EMAIL;
    if (!superadminEmail || user.email !== superadminEmail) return null;

    return user;
}

// PATCH /api/superadmin/negocios/[id]
// Body: { plan_activo?: boolean } | { trial_hasta?: number | null }
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const user = await verifyAdmin(req);
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const { id } = await params;
    const body = await req.json();
    const admin = createAdminClient();

    const updateData: Record<string, unknown> = {};
    if (typeof body.plan_activo === 'boolean') updateData.plan_activo = body.plan_activo;
    if ('trial_hasta' in body) updateData.trial_hasta = body.trial_hasta;

    if (Object.keys(updateData).length === 0) {
        return NextResponse.json({ error: 'Nada que actualizar' }, { status: 400 });
    }

    const { error } = await admin.from('negocios').update(updateData).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
}
