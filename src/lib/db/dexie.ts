// src/lib/db/dexie.ts
import Dexie, { Table } from 'dexie';
import { VentaLocal, ProductoLocal, ComposicionLocal, ClienteLocal, TransaccionFiadoLocal, VentaDetalleLocal, CajaLocal, SucursalLocal } from '@/types/database';

export class VentaRDDatabase extends Dexie {
    ventas!: Table<VentaLocal>;
    productos!: Table<ProductoLocal>;
    composiciones!: Table<ComposicionLocal>;
    clientes!: Table<ClienteLocal>;
    transacciones_fiado!: Table<TransaccionFiadoLocal>;
    venta_detalles!: Table<VentaDetalleLocal>;
    cajas!: Table<CajaLocal>;
    sucursales!: Table<SucursalLocal>;

    constructor() {
        super('VentaRD_Vault');

        this.version(7).stores({
            ventas: 'id, negocio_id, estado_sincronizacion, fecha_creacion',
            productos: 'id, negocio_id, codigo_barras, nombre, tipo, estado_sincronizacion, fecha_actualizacion',
            composiciones: 'id, producto_padre_id, insumo_id, estado_sincronizacion, fecha_actualizacion',
            clientes: 'id, negocio_id, nombre, telefono, estado_sincronizacion, fecha_actualizacion',
            transacciones_fiado: 'id, negocio_id, cliente_id, tipo, estado_sincronizacion, fecha_actualizacion',
            venta_detalles: 'id, venta_id, producto_id, estado_sincronizacion, fecha_creacion'
        });

        this.version(8).stores({
            ventas: 'id, negocio_id, estado_sincronizacion, fecha_creacion, numero_ticket',
        });

        this.version(9).stores({
            cajas: 'id, negocio_id, sucursal_id, estado, fecha_apertura',
        });

        this.version(10).stores({
            venta_detalles: 'id, venta_id, producto_id, negocio_id, estado_sincronizacion, fecha_creacion'
        });

        // v11: cajas con sync, tabla de sucursales para cache offline
        this.version(11).stores({
            cajas: 'id, negocio_id, sucursal_id, estado, fecha_apertura, estado_sincronizacion, fecha_actualizacion',
            sucursales: 'id, negocio_id',
        });
    }
}

export const db = new VentaRDDatabase();

/**
 * Genera el siguiente número de ticket secuencial para un negocio.
 */
export async function getNextTicketNumber(negocioId: string): Promise<number> {
    const ultimaVenta = await db.ventas
        .where('negocio_id')
        .equals(negocioId)
        .reverse()
        .sortBy('numero_ticket');

    const ultimoNumero = ultimaVenta
        .filter(v => v.numero_ticket != null)
        .map(v => v.numero_ticket!)[0] || 0;

    return ultimoNumero + 1;
}

/**
 * Obtiene la caja abierta actual para un negocio/sucursal.
 */
export async function getCajaAbierta(negocioId: string, sucursalId?: string): Promise<CajaLocal | undefined> {
    const cajas = await db.cajas
        .where('negocio_id')
        .equals(negocioId)
        .filter(c => c.estado === 'abierta')
        .toArray();

    if (sucursalId) {
        return cajas.find(c => c.sucursal_id === sucursalId);
    }
    return cajas[0];
}