// src/lib/print/transport.ts
// Conexión directa con impresoras térmicas: WebUSB, Web Bluetooth y Web Serial.
// Los handles viven en módulo (sobreviven re-renders); los permisos los
// recuerda el navegador, así que tras la primera autorización se reconecta solo.

export type TipoConexion = 'usb' | 'bluetooth' | 'serial';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Handles en runtime
let usbDevice: any = null;
let usbEndpoint: number | null = null;
let btCharacteristic: any = null;
let serialPort: any = null;

// Servicios BLE comunes en impresoras térmicas chinas (Goojprt, Xprinter, etc.)
const BT_SERVICES = [
    0x18f0,
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    '0000ff00-0000-1000-8000-00805f9b34fb',
];

export function soportaConexion(tipo: TipoConexion): boolean {
    if (typeof navigator === 'undefined') return false;
    const nav = navigator as any;
    if (tipo === 'usb') return !!nav.usb;
    if (tipo === 'bluetooth') return !!nav.bluetooth;
    return !!nav.serial;
}

// ─── USB ──────────────────────────────────────────────────────────────────────

async function abrirUSB(device: any): Promise<void> {
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);

    // Buscar la interfaz de impresora (clase 7) o la primera con endpoint OUT
    let claimed = false;
    for (const iface of device.configuration.interfaces) {
        const alt = iface.alternates[0];
        const out = alt.endpoints.find((e: any) => e.direction === 'out');
        if (out && (alt.interfaceClass === 7 || !claimed)) {
            await device.claimInterface(iface.interfaceNumber);
            usbEndpoint = out.endpointNumber;
            claimed = true;
            if (alt.interfaceClass === 7) break;
        }
    }
    if (!claimed) throw new Error('La impresora USB no tiene un canal de salida.');
    usbDevice = device;
}

async function conectarUSB(solicitar: boolean): Promise<void> {
    const usb = (navigator as any).usb;
    if (!usb) throw new Error('Este navegador no soporta WebUSB. Usa Chrome o Edge.');

    if (usbDevice?.opened) return;

    // Reconexión silenciosa con dispositivos ya autorizados
    const autorizados = await usb.getDevices();
    if (autorizados.length > 0) {
        await abrirUSB(autorizados[0]);
        return;
    }
    if (!solicitar) throw new Error('sin_dispositivo');

    // Pedir al usuario que elija (requiere gesto de usuario)
    const device = await usb.requestDevice({
        filters: [{ classCode: 7 }], // impresoras
    }).catch(() => usb.requestDevice({ filters: [] })); // fallback: mostrar todos
    await abrirUSB(device);
}

// ─── Bluetooth ────────────────────────────────────────────────────────────────

async function conectarBluetooth(solicitar: boolean): Promise<void> {
    const bluetooth = (navigator as any).bluetooth;
    if (!bluetooth) throw new Error('Este navegador no soporta Bluetooth. Usa Chrome (Android/PC).');

    if (btCharacteristic?.service?.device?.gatt?.connected) return;

    let device: any = null;

    // Reconexión silenciosa
    if (bluetooth.getDevices) {
        const conocidos = await bluetooth.getDevices().catch(() => []);
        if (conocidos.length > 0) device = conocidos[0];
    }
    if (!device) {
        if (!solicitar) throw new Error('sin_dispositivo');
        device = await bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: BT_SERVICES,
        });
    }

    const gatt = await device.gatt.connect();
    // Buscar una característica escribible en los servicios conocidos
    for (const uuid of BT_SERVICES) {
        try {
            const service = await gatt.getPrimaryService(uuid);
            const chars = await service.getCharacteristics();
            const escribible = chars.find((c: any) => c.properties.write || c.properties.writeWithoutResponse);
            if (escribible) {
                btCharacteristic = escribible;
                return;
            }
        } catch { /* este servicio no existe en esta impresora, probar el siguiente */ }
    }
    throw new Error('No se encontró el canal de impresión Bluetooth.');
}

// ─── Serial ───────────────────────────────────────────────────────────────────

async function conectarSerial(solicitar: boolean): Promise<void> {
    const serial = (navigator as any).serial;
    if (!serial) throw new Error('Este navegador no soporta puertos Serial. Usa Chrome o Edge.');

    if (serialPort?.writable) return;

    const puertos = await serial.getPorts();
    let port = puertos[0] ?? null;
    if (!port) {
        if (!solicitar) throw new Error('sin_dispositivo');
        port = await serial.requestPort();
    }
    await port.open({ baudRate: 9600 });
    serialPort = port;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/** Conecta/empareja la impresora. Llamar desde un click (gesto de usuario). */
export async function conectarImpresora(tipo: TipoConexion): Promise<void> {
    if (tipo === 'usb') await conectarUSB(true);
    else if (tipo === 'bluetooth') await conectarBluetooth(true);
    else await conectarSerial(true);
}

/** Envía bytes ESC/POS. Intenta reconectar en silencio si hace falta. */
export async function enviarAImpresora(data: Uint8Array, tipo: TipoConexion): Promise<void> {
    if (tipo === 'usb') {
        await conectarUSB(false);
        // Enviar en bloques (algunos chips USB se atoran con buffers grandes)
        for (let i = 0; i < data.length; i += 4096) {
            await usbDevice.transferOut(usbEndpoint, data.slice(i, i + 4096));
        }
    } else if (tipo === 'bluetooth') {
        await conectarBluetooth(false);
        // BLE: paquetes pequeños con pausa breve
        const usaSinRespuesta = btCharacteristic.properties.writeWithoutResponse;
        for (let i = 0; i < data.length; i += 100) {
            const chunk = data.slice(i, i + 100);
            if (usaSinRespuesta) await btCharacteristic.writeValueWithoutResponse(chunk);
            else await btCharacteristic.writeValue(chunk);
            await new Promise(r => setTimeout(r, 15));
        }
    } else {
        await conectarSerial(false);
        const writer = serialPort.writable.getWriter();
        try {
            await writer.write(data);
        } finally {
            writer.releaseLock();
        }
    }
}

/** Cierra/olvida la conexión actual (no revoca el permiso del navegador) */
export async function desconectarImpresora(): Promise<void> {
    try { if (usbDevice?.opened) await usbDevice.close(); } catch { }
    try { btCharacteristic?.service?.device?.gatt?.disconnect(); } catch { }
    try { await serialPort?.close(); } catch { }
    usbDevice = null; usbEndpoint = null; btCharacteristic = null; serialPort = null;
}
