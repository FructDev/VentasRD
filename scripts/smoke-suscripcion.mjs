// scripts/smoke-suscripcion.mjs
// Verifica el candado de suscripción en la app real:
//   - acceso vigente → entra al POS
//   - vencido dentro de gracia (2 días) → entra + aviso de bloqueo próximo
//   - vencido +10 días → pantalla de bloqueo, sin acceso al POS (datos intactos)
import { chromium } from 'playwright';

const BASE = 'http://localhost:3001';
const DIA = 86400000;
let fallos = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!ok) fallos++; };

async function cargarCon(browser, accesoOffsetDias) {
    const ctx = await browser.newContext();
    await ctx.addInitScript((offsetDias) => {
        Object.defineProperty(navigator, 'onLine', { get: () => false });
        const acceso = Date.now() + offsetDias * 86400000;
        localStorage.setItem('ventard-config', JSON.stringify({ state: {
            negocioId: '00000000-0000-4000-8000-000000000001', negocioNombre: 'Test',
            sucursalId: 's1', pinAdmin: 'x', rolUsuario: 'admin', isOfflineUnlocked: true,
            accesoHasta: acceso, ultimaFechaVista: 0,
        }, version: 0 }));
        localStorage.setItem('vrd_novedades_version', '2026-06');
        localStorage.setItem('vrd_tutorial_dismissed', 'true');
    }, accesoOffsetDias);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const texto = await page.evaluate(() => document.body.innerText);
    return { ctx, texto };
}

const browser = await chromium.launch();

// 1. Acceso vigente (vence en 10 días) → POS
{
    const { ctx, texto } = await cargarCon(browser, 10);
    check('Acceso vigente → entra al POS', texto.includes('Buscar producto') || texto.includes('Cobrar'));
    check('Acceso vigente → sin pantalla de bloqueo', !texto.includes('Reactivar por WhatsApp'));
    await ctx.close();
}

// 2. Vencido hace 2 días → gracia (entra + aviso)
{
    const { ctx, texto } = await cargarCon(browser, -2);
    check('En gracia → sigue entrando al POS', texto.includes('Buscar producto') || texto.includes('Cobrar'));
    check('En gracia → muestra aviso de bloqueo próximo', /se bloqueará en/i.test(texto));
    await ctx.close();
}

// 3. Vencido hace 10 días → bloqueado
{
    const { ctx, texto } = await cargarCon(browser, -10);
    check('Vencido +5 días → pantalla de bloqueo', texto.includes('Reactivar por WhatsApp'));
    check('Vencido +5 días → NO entra al POS', !texto.includes('Buscar producto'));
    await ctx.close();
}

await browser.close();
console.log(fallos === 0 ? '\n🎉 Candado de suscripción correcto' : `\n⚠️ ${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
