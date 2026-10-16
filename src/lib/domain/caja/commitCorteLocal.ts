import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { CajaLocal, CorteCajaLocal, PagoReparacion, AbonoApartado } from '@/types/database';
import { commandHash, moneyCents } from '@/lib/domain/local/command';
import { calcularResumenCaja } from './resumenTurno';
import { sharedCashRefunds } from '@/lib/sync/shared-cash-refunds';
import { resumirAbonosCaja } from '@/lib/domain/fiado/abonos';
export interface CorteEntrada {
    operationId: string; negocioId: string; sucursalId?: string; cajaId: string; tipo: 'X' | 'Z';
    /** Inyectable para pruebas. UI omite: el reloj se toma después de adquirir el lock. */
    fecha?: number;
    contado?: number; denominaciones?: Record<string, number>; notas?: string;
}
type Detalle = { key: string; fecha: number; tipo: string; titulo: string; monto: number; signo: 'in' | 'out' };
function validarConteo(contado: number | undefined, denominaciones: Record<string, number> | undefined) {
    const values = new Set([2000, 1000, 500, 200, 100, 50, 25, 10, 5, 1]);
    let cents = 0;
    for (const [value, qty] of Object.entries(denominaciones ?? {})) {
        if (!values.has(Number(value)) || String(Number(value)) !== value || !Number.isSafeInteger(qty) || qty < 0) throw new Error('conteo_invalido');
        cents += Number(value) * 100 * qty;
    }
    if (!Number.isSafeInteger(cents) || contado == null || moneyCents(contado) !== cents) throw new Error('conteo_invalido');
}
export async function abrirCajaLocal(database: VentaRDDatabase, caja: CajaLocal): Promise<CajaLocal> {
    caja = structuredClone(caja);
    if (!caja.id || !caja.negocio_id || caja.estado !== 'abierta' || !Number.isSafeInteger(caja.fecha_apertura) || caja.fecha_apertura <= 0) throw new Error('turno_command_invalid');
    validarConteo(caja.monto_apertura, caja.denominaciones_apertura);
    const hash = commandHash({ kind: 'OPEN_TURN', contractVersion: 1, ...caja });
    const journalId = `${caja.negocio_id}:OPEN_TURN:${caja.id}`;
    return database.transaction('rw', [database.cajas, database.operaciones_locales], async () => {
        const journal = await database.operaciones_locales.get(journalId);
        if (journal) {
            if (journal.payload_hash !== hash) throw new Error('operacion_id_conflicto');
            return journal.resultado as CajaLocal;
        }
        const abiertas = await database.cajas.where('negocio_id').equals(caja.negocio_id)
            .filter(c => c.estado === 'abierta' && (c.sucursal_id ?? null) === (caja.sucursal_id ?? null)).toArray();
        if (abiertas.length > 1) throw new Error('turno_ambiguo');
        if (abiertas.length) throw new Error('turno_ya_abierto');
        const created = { ...caja, estado_sincronizacion: 0 as const, fecha_actualizacion: caja.fecha_apertura };
        await database.cajas.add(created);
        await database.operaciones_locales.add({ id: journalId, negocio_id: caja.negocio_id, operation_id: caja.id,
            tipo: 'OPEN_TURN', contract_version: 1, payload_hash: hash, estado_local: 'COMMITTED', estado_remoto: 'NOT_ENABLED',
            fecha_origen: caja.fecha_apertura, resultado: created });
        return created;
    });
}
const tables = (db: VentaRDDatabase) => [db.cajas, db.ventas, db.venta_detalles, db.devoluciones,
    db.gastos, db.reparaciones, db.apartados, db.transacciones_fiado, db.cortes_caja, db.operaciones_locales, db.shared_entities, db.shared_mutations];

/** Snapshot tenant/sucursal/ventana. No usa Zustand, red, impresión ni cifras de UI. */
export async function leerResumenCorte(database: VentaRDDatabase, caja: CajaLocal, fecha: number) {
    const inWindow = (t: number) => t >= caja.fecha_apertura && t <= fecha;
    const scope = (row: { negocio_id: string; sucursal_id?: string | null }) => row.negocio_id === caja.negocio_id && (row.sucursal_id ?? null) === (caja.sucursal_id ?? null);
    const detallesEfectivo: Detalle[] = [];
    const limites: string[] = [];
    const ventasTenant = await database.ventas.where('negocio_id').equals(caja.negocio_id).toArray();
    const referencias = ventasTenant.filter(scope);
    const ventas = referencias.filter(v => inWindow(v.fecha_creacion) && (!v.caja_id || v.caja_id === caja.id));
    if (ventas.some(v => !v.caja_id)) limites.push('VENTAS_LEGACY_ATRIBUIDAS_POR_VENTANA');
    const referenciasMap = new Map(referencias.map(v => [v.id, v]));
    const devoluciones = (await database.devoluciones.where('negocio_id').equals(caja.negocio_id).toArray())
        .filter(d => inWindow(d.fecha_creacion) && referenciasMap.has(d.venta_id) && (!d.caja_id || d.caja_id === caja.id));
    const necesarias = new Map(ventas.map(v => [v.id, v]));
    devoluciones.forEach(d => necesarias.set(d.venta_id, referenciasMap.get(d.venta_id)!));
    for (const v of necesarias.values()) {
        // Nunca aceptar fracciones de centavo por la fórmula legacy de redondeo.
        moneyCents(v.total);
        if (v.metodo_pago === 'mixto') { moneyCents(v.monto_efectivo ?? 0); moneyCents(v.monto_transferencia ?? 0); }
    }
    for (const d of devoluciones) moneyCents(d.monto_devuelto);
    if (devoluciones.length) limites.push('DEVOLUCIONES_CLASIFICADAS_POR_METODO_ORIGINAL_NO_LIQUIDACION_BANCARIA');
    const resumen = calcularResumenCaja(ventas, devoluciones, referencias);
    for (const v of ventas) {
        moneyCents(v.total);
        const cash = v.metodo_pago === 'efectivo' ? v.total : v.metodo_pago === 'mixto' ? v.monto_efectivo ?? 0 : 0;
        if (cash > 0) detallesEfectivo.push({ key: `v-${v.id}`, fecha: v.fecha_creacion, tipo: 'Venta', titulo: `Venta #${v.numero_ticket ?? '—'}`, monto: cash, signo: 'in' });
    }
    for (const d of devoluciones) {
        moneyCents(d.monto_devuelto);
        const v = referenciasMap.get(d.venta_id)!;
        const cash = v.metodo_pago === 'efectivo' ? d.monto_devuelto : v.metodo_pago === 'mixto' && v.total > 0
            ? Math.round(d.monto_devuelto * (v.monto_efectivo ?? 0) / v.total * 100) / 100 : 0;
        if (cash > 0) detallesEfectivo.push({ key: `d-${d.id}`, fecha: d.fecha_creacion, tipo: 'Devolución', titulo: d.razon || 'Devolución', monto: cash, signo: 'out' });
    }
    let gastosCents = 0;
    for (const g of await database.gastos.where('negocio_id').equals(caja.negocio_id).toArray()) {
        if (!scope(g) || !inWindow(g.fecha_creacion) || g.eliminado || g.metodo !== 'efectivo') continue;
        gastosCents += moneyCents(g.monto);
        detallesEfectivo.push({ key: `g-${g.id}`, fecha: g.fecha_creacion, tipo: 'Gasto', titulo: g.descripcion || 'Gasto', monto: g.monto, signo: 'out' });
    }
    const services = async (kind: 'REPARACION' | 'APARTADO') => {
        const cents = { efectivo: 0, tarjeta: 0, transferencia: 0, total: 0 };
        const sumar = (p: Pick<PagoReparacion | AbonoApartado, 'fecha' | 'metodo' | 'monto' | 'caja_id'>, key: string, folio: string) => {
            if (!inWindow(p.fecha) || p.caja_id && p.caja_id !== caja.id) return;
            if (!['efectivo', 'tarjeta', 'transferencia'].includes(p.metodo)) { limites.push('PAGO_SERVICIO_METODO_DESCONOCIDO'); return; }
            if (!p.caja_id) limites.push('PAGOS_SERVICIO_LEGACY_ATRIBUIDOS_POR_VENTANA');
            const amount = moneyCents(p.monto); cents[p.metodo] += amount; cents.total += amount;
            if (p.metodo === 'efectivo' && amount > 0) detallesEfectivo.push({ key, fecha: p.fecha, tipo: kind === 'REPARACION' ? 'Reparación' : 'Apartado', titulo: `${folio} · pago`, monto: amount / 100, signo: 'in' });
        };
        if (kind === 'REPARACION') {
            for (const r of (await database.reparaciones.where('negocio_id').equals(caja.negocio_id).toArray()).filter(scope)) {
                if (r.pagos?.length) r.pagos.forEach((p, i) => sumar(p, `rp-${r.id}-${i}`, r.folio));
                else {
                    // Fórmula legacy caracterizada; método ausente NO se inventa efectivo.
                    if (r.abono > 0 && inWindow(r.fecha_creacion)) {
                        if (r.metodo_abono) sumar({ fecha: r.fecha_creacion, metodo: r.metodo_abono, monto: r.abono }, `ra-${r.id}`, r.folio);
                        else limites.push('REPARACION_LEGACY_METODO_DESCONOCIDO');
                    }
                    if (r.estado === 'entregado' && r.fecha_entrega && inWindow(r.fecha_entrega)) {
                        if (r.metodo_pago_final) sumar({ fecha: r.fecha_entrega, metodo: r.metodo_pago_final, monto: Math.max(0, r.total - r.abono) }, `rf-${r.id}`, r.folio);
                        else limites.push('REPARACION_LEGACY_METODO_DESCONOCIDO');
                    }
                }
            }
        } else for (const a of (await database.apartados.where('negocio_id').equals(caja.negocio_id).toArray()).filter(scope)) {
            a.abonos.forEach((p, i) => sumar(p, `ap-${a.id}-${i}`, a.folio));
        }
        return { efectivo: cents.efectivo / 100, tarjeta: cents.tarjeta / 100, transferencia: cents.transferencia / 100, total: cents.total / 100 };
    };
    const reparaciones = await services('REPARACION');
    const apartados = await services('APARTADO');
    const abonos = resumirAbonosCaja(await database.transacciones_fiado.where('negocio_id').equals(caja.negocio_id).toArray(), caja, fecha);
    if (abonos.noClasificados) limites.push('ABONOS_FIADO_NO_CLASIFICADOS');
    for (const a of abonos.incluidos) if (a.metodo_pago === 'efectivo') detallesEfectivo.push({ key: `fi-${a.id}`, fecha: a.fecha_creacion, tipo: 'Abono fiado', titulo: 'Cobro de deuda · efectivo', monto: a.monto, signo: 'in' });
    const depositos = await sharedCashRefunds(database, caja, fecha);
    detallesEfectivo.push(...depositos.details);
    const esperadoCents = moneyCents(caja.monto_apertura) + Math.round(resumen.efectivo * 100) + moneyCents(reparaciones.efectivo)
        + moneyCents(apartados.efectivo) + moneyCents(abonos.efectivo) - gastosCents - depositos.cents;
    if (!Number.isSafeInteger(esperadoCents)) throw new Error('importe_fuera_de_rango');
    const mapa = new Map<string, { nombre: string; cantidad: number; subtotalCents: number }>();
    const ids = new Set(ventas.map(v => v.id));
    for (const d of await database.venta_detalles.where('negocio_id').equals(caja.negocio_id).toArray()) {
        if (!ids.has(d.venta_id)) continue;
        const prev = mapa.get(d.producto_id) ?? { nombre: d.nombre || 'Producto sin nombre histórico', cantidad: 0, subtotalCents: 0 };
        prev.cantidad += d.cantidad; prev.subtotalCents += moneyCents(d.subtotal); mapa.set(d.producto_id, prev);
    }
    const productos = [...mapa].sort(([a, x], [b, y]) => y.subtotalCents - x.subtotalCents || a.localeCompare(b))
        .map(([, p]) => ({ nombre: p.nombre, cantidad: p.cantidad, subtotal: p.subtotalCents / 100 }));
    return { resumen, depositosDevueltos: depositos.cents / 100, gastos: gastosCents / 100, reparaciones, apartados, abonos, esperado: esperadoCents / 100,
        productos, limites: [...new Set(limites)].sort(), detalleEfectivo: detallesEfectivo.sort((a, b) => b.fecha - a.fecha || a.key.localeCompare(b.key)) };
}

type ResultadoCorte = { corte: CorteCajaLocal; snapshot: Awaited<ReturnType<typeof leerResumenCorte>>; reutilizada: boolean };
/** Commit único de cierre+Z+journal. Todos los productores comparten tablas del lock. */
export async function commitCorteLocal(database: VentaRDDatabase, entrada: CorteEntrada): Promise<ResultadoCorte> {
    entrada = structuredClone(entrada);
    if (!entrada.operationId || entrada.fecha !== undefined && !Number.isSafeInteger(entrada.fecha)) throw new Error('corte_command_invalid');
    const hash = commandHash({ kind: 'CUT', contractVersion: 1, ...entrada });
    const journalId = `${entrada.negocioId}:CUT:${entrada.operationId}`;
    return database.transaction('rw', tables(database), async () => {
        const journal = await database.operaciones_locales.get(journalId);
        if (journal) {
            if (journal.payload_hash !== hash) throw new Error('operacion_id_conflicto');
            return { ...(journal.resultado as Omit<ResultadoCorte, 'reutilizada'>), reutilizada: true };
        }
        const fecha = entrada.fecha ?? Date.now();
        const caja = await database.cajas.get(entrada.cajaId);
        if (!caja || caja.negocio_id !== entrada.negocioId || (caja.sucursal_id ?? null) !== (entrada.sucursalId ?? null)) throw new Error('caja_ambito_invalido');
        const abiertas = await database.cajas.where('negocio_id').equals(entrada.negocioId)
            .filter(c => c.estado === 'abierta' && (c.sucursal_id ?? null) === (entrada.sucursalId ?? null)).toArray();
        if (abiertas.length > 1) throw new Error('turno_ambiguo');
        if (caja.estado !== 'abierta' || abiertas[0]?.id !== caja.id || fecha < caja.fecha_apertura) throw new Error('turno_cambiado');
        if (!['X', 'Z'].includes(entrada.tipo)) throw new Error('corte_tipo_invalido');
        if (entrada.tipo === 'Z') validarConteo(entrada.contado, entrada.denominaciones);
        const snapshot = await leerResumenCorte(database, caja, fecha);
        const { resumen, reparaciones, apartados, abonos } = snapshot;
        const sum = (...numbers: number[]) => numbers.reduce((acc, value) => acc + Math.round(value * 100), 0) / 100;
        const corte: CorteCajaLocal = { id: entrada.operationId, negocio_id: entrada.negocioId, sucursal_id: entrada.sucursalId,
            caja_id: caja.id, tipo: entrada.tipo, fecha_creacion: fecha, efectivo: sum(resumen.efectivo, reparaciones.efectivo, apartados.efectivo, abonos.efectivo),
            tarjeta: sum(resumen.tarjeta, reparaciones.tarjeta, apartados.tarjeta, abonos.tarjeta),
            transferencia: sum(resumen.transferencia, reparaciones.transferencia, apartados.transferencia, abonos.transferencia),
            fiado: resumen.fiado, mixto: resumen.mixto, total_ventas: resumen.total, cantidad_transacciones: resumen.cantidad,
            ingreso_reparaciones: reparaciones.total, ingreso_apartados: apartados.total, ingreso_abonos_fiado: abonos.total,
            limites_locales: snapshot.limites, estado_sincronizacion: 0,
            ...(entrada.tipo === 'Z' ? { monto_apertura: caja.monto_apertura, monto_esperado: snapshot.esperado,
                monto_contado: entrada.contado, diferencia: (moneyCents(entrada.contado!) - Math.round(snapshot.esperado * 100)) / 100 } : {}) };
        if (entrada.tipo === 'Z') await database.cajas.update(caja.id, { estado: 'cerrada', fecha_cierre: fecha,
            monto_cierre: entrada.contado, monto_esperado: corte.monto_esperado, diferencia: corte.diferencia,
            denominaciones_cierre: entrada.denominaciones, notas: entrada.notas, estado_sincronizacion: 0, fecha_actualizacion: fecha });
        await database.cortes_caja.add(corte);
        // El journal no necesita duplicar textos libres de gastos/devoluciones.
        const snapshotGuardado = { ...snapshot, detalleEfectivo: snapshot.detalleEfectivo.map(d => ({ ...d, titulo: d.tipo })) };
        await database.operaciones_locales.add({ id: journalId, negocio_id: entrada.negocioId, operation_id: entrada.operationId,
            tipo: 'CUT', contract_version: 1, payload_hash: hash, estado_local: 'COMMITTED', estado_remoto: 'NOT_ENABLED',
            fecha_origen: fecha, resultado: { corte, snapshot: snapshotGuardado } });
        return { corte, snapshot: snapshotGuardado, reutilizada: false };
    });
}
