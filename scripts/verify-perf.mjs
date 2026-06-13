// scripts/verify-perf.mjs
// Benchmark de la Fase 4: siembra 15,000 ventas + 30,000 detalles en IndexedDB
// (≈ 6 meses de un colmado activo) y mide el tiempo de carga del Dashboard
// y el Historial. Presupuesto: < 3000ms cada uno en desktop.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3001';
const NEGOCIO_ID = '00000000-0000-4000-8000-000000000001';
let fallos = 0;

function check(nombre, ok, detalle = '') {
    console.log(`${ok ? '✅' : '❌'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
    if (!ok) fallos++;
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(([negocioId]) => {
    Object.defineProperty(navigator, 'onLine', { get: () => false }); // sin sync que interfiera
    localStorage.setItem('ventard-config', JSON.stringify({
        state: {
            negocioId,
            negocioNombre: 'Colmado Benchmark',
            sucursalId: '00000000-0000-4000-8000-000000000002',
            planActivo: true,
            pinAdmin: 'x',
            rolUsuario: 'admin',
            nombreUsuario: 'Bench', // empleado-admin: PinGuard no pide PIN (acceso por rol)
            isOfflineUnlocked: true, // saltar la pantalla de PIN offline
        },
        version: 0,
    }));
}, [NEGOCIO_ID]);

const page = await ctx.newPage();

// 1. Primera visita: deja que la app cree el esquema Dexie v17
console.log('\n── Preparación: creando esquema y sembrando 15,000 ventas ──');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000); // app monta y crea la BD

const seed = await page.evaluate(async ({ negocioId }) => {
    const abrir = () => new Promise((res, rej) => {
        const req = indexedDB.open('VentaRD_Vault'); // sin versión: usa la existente
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
    const dbi = await abrir();
    if (!dbi.objectStoreNames.contains('ventas')) return { ok: false, error: 'esquema no creado' };

    const t0 = performance.now();
    const DIAS = 180;
    const AHORA = Date.now();
    const METODOS = ['efectivo', 'efectivo', 'efectivo', 'tarjeta', 'transferencia'];

    // Sembrar en lotes para no bloquear
    const LOTE = 1000;
    for (let lote = 0; lote < 15; lote++) {
        await new Promise((res, rej) => {
            const tx = dbi.transaction(['ventas', 'venta_detalles'], 'readwrite');
            const sv = tx.objectStore('ventas');
            const sd = tx.objectStore('venta_detalles');
            for (let i = 0; i < LOTE; i++) {
                const n = lote * LOTE + i;
                const id = `bench-${String(n).padStart(8, '0')}`;
                // Distribuir en 180 días; el ~1% de hoy
                const fecha = AHORA - Math.floor(Math.random() * DIAS * 24 * 60 * 60 * 1000);
                sv.put({
                    id, negocio_id: negocioId, numero_ticket: n + 1, caja_codigo: 'CBM',
                    total: 100 + (n % 900), metodo_pago: METODOS[n % METODOS.length],
                    estado_sincronizacion: 1, fecha_creacion: fecha,
                });
                for (let d = 0; d < 2; d++) {
                    sd.put({
                        id: `${id}-d${d}`, venta_id: id, producto_id: `prod-${n % 50}`,
                        negocio_id: negocioId, cantidad: 1 + (n % 3), precio_unitario: 50,
                        subtotal: 50 * (1 + (n % 3)), estado_sincronizacion: 1, fecha_creacion: fecha,
                    });
                }
            }
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
        });
    }
    return { ok: true, ms: Math.round(performance.now() - t0) };
}, { negocioId: NEGOCIO_ID });

if (!seed.ok) { console.error('Seed falló:', seed.error); process.exit(1); }
console.log(`   15,000 ventas + 30,000 detalles sembrados en ${seed.ms}ms`);

// 2. Medir Dashboard
console.log('\n── Benchmark: Dashboard con 6 meses de datos ──');
{
    const t0 = Date.now();
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Ticket Promedio', { timeout: 15000 });
    // Esperar a que los KPIs tengan datos reales (no skeleton)
    await page.waitForFunction(() => {
        const el = document.body.textContent || '';
        return el.includes('RD$') && el.includes('transacciones');
    }, { timeout: 15000 });
    const ms = Date.now() - t0;
    check(`Dashboard interactivo en ${ms}ms`, ms < 3000, 'presupuesto: 3000ms');
}

// 3. Medir Historial
console.log('\n── Benchmark: Historial con 15,000 ventas ──');
{
    const t0 = Date.now();
    await page.goto(`${BASE}/historial`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
        const el = document.body.textContent || '';
        return /CBM-\d{5}/.test(el); // primera fila con ticket renderizada
    }, { timeout: 15000 });
    const ms = Date.now() - t0;
    check(`Historial con primera página en ${ms}ms`, ms < 3000, 'presupuesto: 3000ms');
}

// 4. Medir POS (la pantalla más crítica)
console.log('\n── Benchmark: POS (caja) ──');
{
    const t0 = Date.now();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[placeholder*="Buscar producto"]', { timeout: 15000 });
    const ms = Date.now() - t0;
    check(`POS listo para vender en ${ms}ms`, ms < 3000, 'presupuesto: 3000ms');
}

await browser.close();
console.log(fallos === 0 ? '\n🎉 Fase 4 verificada: la app vuela con 6 meses de datos' : `\n⚠️ ${fallos} verificación(es) fallaron`);
process.exit(fallos === 0 ? 0 : 1);
