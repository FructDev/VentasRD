// scripts/seed-productos.mjs
// Siembra N productos de prueba en un negocio (para pruebas de rendimiento).
// Los productos bajan solos al dispositivo con el sync normal.
//
// Uso:
//   node scripts/seed-productos.mjs --negocio <negocio_id> [--cantidad 300] [--sucursal <sucursal_id>] [--borrar]
//
//   --borrar  elimina los productos sembrados antes (los marca eliminado=true)
//
// Usa el service role key de .env.local. Los productos llevan el prefijo
// "[TEST]" en el nombre para identificarlos y poder limpiarlos después.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';

// Cargar .env.local a mano (sin dependencias)
const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
}
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ── Argumentos ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const NEGOCIO_ID = get('--negocio');
const CANTIDAD = parseInt(get('--cantidad') || '300', 10);
const SUCURSAL_ID = get('--sucursal');
const BORRAR = args.includes('--borrar');

if (!NEGOCIO_ID) {
    console.error('Falta --negocio <negocio_id>. Sácalo de Ajustes o de la tabla negocios.');
    process.exit(1);
}

// ── Generador de productos realistas (colmado/tienda RD) ────────────────────
const BASES = [
    ['Arroz Selecto', 250, 190], ['Aceite Crisol', 195, 150], ['Leche Rica', 120, 95],
    ['Coca-Cola', 85, 60], ['Pollo lb', 180, 140], ['Jabón Candado', 65, 45],
    ['Habichuela Roja', 110, 80], ['Espagueti Milano', 55, 38], ['Salami Induveca', 165, 125],
    ['Queso Geo', 145, 110], ['Pan Sobao', 30, 18], ['Café Santo Domingo', 210, 165],
    ['Azúcar Crema', 60, 42], ['Sal Molida', 25, 15], ['Salsa Tomate Linda', 48, 32],
    ['Avena Quaker', 95, 70], ['Malta Morena', 50, 35], ['Agua Planeta Azul', 35, 20],
    ['Cerveza Presidente', 150, 110], ['Ron Barceló', 650, 500], ['Detergente Ace', 88, 62],
    ['Cloro Mistolín', 70, 48], ['Papel Higiénico Scott', 130, 95], ['Pasta Colgate', 115, 82],
    ['Galletas Guarina', 45, 28], ['Plátano Verde', 20, 12], ['Yuca lb', 28, 16],
    ['Huevo Unidad', 12, 8], ['Mantequilla Sobrino', 98, 72], ['Sardina Excelsior', 75, 52],
];
const VARIANTES = ['', ' 1lb', ' 2lb', ' 5lb', ' Grande', ' Pequeño', ' Familiar', ' 500ml', ' 1L', ' 2L', ' x3', ' x6', ' x12', ' Promo'];
const TASAS = [0.18, 0.18, 0.18, 0.16, 0]; // mayoría gravados, algunos exentos

function generarProductos(n) {
    const productos = [];
    const ahora = Date.now();
    for (let i = 0; i < n; i++) {
        const [base, precio, costo] = BASES[i % BASES.length];
        const variante = VARIANTES[Math.floor(i / BASES.length) % VARIANTES.length];
        productos.push({
            id: randomUUID(),
            negocio_id: NEGOCIO_ID,
            nombre: `[TEST] ${base}${variante} #${String(i + 1).padStart(3, '0')}`,
            codigo_barras: `TEST${String(i + 1).padStart(9, '0')}`,
            precio_venta: precio + (i % 7),           // variar un poco
            costo: costo + (i % 5),
            stock_actual: 5 + (i % 40),
            stock_minimo: 3,
            tasa_itbis: TASAS[i % TASAS.length],
            tipo: 'simple',
            ubicacion: `Pasillo ${1 + (i % 6)}-${String.fromCharCode(65 + (i % 4))}`,
            eliminado: false,
            fecha_actualizacion: ahora + i, // ts únicos para el pull incremental
        });
    }
    return productos;
}

// ── Ejecución ─────────────────────────────────────────────────────────────────
async function main() {
    // Verificar que el negocio existe
    const { data: negocio, error: negErr } = await supabase
        .from('negocios').select('id, nombre').eq('id', NEGOCIO_ID).maybeSingle();
    if (negErr || !negocio) {
        console.error('Negocio no encontrado:', negErr?.message || NEGOCIO_ID);
        process.exit(1);
    }
    console.log(`Negocio: ${negocio.nombre} (${negocio.id})`);

    if (BORRAR) {
        // Soft-delete: el sync propaga eliminado=true y los borra del dispositivo
        const { data, error } = await supabase
            .from('productos')
            .update({ eliminado: true, fecha_actualizacion: Date.now() })
            .eq('negocio_id', NEGOCIO_ID)
            .like('nombre', '[TEST]%')
            .select('id');
        if (error) { console.error('Error al borrar:', error.message); process.exit(1); }
        console.log(`🧹 ${data?.length ?? 0} productos [TEST] marcados como eliminados.`);
        return;
    }

    const productos = generarProductos(CANTIDAD);

    // Insertar en lotes de 100
    for (let i = 0; i < productos.length; i += 100) {
        const lote = productos.slice(i, i + 100);
        const { error } = await supabase.from('productos').upsert(lote);
        if (error) { console.error(`Error en lote ${i / 100 + 1}:`, error.message); process.exit(1); }
        console.log(`  Lote ${i / 100 + 1}: ${lote.length} productos ✓`);
    }

    // Stock por sucursal (si se indicó) para que el reconteo no lo pise
    if (SUCURSAL_ID) {
        const inv = productos.map(p => ({
            sucursal_id: SUCURSAL_ID,
            producto_id: p.id,
            stock_actual: p.stock_actual,
            stock_minimo: p.stock_minimo,
            fecha_actualizacion: Date.now(),
        }));
        for (let i = 0; i < inv.length; i += 100) {
            const { error } = await supabase
                .from('inventario_sucursales')
                .upsert(inv.slice(i, i + 100), { onConflict: 'sucursal_id,producto_id' });
            if (error) { console.error('Error en inventario_sucursales:', error.message); process.exit(1); }
        }
        console.log(`  Stock replicado en la sucursal ${SUCURSAL_ID} ✓`);
    }

    console.log(`\n✅ ${CANTIDAD} productos [TEST] sembrados. Abre la app y espera el sync (~15s).`);
    console.log(`   Para limpiarlos: node scripts/seed-productos.mjs --negocio ${NEGOCIO_ID} --borrar`);
}

main();
