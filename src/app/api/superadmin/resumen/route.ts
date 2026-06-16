// src/app/api/superadmin/resumen/route.ts
// Resumen global para el operador: pagos registrados este mes (para calcular
// lo cobrado). Best-effort: si pagos_log no existe aún, devuelve 0.
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
    const inicioMes = new Date();
    inicioMes.setDate(1);
    inicioMes.setHours(0, 0, 0, 0);

    let pagosMes = 0;
    try {
        // Cada "Pago +30d" (dias = 30) cuenta como una renovación cobrada este mes
        const { count } = await admin.from('pagos_log')
            .select('id', { count: 'exact', head: true })
            .eq('dias', 30)
            .gte('creado_en', inicioMes.toISOString());
        pagosMes = count ?? 0;
    } catch { /* tabla no creada */ }

    return NextResponse.json({ pagosMes });
}
