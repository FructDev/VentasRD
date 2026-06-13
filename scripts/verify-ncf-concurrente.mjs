// scripts/verify-ncf-concurrente.mjs
// Verifica la secuencia NCF centralizada (Fase 2):
//   1. Dos cajas reservan bloques AL MISMO TIEMPO → bloques sin solapamiento
//   2. La secuencia se agota limpiamente → nunca emite fuera del rango DGII
//   3. Reconfigurar el rango NO retrocede la secuencia (no re-emite números usados)
//
// Requiere: haber corrido scripts/sql/fase2_ncf_central.sql en Supabase.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
}

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

let fallos = 0;
function check(nombre, ok, detalle = '') {
    console.log(`${ok ? '✅' : '❌'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
    if (!ok) fallos++;
}

const NEGOCIO_ID = randomUUID();
const reservar = (cantidad) => supabase.rpc('reservar_ncf', { p_negocio_id: NEGOCIO_ID, p_cantidad: cantidad });

console.log('\n── Setup: negocio de prueba con secuencia B02 del 1 al 50 ──');
{
    const { error: e1 } = await supabase.from('negocios').insert({
        id: NEGOCIO_ID, nombre: '__TEST_FASE2__', pin_admin: 'x', plan_activo: false,
    });
    if (e1) { console.error('No se pudo crear negocio:', e1.message); process.exit(1); }

    const { error: e2 } = await supabase.rpc('configurar_ncf', {
        p_negocio_id: NEGOCIO_ID, p_tipo: 'B02', p_desde: 1, p_hasta: 50, p_habilitado: true,
    });
    if (e2) { console.error('configurar_ncf falló:', e2.message); process.exit(1); }
    console.log('   Secuencia creada: B02, 1-50');
}

try {
    // ─── Test 1: reservas simultáneas ─────────────────────────────────────────
    console.log('\n── Test 1: Caja A y Caja B reservan 20 números AL MISMO TIEMPO ──');
    const [r1, r2] = await Promise.all([reservar(20), reservar(20)]);
    const b1 = r1.data?.[0];
    const b2 = r2.data?.[0];
    check('Ambas reservas devolvieron bloque', !!b1 && !!b2,
        r1.error?.message || r2.error?.message || `A: ${b1?.bloque_desde}-${b1?.bloque_hasta}, B: ${b2?.bloque_desde}-${b2?.bloque_hasta}`);

    if (b1 && b2) {
        const sinSolape = Number(b1.bloque_hasta) < Number(b2.bloque_desde) || Number(b2.bloque_hasta) < Number(b1.bloque_desde);
        check('Bloques SIN solapamiento (cero NCF duplicados)', sinSolape,
            `A: ${b1.bloque_desde}-${b1.bloque_hasta}, B: ${b2.bloque_desde}-${b2.bloque_hasta}`);
        const total = (Number(b1.bloque_hasta) - Number(b1.bloque_desde) + 1) + (Number(b2.bloque_hasta) - Number(b2.bloque_desde) + 1);
        check('Se asignaron exactamente 40 números', total === 40, `${total} números`);
    }

    // ─── Test 2: agotamiento limpio ───────────────────────────────────────────
    console.log('\n── Test 2: agotar la secuencia (quedan 10 de 50) ──');
    const r3 = await reservar(20); // pide 20, solo quedan 10
    const b3 = r3.data?.[0];
    check('Entrega solo los 10 restantes (no inventa números)',
        b3 && Number(b3.bloque_desde) === 41 && Number(b3.bloque_hasta) === 50,
        b3 ? `${b3.bloque_desde}-${b3.bloque_hasta}` : 'sin bloque');

    const r4 = await reservar(20); // ya no queda nada
    check('Secuencia agotada → no devuelve bloque (nunca emite fuera del rango DGII)',
        !r4.error && (!r4.data || r4.data.length === 0),
        r4.error?.message || `${r4.data?.length ?? 0} filas`);

    // ─── Test 3: reconfigurar no retrocede ────────────────────────────────────
    console.log('\n── Test 3: el dueño amplía el rango (1-100) — no debe re-emitir 1-50 ──');
    await supabase.rpc('configurar_ncf', {
        p_negocio_id: NEGOCIO_ID, p_tipo: 'B02', p_desde: 1, p_hasta: 100, p_habilitado: true,
    });
    const r5 = await reservar(5);
    const b5 = r5.data?.[0];
    check('La siguiente reserva continúa en 51 (no vuelve al 1)',
        b5 && Number(b5.bloque_desde) === 51,
        b5 ? `${b5.bloque_desde}-${b5.bloque_hasta}` : 'sin bloque');

} finally {
    console.log('\n── Limpieza ──');
    await supabase.from('ncf_secuencias').delete().eq('negocio_id', NEGOCIO_ID);
    await supabase.from('negocios').delete().eq('id', NEGOCIO_ID);
    console.log('   Datos de prueba eliminados.');
}

console.log(fallos === 0 ? '\n🎉 Fase 2 verificada: NCF duplicados imposibles' : `\n⚠️ ${fallos} verificación(es) fallaron`);
process.exit(fallos === 0 ? 0 : 1);
