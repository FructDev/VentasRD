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
                .filter(p => incluirInsumos || p.tipo !== 'insumo')
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
            const productosIds = await db.productos
                .where('negocio_id').equals(negocioId)
                .primaryKeys() as string[];
            const productosSet = new Set(productosIds);
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
            ? db.clientes.where('negocio_id').equals(negocioId).toArray()
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
 */
export function useVentasHoyTenant() {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        async () => {
            if (!negocioId) return [];
            const hoy = new Date().setHours(0, 0, 0, 0);
            const ventas = await db.ventas
                .where('negocio_id')
                .equals(negocioId)
                .toArray();
            return ventas.filter(v => v.fecha_creacion >= hoy);
        },
        [negocioId]
    ) || [];
}

/**
 * Ventas del período especificado del negocio actual.
 */
export function useVentasPeriodoTenant(dias: number) {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        async () => {
            if (!negocioId) return [];
            const desde = Date.now() - (dias * 24 * 60 * 60 * 1000);
            const ventas = await db.ventas
                .where('negocio_id')
                .equals(negocioId)
                .toArray();
            return ventas.filter(v => v.fecha_creacion >= desde);
        },
        [negocioId, dias]
    ) || [];
}

/**
 * Ventas en un rango de timestamps arbitrario del negocio actual.
 */
export function useVentasRangoTenant(desde: number, hasta: number) {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        async () => {
            if (!negocioId) return [];
            const ventas = await db.ventas
                .where('negocio_id')
                .equals(negocioId)
                .toArray();
            return ventas.filter(v => v.fecha_creacion >= desde && v.fecha_creacion <= hasta);
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
                .filter(p => p.stock_actual <= p.stock_minimo)
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
 * Ventas del negocio actual, ordenadas por fecha desc.
 */
export function useVentasTenant(limite = 100) {
    const { negocioId } = useConfigStore();
    return useLiveQuery(
        async () => {
            if (!negocioId) return [];
            const ventas = await db.ventas.where('negocio_id').equals(negocioId).toArray();
            return ventas.sort((a, b) => b.fecha_creacion - a.fecha_creacion).slice(0, limite);
        },
        [negocioId, limite]
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
