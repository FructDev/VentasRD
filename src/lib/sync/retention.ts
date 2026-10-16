import type { VentaRDDatabase } from '@/lib/db/dexie';
import { validateExactReceipt } from './inventory/state-machine';

/** Local retention only; never treats a legacy sync flag as a remote receipt. */
export async function purgeAcknowledgedHistory(input: {
    database: VentaRDDatabase;
    negocioId: string;
    asOf: number;
    isCurrentScope?: () => boolean;
}): Promise<{ sales: number; movements: number }> {
    const { database: db, negocioId, asOf } = input;
    const cutoff90 = asOf - 90 * 24 * 60 * 60 * 1000;
    const cutoff30 = asOf - 30 * 24 * 60 * 60 * 1000;
    return db.transaction('rw', [db.ventas, db.venta_detalles, db.movimientos_stock,
        db.devoluciones, db.cortes_caja, db.gastos], async () => {
        if (input.isCurrentScope && !input.isCurrentScope()) return { sales: 0, movements: 0 };
        const sales = await db.ventas.where('negocio_id').equals(negocioId)
            .filter(row => row.fecha_creacion < cutoff90 && row.estado_sincronizacion === 1).toArray();
        const details = sales.length ? await db.venta_detalles.where('venta_id').anyOf(sales.map(row => row.id)).toArray() : [];
        const movements = await db.movimientos_stock.where('negocio_id').equals(negocioId).toArray();
        const blockedSales = new Set(details.filter(row => row.estado_sincronizacion !== 1 || row.negocio_id !== negocioId).map(row => row.venta_id));
        for (const movement of movements) {
            if (movement.estado_sincronizacion !== 1 && movement.referencia_id) blockedSales.add(movement.referencia_id);
        }
        const deletableSales = sales.filter(row => !blockedSales.has(row.id)).map(row => row.id);
        const deletableMovements = movements.filter(row => row.fecha_creacion < cutoff30
            && row.estado_sincronizacion === 1 && row.sync_protocol_version === 2
            && row.sync_state === 'APPLIED' && row.remote_receipt
            && validateExactReceipt(row, row.remote_receipt).ok).map(row => row.id);
        if (input.isCurrentScope && !input.isCurrentScope()) return { sales: 0, movements: 0 };
        if (deletableSales.length) {
            await db.venta_detalles.where('venta_id').anyOf(deletableSales).delete();
            await db.ventas.bulkDelete(deletableSales);
        }
        if (deletableMovements.length) await db.movimientos_stock.bulkDelete(deletableMovements);
        await db.devoluciones.where('negocio_id').equals(negocioId)
            .filter(row => row.fecha_creacion < cutoff90 && row.estado_sincronizacion === 1).delete();
        await db.cortes_caja.where('negocio_id').equals(negocioId)
            .filter(row => row.fecha_creacion < cutoff90 && row.estado_sincronizacion === 1).delete();
        await db.gastos.where('negocio_id').equals(negocioId)
            .filter(row => row.fecha_creacion < cutoff90 && row.estado_sincronizacion === 1 && !row.eliminado).delete();
        return { sales: deletableSales.length, movements: deletableMovements.length };
    });
}
