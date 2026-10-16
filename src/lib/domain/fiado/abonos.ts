import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { CajaLocal, TransaccionFiadoLocal } from '@/types/database';
import {sharedBalanceCents} from '@/lib/sync/shared-balance';

export type MetodoAbono = 'efectivo' | 'tarjeta' | 'transferencia';
const metodos: readonly string[] = ['efectivo', 'tarjeta', 'transferencia'];

/** Trabajar en centavos; no aceptar fracciones de centavo ni NaN. */
function centavos(valor: string | number): number {
    if (typeof valor === 'number') {
        const redondeado = Math.round(valor * 100);
        // Solo ruido binario de importes previamente guardados, no fracciones reales.
        if (!Number.isFinite(valor) || valor < 0 || !Number.isSafeInteger(redondeado) || Math.abs(valor * 100 - redondeado) > 0.000001) {
            throw new Error('Importe histórico no verificable en centavos.');
        }
        return redondeado;
    }
    const texto = String(valor).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(texto)) throw new Error('Importe inválido: usa hasta dos decimales.');
    const [entero, decimal = ''] = texto.split('.');
    const resultado = Number(entero) * 100 + Number(decimal.padEnd(2, '0'));
    if (!Number.isSafeInteger(resultado)) throw new Error('Importe fuera de rango.');
    return resultado;
}

export interface EntradaAbono {
    id: string;
    negocioId: string;
    sucursalId: string | null;
    cajaId: string;
    clienteId: string;
    monto: string;
    metodo: MetodoAbono;
    concepto: string;
    fecha: number;
}

/** Un único commit de deuda/contexto. No crea ventas ni modifica stock/caja. */
export async function registrarAbonoLocal(database: VentaRDDatabase, entrada: EntradaAbono): Promise<TransaccionFiadoLocal> {
    const monto = centavos(entrada.monto);
    if (monto <= 0 || !metodos.includes(entrada.metodo) || !entrada.id || !entrada.negocioId ||
        !entrada.clienteId || !entrada.cajaId || !Number.isSafeInteger(entrada.fecha)) {
        throw new Error('Datos de abono inválidos.');
    }
    return database.transaction('rw', database.transacciones_fiado, database.clientes, database.cajas, async () => {
        const previa = await database.transacciones_fiado.get(entrada.id);
        if (previa) {
            if (previa.tipo === 'abono' && previa.negocio_id === entrada.negocioId &&
                previa.cliente_id === entrada.clienteId && previa.caja_id === entrada.cajaId &&
                previa.sucursal_id === entrada.sucursalId && previa.metodo_pago === entrada.metodo &&
                centavos(previa.monto) === monto && previa.concepto === entrada.concepto) return previa;
            throw new Error('Identidad de abono reutilizada con datos diferentes.');
        }
        const cliente = await database.clientes.get(entrada.clienteId);
        if (!cliente || cliente.eliminado || cliente.negocio_id !== entrada.negocioId) throw new Error('Cliente no disponible en este negocio.');
        const cajas = await database.cajas.where('negocio_id').equals(entrada.negocioId)
            .filter(c => c.estado === 'abierta' && (c.sucursal_id ?? null) === entrada.sucursalId).toArray();
        if (cajas.length !== 1 || cajas[0].id !== entrada.cajaId || entrada.fecha < cajas[0].fecha_apertura) {
            throw new Error('Caja cerrada, cambiada o ambigua. Verifica la caja antes de recibir el abono.');
        }
        const historial = await database.transacciones_fiado.where('cliente_id').equals(entrada.clienteId)
            .filter(t => t.negocio_id === entrada.negocioId).toArray();
        const saldo = sharedBalanceCents(cliente,historial);
        if (!Number.isSafeInteger(saldo) || monto > saldo) throw new Error('El abono supera el saldo actual del cliente.');
        const fila: TransaccionFiadoLocal = {
            id: entrada.id, negocio_id: entrada.negocioId, sucursal_id: entrada.sucursalId,
            caja_id: entrada.cajaId, cliente_id: entrada.clienteId, venta_id: null,
            tipo: 'abono', monto: monto / 100, metodo_pago: entrada.metodo, concepto: entrada.concepto,
            fecha_creacion: entrada.fecha, fecha_actualizacion: entrada.fecha, estado_sincronizacion: 0,
        };
        await database.transacciones_fiado.add(fila);
        return fila;
    });
}

/** Legacy jamás se atribuye por texto, sesión de upload o proximidad temporal. */
export function resumirAbonosCaja(filas: readonly TransaccionFiadoLocal[], caja: CajaLocal, asOf: number) {
    const cents = { efectivo: 0, tarjeta: 0, transferencia: 0 };
    const incluidos: TransaccionFiadoLocal[] = [];
    let noClasificados = 0;
    const fin = Math.min(asOf, caja.fecha_cierre ?? asOf);
    for (const t of filas) {
        if (t.tipo !== 'abono' || t.negocio_id !== caja.negocio_id ||
            !Number.isSafeInteger(t.fecha_creacion) || t.fecha_creacion < caja.fecha_apertura || t.fecha_creacion > fin) continue;
        if (t.sucursal_id != null && t.sucursal_id !== caja.sucursal_id) continue;
        if (t.caja_id && t.caja_id !== caja.id) continue;
        if (t.sucursal_id === undefined || !t.caja_id || !t.metodo_pago || !metodos.includes(t.metodo_pago)) {
            noClasificados++; continue;
        }
        if ((t.sucursal_id ?? null) !== (caja.sucursal_id ?? null)) continue;
        try {
            const monto = centavos(t.monto);
            if (monto <= 0) { noClasificados++; continue; }
            const siguiente = cents[t.metodo_pago] + monto;
            if (!Number.isSafeInteger(siguiente)) { noClasificados++; continue; }
            cents[t.metodo_pago] = siguiente;
            incluidos.push(t);
        } catch { noClasificados++; }
    }
    return {
        efectivo: cents.efectivo / 100, tarjeta: cents.tarjeta / 100, transferencia: cents.transferencia / 100,
        total: (cents.efectivo + cents.tarjeta + cents.transferencia) / 100,
        noClasificados, incluidos,
    };
}

/** Cierra serializado con la recepción de abonos; no altera el resto de fuentes. */
export async function cerrarCajaConAbonos(database: VentaRDDatabase, entrada: {
    cajaId: string; negocioId: string; sucursalId: string | null; fecha?: number;
    esperadoSinFiado: number; contado: number; denominaciones: Record<string, number>; notas?: string;
}) {
    return database.transaction('rw', database.cajas, database.transacciones_fiado, async () => {
        // El reloj se toma DESPUÉS de adquirir la transacción, no antes de esperar
        // a un abono concurrente. Las pruebas pueden inyectar una fecha fija.
        const fecha = entrada.fecha ?? Date.now();
        const caja = await database.cajas.get(entrada.cajaId);
        if (!caja || caja.estado !== 'abierta' || caja.negocio_id !== entrada.negocioId ||
            (caja.sucursal_id ?? null) !== entrada.sucursalId || !Number.isSafeInteger(fecha) || fecha < caja.fecha_apertura) {
            throw new Error('Caja cambiada o cerrada.');
        }
        if (!Number.isFinite(entrada.esperadoSinFiado) || !Number.isFinite(entrada.contado) || entrada.contado < 0) throw new Error('Conteo inválido.');
        const filas = await database.transacciones_fiado.where('negocio_id').equals(entrada.negocioId).toArray();
        const abonos = resumirAbonosCaja(filas, caja, fecha);
        const montoEsperado = Math.round((entrada.esperadoSinFiado + abonos.efectivo) * 100) / 100;
        const diferencia = Math.round((entrada.contado - montoEsperado) * 100) / 100;
        await database.cajas.update(caja.id, {
            estado: 'cerrada', monto_cierre: entrada.contado, monto_esperado: montoEsperado, diferencia,
            denominaciones_cierre: entrada.denominaciones, fecha_cierre: fecha, notas: entrada.notas,
            estado_sincronizacion: 0, fecha_actualizacion: fecha,
        });
        return { montoEsperado, diferencia, abonos };
    });
}

/** Los campos legacy desconocidos se omiten, no se rellenan con la sesión actual. */
export function payloadFiadoRemoto(t: TransaccionFiadoLocal) {
    return {
        id: t.id, negocio_id: t.negocio_id, cliente_id: t.cliente_id, venta_id: t.venta_id,
        tipo: t.tipo, monto: t.monto, concepto: t.concepto,
        fecha_creacion: new Date(t.fecha_creacion).toISOString(), fecha_actualizacion: t.fecha_actualizacion,
        ...(t.sucursal_id !== undefined ? { sucursal_id: t.sucursal_id } : {}),
        ...(t.caja_id !== undefined ? { caja_id: t.caja_id } : {}),
        ...(t.metodo_pago !== undefined ? { metodo_pago: t.metodo_pago } : {}),
    };
}
