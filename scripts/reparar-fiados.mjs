// scripts/reparar-fiados.mjs
// Diagnóstico y reparación de deudas de fiado perdidas: encuentra ventas con
// metodo_pago='fiado' que NO tienen su cargo en transacciones_fiado (el push
// en lote se envenenaba con una fila mala y dejaba de subir cargos) y crea
// el cargo faltante con el total de la venta.
//
// Uso:
//   node scripts/reparar-fiados.mjs                → diagnóstico global (no escribe)
//   node scripts/reparar-fiados.mjs --negocio <id> → diagnóstico de un negocio
//   node scripts/reparar-fiados.mjs --aplicar      → crea los cargos faltantes
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
}
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const NEGOCIO_ID = get('--negocio');
const APLICAR = args.includes('--aplicar');

async function main() {
    // 1. Todas las ventas fiado (con cliente) del alcance
    let q = supabase.from('ventas')
        .select('id, negocio_id, cliente_id, total, fecha_creacion')
        .eq('metodo_pago', 'fiado')
        .not('cliente_id', 'is', null)
        .order('fecha_creacion', { ascending: true })
        .limit(10000);
    if (NEGOCIO_ID) q = q.eq('negocio_id', NEGOCIO_ID);
    const { data: ventas, error: vErr } = await q;
    if (vErr) { console.error('Error leyendo ventas:', vErr.message); process.exit(1); }
    console.log(`Ventas fiado encontradas: ${ventas.length}`);

    // 2. Cargos existentes para esas ventas (por lotes de ids)
    const conCargo = new Set();
    for (let i = 0; i < ventas.length; i += 300) {
        const ids = ventas.slice(i, i + 300).map(v => v.id);
        const { data: trans, error: tErr } = await supabase.from('transacciones_fiado')
            .select('venta_id').eq('tipo', 'cargo').in('venta_id', ids);
        if (tErr) { console.error('Error leyendo transacciones:', tErr.message); process.exit(1); }
        for (const t of trans ?? []) conCargo.add(t.venta_id);
    }

    // 3. Las ventas fiado SIN cargo = deuda perdida
    const faltantes = ventas.filter(v => !conCargo.has(v.id));
    if (faltantes.length === 0) {
        console.log('✅ Todas las ventas fiado tienen su cargo. Nada que reparar.');
        return;
    }

    // Resumen por negocio
    const porNegocio = new Map();
    for (const v of faltantes) {
        const acc = porNegocio.get(v.negocio_id) || { n: 0, monto: 0 };
        acc.n++; acc.monto += Number(v.total) || 0;
        porNegocio.set(v.negocio_id, acc);
    }
    console.log(`\n⚠️  ${faltantes.length} ventas fiado SIN cargo (deuda no reflejada):\n`);
    for (const [neg, acc] of porNegocio) {
        const { data: n } = await supabase.from('negocios').select('nombre').eq('id', neg).maybeSingle();
        console.log(`  ${n?.nombre || neg}: ${acc.n} ventas · RD$${acc.monto.toLocaleString()} de deuda perdida`);
    }

    if (!APLICAR) {
        console.log('\nEsto fue solo diagnóstico. Para crear los cargos faltantes:');
        console.log(`  node scripts/reparar-fiados.mjs ${NEGOCIO_ID ? `--negocio ${NEGOCIO_ID} ` : ''}--aplicar`);
        return;
    }

    // 4. Reparar: crear el cargo faltante con los datos de la venta.
    //    fecha_actualizacion = ahora → los dispositivos lo bajan en el próximo pull.
    let ok = 0;
    for (const v of faltantes) {
        const { error } = await supabase.from('transacciones_fiado').insert({
            id: randomUUID(),
            negocio_id: v.negocio_id,
            cliente_id: v.cliente_id,
            venta_id: v.id,
            tipo: 'cargo',
            monto: v.total,
            concepto: 'Compra en POS (cargo reparado)',
            fecha_creacion: new Date(v.fecha_creacion).toISOString(),
            fecha_actualizacion: Date.now(),
        });
        if (error) console.error(`  ✗ venta ${v.id}: ${error.code} ${error.message}`);
        else ok++;
    }
    console.log(`\n✅ ${ok}/${faltantes.length} cargos reparados. Los dispositivos los bajarán en el próximo sync.`);
}

main();
