// scripts/verify-sentry.mjs
// Lanza un error de prueba en la app y verifica que se envía a sentry.io
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();

let envios = 0;
page.on('request', r => { if (r.url().includes('sentry.io')) envios++; });

await page.goto('http://localhost:3001/landing', { waitUntil: 'networkidle' });
await page.evaluate(() => {
    setTimeout(() => { throw new Error('Prueba de Sentry — VentaRD (puedes ignorar este error)'); }, 100);
});
await page.waitForTimeout(5000);

console.log(envios > 0
    ? `✅ Error enviado a Sentry (${envios} peticiones a sentry.io)`
    : '❌ No se detectaron envíos a sentry.io');
await browser.close();
process.exit(envios > 0 ? 0 : 1);
