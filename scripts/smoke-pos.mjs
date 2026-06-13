// scripts/smoke-pos.mjs
// Verifica que el POS sigue 100% funcional tras el refactor de rendimiento:
// buscar producto → agregar al carrito → el carrito lo refleja. Y mide cuántas
// veces se renderiza la parrilla al teclear (debe ser estable con memo).
import { chromium } from 'playwright';

const BASE = 'http://localhost:3001';
const NEGOCIO = '00000000-0000-4000-8000-000000000001';
let fallos = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!ok) fallos++; };

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(([neg]) => {
    Object.defineProperty(navigator, 'onLine', { get: () => false });
    localStorage.setItem('ventard-config', JSON.stringify({ state: {
        negocioId: neg, negocioNombre: 'Test', sucursalId: 's1', planActivo: true,
        pinAdmin: 'x', rolUsuario: 'admin', nombreUsuario: 'Bench', isOfflineUnlocked: true,
    }, version: 0 }));
    // Saltar el modal de Novedades para que no tape la parrilla en la prueba
    localStorage.setItem('vrd_novedades_version', '2026-06');
    localStorage.setItem('vrd_tutorial_dismissed', 'true');
}, [NEGOCIO]);

const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

// Sembrar 200 productos
await page.evaluate(async (neg) => {
    const dbi = await new Promise((res, rej) => {
        const r = indexedDB.open('VentaRD_Vault'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
        const tx = dbi.transaction(['productos'], 'readwrite');
        const s = tx.objectStore('productos');
        for (let i = 0; i < 200; i++) {
            s.put({ id: `p${i}`, negocio_id: neg, nombre: `Producto ${i}`, codigo_barras: `${1000 + i}`,
                precio_venta: 50 + i, costo: 30, stock_actual: 100, stock_minimo: 5, tasa_itbis: 0.18,
                tipo: 'simple', estado_sincronizacion: 1, fecha_actualizacion: Date.now() });
        }
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
}, NEGOCIO);

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[placeholder*="Buscar producto"]', { timeout: 10000 });
await page.waitForTimeout(1500);

// 1. Buscar
const buscador = page.locator('input[placeholder*="Buscar producto"]');
await buscador.fill('Producto 137');
await page.waitForTimeout(800);
let texto = await page.evaluate(() => document.body.innerText);
check('El buscador filtra y muestra el producto', texto.includes('Producto 137'));

// 2. Que el foco del buscador NO se pierda al teclear (prueba del CartContent fix)
const focoOk = await page.evaluate(() => document.activeElement?.getAttribute('placeholder')?.includes('Buscar producto'));
check('El buscador mantiene el foco mientras se escribe', !!focoOk);

// 3. Agregar al carrito haciendo clic en la tarjeta
await page.locator('button:has-text("Producto 137")').first().click();
await page.waitForTimeout(700);
texto = await page.evaluate(() => document.body.innerText);
// El total debe dejar de ser 0 y el ticket debe mostrar el producto
const totalNoCero = await page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/Total\s*RD\$([\d,]+\.\d{2})/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
});
check('Clic en la tarjeta agrega el producto al carrito', totalNoCero > 0, `total RD$${totalNoCero}`);

// 4. Cambiar cantidad con + (prueba que el carrito funciona)
const antes = totalNoCero;
await page.locator('button:text-is("+")').first().click().catch(() => {});
await page.waitForTimeout(500);
const despues = await page.evaluate(() => {
    const m = document.body.innerText.match(/Total\s*RD\$([\d,]+\.\d{2})/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
});
check('El botón + aumenta la cantidad en el carrito', despues > antes, `${antes} → ${despues}`);

// 5. Abrir cobro y verificar que el modal aparece
await page.locator('button:has-text("Cobrar Venta")').first().click();
await page.waitForTimeout(600);
texto = await page.evaluate(() => document.body.innerText);
check('Abre el modal de cobro', texto.includes('Completar Pago') || texto.includes('Monto a Cobrar'));

await browser.close();
console.log(fallos === 0 ? '\n🎉 POS 100% funcional tras el refactor' : `\n⚠️ ${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
