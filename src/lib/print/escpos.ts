// src/lib/print/escpos.ts
// Generador de comandos ESC/POS para impresoras térmicas.
// Produce un Uint8Array listo para enviar por USB, Bluetooth o Serial.

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

// Mapeo de caracteres españoles a CP850 (codepage estándar en térmicas)
const CP850: Record<string, number> = {
    'á': 0xa0, 'é': 0x82, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3,
    'Á': 0xb5, 'É': 0x90, 'Í': 0xd6, 'Ó': 0xe0, 'Ú': 0xe9,
    'ñ': 0xa4, 'Ñ': 0xa5, 'ü': 0x81, 'Ü': 0x9a,
    '¿': 0xa8, '¡': 0xad, '°': 0xf8, 'º': 0xa7, 'ª': 0xa6,
};

function encodeCP850(texto: string): number[] {
    const out: number[] = [];
    for (const ch of texto) {
        const code = ch.codePointAt(0)!;
        if (code < 128) out.push(code);
        else if (CP850[ch] !== undefined) out.push(CP850[ch]);
        else out.push(0x3f); // '?'
    }
    return out;
}

export interface LogoBitmap {
    widthBytes: number; // bytes por fila (ancho en px / 8)
    height: number;
    data: Uint8Array;   // 1 bit por pixel, MSB primero
}

export class EscPosBuilder {
    private buf: number[] = [];

    raw(...bytes: number[]) { this.buf.push(...bytes); return this; }

    /** Inicializa la impresora y selecciona CP850 */
    init() {
        this.raw(ESC, 0x40);       // ESC @ — reset
        this.raw(ESC, 0x74, 2);    // ESC t 2 — codepage CP850
        return this;
    }

    /** 0 = izquierda, 1 = centro, 2 = derecha */
    align(n: 0 | 1 | 2) { return this.raw(ESC, 0x61, n); }

    bold(on: boolean) { return this.raw(ESC, 0x45, on ? 1 : 0); }

    /** Texto doble alto y ancho (para títulos) */
    doble(on: boolean) { return this.raw(GS, 0x21, on ? 0x11 : 0x00); }

    /** Texto doble alto solamente */
    dobleAlto(on: boolean) { return this.raw(GS, 0x21, on ? 0x01 : 0x00); }

    text(texto: string) { this.buf.push(...encodeCP850(texto)); return this; }

    line(texto = '') { return this.text(texto).raw(LF); }

    feed(n = 1) { for (let i = 0; i < n; i++) this.raw(LF); return this; }

    divider(cols: number, char = '-') { return this.line(char.repeat(cols)); }

    /** Línea con texto a la izquierda y a la derecha, rellenada con espacios */
    lineLR(izq: string, der: string, cols: number) {
        const espacio = cols - izq.length - der.length;
        if (espacio < 1) {
            // Truncar la izquierda si no cabe
            const maxIzq = cols - der.length - 1;
            izq = maxIzq > 3 ? izq.slice(0, maxIzq - 1) + '…' : izq.slice(0, Math.max(0, maxIzq));
        }
        return this.line(izq + ' '.repeat(Math.max(1, cols - izq.length - der.length)) + der);
    }

    /** Corte parcial de papel (con avance previo) */
    cortar() { return this.raw(GS, 0x56, 66, 3); }

    /** Pulso para abrir la gaveta de dinero (pin 2, estándar) */
    gaveta() { return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa); }

    /** Imprime un bitmap monocromo (GS v 0 — raster) */
    image(bmp: LogoBitmap) {
        const xL = bmp.widthBytes & 0xff;
        const xH = (bmp.widthBytes >> 8) & 0xff;
        const yL = bmp.height & 0xff;
        const yH = (bmp.height >> 8) & 0xff;
        this.raw(GS, 0x76, 0x30, 0x00, xL, xH, yL, yH);
        this.buf.push(...bmp.data);
        return this.raw(LF);
    }

    build(): Uint8Array { return new Uint8Array(this.buf); }
}

/**
 * Carga una imagen (URL o data URL) y la convierte a bitmap monocromo
 * para imprimir como raster. `widthDots` típico: 384 (58mm) o 512 (80mm).
 */
export async function cargarLogoBitmap(url: string, widthDots: number): Promise<LogoBitmap> {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = 'anonymous'; // Cloudinary permite CORS
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('No se pudo cargar el logo'));
        i.src = url;
    });

    // Escalar manteniendo proporción; ancho múltiplo de 8
    const w = Math.min(widthDots, Math.ceil(img.width / 8) * 8);
    const h = Math.round((img.height / img.width) * w);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const pixels = ctx.getImageData(0, 0, w, h).data;
    const widthBytes = w / 8;
    const data = new Uint8Array(widthBytes * h);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            // Luminancia; umbral fijo (funciona bien para logos de alto contraste)
            const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
            if (lum < 160) {
                data[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
            }
        }
    }

    return { widthBytes, height: h, data };
}
