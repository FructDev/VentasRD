// scripts/generate-icons.js
// Genera los íconos PWA de VentaRD en todos los tamaños necesarios
const sharp = require('sharp');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');

// Diseño: fondo navy con carrito dorado
// Construimos el SVG a mano para que sharp lo renderice limpio
function buildSVG(size) {
    const r = Math.round(size * 0.18);   // radio de esquinas redondeadas
    const sw = Math.round(size * 0.055); // stroke-width
    const cx = size / 2;

    // Proporciones del carrito (relativas al tamaño)
    const handleX1 = size * 0.14;
    const handleX2 = size * 0.26;
    const handleY  = size * 0.36;

    const cartL  = size * 0.26;
    const cartR  = size * 0.84;
    const cartT  = size * 0.36;
    const cartB  = size * 0.64;
    const cartMY = size * 0.575; // línea de producto media

    const w1x = size * 0.355;
    const w2x = size * 0.685;
    const wy  = size * 0.76;
    const wr  = size * 0.065;

    // Línea del mango (handle) + separador horizontal interno del carrito
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <!-- Fondo navy con esquinas redondeadas -->
  <rect width="${size}" height="${size}" rx="${r}" fill="#0D1B2E"/>

  <!-- Mango del carrito -->
  <line x1="${handleX1}" y1="${handleY}" x2="${handleX2}" y2="${handleY}"
    stroke="#D4A017" stroke-width="${sw}" stroke-linecap="round"/>

  <!-- Cuerpo del carrito (rectángulo abierto arriba-izquierda) -->
  <path d="M${handleX2} ${cartT} H${cartR} V${cartB} H${cartL} V${cartT}"
    stroke="#D4A017" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>

  <!-- Línea interna (división de productos) -->
  <line x1="${cartL}" y1="${cartMY}" x2="${cartR}" y2="${cartMY}"
    stroke="#D4A017" stroke-width="${Math.round(sw * 0.65)}" stroke-linecap="round" opacity="0.6"/>

  <!-- Ruedas -->
  <circle cx="${w1x}" cy="${wy}" r="${wr}" fill="#D4A017"/>
  <circle cx="${w2x}" cy="${wy}" r="${wr}" fill="#D4A017"/>
</svg>`;
}

async function generate(size, filename) {
    const svg = Buffer.from(buildSVG(size));
    await sharp(svg)
        .png()
        .toFile(path.join(publicDir, filename));
    console.log(`✓ ${filename} (${size}x${size})`);
}

(async () => {
    try {
        await generate(512, 'icon-512x512.png');
        await generate(192, 'icon-192x192.png');
        await generate(180, 'apple-touch-icon.png');
        await generate(32,  'favicon-32x32.png');
        await generate(16,  'favicon-16x16.png');
        console.log('\n✅ Todos los íconos generados en /public');
    } catch (err) {
        console.error('Error generando íconos:', err.message);
        process.exit(1);
    }
})();
