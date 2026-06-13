// src/lib/print/tickets.ts
// Arma los tickets en ESC/POS y los envía a la impresora directa.
import { EscPosBuilder, cargarLogoBitmap, LogoBitmap } from './escpos';
import { enviarAImpresora } from './transport';
import type { ImpresionConfig } from '@/store/useConfigStore';

export interface DatosVentaTicket {
    items: { cantidad: number; nombre: string; precio: number }[];
    subtotal: number;
    itbis: number;
    descuento: number;
    total: number;
    metodoPago: string;
    montoRecibido: number;
    devuelta: number;
    negocio: { nombre: string; rnc?: string; direccion?: string; telefono?: string };
    numeroTicket?: number;
    cajaCodigo?: string;
    ncf?: string;
    vendedor?: string;
    mensajePie?: string;
    logoUrl?: string;
}

const fmt = (n: number) => n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function colsDe(config: ImpresionConfig): number {
    // Font A estándar: 48 columnas en 80mm, 32 en 58mm
    return config.anchoPapel === '58mm' ? 32 : 48;
}

function dotsDe(config: ImpresionConfig): number {
    return config.anchoPapel === '58mm' ? 360 : 500;
}

/** Intenta cargar el logo; si falla (offline, CORS) sigue sin él */
async function logoSeguro(url: string | undefined, config: ImpresionConfig): Promise<LogoBitmap | null> {
    if (!url || !config.mostrarLogo) return null;
    try {
        return await cargarLogoBitmap(url, dotsDe(config));
    } catch {
        return null;
    }
}

function cabecera(b: EscPosBuilder, datos: DatosVentaTicket, logo: LogoBitmap | null, cols: number) {
    b.align(1);
    if (logo) b.image(logo);
    b.doble(true).bold(true).line(datos.negocio.nombre.toUpperCase()).doble(false).bold(false);
    if (datos.negocio.rnc) b.line(`RNC: ${datos.negocio.rnc}`);
    if (datos.negocio.direccion) b.line(datos.negocio.direccion);
    if (datos.negocio.telefono) b.line(`Tel: ${datos.negocio.telefono}`);
    b.feed(1);
    b.line(`Fecha: ${new Date().toLocaleString('es-DO')}`);
    const numStr = datos.numeroTicket != null ? String(datos.numeroTicket).padStart(5, '0') : '-----';
    b.bold(true).line(`Ticket #: ${datos.cajaCodigo ? `${datos.cajaCodigo}-${numStr}` : numStr}`).bold(false);
    if (datos.vendedor) b.line(`Le atendio: ${datos.vendedor}`);

    if (datos.ncf) {
        b.divider(cols);
        b.line('COMPROBANTE FISCAL');
        b.bold(true).line(datos.ncf).bold(false);
        b.line(datos.ncf.startsWith('B01') ? 'Credito Fiscal' : 'Consumidor Final');
    }
}

function cuerpoVenta(b: EscPosBuilder, datos: DatosVentaTicket, cols: number) {
    b.align(0);
    b.divider(cols);
    b.bold(true).lineLR('CANT DESCRIPCION', 'IMPORTE', cols).bold(false);
    b.divider(cols);

    for (const item of datos.items) {
        const importe = fmt(item.precio * item.cantidad);
        b.lineLR(`${item.cantidad} ${item.nombre}`, importe, cols);
        if (item.cantidad > 1) b.line(`   @ ${fmt(item.precio)}`);
    }

    b.divider(cols);
    b.lineLR('Subtotal:', `RD$ ${fmt(datos.subtotal)}`, cols);
    b.lineLR('ITBIS:', `RD$ ${fmt(datos.itbis)}`, cols);
    if (datos.descuento > 0) b.lineLR('Descuento:', `- RD$ ${fmt(datos.descuento)}`, cols);
    b.bold(true).dobleAlto(true);
    b.lineLR('TOTAL:', `RD$ ${fmt(datos.total)}`, cols);
    b.dobleAlto(false).bold(false);

    b.divider(cols);
    b.lineLR(`Pago (${datos.metodoPago}):`, `RD$ ${fmt(datos.montoRecibido)}`, cols);
    if (datos.metodoPago === 'efectivo') {
        b.bold(true).lineLR('DEVUELTA:', `RD$ ${fmt(datos.devuelta)}`, cols).bold(false);
    }

    b.feed(1);
    b.align(1);
    b.line(datos.mensajePie || '¡Gracias por su compra!');
    b.line('VentaRD POS');
}

/** Construye e imprime el ticket de venta por la impresora directa */
export async function imprimirVentaDirecta(datos: DatosVentaTicket, config: ImpresionConfig): Promise<void> {
    const cols = colsDe(config);
    const logo = await logoSeguro(datos.logoUrl, config);

    const b = new EscPosBuilder();
    b.init();

    // Abrir gaveta en ventas de contado (antes de imprimir, para dar la devuelta rápido)
    if (config.abrirGaveta && (datos.metodoPago === 'efectivo' || datos.metodoPago === 'mixto')) {
        b.gaveta();
    }

    for (let copia = 0; copia < config.copias; copia++) {
        cabecera(b, datos, logo, cols);
        cuerpoVenta(b, datos, cols);
        b.feed(3);
        if (config.cortarPapel) b.cortar();
        else b.feed(2);
    }

    await enviarAImpresora(b.build(), config.tipoConexion);
}

/** Página de prueba para verificar la conexión y el formato */
export async function imprimirPrueba(config: ImpresionConfig, nombreNegocio: string, logoUrl?: string): Promise<void> {
    const cols = colsDe(config);
    const logo = await logoSeguro(logoUrl, config);

    const b = new EscPosBuilder();
    b.init().align(1);
    if (logo) b.image(logo);
    b.doble(true).bold(true).line(nombreNegocio.toUpperCase()).doble(false).bold(false);
    b.feed(1);
    b.line('*** PAGINA DE PRUEBA ***');
    b.line(new Date().toLocaleString('es-DO'));
    b.feed(1);
    b.align(0);
    b.divider(cols);
    b.lineLR('Papel:', config.anchoPapel, cols);
    b.lineLR('Columnas:', String(cols), cols);
    b.lineLR('Conexion:', config.tipoConexion.toUpperCase(), cols);
    b.divider(cols);
    b.line('Caracteres: áéíóú ñÑ ¿¡ RD$');
    b.bold(true).line('Negrita').bold(false);
    b.dobleAlto(true).line('Doble alto').dobleAlto(false);
    b.divider(cols);
    b.align(1).line('Si lees esto, ¡todo funciona!');
    b.feed(3);
    if (config.cortarPapel) b.cortar();

    await enviarAImpresora(b.build(), config.tipoConexion);
}
