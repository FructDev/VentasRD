// src/app/api/catalogo/[negocioId]/route.ts
// Catálogo público de un negocio (sin sesión). Usa el service role para leer,
// pero SOLO expone campos seguros y únicamente si el dueño activó el catálogo
// (catalogo_publico = true). Nunca devuelve costo, stock ni datos internos.
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, excedeLimite, demasiadasPeticiones } from '@/lib/api/guardia';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers = { 'Cache-Control': 'no-store' };

export async function GET(req: NextRequest, { params }: { params: Promise<{ negocioId: string }> }) {
    try {
        // Público: frenar el scraping/sondeo de UUIDs (60 peticiones por IP / 5 min)
        if (excedeLimite(req, 'catalogo', 60, 5 * 60 * 1000)) return demasiadasPeticiones();

        const { negocioId } = await params;
        // Validar formato UUID antes de consultar (evita ruido y sondeos)
        if (!uuid.test(negocioId || '')) {
            return NextResponse.json({ error: 'Catálogo no disponible' }, { status: 404, headers });
        }

        const after = req.nextUrl.searchParams.get('after');
        if (after !== null && !uuid.test(after)) return NextResponse.json({ error: 'Página inválida' }, { status: 400, headers });
        const { data: page, error: nativeError } = await supabaseAdmin.rpc('native_public_catalogue_page_v1', {
            p_negocio_id: negocioId, p_after_id: after,
        });
        if (!nativeError) return NextResponse.json(page, { headers });
        if (nativeError.message === 'NATIVE_CATALOGUE_UNAVAILABLE') return NextResponse.json({ error: 'Catálogo no disponible' }, { status: 404, headers });
        // Compatibility with the existing web deployment before native schema.
        // An installed RPC failure must never fall back to old public metadata.
        if (!['PGRST202', '42883'].includes(nativeError.code)) return NextResponse.json({ error: 'No se pudo consultar el catálogo' }, { status: 503, headers });

        const { data: negocio, error: businessError } = await supabaseAdmin
            .from('negocios')
            .select('id, nombre, whatsapp_dueno, telefono, direccion, logo_url, color_marca, catalogo_publico')
            .eq('id', negocioId)
            .maybeSingle();

        if (businessError) return NextResponse.json({ error: 'No se pudo consultar el catálogo' }, { status: 503, headers });

        if (!negocio || !negocio.catalogo_publico) {
            return NextResponse.json({ error: 'Catálogo no disponible' }, { status: 404, headers });
        }

        let query = supabaseAdmin
            .from('productos')
            .select('id, nombre, precio_venta, imagen_url')
            .eq('negocio_id', negocioId)
            .or('eliminado.is.null,eliminado.eq.false')
            .order('id', { ascending: true })
            .limit(201);
        if (after) query = query.gt('id', after);
        const { data: productos, error: productsError } = await query;
        if (productsError) return NextResponse.json({ error: 'No se pudo consultar el catálogo' }, { status: 503, headers });
        const rows = (productos || []).slice(0, 200);

        return NextResponse.json({
            negocio: {
                nombre: negocio.nombre,
                whatsapp: negocio.whatsapp_dueno || negocio.telefono || null,
                direccion: negocio.direccion || null,
                logo_url: negocio.logo_url || null,
                color_marca: negocio.color_marca || 'dorado',
            },
            productos: rows,
            nextId: (productos?.length || 0) > 200 ? rows.at(-1)?.id : null,
        }, { headers });
    } catch {
        console.error('[catalogo] No se pudo completar la consulta');
        return NextResponse.json({ error: 'Error al cargar el catálogo' }, { status: 500, headers });
    }
}
