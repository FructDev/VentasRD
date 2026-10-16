// src/lib/db/dexie.ts
import Dexie, { Table } from 'dexie';
import type {SharedInbox,SharedOutbox,SharedState} from '@/lib/sync/shared-journal';
import type {SharedEntity,SharedCapture} from '@/lib/sync/shared-bootstrap';
import {attachSharedCapture,type SharedMutation} from '@/lib/sync/shared-capture';
import {reserveSharedFolio} from '@/lib/sync/shared-folio';
import type { OperacionLocal } from '@/types/database';
import { VentaLocal, ProductoLocal, ComposicionLocal, ClienteLocal, TransaccionFiadoLocal, VentaDetalleLocal, CajaLocal, SucursalLocal, DevolucionLocal, CorteCajaLocal, SerialLocal, MovimientoStockLocal, GastoLocal, ReparacionLocal, ApartadoLocal, SecuenciaLocal, InventarioSyncCursorLocal } from '@/types/database';

export class VentaRDDatabase extends Dexie {
    ventas!: Table<VentaLocal>;
    productos!: Table<ProductoLocal>;
    composiciones!: Table<ComposicionLocal>;
    clientes!: Table<ClienteLocal>;
    transacciones_fiado!: Table<TransaccionFiadoLocal>;
    venta_detalles!: Table<VentaDetalleLocal>;
    cajas!: Table<CajaLocal>;
    sucursales!: Table<SucursalLocal>;
    devoluciones!: Table<DevolucionLocal>;
    cortes_caja!: Table<CorteCajaLocal>;
    seriales!: Table<SerialLocal>;
    movimientos_stock!: Table<MovimientoStockLocal>;
    gastos!: Table<GastoLocal>;
    reparaciones!: Table<ReparacionLocal>;
    apartados!: Table<ApartadoLocal>;
    secuencias!: Table<SecuenciaLocal>;
    inventario_sync_cursors!: Table<InventarioSyncCursorLocal>;
    operaciones_locales!: Table<OperacionLocal>;
    shared_outbox!: Table<SharedOutbox>;
    shared_inbox!: Table<SharedInbox>;
    shared_state!: Table<SharedState>;
    shared_entities!: Table<SharedEntity>;
    shared_captures!: Table<SharedCapture>;
    shared_mutations!: Table<SharedMutation>;

    constructor(nombre = 'VentaRD_Vault') {
        super(nombre);

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

        // v12: tabla de devoluciones
        this.version(12).stores({
            devoluciones: 'id, negocio_id, venta_id, fecha_creacion, estado_sincronizacion',
        });

        // v13: campo ncf en ventas
        this.version(13).stores({
            ventas: 'id, negocio_id, estado_sincronizacion, fecha_creacion, numero_ticket, ncf',
        });

        // v14: tabla de cortes de caja (X parcial / Z cierre)
        this.version(14).stores({
            cortes_caja: 'id, negocio_id, caja_id, tipo, fecha_creacion, estado_sincronizacion',
        });

        // v15: seriales (IMEI, números de serie por unidad)
        this.version(15).stores({
            seriales: 'id, negocio_id, producto_id, numero_serial, estado, estado_sincronizacion, fecha_actualizacion',
        });

        // v16: movimientos de stock (kardex) — el stock se sincroniza por deltas
        // atómicos en vez de valores absolutos, eliminando pérdidas entre cajas.
        this.version(16).stores({
            movimientos_stock: 'id, negocio_id, producto_id, tipo, estado_sincronizacion, fecha_creacion',
        });

        // v17: índice compuesto [negocio_id+fecha_creacion] — las consultas por
        // período usan el índice en vez de cargar la tabla completa a memoria.
        this.version(17).stores({
            ventas: 'id, negocio_id, estado_sincronizacion, fecha_creacion, numero_ticket, ncf, [negocio_id+fecha_creacion]',
        });

        // v18: gastos (salidas de dinero) — ganancia neta y cuadre de caja completo
        this.version(18).stores({
            gastos: 'id, negocio_id, categoria, estado_sincronizacion, fecha_creacion, [negocio_id+fecha_creacion]',
        });

        // v19: reparaciones (Plan Pro — tiendas de celulares)
        this.version(19).stores({
            reparaciones: 'id, negocio_id, sucursal_id, folio, estado, cliente_telefono, equipo_imei, estado_sincronizacion, fecha_creacion, fecha_actualizacion',
        });

        // v20: apartados (Plan Pro — layaway / plan separe)
        this.version(20).stores({
            apartados: 'id, negocio_id, sucursal_id, folio, estado, cliente_telefono, estado_sincronizacion, fecha_creacion, fecha_actualizacion',
        });

        // v21: contadores locales transaccionales por caja. Es aditivo; el valor
        // inicial se deriva perezosamente del historial y ultimoTicket cacheado.
        this.version(21).stores({
            secuencias: 'id, negocio_id, caja_codigo, tipo',
        });

        // v22: metadata/indices del protocolo de inventario recuperable. La
        // apertura no backfillea: los movimientos legacy se adoptan al leerlos.
        this.version(22).stores({
            movimientos_stock: 'id, negocio_id, producto_id, tipo, estado_sincronizacion, fecha_creacion, [negocio_id+sync_state], [negocio_id+next_attempt_at], [negocio_id+sucursal_id+producto_id]',
            inventario_sync_cursors: 'id, negocio_id, sucursal_id, last_remote_sequence, [negocio_id+sucursal_id]',
        });
        // v23 es expansiva: no altera hechos/flags/recibos de versiones anteriores.
        this.version(23).stores({
            operaciones_locales: 'id, negocio_id, operation_id, tipo, [negocio_id+operation_id]',
        });
        // Additive shared-journal custody. Existing browser facts are untouched.
        this.version(24).stores({
            shared_outbox:'id, scopeKey, [scopeKey+order], [scopeKey+operationId]',
            shared_inbox:'id, scopeKey, &[scopeKey+operationId]',
            shared_state:'id',
            shared_entities:'id, scopeKey, [scopeKey+kind]',
            shared_captures:'id, scopeKey',
            shared_mutations:'id, scopeKey, [scopeKey+order]',
        });
        attachSharedCapture(this);
    }
}

/**
 * Formatea un número de secuencia como NCF completo.
 * Ej: tipo='B02', secuencia=5 → 'B0200000005'
 */
export function formatNcf(tipo: string, secuencia: number): string {
    return `${tipo}${String(secuencia).padStart(8, '0')}`;
}

export const db = new VentaRDDatabase();

/**
 * Genera el siguiente número de ticket secuencial PARA ESTA CAJA.
 * Cada caja tiene su propia secuencia (prefijo caja_codigo), así dos cajas
 * offline nunca generan el mismo ticket.
 */
export async function getNextTicketNumber(negocioId: string, cajaCodigo?: string): Promise<number> {
    const ventas = await db.ventas
        .where('negocio_id')
        .equals(negocioId)
        .toArray();

    // Respaldo persistido en el store: sobrevive a la purga de ventas viejas
    const { useConfigStore } = await import('@/store/useConfigStore');
    const ultimoPersistido = useConfigStore.getState().ultimoTicket;

    // Secuencia de esta caja
    const deEstaCaja = ventas.filter(v => v.numero_ticket != null && v.caja_codigo === cajaCodigo);
    if (deEstaCaja.length > 0 || ultimoPersistido > 0) {
        const maxTabla = deEstaCaja.reduce((m, v) => Math.max(m, v.numero_ticket!), 0);
        return Math.max(maxTabla, ultimoPersistido) + 1;
    }

    // Primera venta con prefijo: continuar desde el máximo global para que un
    // negocio de una sola caja no vea su numeración "reiniciarse"
    const maxGlobal = ventas
        .filter(v => v.numero_ticket != null)
        .reduce((m, v) => Math.max(m, v.numero_ticket!), 0);
    return maxGlobal + 1;
}

/**
 * Genera el siguiente folio de reparación para el negocio (ej. "REP-001").
 * Consecutivo simple por negocio basado en el máximo existente local.
 */
export async function getNextFolioReparacion(negocioId: string): Promise<string> {
    const shared=await reserveSharedFolio(db,negocioId,'REPAIR');if(shared)return shared;
    const reps = await db.reparaciones.where('negocio_id').equals(negocioId).toArray();
    let max = 0;
    for (const r of reps) {
        const m = /REP-(\d+)/i.exec(r.folio || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `REP-${String(max + 1).padStart(3, '0')}`;
}

/**
 * Genera el siguiente folio de apartado para el negocio (ej. "AP-001").
 */
export async function getNextFolioApartado(negocioId: string): Promise<string> {
    const shared=await reserveSharedFolio(db,negocioId,'LAYAWAY');if(shared)return shared;
    const aps = await db.apartados.where('negocio_id').equals(negocioId).toArray();
    let max = 0;
    for (const a of aps) {
        const m = /AP-(\d+)/i.exec(a.folio || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `AP-${String(max + 1).padStart(3, '0')}`;
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
