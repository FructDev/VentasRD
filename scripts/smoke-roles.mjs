// Verifica el panel restringido del vendedor vs el completo del admin.
import { chromium } from 'playwright';
const BASE = 'http://localhost:3001';
const NEG = '00000000-0000-4000-8000-000000000001';
let fallos = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!ok) fallos++; };

async function nuevoCtx(browser, rol, nombre) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([neg, r, nom]) => {
    Object.defineProperty(navigator, 'onLine', { get: () => false });
    localStorage.setItem('ventard-config', JSON.stringify({ state: {
      negocioId: neg, negocioNombre: 'Test', sucursalId: 's1', planActivo: true,
      pinAdmin: 'x', rolUsuario: r, nombreUsuario: nom, isOfflineUnlocked: true,
    }, version: 0 }));
    localStorage.setItem('vrd_novedades_version', '2026-06');
    localStorage.setItem('vrd_tutorial_dismissed', 'true');
    localStorage.setItem('vrd_resumen_diario_visto', new Date().toISOString().slice(0,10));
  }, [NEG, rol, nombre]);
  return ctx;
}

async function seed(page) {
  await page.evaluate(async (neg) => {
    const dbi = await new Promise((res, rej) => { const r = indexedDB.open('VentaRD_Vault'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => {
      const tx = dbi.transaction(['ventas'], 'readwrite'); const s = tx.objectStore('ventas');
      const hoy = Date.now();
      s.put({ id: 'vA', negocio_id: neg, numero_ticket: 1, caja_codigo: 'C1', total: 100, metodo_pago: 'efectivo', vendedor_nombre: 'Ana Vendedora', estado_sincronizacion: 1, fecha_creacion: hoy });
      s.put({ id: 'vB', negocio_id: neg, numero_ticket: 2, caja_codigo: 'C1', total: 500, metodo_pago: 'efectivo', vendedor_nombre: 'Otro', estado_sincronizacion: 1, fecha_creacion: hoy });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }, NEG);
}

const browser = await chromium.launch();

// ── VENDEDOR ──
{
  const ctx = await nuevoCtx(browser, 'vendedor', 'Ana Vendedora');
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
  await seed(page);
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /ticket promedio/i.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  const t = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  check('Vendedor: título "Mis Ventas"', t.includes('mis ventas'));
  check('Vendedor: NO ve "Ganancia Neta"', !t.includes('ganancia neta'));
  check('Vendedor: NO ve "Te Deben"', !t.includes('te deben'));
  check('Vendedor: NO ve "Por Vendedor"', !t.includes('por vendedor'));
  check('Vendedor: NO ve "Stock Crítico"', !t.includes('stock crítico') && !t.includes('stock critico'));
  check('Vendedor: ve su propia venta (RD$100)', t.includes('rd$100.00'));
  check('Vendedor: NO ve la venta de otro (total RD$600)', !t.includes('rd$600.00'));
  await ctx.close();
}

// ── ADMIN ──
{
  const ctx = await nuevoCtx(browser, 'admin', '');
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
  await seed(page);
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /ticket promedio/i.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  const t = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  check('Admin: título "Dashboard"', t.includes('dashboard'));
  check('Admin: SÍ ve "Ganancia Neta"', t.includes('ganancia neta'));
  check('Admin: SÍ ve "Por Vendedor"', t.includes('por vendedor'));
  check('Admin: ve el total del negocio (RD$600)', t.includes('rd$600.00'));
  await ctx.close();
}

await browser.close();
console.log(fallos === 0 ? '\n🎉 Roles correctos: vendedor restringido, admin completo' : `\n⚠️ ${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
