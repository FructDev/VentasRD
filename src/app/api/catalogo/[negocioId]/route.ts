// src/app/api/catalogo/[negocioId]/route.ts
// Catálogo público de un negocio (sin sesión). Usa el service role para leer,
// pero SOLO expone campos seguros y únicamente si el dueño activó el catálogo
// (catalogo_publico = true). Nunca devuelve costo, stock ni datos internos.
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, excedeLimite, demasiadasPeticiones } from '@/lib/api/guardia';

export async function GET(req: NextRequest, { params }: { params: Promise<{ negocioId: string }> }) {
    try {
        // Público: frenar el scraping/sondeo de UUIDs (60 peticiones por IP / 5 min)
        if (excedeLimite(req, 'catalogo', 60, 5 * 60 * 1000)) return demasiadasPeticiones();

        const { negocioId } = await params;
        // Validar formato UUID antes de consultar (evita ruido y sondeos)
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(negocioId || '')) {
            return NextResponse.json({ error: 'Catálogo no disponible' }, { status: 404 });
        }

        const { data: negocio } = await supabaseAdmin
            .from('negocios')
            .select('id, nombre, whatsapp_dueno, telefono, direccion, logo_url, color_marca, catalogo_publico')
            .eq('id', negocioId)
            .maybeSingle();

        if (!negocio || !negocio.catalogo_publico) {
            return NextResponse.json({ error: 'Catálogo no disponible' }, { status: 404 });
        }

        const { data: productos } = await supabaseAdmin
            .from('productos')
            .select('id, nombre, precio_venta, imagen_url')
            .eq('negocio_id', negocioId)
            .or('eliminado.is.null,eliminado.eq.false')
            .order('nombre', { ascending: true });

        return NextResponse.json({
            negocio: {
                nombre: negocio.nombre,
                whatsapp: negocio.whatsapp_dueno || negocio.telefono || null,
                direccion: negocio.direccion || null,
                logo_url: negocio.logo_url || null,
                color_marca: negocio.color_marca || 'dorado',
            },
            productos: productos || [],
        }, { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600' } });
    } catch (e) {
        console.error('[catalogo]', e);
        return NextResponse.json({ error: 'Error al cargar el catálogo' }, { status: 500 });
    }
}
