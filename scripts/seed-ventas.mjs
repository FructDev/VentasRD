// scripts/seed-ventas.mjs
// Siembra ventas históricas de prueba (con detalles y cargos de fiado) para
// replicar una cuenta con meses de uso y reproducir problemas de rendimiento.
// Las ventas bajan al dispositivo con el sync normal (pull inicial las trae todas).
//
// Uso:
//   node scripts/seed-ventas.mjs --negocio <id> [--cantidad 2000] [--dias 90] [--sucursal <id>] [--borrar]
//
// Las ventas llevan caja_codigo 'TST' para identificarlas y limpiarlas después.
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
const CANTIDAD = parseInt(get('--cantidad') || '2000', 10);
const DIAS = parseInt(get('--dias') || '90', 10);
const SUCURSAL_ID = get('--sucursal');
const BORRAR = args.includes('--borrar');
const CAJA = 'TST';

if (!NEGOCIO_ID) { console.error('Falta --negocio <negocio_id>'); process.exit(1); }

const azar = (n) => Math.floor(Math.random() * n);
const METODOS = ['efectivo', 'efectivo', 'efectivo', 'tarjeta', 'transferencia', 'fiado']; // fiado ~17%

async function borrar() {
    // Orden: detalles → fiado → ventas (por integridad referencial)
    const { data: ventas } = await supabase.from('ventas')
        .select('id').eq('negocio_id', NEGOCIO_ID).eq('caja_codigo', CAJA);
    const ids = (ventas || []).map(v => v.id);
    console.log(`Encontradas ${ids.length} ventas [TST].`);
    for (let i = 0; i < ids.length; i += 200) {
        const lote = ids.slice(i, i + 200);
        await supabase.from('venta_detalles').delete().in('venta_id', lote);
        await supabase.from('transacciones_fiado').delete().in('venta_id', lote);
        await supabase.from('ventas').delete().in('id', lote);
        console.log(`  Borradas ${Math.min(i + 200, ids.length)}/${ids.length}`);
    }
    // Cliente de prueba del fiado
    await supabase.from('transacciones_fiado').delete().eq('negocio_id', NEGOCIO_ID).eq('concepto', '[TEST] Compra en POS');
    console.log('🧹 Limpio. En el dispositivo: borrar datos del sitio o esperar la purga.');
}

async function main() {
    const { data: negocio } = await supabase.from('negocios').select('id, nombre').eq('id', NEGOCIO_ID).maybeSingle();
    if (!negocio) { console.error('Negocio no encontrado.'); process.exit(1); }
    console.log(`Negocio: ${negocio.nombre}`);

    if (BORRAR) return borrar();

    // Productos disponibles (preferir los [TEST] del seed anterior)
    const { data: productos } = await supabase.from('productos')
        .select('id, nombre, precio_venta').eq('negocio_id', NEGOCIO_ID)
        .or('eliminado.is.null,eliminado.eq.false').limit(500);
    if (!productos?.length) { console.error('El negocio no tiene productos. Corre antes seed-productos.mjs'); process.exit(1); }
    console.log(`Usando ${productos.length} productos como base.`);

    // Cliente de prueba para los fiados
    const clienteId = randomUUID();
    await supabase.from('clientes').upsert({
        id: clienteId, negocio_id: NEGOCIO_ID, nombre: '[TEST] Cliente Fiado',
        telefono: '8090000000', limite_credito: 1000000, fecha_actualizacion: Date.now(),
    });

    const ahora = Date.now();
    const inicio = ahora - DIAS * 86400000;
    let ticket = 1;

    const ventas = [], detalles = [], fiados = [];
    for (let i = 0; i < CANTIDAD; i++) {
        const idVenta = randomUUID();
        // Distribuir en el rango de días, horario comercial (8am-8pm)
        const dia = inicio + azar(DIAS) * 86400000;
        const fecha = dia + (8 * 3600 + azar(12 * 3600)) * 1000;
        const metodo = METODOS[azar(METODOS.length)];

        const numItems = 1 + azar(4);
        let total = 0;
        for (let j = 0; j < numItems; j++) {
            const p = productos[azar(productos.length)];
            const cantidad = 1 + azar(3);
            const sub = p.precio_venta * cantidad;
            total += sub;
            detalles.push({
                id: randomUUID(), venta_id: idVenta, producto_id: p.id, negocio_id: NEGOCIO_ID,
                ...(SUCURSAL_ID && { sucursal_id: SUCURSAL_ID }),
                nombre: p.nombre, cantidad, precio_unitario: p.precio_venta, subtotal: sub,
                fecha_creacion: fecha,
            });
        }

        ventas.push({
            id: idVenta, negocio_id: NEGOCIO_ID,
            ...(SUCURSAL_ID && { sucursal_id: SUCURSAL_ID }),
            numero_ticket: ticket++, caja_codigo: CAJA,
            total, metodo_pago: metodo,
            ...(metodo === 'fiado' && { cliente_id: clienteId }),
            fecha_creacion: fecha,
        });

        if (metodo === 'fiado') {
            fiados.push({
                id: randomUUID(), negocio_id: NEGOCIO_ID, cliente_id: clienteId, venta_id: idVenta,
                tipo: 'cargo', monto: total, concepto: '[TEST] Compra en POS',
                // En la nube fecha_creacion es timestamp (ISO); fecha_actualizacion es bigint ms
                fecha_creacion: new Date(fecha).toISOString(), fecha_actualizacion: fecha,
            });
        }
    }

    const insertar = async (tabla, filas) => {
        for (let i = 0; i < filas.length; i += 200) {
            const { error } = await supabase.from(tabla).upsert(filas.slice(i, i + 200));
            if (error) { console.error(`Error en ${tabla}:`, error.message); process.exit(1); }
        }
        console.log(`  ${tabla}: ${filas.length} ✓`);
    };

    await insertar('ventas', ventas);
    await insertar('venta_detalles', detalles);
    await insertar('transacciones_fiado', fiados);

    console.log(`\n✅ ${CANTIDAD} ventas (${detalles.length} detalles, ${fiados.length} fiados) en ${DIAS} días.`);
    console.log('   Abre la app: el pull inicial las bajará todas al dispositivo.');
    console.log(`   Limpiar: node scripts/seed-ventas.mjs --negocio ${NEGOCIO_ID} --borrar`);
}

main();
