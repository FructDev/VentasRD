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
        .select('id, nombre, "dueño_id", telefono, tipo_negocio, whatsapp_dueno, plan_activo, plan_tier, trial_hasta, acceso_hasta, onboarding_completado, direccion, nota_operador');

    if (negociosError) {
        return NextResponse.json({ error: negociosError.message }, { status: 500 });
    }

    const { data: { users }, error: usersError } = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (usersError) {
        return NextResponse.json({ error: usersError.message }, { status: 500 });
    }

    const usersMap = new Map(users.map(u => [u.id, u]));

    // Cuentas registradas desde el mismo dispositivo (detección de trials ciclados)
    const porDispositivo = new Map<string, number>();
    for (const u of users) {
        const d = (u.user_metadata as { device_id?: string } | null)?.device_id;
        if (d) porDispositivo.set(d, (porDispositivo.get(d) || 0) + 1);
    }

    const result = (negocios || [])
        .map(n => {
            const dueno = usersMap.get((n as { 'dueño_id'?: string })['dueño_id'] || '');
            const deviceId = (dueno?.user_metadata as { device_id?: string } | null)?.device_id;
            return {
                ...n,
                // El email vive en auth.users, indexado por el id del DUEÑO (no del negocio)
                email: dueno?.email || '',
                created_at: dueno?.created_at || '',
                // >1 = este dispositivo registró más de una cuenta (posible ciclado de trials)
                cuentas_mismo_dispositivo: deviceId ? (porDispositivo.get(deviceId) || 1) : 1,
            };
        })
        // Ordenar por vencimiento más próximo primero (a quién cobrar/avisar)
        .sort((a, b) => (a.acceso_hasta ?? a.trial_hasta ?? Infinity) - (b.acceso_hasta ?? b.trial_hasta ?? Infinity));

    return NextResponse.json(result);
}
