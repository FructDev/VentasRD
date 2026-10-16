import type { DevolucionLocal, VentaLocal } from '@/types/database';

export interface ResumenCaja {
    efectivo: number;
    tarjeta: number;
    transferencia: number;
    fiado: number;
    mixto: number;
    total: number;
    cantidad: number;
    devoluciones: number;
    efectivoVentas: number;
    efectivoDevuelto: number;
    totalDevuelto: number;
    devolucionesNoClasificadas: number;
}

function moneda(valor: number): number {
    return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function proporcion(valor: number, parte: number, total: number): number {
    return total > 0 ? moneda(valor * parte / total) : 0;
}

/**
 * Caracteriza la fórmula observable del turno. Devoluciones se clasifican por
 * método original: NO constituye evidencia de reintegro o liquidación bancaria.
 * Si falta la venta original el caso queda contado como no clasificable.
 */
export function calcularResumenCaja(
    ventasTurno: VentaLocal[],
    devolucionesTurno: DevolucionLocal[],
    ventasReferencia: VentaLocal[] = ventasTurno,
): ResumenCaja {
    const resumen: ResumenCaja = {
        efectivo: 0,
        tarjeta: 0,
        transferencia: 0,
        fiado: 0,
        mixto: 0,
        total: 0,
        cantidad: ventasTurno.length,
        devoluciones: 0,
        efectivoVentas: 0,
        efectivoDevuelto: 0,
        totalDevuelto: 0,
        devolucionesNoClasificadas: 0,
    };

    for (const venta of ventasTurno) {
        resumen.total = moneda(resumen.total + venta.total);
        if (venta.metodo_pago === 'efectivo') {
            resumen.efectivo = moneda(resumen.efectivo + venta.total);
            resumen.efectivoVentas = moneda(resumen.efectivoVentas + venta.total);
        } else if (venta.metodo_pago === 'tarjeta') {
            resumen.tarjeta = moneda(resumen.tarjeta + venta.total);
        } else if (venta.metodo_pago === 'transferencia') {
            resumen.transferencia = moneda(resumen.transferencia + venta.total);
        } else if (venta.metodo_pago === 'fiado') {
            resumen.fiado = moneda(resumen.fiado + venta.total);
        } else {
            const efectivo = Math.min(venta.total, Math.max(0, venta.monto_efectivo ?? 0));
            const transferencia = Math.min(venta.total - efectivo, Math.max(0, venta.monto_transferencia ?? 0));
            resumen.efectivo = moneda(resumen.efectivo + efectivo);
            resumen.efectivoVentas = moneda(resumen.efectivoVentas + efectivo);
            resumen.transferencia = moneda(resumen.transferencia + transferencia);
            resumen.mixto = moneda(resumen.mixto + venta.total);
        }
    }

    const ventasPorId = new Map(ventasReferencia.map(venta => [venta.id, venta]));
    const devueltoPorVenta = new Map<string, number>();
    const devolucionesOrdenadas = [...devolucionesTurno]
        .sort((a, b) => a.fecha_creacion - b.fecha_creacion || a.id.localeCompare(b.id));

    for (const devolucion of devolucionesOrdenadas) {
        const venta = ventasPorId.get(devolucion.venta_id);
        if (!venta) {
            resumen.devolucionesNoClasificadas++;
            continue;
        }

        const yaDevuelto = devueltoPorVenta.get(venta.id) ?? 0;
        const monto = moneda(Math.min(
            Math.max(0, devolucion.monto_devuelto),
            Math.max(0, venta.total - yaDevuelto),
        ));
        if (monto <= 0) continue;
        devueltoPorVenta.set(venta.id, moneda(yaDevuelto + monto));
        resumen.devoluciones++;
        resumen.totalDevuelto = moneda(resumen.totalDevuelto + monto);
        resumen.total = moneda(resumen.total - monto);

        if (venta.metodo_pago === 'efectivo') {
            resumen.efectivo = moneda(resumen.efectivo - monto);
            resumen.efectivoDevuelto = moneda(resumen.efectivoDevuelto + monto);
        } else if (venta.metodo_pago === 'tarjeta') {
            resumen.tarjeta = moneda(resumen.tarjeta - monto);
        } else if (venta.metodo_pago === 'transferencia') {
            resumen.transferencia = moneda(resumen.transferencia - monto);
        } else if (venta.metodo_pago === 'fiado') {
            resumen.fiado = moneda(resumen.fiado - monto);
        } else {
            const efectivoOriginal = Math.min(venta.total, Math.max(0, venta.monto_efectivo ?? 0));
            const efectivoDevuelto = proporcion(monto, efectivoOriginal, venta.total);
            const transferenciaDevuelta = moneda(monto - efectivoDevuelto);
            resumen.efectivo = moneda(resumen.efectivo - efectivoDevuelto);
            resumen.efectivoDevuelto = moneda(resumen.efectivoDevuelto + efectivoDevuelto);
            resumen.transferencia = moneda(resumen.transferencia - transferenciaDevuelta);
            resumen.mixto = moneda(resumen.mixto - monto);
        }
    }

    return resumen;
}
