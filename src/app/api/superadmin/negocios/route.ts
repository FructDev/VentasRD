// src/app/api/superadmin/negocios/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

function verifyAdmin(req: NextRequest): boolean {
    const secret = req.headers.get('x-superadmin-secret');
    const expected = process.env.SUPERADMIN_SECRET;
    return !!expected && secret === expected;
}

export async function GET(req: NextRequest) {
    if (!verifyAdmin(req)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const admin = createAdminClient();

    const { data: negocios, error: negociosError } = await admin
        .from('negocios')
        .select('id, nombre, telefono, tipo_negocio, whatsapp_dueno, plan_activo, plan_tier, trial_hasta, acceso_hasta, onboarding_completado, direccion, nota_operador');

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
        // Ordenar por vencimiento más próximo primero (a quién cobrar/avisar)
        .sort((a, b) => (a.acceso_hasta ?? a.trial_hasta ?? Infinity) - (b.acceso_hasta ?? b.trial_hasta ?? Infinity));

    return NextResponse.json(result);
}
