import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { EntradaResumenVentas } from './resumenVentas';
import type { VentaLocal } from '@/types/database';

/** Snapshot coherente, read-only; no worker/red ni carga de toda la historia. */
export async function leerResumenVentas(
    database: VentaRDDatabase, negocioId: string, desde: number, hasta: number,
): Promise<EntradaResumenVentas> {
    return database.transaction('r', [database.ventas, database.venta_detalles, database.devoluciones, database.productos], async () => {
        const [ventasPeriodo, devoluciones, productos] = await Promise.all([
            database.ventas.where('[negocio_id+fecha_creacion]').between([negocioId, desde], [negocioId, hasta], true, true).toArray(),
            database.devoluciones.where('negocio_id').equals(negocioId).filter(r => r.fecha_creacion >= desde && r.fecha_creacion <= hasta).toArray(),
            database.productos.where('negocio_id').equals(negocioId).toArray(),
        ]);
        const idsPeriodo = new Set(ventasPeriodo.map(v => v.id));
        const idsAnteriores = [...new Set(devoluciones.map(r => r.venta_id))].filter(id => !idsPeriodo.has(id));
        const anteriores = idsAnteriores.length ? await database.ventas.bulkGet(idsAnteriores) : [];
        const ventas = [...ventasPeriodo, ...anteriores.filter((v): v is VentaLocal => v !== undefined && v.negocio_id === negocioId)];
        const ids = ventas.map(v => v.id);
        const detalles = ids.length ? await database.venta_detalles.where('venta_id').anyOf(ids).filter(d => d.negocio_id === negocioId).toArray() : [];
        return { negocioId, desde, hasta, ventas, detalles, devoluciones, productos };
    });
}
