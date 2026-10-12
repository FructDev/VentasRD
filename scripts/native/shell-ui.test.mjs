// Recorrido real del FRONTEND empaquetado en Chromium sintético; NO prueba
// WebView2/Tauri físico, permisos comerciales ni coldstart de una PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const dist = resolve(fileURLToPath(new URL('../../apps/pos/dist/', import.meta.url)));
test('Ventas → módulos pendientes → inventario → ajustes; sin backend no inventa datos', async () => {
  assert.ok(existsSync(resolve(dist, 'index.html')), 'RED: falta frontend empaquetado');
  const server = createServer((req, res) => {
    const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!(path === dist || path.startsWith(dist + sep))) { res.writeHead(403).end(); return; }
    const file = path === dist ? resolve(dist, 'index.html') : path;
    const mime = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png'}[extname(file)];
    try { res.writeHead(200, {'Content-Type': mime ?? 'application/octet-stream'}).end(readFileSync(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const context = await browser.newContext({serviceWorkers:'block'});
    const remote = [], errors = [];
    await context.route('**/*', (route) => {
      if (!route.request().url().startsWith(url + '/')) { remote.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url+'/#/?source=synthetic');
    await page.getByRole('heading', {name:'Ventas', exact:true}).waitFor();
    assert.equal(await page.locator('[data-product]').count(), 0);
    assert.equal(await page.getByRole('button', {name:/Cobrar Venta/}).count(), 0);
    assert.equal(await page.getByRole('navigation', {name:'Navegación principal'}).getByRole('link').count(), 11);
    await page.getByRole('link', {name:'Clientes', exact:true}).click();
    await page.getByRole('heading', {name:'Clientes', exact:true}).waitFor();
    await page.getByText('Pantalla reservada en la navegación definitiva.', {exact:false}).waitFor();
    await page.getByRole('link', {name:'Inventario', exact:true}).click();
    await page.getByRole('heading', {name:'Inventario', exact:true}).waitFor();
    assert.equal(await page.locator('[data-inventory-product]').count(), 0);
    await page.getByRole('textbox', {name:'Buscar producto', exact:true}).fill('000010');
    assert.equal(await page.locator('[data-inventory-product]').count(), 0);
    await page.getByRole('link', {name:'Ajustes', exact:true}).click();
    await page.getByRole('heading', {name:'Ajustes', exact:true}).waitFor();
    await page.reload();
    await page.getByRole('heading', {name:'Ajustes', exact:true}).waitFor();
    await page.goto(url + '/#/ruta-inexistente?source=synthetic');
    await page.getByRole('heading', {name:'Ruta no disponible'}).waitFor();
    await page.getByRole('link', {name:'Volver a Ventas'}).click();
    await page.getByRole('heading', {name:'Ventas', exact:true}).waitFor();
    assert.deepEqual(remote, []);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name)), []);
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
    await page.setViewportSize({width:360, height:780});
    await page.getByRole('link', {name:'Inventario', exact:true}).click();
    await page.getByRole('heading', {name:'Inventario', exact:true}).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (process.env.VENTARD_CAPTURE_SYNTHETIC_UI === '1') {
      await page.screenshot({path:fileURLToPath(new URL('../../docs/native/evidence/native-pos-mobile.png', import.meta.url)), fullPage:true});
    }
    console.log('UI PASS: rutas/reload/mobile; ausencia de backend = cero productos/cobros; 0 requests remotos; 0 DB/LS/SW.');
  } finally {
    await browser?.close();
    await new Promise(r => server.close(r));
  }
});
