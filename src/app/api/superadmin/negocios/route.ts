// src/app/api/superadmin/negocios/route.ts
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

export async function GET(req: NextRequest) {
    const user = await verifyAdmin(req);
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const admin = createAdminClient();

    const { data: negocios, error: negociosError } = await admin
        .from('negocios')
        .select('id, nombre, telefono, tipo_negocio, whatsapp_dueno, plan_activo, trial_hasta, onboarding_completado, direccion');

    if (negociosError) {
        return NextResponse.json({ error: negociosError.message }, { status: 500 });
    }

    const { data: { users }, error: usersError } = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (usersError) {
        return NextResponse.json({ error: usersError.message }, { status: 500 });
    }

    const usersMap = new Map(users.map(u => [u.id, u]));

    const result = (negocios || [])
        .map(n => ({
            ...n,
            email: usersMap.get(n.id)?.email || '',
            created_at: usersMap.get(n.id)?.created_at || '',
        }))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return NextResponse.json(result);
}
