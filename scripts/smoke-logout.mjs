// Verifica que un CAJERO puede cerrar sesión (era inalcanzable: el logout vivía en /admin)
import { chromium } from 'playwright';
const BASE = 'http://localhost:3001';
let fallos = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!ok) fallos++; };

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'onLine', { get: () => false });
  localStorage.setItem('ventard-config', JSON.stringify({ state: {
    negocioId: '00000000-0000-4000-8000-000000000001', negocioNombre: 'Test', sucursalId: 's1',
    planActivo: true, pinAdmin: 'x', rolUsuario: 'cajero', nombreUsuario: 'Juan Cajero', isOfflineUnlocked: true,
  }, version: 0 }));
  localStorage.setItem('vrd_novedades_version', '2026-06');
  localStorage.setItem('vrd_tutorial_dismissed', 'true');
});
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// El cajero ve el menú de usuario (avatar con inicial "J")
const avatar = page.locator('button[aria-label="Menú de usuario"]');
check('El cajero ve el menú de usuario en el TopBar', await avatar.count() > 0);

await avatar.click();
await page.waitForTimeout(400);
let texto = await page.evaluate(() => document.body.innerText);
check('El menú muestra "Cerrar sesión"', texto.includes('Cerrar sesión'));
check('El menú muestra el nombre y rol del cajero', texto.includes('Juan Cajero') && texto.includes('Cajero'));

// Clic en cerrar sesión → aparece confirmación
await page.locator('button:has-text("Cerrar sesión")').first().click();
await page.waitForTimeout(400);
texto = await page.evaluate(() => document.body.innerText);
check('Aparece la confirmación antes de salir', texto.includes('conexión a internet') || texto.includes('quieres salir'));

await browser.close();
console.log(fallos === 0 ? '\n🎉 El cajero ya puede cerrar sesión' : `\n⚠️ ${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
