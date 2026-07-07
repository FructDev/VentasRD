// scripts/diagnostico-negocio.mjs
// Radiografía rápida de un negocio: cuántas filas tiene en cada tabla.
// Sirve para diagnosticar problemas de rendimiento (volumen de datos).
//
// Uso: node scripts/diagnostico-negocio.mjs --negocio <negocio_id>
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
}
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const NEGOCIO_ID = get('--negocio');
if (!NEGOCIO_ID) { console.error('Falta --negocio <negocio_id>'); process.exit(1); }

const TABLAS = [
    'productos', 'ventas', 'venta_detalles', 'transacciones_fiado', 'clientes',
    'gastos', 'movimientos_stock', 'devoluciones', 'seriales', 'cortes_caja',
    'reparaciones', 'apartados', 'composiciones', 'sucursales', 'usuarios_negocio',
];

async function contar(tabla) {
    const { count, error } = await supabase
        .from(tabla).select('*', { count: 'exact', head: true }).eq('negocio_id', NEGOCIO_ID);
    return error ? `— (${error.code || error.message})` : count;
}

async function main() {
    const { data: negocio } = await supabase
        .from('negocios').select('nombre, plan_tier, trial_hasta, acceso_hasta').eq('id', NEGOCIO_ID).maybeSingle();
    if (!negocio) { console.error('Negocio no encontrado.'); process.exit(1); }

    console.log(`\n📋 Diagnóstico: ${negocio.nombre} (plan ${negocio.plan_tier || 'basico'})`);
    console.log('─'.repeat(46));

    let totalFilas = 0;
    for (const t of TABLAS) {
        const c = await contar(t);
        if (typeof c === 'number') totalFilas += c;
        const alerta = typeof c === 'number' && c > 5000 ? '  ⚠️ ALTO' : (typeof c === 'number' && c > 1000 ? '  🔶' : '');
        console.log(`${t.padEnd(24)} ${String(c).padStart(8)}${alerta}`);
    }
    console.log('─'.repeat(46));
    console.log(`${'TOTAL'.padEnd(24)} ${String(totalFilas).padStart(8)}`);

    // Primera y última venta → antigüedad de los datos
    const { data: primera } = await supabase.from('ventas')
        .select('fecha_creacion').eq('negocio_id', NEGOCIO_ID)
        .order('fecha_creacion', { ascending: true }).limit(1).maybeSingle();
    const { data: ultima } = await supabase.from('ventas')
        .select('fecha_creacion').eq('negocio_id', NEGOCIO_ID)
        .order('fecha_creacion', { ascending: false }).limit(1).maybeSingle();
    if (primera && ultima) {
        const dias = Math.round((ultima.fecha_creacion - primera.fecha_creacion) / 86400000);
        console.log(`\nVentas: desde ${new Date(primera.fecha_creacion).toLocaleDateString('es-DO')} hasta ${new Date(ultima.fecha_creacion).toLocaleDateString('es-DO')} (${dias} días)`);
    }
    // Fotos de productos: las URLs de Cloudinary son livianas; una foto guardada
    // como data URL (base64) pesa cientos de KB por producto y arrastra la app.
    const { data: fotos } = await supabase.from('productos')
        .select('imagen_url').eq('negocio_id', NEGOCIO_ID).not('imagen_url', 'is', null);
    if (fotos?.length) {
        const base64 = fotos.filter(f => f.imagen_url.startsWith('data:'));
        const pesoKB = Math.round(base64.reduce((s, f) => s + f.imagen_url.length, 0) / 1024);
        console.log(`\nFotos de productos: ${fotos.length} (${base64.length} en base64${base64.length ? ` ≈ ${pesoKB} KB dentro de la tabla ⚠️` : ''})`);
        if (base64.length > 20) console.log('   ⚠️ Muchas fotos base64: probable causa de lentitud. Se migran a Cloudinary.');
    } else {
        console.log('\nFotos de productos: 0');
    }

    console.log('\n💡 Todo esto baja al dispositivo del usuario y vive en su IndexedDB.');
    console.log('   >5,000 filas en ventas/detalles/movimientos = candidato a lentitud en equipos modestos.\n');
}

main();
