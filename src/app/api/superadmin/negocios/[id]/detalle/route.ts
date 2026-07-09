// src/app/api/superadmin/negocios/[id]/detalle/route.ts
// Métricas de actividad de un negocio (para el panel de detalle del operador).
// Cada métrica es best-effort: si una tabla/función no existe aún, devuelve 0/null
// sin tumbar el resto.
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

function verifyAdmin(req: NextRequest): boolean {
    const secret = req.headers.get('x-superadmin-secret');
    const expected = process.env.SUPERADMIN_SECRET;
    return !!expected && secret === expected;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!verifyAdmin(req)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const { id } = await params;
    const admin = createAdminClient();

    const contar = async (tabla: string) => {
        try {
            const { count } = await admin.from(tabla).select('id', { count: 'exact', head: true }).eq('negocio_id', id);
            return count ?? 0;
        } catch { return 0; }
    };

    const [sucursales, productos, ventas, clientes, empleados] = await Promise.all([
        contar('sucursales'), contar('productos'), contar('ventas'), contar('clientes'), contar('usuarios_negocio'),
    ]);

    // Última venta (best-effort)
    let ultimaVenta: number | null = null;
    try {
        const { data } = await admin.from('ventas')
            .select('fecha_creacion').eq('negocio_id', id)
            .order('fecha_creacion', { ascending: false }).limit(1).maybeSingle();
        ultimaVenta = data?.fecha_creacion ?? null;
    } catch { /* tabla vacía */ }

    // Total facturado (RPC; si no existe la función aún, queda null)
    let totalFacturado: number | null = null;
    try {
        const { data, error } = await admin.rpc('total_ventas_negocio', { p_negocio_id: id });
        if (!error) totalFacturado = Number(data) || 0;
    } catch { /* función no creada */ }

    // Historial de pagos (si la tabla aún no existe, lista vacía)
    let pagos: { dias: number | null; nuevo_acceso_hasta: number | null; nota: string | null; creado_en: string }[] = [];
    try {
        const { data } = await admin.from('pagos_log')
            .select('dias, nuevo_acceso_hasta, nota, creado_en, monto, metodo, plan')
            .eq('negocio_id', id).order('creado_en', { ascending: false }).limit(12);
        pagos = data ?? [];
    } catch { /* tabla no creada */ }

    return NextResponse.json({ sucursales, productos, ventas, clientes, empleados, ultimaVenta, totalFacturado, pagos });
}
