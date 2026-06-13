// scripts/verify-offline.mjs
// Verifica el comportamiento offline de la app:
//   Caso 1: dispositivo conocido (negocioId en localStorage) → PIN screen → desbloqueo → POS
//   Caso 2: dispositivo nuevo (sin datos) → redirige a /login
//
// Nota: Playwright setOffline() no intercepta bien las peticiones del service
// worker, así que simulamos offline a nivel de app (navigator.onLine = false),
// que es lo que usa el AuthProvider para decidir el flujo. El SW se verifica
// por separado (registro + precache).
import { chromium } from 'playwright';

const BASE = 'http://localhost:3001';
let fallos = 0;

function check(nombre, ok, detalle = '') {
    console.log(`${ok ? '✅' : '❌'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
    if (!ok) fallos++;
}

const browser = await chromium.launch();

// ─── Service worker: registro y precache ──────────────────────────────────────
console.log('\n── Service worker (cascarón offline de la PWA) ──');
{
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const swInfo = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return { activo: false, caches: 0 };
        const reg = await navigator.serviceWorker.ready.catch(() => null);
        await new Promise(r => setTimeout(r, 3000)); // dar tiempo al precache
        const keys = await caches.keys();
        let entradas = 0;
        for (const k of keys) {
            const c = await caches.open(k);
            entradas += (await c.keys()).length;
        }
        return { activo: !!reg?.active, caches: keys.length, entradas };
    });
    check('Service worker registrado y activo', swInfo.activo);
    check('Precache de workbox poblado', swInfo.entradas > 10, `${swInfo.caches} caches, ${swInfo.entradas} recursos`);
    await ctx.close();
}

// ─── CASO 2: dispositivo nuevo, OFFLINE ───────────────────────────────────────
console.log('\n── CASO 2: dispositivo nuevo (sin sesión previa) OFFLINE ──');
{
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'onLine', { get: () => false });
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    const url = page.url();
    check('No entra al POS; redirige a login', url.includes('/login') || url.includes('/landing'), url);
    await ctx.close();
}

// ─── CASO 1: dispositivo conocido, OFFLINE ────────────────────────────────────
console.log('\n── CASO 1: dispositivo que ya conoce el negocio, OFFLINE ──');
{
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'onLine', { get: () => false });
        // Estado persistido como si ya se hubiera iniciado sesión antes
        // (PIN '1234' en formato legado texto plano — prueba además la migración a hash)
        localStorage.setItem('ventard-config', JSON.stringify({
            state: {
                negocioId: '00000000-0000-4000-8000-000000000001',
                negocioNombre: 'Colmado Prueba',
                sucursalId: '00000000-0000-4000-8000-000000000002',
                planActivo: true,
                pinAdmin: '1234',
                rolUsuario: 'admin',
                isOfflineUnlocked: false,
            },
            version: 0,
        }));
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const texto = await page.textContent('body').catch(() => '');
    const muestraPin = texto.includes('ingresa tu PIN');
    check('Muestra la pantalla de PIN offline', muestraPin);

    if (muestraPin) {
        for (const d of ['1', '2', '3', '4']) {
            await page.click(`button:text-is("${d}")`);
            await page.waitForTimeout(250);
        }
        await page.waitForTimeout(3000);
        const textoPos = await page.textContent('body').catch(() => '');
        check('PIN correcto desbloquea y entra al POS',
            textoPos.includes('Buscar producto') || textoPos.includes('Cobrar Venta'));
        check('El POS muestra el indicador Offline', textoPos.includes('Offline'));

        const pinMigrado = await page.evaluate(() => {
            try {
                const cfg = JSON.parse(localStorage.getItem('ventard-config'));
                return typeof cfg.state.pinAdmin === 'string' && cfg.state.pinAdmin.length === 64;
            } catch { return false; }
        });
        check('PIN migrado a hash SHA-256 tras el desbloqueo', pinMigrado);
    }
    await ctx.close();
}

// ─── CASO 1b: PIN incorrecto ──────────────────────────────────────────────────
console.log('\n── CASO 1b: PIN incorrecto ──');
{
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'onLine', { get: () => false });
        localStorage.setItem('ventard-config', JSON.stringify({
            state: {
                negocioId: '00000000-0000-4000-8000-000000000001',
                negocioNombre: 'Colmado Prueba',
                pinAdmin: '1234',
                rolUsuario: 'admin',
                isOfflineUnlocked: false,
            },
            version: 0,
        }));
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    for (const d of ['9', '9', '9', '9']) {
        await page.click(`button:text-is("${d}")`).catch(() => {});
        await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1200);
    const texto = await page.textContent('body').catch(() => '');
    check('PIN incorrecto muestra error y no entra', texto.includes('PIN incorrecto'));
    await ctx.close();
}

await browser.close();
console.log(fallos === 0 ? '\n🎉 Todas las verificaciones pasaron' : `\n⚠️ ${fallos} verificación(es) fallaron`);
process.exit(fallos === 0 ? 0 : 1);
