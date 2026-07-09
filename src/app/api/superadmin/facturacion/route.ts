// src/app/api/superadmin/facturacion/route.ts
// Facturación de la empresa: suma de pagos registrados en el mes actual
// y el anterior (para comparar). Fuente: pagos_log con monto.
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

    const ahora = new Date();
    const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1).toISOString();
    const inicioMesPasado = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1).toISOString();

    try {
        const { data } = await admin
            .from('pagos_log')
            .select('monto, creado_en')
            .gte('creado_en', inicioMesPasado)
            .not('monto', 'is', null);

        let mesActual = 0, pagosActual = 0, mesPasado = 0;
        for (const p of data ?? []) {
            if (p.creado_en >= inicioMes) { mesActual += Number(p.monto) || 0; pagosActual++; }
            else mesPasado += Number(p.monto) || 0;
        }
        return NextResponse.json({ mesActual, pagosActual, mesPasado });
    } catch {
        return NextResponse.json({ mesActual: 0, pagosActual: 0, mesPasado: 0 });
    }
}
