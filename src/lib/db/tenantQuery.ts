// src/lib/db/tenantQuery.ts
// Hooks centralizados que SIEMPRE filtran por negocio_id.
// Toda lectura de Dexie DEBE pasar por aquí para garantizar aislamiento multi-tenant.

import { useLiveQuery } from 'dexie-react-hooks';
import { useConfigStore } from '@/store/useConfigStore';
import { db } from './dexie';

/**
 * Productos del negocio actual (excluye insumos por defecto).
 */
export function useProductosTenant(incluirInsumos = true) {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        () => negocioId
            ? db.productos.where('negocio_id').equals(negocioId)
                .filter(p => !p.eliminado && (incluirInsumos || p.tipo !== 'insumo'))
                .toArray()
            : [],
        [negocioId, incluirInsumos]
    ) || [];
}

/**
 * Composiciones (recetas de combos) del negocio actual.
 * Filtradas por los IDs de productos-padre que pertenecen a este negocio,
 * garantizando aislamiento multi-tenant sin necesidad de negocio_id en la tabla.
 */
export function useComposicionesTenant() {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        async () => {
            if (!negocioId) return [];
            // Excluir productos eliminados para no mostrar composiciones huérfanas
            const productosActivos = await db.productos
                .where('negocio_id').equals(negocioId)
                .filter(p => !p.eliminado)
                .toArray();
            const productosSet = new Set(productosActivos.map(p => p.id));
            const all = await db.composiciones.toArray();
            return all.filter(c => productosSet.has(c.producto_padre_id));
        },
        [negocioId]
    ) || [];
}

/**
 * Clientes del negocio actual.
 */
export function useClientesTenant() {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        () => negocioId
            ? db.clientes.where('negocio_id').equals(negocioId)
                .filter(c => !c.eliminado)
                .toArray()
            : [],
        [negocioId]
    ) || [];
}

/**
 * Transacciones de fiado del negocio actual.
 */
export function useTransaccionesFiadoTenant() {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        () => negocioId
            ? db.transacciones_fiado.where('negocio_id').equals(negocioId).toArray()
            : [],
        [negocioId]
    ) || [];
}

/**
 * Ventas de hoy del negocio actual.
 * Usa el índice compuesto [negocio_id+fecha_creacion] — no carga la tabla completa.
 */
export function useVentasHoyTenant() {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        () => {
            if (!negocioId) return [];
            const hoy = new Date().setHours(0, 0, 0, 0);
            return db.ventas
                .where('[negocio_id+fecha_creacion]')
                .between([negocioId, hoy], [negocioId, Infinity])
                .toArray();
        },
        [negocioId]
    ) || [];
}

/**
 * Ventas del período especificado del negocio actual (vía índice compuesto).
 */
export function useVentasPeriodoTenant(dias: number) {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        () => {
            if (!negocioId) return [];
            const desde = Date.now() - (dias * 24 * 60 * 60 * 1000);
            return db.ventas
                .where('[negocio_id+fecha_creacion]')
                .between([negocioId, desde], [negocioId, Infinity])
                .toArray();
        },
        [negocioId, dias]
    ) || [];
}

/**
 * Ventas en un rango de timestamps arbitrario del negocio actual (vía índice compuesto).
 */
export function useVentasRangoTenant(desde: number, hasta: number) {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        () => {
            if (!negocioId) return [];
            return db.ventas
                .where('[negocio_id+fecha_creacion]')
                .between([negocioId, desde], [negocioId, hasta], true, true)
                .toArray();
        },
        [negocioId, desde, hasta]
    ) || [];
}

/**
 * Productos con stock bajo/agotado del negocio actual.
 */
export function useProductosBajoStockTenant() {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        () => negocioId
            ? db.productos.where('negocio_id').equals(negocioId)
                .filter(p => !p.eliminado && p.stock_actual <= p.stock_minimo)
                .toArray()
            : [],
        [negocioId]
    ) || [];
}

/**
 * Sucursales del negocio actual (desde cache local).
 */
export function useSucursalesTenant() {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        () => negocioId
            ? db.sucursales.where('negocio_id').equals(negocioId).toArray()
            : [],
        [negocioId]
    ) || [];
}

/**
 * Detalles de venta del negocio actual.
 * ⚠️ Carga TODOS los detalles — usar solo en exportes/reportes puntuales.
 * Para vistas, preferir useVentaDetallesPorVentas (consulta por índice).
 */
export function useVentaDetallesTenant() {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        () => negocioId
            ? db.venta_detalles.where('negocio_id').equals(negocioId).toArray()
            : [],
        [negocioId]
    ) || [];
}

/**
 * Detalles SOLO de las ventas indicadas (usa el índice venta_id).
 * Escala con el período visible, no con la historia completa del negocio.
 */
export function useVentaDetallesPorVentas(ventaIds: string[]) {
    // Clave estable: el array cambia de identidad en cada render
    const clave = ventaIds.join(',');
    return useLiveQuery(
        async (): Promise<import('@/types/database').VentaDetalleLocal[]> =>
            ventaIds.length > 0
                ? db.venta_detalles.where('venta_id').anyOf(ventaIds).toArray()
                : [],
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [clave]
    ) || [];
}

/**
 * Ventas del negocio actual, ordenadas por fecha desc.
 * Usa el índice compuesto: lee solo las `limite` más recientes, no toda la tabla.
 */
export function useVentasTenant(limite = 100) {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        () => {
            if (!negocioId) return [];
            return db.ventas
                .where('[negocio_id+fecha_creacion]')
                .between([negocioId, -Infinity], [negocioId, Infinity])
                .reverse()
                .limit(limite)
                .toArray();
        },
        [negocioId, limite]
    ) || [];
}

/**
 * Gastos del negocio actual en un rango de fechas (vía índice compuesto).
 */
export function useGastosRangoTenant(desde: number, hasta: number) {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        async () => {
            if (!negocioId) return [];
            const gastos = await db.gastos
                .where('[negocio_id+fecha_creacion]')
                .between([negocioId, desde], [negocioId, hasta], true, true)
                .toArray();
            return gastos.filter(g => !g.eliminado);
        },
        [negocioId, desde, hasta]
    ) || [];
}

/**
 * Devoluciones del negocio actual.
 */
export function useDevolucionesTenant() {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        () => negocioId
            ? db.devoluciones.where('negocio_id').equals(negocioId).toArray()
            : [],
        [negocioId]
    ) || [];
}
