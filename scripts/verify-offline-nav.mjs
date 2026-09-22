// scripts/verify-offline-nav.mjs
// LA PROMESA CENTRAL: toda la app debe navegar OFFLINE de verdad.
// Nacido del incidente 2026-07: el cache de páginas omitía media app y
// expiraba en 24h — "Inventario: no tienes conexión" en pleno campo.
//
// Estrategia:
//   1. ONLINE: visitar todas las rutas (calienta el cache del service worker).
//   2. context.setOffline(true) — red REALMENTE bloqueada (el SW sigue vivo
//      y debe servir desde CacheStorage).
//   3. Recargar cada ruta con carga completa (page.goto) y verificar que
//      NO cae al fallback /offline y que el contenido renderiza.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3001';
let fallos = 0;

function check(nombre, ok, detalle = '') {
    console.log(`${ok ? '✅' : '❌'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
    if (!ok) fallos++;
}

// Todas las rutas operativas de la app (Pro incluido)
const RUTAS = [
    '/', '/historial', '/inventario', '/clientes', '/gastos',
    '/dashboard', '/reportes', '/configuracion',
    '/reparaciones', '/garantias', '/apartados',
];

const CONFIG_SESION = {
    state: {
        negocioId: '00000000-0000-4000-8000-000000000001',
        negocioNombre: 'Colmado Prueba',
        sucursalId: '00000000-0000-4000-8000-000000000002',
        dispositivoId: 'CT1',
        planActivo: true,
        planTier: 'pro',
        accesoHasta: Date.now() + 30 * 24 * 60 * 60 * 1000,
        pinAdmin: '1234',
        rolUsuario: 'admin',
        isAdminMode: true,
        isOfflineUnlocked: true,
    },
    version: 0,
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript((cfg) => {
    localStorage.setItem('ventard-config', JSON.stringify(cfg));
}, CONFIG_SESION);
const page = await ctx.newPage();

// ─── FASE 1: calentar el cache ONLINE ─────────────────────────────────────────
console.log('\n── Fase 1: calentando el cache del service worker (online) ──');
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('goto inicial:', e.message));
await page.waitForTimeout(3000);
// Esperar a que el SW esté activo y controlando
const swListo = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    return !!reg?.active;
});
check('Service worker activo', swListo);

for (const ruta of RUTAS) {
    await page.goto(BASE + ruta, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(700);
}
console.log(`   ${RUTAS.length} rutas visitadas online`);
await page.waitForTimeout(2000); // dejar asentar el runtime cache

// ─── FASE 2: red BLOQUEADA — recargar cada ruta ───────────────────────────────
console.log('\n── Fase 2: red bloqueada — cada ruta debe abrir desde el cache ──');
await ctx.setOffline(true);

for (const ruta of RUTAS) {
    const inicio = Date.now();
    let error = '';
    try {
        await page.goto(BASE + ruta, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
        error = e.message?.slice(0, 60) ?? 'error de carga';
    }
    const ms = Date.now() - inicio;
    await page.waitForTimeout(1200);

    const url = page.url();
    const texto = (await page.textContent('body').catch(() => '')) || '';
    const cayoAlFallback = url.includes('/offline') || texto.includes('Sin conexión y sin');
    const renderizo = texto.length > 200 && !error;

    check(`OFFLINE ${ruta}`,
        renderizo && !cayoAlFallback,
        cayoAlFallback ? 'cayó al fallback /offline' : error || `${ms}ms`);
}

// Arranque en frío offline no debe eternizarse (el bug de los timeouts en cadena)
{
    const inicio = Date.now();
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    const ms = Date.now() - inicio;
    check('Arranque en frío offline < 8s', ms < 8000, `${ms}ms`);
}

await browser.close();
console.log(fallos === 0 ? '\n🎉 La app completa navega offline' : `\n⚠️ ${fallos} ruta(s) rompen la promesa offline`);
process.exit(fallos === 0 ? 0 : 1);
