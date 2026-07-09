// Renderiza los artes HTML del kit como PNG (marketing/png/).
// Uso: node marketing/render.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const dir = dirname(fileURLToPath(import.meta.url));
const ARTES = [
    { archivo: 'estado-1-luz.html',      w: 1080, h: 1920 },
    { archivo: 'estado-2-fiados.html',   w: 1080, h: 1920 },
    { archivo: 'estado-3-catalogo.html', w: 1080, h: 1920 },
    { archivo: 'estado-4-prueba.html',   w: 1080, h: 1920 },
    { archivo: 'post-1-offline.html',    w: 1080, h: 1080 },
    { archivo: 'post-2-celulares.html',  w: 1080, h: 1080 },
];

mkdirSync(join(dir, 'png'), { recursive: true });
const browser = await chromium.launch();

for (const { archivo, w, h } of ARTES) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto('file://' + join(dir, archivo).replace(/\\/g, '/'));
    await page.waitForLoadState('networkidle'); // esperar las fuentes de Google
    await page.waitForTimeout(400);
    const salida = join(dir, 'png', archivo.replace('.html', '.png'));
    await page.screenshot({ path: salida });
    console.log('✓', salida);
    await page.close();
}

await browser.close();
console.log('\nListo: imágenes en marketing/png/');
