// scripts/verify-stock-concurrente.mjs
// Verifica que el sistema de movimientos de stock (Fase 1) resuelve el problema
// de cajas simultáneas:
//   1. Dos "cajas" venden el mismo producto AL MISMO TIEMPO → el stock final cuadra
//   2. Reintento del mismo movimiento (timeout + retry) → no se aplica dos veces
//   3. Conteo físico (valor absoluto) → pisa el stock correctamente
//
// Requiere: haber corrido scripts/sql/fase1_movimientos_stock.sql en Supabase.
// Usa el service role key de .env.local (solo crea/borra datos de prueba propios).
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';

// Cargar .env.local a mano (sin dependencias)
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

// ─── Setup: negocio y producto de prueba ──────────────────────────────────────
const NEGOCIO_ID = randomUUID();
const PRODUCTO_ID = randomUUID();

console.log('\n── Setup: creando datos de prueba ──');
{
    const { error: e1 } = await supabase.from('negocios').insert({
        id: NEGOCIO_ID, nombre: '__TEST_FASE1__', pin_admin: 'x', plan_activo: false,
    });
    if (e1) { console.error('No se pudo crear negocio de prueba:', e1.message); process.exit(1); }

    const { error: e2 } = await supabase.from('productos').insert({
        id: PRODUCTO_ID, negocio_id: NEGOCIO_ID, nombre: '__Coca Cola Test__',
        codigo_barras: '', precio_venta: 75, costo: 50,
        stock_actual: 20, stock_minimo: 2, tasa_itbis: 0.18, tipo: 'simple',
        fecha_actualizacion: Date.now(),
    });
    if (e2) { console.error('No se pudo crear producto de prueba:', e2.message); process.exit(1); }
    console.log('   Producto creado con stock inicial: 20');
}

const mov = (delta, extra = {}) => supabase.rpc('aplicar_movimiento_stock', {
    p_id: randomUUID(),
    p_negocio_id: NEGOCIO_ID,
    p_sucursal_id: null,
    p_producto_id: PRODUCTO_ID,
    p_delta: delta,
    p_tipo: 'venta',
    p_referencia_id: null,
    p_fecha_creacion: Date.now(),
    p_valor_absoluto: null,
    ...extra,
});

const leerStock = async () => {
    const { data } = await supabase.from('productos').select('stock_actual').eq('id', PRODUCTO_ID).single();
    return Number(data?.stock_actual);
};

try {
    // ─── Test 1: dos cajas venden simultáneamente ─────────────────────────────
    console.log('\n── Test 1: Caja A vende 7 y Caja B vende 4 AL MISMO TIEMPO ──');
    const [r1, r2] = await Promise.all([mov(-7), mov(-4)]);
    check('Ambas RPCs ejecutaron sin error', !r1.error && !r2.error,
        r1.error?.message || r2.error?.message || '');
    const stock1 = await leerStock();
    check('Stock final correcto: 20 - 7 - 4 = 9', stock1 === 9, `stock en nube: ${stock1}`);

    // ─── Test 2: idempotencia (reintento del mismo movimiento) ────────────────
    console.log('\n── Test 2: el mismo movimiento se reintenta (timeout + retry) ──');
    const movId = randomUUID();
    const params = {
        p_id: movId, p_negocio_id: NEGOCIO_ID, p_sucursal_id: null,
        p_producto_id: PRODUCTO_ID, p_delta: -2, p_tipo: 'venta',
        p_referencia_id: null, p_fecha_creacion: Date.now(), p_valor_absoluto: null,
    };
    await supabase.rpc('aplicar_movimiento_stock', params);
    await supabase.rpc('aplicar_movimiento_stock', params); // reintento idéntico
    const stock2 = await leerStock();
    check('El reintento NO descuenta dos veces: 9 - 2 = 7', stock2 === 7, `stock en nube: ${stock2}`);

    // ─── Test 3: conteo físico (valor absoluto) ───────────────────────────────
    console.log('\n── Test 3: conteo físico establece el stock exacto ──');
    await supabase.rpc('aplicar_movimiento_stock', {
        p_id: randomUUID(), p_negocio_id: NEGOCIO_ID, p_sucursal_id: null,
        p_producto_id: PRODUCTO_ID, p_delta: 0, p_tipo: 'conteo',
        p_referencia_id: null, p_fecha_creacion: Date.now(), p_valor_absoluto: 50,
    });
    const stock3 = await leerStock();
    check('Conteo pisa el stock: → 50', stock3 === 50, `stock en nube: ${stock3}`);

    // ─── Test 4: kardex registrado ────────────────────────────────────────────
    const { data: movs } = await supabase.from('movimientos_stock')
        .select('id').eq('negocio_id', NEGOCIO_ID);
    check('Kardex: 4 movimientos registrados (no 5 — el reintento no duplica)', movs?.length === 4, `${movs?.length} movimientos`);

} finally {
    // ─── Limpieza ─────────────────────────────────────────────────────────────
    console.log('\n── Limpieza de datos de prueba ──');
    await supabase.from('movimientos_stock').delete().eq('negocio_id', NEGOCIO_ID);
    await supabase.from('productos').delete().eq('id', PRODUCTO_ID);
    await supabase.from('negocios').delete().eq('id', NEGOCIO_ID);
    console.log('   Datos de prueba eliminados.');
}

console.log(fallos === 0 ? '\n🎉 Fase 1 verificada: el stock multi-caja es a prueba de balas' : `\n⚠️ ${fallos} verificación(es) fallaron`);
process.exit(fallos === 0 ? 0 : 1);
