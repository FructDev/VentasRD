// Genera artes PNG y un folleto PDF del kit comercial VentaRD.
// Uso: node marketing/kit-ventas/generar-artes.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const dir = dirname(fileURLToPath(import.meta.url));
const salida = join(dir, 'salida');
mkdirSync(salida, { recursive: true });

// Personaliza estos dos datos antes de publicar.
const WHATSAPP = '1 (829) 451-5303';
const MARCA_URL = '@VentaRD';

const posts = [
  {
    archivo: 'post-01-control.png', eyebrow: 'CONTROL DEL PROPIETARIO', icon: '↗',
    title: '¿Sabes cuánto vendió tu negocio <em>sin estar presente?</em>',
    body: 'Consulta ventas, métodos de pago, productos y movimientos desde tu celular o computadora.',
    chips: ['Ventas del día', 'Caja', 'Productos vendidos'], cta: 'Escribe CONTROL por WhatsApp', accent: '#EFC84A',
  },
  {
    archivo: 'post-02-imei.png', eyebrow: 'GARANTÍAS SIN DISCUSIONES', icon: '#',
    title: 'Busca una garantía <em>por IMEI.</em>',
    body: 'Encuentra la fecha de venta, el cliente y el vencimiento aunque no aparezca la factura.',
    chips: ['IMEI', 'Cliente', 'Fecha de garantía'], cta: 'Escribe IMEI para una demo', accent: '#38BDF8',
  },
  {
    archivo: 'post-03-reparaciones.png', eyebrow: 'TALLER ORGANIZADO', icon: '⌁',
    title: 'Cada reparación, <em>bajo control.</em>',
    body: 'Registra el equipo, su condición, el problema, los pagos y cada cambio de estado.',
    chips: ['Recepción', 'Seguimiento', 'Entrega'], cta: 'Escribe TALLER por WhatsApp', accent: '#34D399',
  },
  {
    archivo: 'post-04-inventario.png', eyebrow: 'INVENTARIO REAL', icon: '▦',
    title: 'Deja de comprar y vender <em>de memoria.</em>',
    body: 'La existencia se actualiza con cada venta y puedes identificar lo que está por agotarse.',
    chips: ['Existencias', 'Stock mínimo', 'Movimientos'], cta: 'Escribe INVENTARIO', accent: '#FB923C',
  },
  {
    archivo: 'post-05-apartados.png', eyebrow: 'ABONOS CLAROS', icon: '$',
    title: 'Cada apartado y cada abono, <em>bien registrado.</em>',
    body: 'Controla el total, los pagos realizados, el saldo y los comprobantes del cliente.',
    chips: ['Total', 'Abonos', 'Saldo pendiente'], cta: 'Escribe APARTADO', accent: '#F472B6',
  },
  {
    archivo: 'post-06-todo-en-uno.png', eyebrow: 'MENOS DESORDEN', icon: '✓',
    title: 'Libreta + Excel + WhatsApp <em>ya no tienen que mandar.</em>',
    body: 'Ventas, inventario, caja, clientes, reparaciones y garantías en un solo lugar.',
    chips: ['Un sistema', 'Un historial', 'Más control'], cta: 'Escribe ORDEN por WhatsApp', accent: '#EFC84A',
  },
  {
    archivo: 'post-07-configuracion.png', eyebrow: 'TE ACOMPAÑAMOS', icon: '→',
    title: 'No te entregamos una cuenta vacía <em>y te dejamos solo.</em>',
    body: 'Te ayudamos a configurar el negocio, importar inventario y capacitar al equipo.',
    chips: ['Configuración', 'Importación', 'Capacitación'], cta: 'Escribe QUIERO', accent: '#38BDF8',
  },
  {
    archivo: 'post-08-demo.png', eyebrow: 'VENTARD EN TU NEGOCIO', icon: '▶',
    title: 'Conoce cómo organizar tu negocio <em>en 15 minutos.</em>',
    body: 'Solicita una demostración remota enfocada en los problemas que realmente necesitas resolver.',
    chips: ['Sin compromiso', 'Demo remota', 'Soporte local'], cta: 'Escribe DEMO por WhatsApp', accent: '#34D399',
  },
  // Línea complementaria para comercios generales. Se conserva intacta la
  // campaña especializada de celulares que aparece arriba.
  {
    archivo: 'general-post-01-ventas.png', eyebrow: 'VENTAS BAJO CONTROL', icon: '$',
    title: 'Cada venta registrada.<br><em>Cada peso más claro.</em>',
    body: 'Controla efectivo, tarjeta, transferencias y fiados sin depender de libretas o memoria.',
    chips: ['Ventas', 'Métodos de pago', 'Cuadre'], cta: 'Escribe VENTAS por WhatsApp', accent: '#EFC84A',
  },
  {
    archivo: 'general-post-02-inventario.png', eyebrow: 'INVENTARIO ORGANIZADO', icon: '▦',
    title: '¿Qué tienes, qué falta y <em>qué se está agotando?</em>',
    body: 'Consulta existencias, precios y movimientos para comprar con información y vender con seguridad.',
    chips: ['Existencias', 'Precios', 'Stock mínimo'], cta: 'Escribe INVENTARIO', accent: '#38BDF8',
  },
  {
    archivo: 'general-post-03-caja.png', eyebrow: 'CIERRE DEL DÍA', icon: '✓',
    title: 'Que el cuadre de caja <em>no sea una sorpresa.</em>',
    body: 'Compara lo vendido con el dinero recibido y detecta diferencias al cerrar el turno.',
    chips: ['Apertura', 'Movimientos', 'Cierre'], cta: 'Escribe CAJA para una demo', accent: '#34D399',
  },
  {
    archivo: 'general-post-04-fiados.png', eyebrow: 'CUENTAS CLARAS', icon: '↗',
    title: 'Deja de perseguir fiados <em>entre páginas de una libreta.</em>',
    body: 'Registra cargos, abonos y saldos por cliente, y comparte su estado de cuenta por WhatsApp.',
    chips: ['Clientes', 'Abonos', 'Saldos'], cta: 'Escribe FIADOS', accent: '#FB923C',
  },
  {
    archivo: 'general-post-05-empleados.png', eyebrow: 'AUNQUE NO ESTÉS', icon: '◎',
    title: 'Tu negocio trabaja.<br><em>Tú mantienes el control.</em>',
    body: 'Consulta ventas, caja e inventario y asigna a cada empleado el acceso que necesita.',
    chips: ['Propietario', 'Equipo', 'Permisos'], cta: 'Escribe CONTROL', accent: '#F472B6',
  },
  {
    archivo: 'general-post-06-tipos-negocio.png', eyebrow: 'HECHO PARA COMERCIOS', icon: 'V',
    title: 'Ferretería, tienda, repuestos…<br><em>organiza tu operación.</em>',
    body: 'VentaRD reúne ventas, inventario, caja, clientes y reportes desde celular o computadora.',
    chips: ['Fácil de usar', 'Soporte local', 'Demo remota'], cta: 'Escribe NEGOCIO', accent: '#A3E635',
  },
];

const stories = [
  {
    archivo: 'historia-01-imei.png', eyebrow: '¿TE HA PASADO?', icon: '#',
    title: 'El cliente llegó por garantía…<br><em>pero nadie encuentra la factura.</em>',
    body: 'Busca por IMEI y encuentra la información de la venta.', cta: 'Responde IMEI', accent: '#38BDF8',
  },
  {
    archivo: 'historia-02-reparacion.png', eyebrow: 'ORDEN DE REPARACIÓN', icon: '⌁',
    title: 'No recibas otro equipo<br><em>con un papelito.</em>',
    body: 'Cliente, IMEI, condición, firma, pagos y seguimiento.', cta: 'Responde TALLER', accent: '#34D399',
  },
  {
    archivo: 'historia-03-control.png', eyebrow: 'CONTROL A DISTANCIA', icon: '↗',
    title: 'Tu negocio vende.<br><em>Tú sabes qué pasó.</em>',
    body: 'Revisa ventas, caja y productos aunque no estés presente.', cta: 'Responde CONTROL', accent: '#EFC84A',
  },
  {
    archivo: 'historia-04-demo.png', eyebrow: 'DEMOSTRACIÓN REMOTA', icon: '▶',
    title: 'Ventas, inventario y operaciones<br><em>en un solo lugar.</em>',
    body: 'Te mostramos cómo quedaría VentaRD en tu negocio.', cta: 'Escribe DEMO', accent: '#F472B6',
  },
  {
    archivo: 'general-historia-01-caja.png', eyebrow: 'AL CERRAR EL TURNO', icon: '✓',
    title: '¿La caja cuadra…<br><em>o siempre falta algo?</em>',
    body: 'Registra ventas y métodos de pago para cerrar con información.', cta: 'Responde CAJA', accent: '#34D399',
  },
  {
    archivo: 'general-historia-02-fiados.png', eyebrow: 'CARGOS Y ABONOS', icon: '$',
    title: 'El fiado no debería depender<br><em>de una libreta.</em>',
    body: 'Controla cuánto debe cada cliente y cada pago que realiza.', cta: 'Responde FIADOS', accent: '#FB923C',
  },
  {
    archivo: 'general-historia-03-negocio.png', eyebrow: 'MÁS ORDEN, MÁS CONTROL', icon: '↗',
    title: 'Ventas, inventario y caja.<br><em>Todo en un lugar.</em>',
    body: 'Conoce cómo VentaRD puede organizar tu comercio.', cta: 'Escribe NEGOCIO', accent: '#EFC84A',
  },
];

function baseCss(w, h, accent) {
  return `
    *{box-sizing:border-box}html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden}
    body{font-family:Inter,"Segoe UI",Arial,sans-serif;background:#0D1B2E;color:#fff;position:relative}
    body:before{content:"";position:absolute;width:${Math.round(w*.9)}px;height:${Math.round(w*.9)}px;border-radius:50%;right:-25%;top:-18%;background:radial-gradient(circle,${accent}26,transparent 68%)}
    body:after{content:"";position:absolute;left:0;right:0;bottom:0;height:7px;background:linear-gradient(90deg,#D4A017,${accent})}
    .grain{position:absolute;inset:0;opacity:.16;background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);background-size:48px 48px}
    .logo{display:flex;align-items:center;gap:15px;font-size:30px;font-weight:900;letter-spacing:-1px}.mark{width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,#D4A017,#EFC84A);color:#0D1B2E;display:grid;place-items:center;font-size:25px}
    em{font-style:normal;color:${accent}}
    .eyebrow{color:${accent};font-size:20px;font-weight:900;letter-spacing:2.7px;text-transform:uppercase}
    .icon{display:grid;place-items:center;width:110px;height:110px;border-radius:30px;background:${accent}18;border:2px solid ${accent}55;color:${accent};font-weight:900;font-size:55px}
    .cta{background:linear-gradient(135deg,#D4A017,#EFC84A);color:#0D1B2E;font-weight:950;text-align:center;box-shadow:0 18px 50px #0006}
    .foot{color:#8899AA;font-size:19px;font-weight:700;display:flex;justify-content:space-between;align-items:center}
  `;
}

function squareHtml(p) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
  ${baseCss(1080,1080,p.accent)}
  .wrap{position:relative;height:100%;padding:62px 72px 58px;display:flex;flex-direction:column;z-index:1}
  .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:55px}
  h1{font-size:65px;line-height:1.05;letter-spacing:-3.4px;margin:30px 0 25px;max-width:900px;font-weight:950}
  .body{color:#A8B5C4;font-size:28px;line-height:1.45;max-width:850px;margin:0 0 30px}
  .chips{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:34px}.chip{border:1.5px solid #ffffff20;background:#ffffff08;border-radius:999px;padding:12px 19px;font-size:18px;font-weight:800;color:#D8E0E8}
  .cta{font-size:26px;border-radius:20px;padding:21px 30px;margin-top:auto;margin-bottom:24px}
  </style></head><body><div class="grain"></div><main class="wrap">
  <div class="top"><div class="logo"><div class="mark">V</div>VentaRD</div><div class="icon">${p.icon}</div></div>
  <div class="eyebrow">${p.eyebrow}</div><h1>${p.title}</h1><p class="body">${p.body}</p>
  <div class="chips">${p.chips.map(x=>`<span class="chip">${x}</span>`).join('')}</div>
  <div class="cta">${p.cta}</div><div class="foot"><span>${WHATSAPP}</span><span>${MARCA_URL} · Hecho en RD</span></div>
  </main></body></html>`;
}

function storyHtml(p) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
  ${baseCss(1080,1920,p.accent)}
  .wrap{position:relative;height:100%;padding:90px 82px 82px;display:flex;flex-direction:column;z-index:1}
  .top{display:flex;justify-content:space-between;align-items:center}.logo{font-size:35px}.mark{width:58px;height:58px;font-size:30px}
  .icon{width:150px;height:150px;border-radius:42px;font-size:72px;margin-top:240px;margin-bottom:55px}
  h1{font-size:91px;line-height:1.05;letter-spacing:-4.5px;margin:38px 0 40px;max-width:920px;font-weight:950}
  .body{color:#A8B5C4;font-size:39px;line-height:1.45;max-width:850px}
  .cta{font-size:38px;border-radius:25px;padding:29px 35px;margin-top:auto;margin-bottom:35px}
  .foot{font-size:25px}
  </style></head><body><div class="grain"></div><main class="wrap">
  <div class="top"><div class="logo"><div class="mark">V</div>VentaRD</div><div class="eyebrow">Hecho en RD</div></div>
  <div class="icon">${p.icon}</div><div class="eyebrow">${p.eyebrow}</div><h1>${p.title}</h1><p class="body">${p.body}</p>
  <div class="cta">${p.cta}</div><div class="foot"><span>${WHATSAPP}</span><span>${MARCA_URL}</span></div>
  </main></body></html>`;
}

function onePagerHtml() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
  @page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;width:210mm;height:297mm}body{font-family:Inter,"Segoe UI",Arial,sans-serif;background:#0D1B2E;color:#fff}
  .page{height:297mm;padding:17mm 17mm 13mm;position:relative;overflow:hidden}.page:before{content:"";position:absolute;width:180mm;height:180mm;border-radius:50%;right:-75mm;top:-75mm;background:radial-gradient(circle,#D4A0172b,transparent 68%)}
  .head,.content,.bottom{position:relative;z-index:1}.brand{display:flex;align-items:center;gap:4mm;font-size:24px;font-weight:900}.mark{width:12mm;height:12mm;border-radius:3mm;background:linear-gradient(135deg,#D4A017,#EFC84A);color:#0D1B2E;display:grid;place-items:center}
  .tag{margin-top:17mm;color:#EFC84A;font-size:11px;font-weight:900;letter-spacing:1.6px}.hero{font-size:35px;line-height:1.05;letter-spacing:-1.5px;margin:4mm 0 5mm;max-width:165mm}.hero em{font-style:normal;color:#EFC84A}.sub{font-size:15px;line-height:1.5;color:#A8B5C4;max-width:165mm;margin:0 0 9mm}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:4mm}.card{background:#152438;border:1px solid #27405F;border-radius:4mm;padding:5mm;min-height:30mm}.card b{display:block;color:#fff;font-size:14px;margin-bottom:2mm}.card span{color:#A8B5C4;font-size:11px;line-height:1.4}
  .offer{margin-top:7mm;padding:6mm;border:1px solid #D4A01766;background:#D4A01713;border-radius:4mm;display:flex;justify-content:space-between;gap:8mm;align-items:center}.offer h2{font-size:17px;margin:0 0 2mm}.offer p{font-size:11px;color:#A8B5C4;margin:0;line-height:1.4}.cta{white-space:nowrap;background:linear-gradient(135deg,#D4A017,#EFC84A);color:#0D1B2E;padding:5mm 6mm;border-radius:3mm;font-size:13px;font-weight:900;text-align:center}
  .bottom{position:absolute;left:17mm;right:17mm;bottom:11mm;border-top:1px solid #ffffff18;padding-top:4mm;display:flex;justify-content:space-between;color:#A8B5C4;font-size:10px}.bottom b{color:#fff}
  </style></head><body><main class="page"><div class="head"><div class="brand"><div class="mark">V</div>VentaRD</div><div class="tag">CONTROL PARA NEGOCIOS DOMINICANOS</div><h1 class="hero">Organiza tu negocio.<br><em>Vende con más control.</em></h1><p class="sub">VentaRD reúne ventas, inventario, caja y clientes. Para tiendas de celulares también controla reparaciones, garantías por IMEI, apartados y abonos.</p></div>
  <section class="content"><div class="grid">
  <div class="card"><b>Ventas y caja</b><span>Registra métodos de pago, descuentos, recibos y movimientos del día.</span></div>
  <div class="card"><b>Inventario</b><span>Controla existencias, precios, seriales y productos por agotarse.</span></div>
  <div class="card"><b>Reparaciones</b><span>Equipo, condición, firma, diagnóstico, pagos, estados y entrega.</span></div>
  <div class="card"><b>Garantías por IMEI</b><span>Consulta rápidamente a quién se vendió y cuándo vence su garantía.</span></div>
  <div class="card"><b>Apartados y abonos</b><span>Registra cada pago, saldo pendiente y comprobante del cliente.</span></div>
  <div class="card"><b>Control del propietario</b><span>Consulta ventas, inventario y resultados desde celular o computadora.</span></div>
  </div><div class="offer"><div><h2>Te ayudamos a comenzar</h2><p>Configuración del negocio, importación de inventario, capacitación y acompañamiento durante la prueba.</p></div><div class="cta">Escribe DEMO<br>${WHATSAPP}</div></div></section>
  <footer class="bottom"><span><b>VentaRD</b> · Sistema de ventas y operaciones</span><span>${MARCA_URL} · Hecho en República Dominicana</span></footer></main></body></html>`;
}

// Usa Chrome/Edge instalado cuando Playwright no tiene su Chromium descargado.
// Esto permite regenerar el kit sin instalar un navegador adicional.
const navegadoresLocales = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = navegadoresLocales.find(existsSync);
const browser = await chromium.launch(executablePath ? { executablePath } : {});

for (const p of posts) {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
  await page.setContent(squareHtml(p), { waitUntil: 'load' });
  await page.screenshot({ path: join(salida, p.archivo) });
  console.log('✓', p.archivo);
  await page.close();
}

for (const p of stories) {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.setContent(storyHtml(p), { waitUntil: 'load' });
  await page.screenshot({ path: join(salida, p.archivo) });
  console.log('✓', p.archivo);
  await page.close();
}

{
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1 });
  await page.setContent(onePagerHtml(), { waitUntil: 'load' });
  await page.pdf({ path: join(salida, 'folleto-ventard.pdf'), format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await page.screenshot({ path: join(salida, 'folleto-ventard-preview.png'), fullPage: true });
  console.log('✓ folleto-ventard.pdf');
  await page.close();
}

await browser.close();
console.log(`\nKit generado en: ${salida}`);
