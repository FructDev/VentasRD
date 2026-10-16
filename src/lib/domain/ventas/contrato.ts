import type {
    MovimientoStockLocal,
    TransaccionFiadoLocal,
    VentaDetalleLocal,
    VentaLocal,
} from '@/types/database';
import { createInventoryOperation } from '@/lib/sync/inventory/operation-factory';
import { moneyCents } from '@/lib/domain/local/command';
import { decimalRatio } from '@/lib/domain/local/decimal';

export const VERSION_CONTRATO_VENTA = 1 as const;

export interface IngredienteVenta {
    productoId: string;
    cantidadNecesaria: number;
}

export interface ItemVentaContrato {
    productoId: string;
    /** Línea libre explícita. Ausente conserva semántica de catálogo legacy. */
    sinStock?: true;
    nombre: string;
    cantidad: number;
    precioUnitario: number;
    ingredientes?: IngredienteVenta[];
    serial?: {
        id: string;
        numero: string;
    };
}

export interface ConfirmarVentaEntrada {
    version: typeof VERSION_CONTRATO_VENTA;
    operacionId: string;
    negocioId: string;
    sucursalId?: string;
    cajaCodigo: string;
    cajaId?: string;
    numeroTicket: number;
    fecha: number;
    total: number;
    metodoPago: VentaLocal['metodo_pago'];
    montoEfectivo?: number;
    montoTransferencia?: number;
    ncf?: string;
    vendedorNombre?: string;
    clienteId?: string;
    clienteNombre?: string;
    garantiaDias: number;
    /** Identidad de emisión incluida en el comando local; no equivale a gaveta. */
    originDeviceId?: string;
    items: ItemVentaContrato[];
}

export interface ActualizacionSerialVenta {
    serialId: string;
    productoId: string;
    numeroSerial: string;
    ventaId: string;
    fechaVenta: number;
    garantiaDias: number;
    garantiaHasta: number | null;
    clienteNombre: string | null;
    precioVenta: number;
}

export interface EfectosVentaLocal {
    venta: VentaLocal;
    detalles: VentaDetalleLocal[];
    cargoFiado: TransaccionFiadoLocal | null;
    movimientosStock: MovimientoStockLocal[];
    seriales: ActualizacionSerialVenta[];
    /** Snapshot local de consumo vendido. Nunca se reconstruye con la receta actual. */
    stockPorItem?: { productoId: string; cantidadVendida: number; consumos: { productoId: string; cantidad: number }[] }[];
    impactoCaja: {
        efectivo: number;
        tarjeta: number;
        transferencia: number;
        fiado: number;
    };
    secuencia: {
        cajaCodigo: string;
        numeroTicket: number;
        ncf?: string;
    };
}

export type CrearIdEfecto = (
    tipo: 'detalle' | 'fiado' | 'movimiento_stock',
    indice: number,
) => string;

function esNumeroValido(valor: number): boolean {
    return Number.isFinite(valor) && valor >= 0;
}

export interface IncompatibilidadItemVenta {
    itemIndex: number;
    ingredientIndex?: number;
    code: 'stock_consumo_no_entero' | 'stock_consumo_fuera_rango' |
        'stock_consumo_agregado_fuera_rango' | 'importe_precio_no_representable' | 'importe_subtotal_no_representable';
}

function consumoRecetaEntero(necesaria: number, vendida: number): number {
    try {
        const a = decimalRatio(necesaria), b = decimalRatio(vendida);
        const n = a.n * b.n, d = a.d * b.d;
        // NaN se interpreta como incompatibilidad, nunca como cantidad guardada.
        return n % d === BigInt(0) ? Number(n / d) : NaN;
    } catch { return NaN; }
}

/** Preflight puro O(items + ingredientes). No convierte datos legacy ni suma
 * fracciones para ocultar movimientos incompatibles con el protocolo int4. */
export function diagnosticarCompatibilidadItems(items: readonly ItemVentaContrato[]): IncompatibilidadItemVenta[] {
    const issues: IncompatibilidadItemVenta[] = [];
    const consumed = new Map<string, number>();
    items.forEach((item, itemIndex) => {
        let cents: number | undefined;
        try { cents = moneyCents(item.precioUnitario); }
        catch { issues.push({ itemIndex, code: 'importe_precio_no_representable' }); }
        if (cents !== undefined) {
            try { moneyCents(cents * item.cantidad / 100); }
            catch { issues.push({ itemIndex, code: 'importe_subtotal_no_representable' }); }
        }
        if (item.sinStock) return;
        const targets: { productoId: string; quantity: number; ingredientIndex?: number }[] = item.ingredientes?.length
            ? item.ingredientes.map((ingredient, ingredientIndex) => ({
                productoId: ingredient.productoId, quantity: consumoRecetaEntero(ingredient.cantidadNecesaria, item.cantidad), ingredientIndex,
            }))
            : [{ productoId: item.productoId, quantity: item.cantidad }];
        targets.forEach(target => {
            const context = { itemIndex, ...(target.ingredientIndex === undefined ? {} : { ingredientIndex: target.ingredientIndex }) };
            if (!Number.isInteger(target.quantity)) {
                issues.push({ ...context, code: 'stock_consumo_no_entero' }); return;
            }
            if (target.quantity <= 0 || target.quantity > 2_147_483_647) {
                issues.push({ ...context, code: 'stock_consumo_fuera_rango' }); return;
            }
            const accumulated = (consumed.get(target.productoId) ?? 0) + target.quantity;
            consumed.set(target.productoId, accumulated);
            if (accumulated > 2_147_483_647) issues.push({ ...context, code: 'stock_consumo_agregado_fuera_rango' });
        });
    });
    return issues;
}

export function validarConfirmacionVenta(entrada: ConfirmarVentaEntrada): string[] {
    const errores: string[] = [];

    if (entrada.version !== VERSION_CONTRATO_VENTA) errores.push('version_no_soportada');
    if (!entrada.operacionId) errores.push('operacion_id_requerido');
    if (!entrada.negocioId) errores.push('negocio_requerido');
    if (!entrada.cajaCodigo) errores.push('caja_requerida');
    if (!Number.isInteger(entrada.numeroTicket) || entrada.numeroTicket <= 0) errores.push('ticket_invalido');
    if (!esNumeroValido(entrada.total)) errores.push('total_invalido');
    try {
        moneyCents(entrada.total);
        for (const item of entrada.items) moneyCents(item.precioUnitario);
        if (entrada.metodoPago === 'mixto') {
            const efectivo = moneyCents(entrada.montoEfectivo ?? 0);
            const transferencia = moneyCents(entrada.montoTransferencia ?? 0);
            if (efectivo + transferencia !== moneyCents(entrada.total)) errores.push('pago_mixto_no_cuadra');
        }
    } catch { errores.push('importe_no_representable_en_centavos'); }
    if (!['efectivo', 'tarjeta', 'transferencia', 'fiado', 'mixto'].includes(entrada.metodoPago)) errores.push('metodo_pago_invalido');
    if (!Number.isSafeInteger(entrada.garantiaDias) || entrada.garantiaDias < 0) errores.push('garantia_invalida');
    if (!Number.isFinite(entrada.fecha) || entrada.fecha <= 0) errores.push('fecha_invalida');
    if (entrada.items.length === 0) errores.push('venta_sin_items');
    for (const issue of diagnosticarCompatibilidadItems(entrada.items)) {
        errores.push(`item_${issue.itemIndex}${issue.ingredientIndex === undefined ? '' : `_ingrediente_${issue.ingredientIndex}`}_${issue.code}`);
    }

    const seriales = new Set<string>();
    entrada.items.forEach((item, indice) => {
        if (!item.productoId) errores.push(`item_${indice}_producto_requerido`);
        if (!item.nombre.trim()) errores.push(`item_${indice}_nombre_requerido`);
        if (!Number.isFinite(item.cantidad) || item.cantidad <= 0) errores.push(`item_${indice}_cantidad_invalida`);
        if (!esNumeroValido(item.precioUnitario)) errores.push(`item_${indice}_precio_invalido`);
        if (item.sinStock && (item.serial || item.ingredientes?.length)) errores.push(`item_${indice}_libre_con_inventario`);
        if (item.sinStock && !Number.isSafeInteger(item.cantidad)) errores.push(`item_${indice}_libre_cantidad_invalida`);
        if (item.serial) {
            if (item.cantidad !== 1) errores.push(`item_${indice}_serial_cantidad_invalida`);
            if (seriales.has(item.serial.id)) errores.push(`item_${indice}_serial_duplicado`);
            seriales.add(item.serial.id);
        }
        item.ingredientes?.forEach((ingrediente, ingredienteIndice) => {
            if (!ingrediente.productoId) errores.push(`item_${indice}_ingrediente_${ingredienteIndice}_producto_requerido`);
            if (!Number.isFinite(ingrediente.cantidadNecesaria) || ingrediente.cantidadNecesaria <= 0) {
                errores.push(`item_${indice}_ingrediente_${ingredienteIndice}_cantidad_invalida`);
            }
        });
    });

    if (entrada.metodoPago === 'fiado' && !entrada.clienteId) errores.push('fiado_sin_cliente');
    if (entrada.metodoPago === 'mixto') {
        const efectivo = entrada.montoEfectivo ?? 0;
        const transferencia = entrada.montoTransferencia ?? 0;
        if (efectivo <= 0 || transferencia <= 0) errores.push('pago_mixto_incompleto');
    }

    return errores;
}

/** Valida intención antes de consumir NCF/preparar. El ticket provisional solo
 * satisface validación estructural: no lee ni reserva contador. Commit lo asigna. */
export function asegurarContratoPreparacionVenta(entrada: Omit<ConfirmarVentaEntrada, 'numeroTicket'>): void {
    const errors = validarConfirmacionVenta({ ...entrada, numeroTicket: 1 });
    if (errors.length) throw new Error(`venta_invalida:${errors.join(',')}`);
}

export function construirEfectosVenta(
    entrada: ConfirmarVentaEntrada,
    crearId: CrearIdEfecto,
): EfectosVentaLocal {
    const errores = validarConfirmacionVenta(entrada);
    if (errores.length > 0) throw new Error(`venta_invalida:${errores.join(',')}`);

    const venta: VentaLocal = {
        id: entrada.operacionId,
        negocio_id: entrada.negocioId,
        sucursal_id: entrada.sucursalId,
        numero_ticket: entrada.numeroTicket,
        caja_codigo: entrada.cajaCodigo,
        ...(entrada.cajaId ? { caja_id: entrada.cajaId } : {}),
        ncf: entrada.ncf,
        vendedor_nombre: entrada.vendedorNombre,
        total: entrada.total,
        metodo_pago: entrada.metodoPago,
        ...(entrada.metodoPago === 'mixto' && {
            monto_efectivo: entrada.montoEfectivo,
            monto_transferencia: entrada.montoTransferencia,
        }),
        ...(entrada.metodoPago === 'fiado' && entrada.clienteId && { cliente_id: entrada.clienteId }),
        ...(entrada.clienteNombre?.trim() && { cliente_nombre: entrada.clienteNombre.trim() }),
        estado_sincronizacion: 0,
        fecha_creacion: entrada.fecha,
    };

    const detalles: VentaDetalleLocal[] = entrada.items.map((item, indice) => {
        const id = crearId('detalle', indice);
        return {
        id,
        venta_id: entrada.operacionId,
        producto_id: item.sinStock ? id : item.productoId,
        ...(item.sinStock ? { sin_stock: true as const } : {}),
        negocio_id: entrada.negocioId,
        sucursal_id: entrada.sucursalId,
        nombre: item.nombre,
        cantidad: item.cantidad,
        precio_unitario: item.precioUnitario,
        subtotal: moneyCents(item.precioUnitario) * item.cantidad / 100,
        estado_sincronizacion: 0,
        fecha_creacion: entrada.fecha,
    }; });

    const cargoFiado: TransaccionFiadoLocal | null = entrada.metodoPago === 'fiado' && entrada.clienteId
        ? {
            id: crearId('fiado', 0),
            negocio_id: entrada.negocioId,
            sucursal_id: entrada.sucursalId,
            cliente_id: entrada.clienteId,
            venta_id: entrada.operacionId,
            tipo: 'cargo',
            monto: entrada.total,
            concepto: 'Compra en POS',
            fecha_creacion: entrada.fecha,
            fecha_actualizacion: entrada.fecha,
            estado_sincronizacion: 0,
        }
        : null;

    let movimientoIndice = 0;
    const movimientosStock: MovimientoStockLocal[] = [];
    for (const item of entrada.items) {
        if (item.sinStock) continue;
        const objetivos = item.ingredientes?.length
            ? item.ingredientes.map(i => ({ productoId: i.productoId, cantidad: consumoRecetaEntero(i.cantidadNecesaria, item.cantidad) }))
            : [{ productoId: item.productoId, cantidad: item.cantidad }];

        for (const objetivo of objetivos) {
            movimientosStock.push(createInventoryOperation({
                operationId: crearId('movimiento_stock', movimientoIndice++),
                negocioId: entrada.negocioId,
                sucursalId: entrada.sucursalId,
                productoId: objetivo.productoId,
                delta: -objetivo.cantidad,
                tipo: 'venta',
                referenciaId: entrada.operacionId,
                fechaOrigen: entrada.fecha,
                originDeviceId: entrada.originDeviceId ?? entrada.cajaCodigo,
            }));
        }
    }

    const seriales: ActualizacionSerialVenta[] = entrada.items.flatMap(item => item.serial ? [{
        serialId: item.serial.id,
        productoId: item.productoId,
        numeroSerial: item.serial.numero,
        ventaId: entrada.operacionId,
        fechaVenta: entrada.fecha,
        garantiaDias: entrada.garantiaDias,
        garantiaHasta: entrada.garantiaDias > 0
            ? entrada.fecha + entrada.garantiaDias * 24 * 60 * 60 * 1000
            : null,
        clienteNombre: entrada.clienteNombre?.trim() || null,
        precioVenta: item.precioUnitario,
    }] : []);

    const impactoCaja = {
        efectivo: entrada.metodoPago === 'efectivo' ? entrada.total : entrada.metodoPago === 'mixto' ? entrada.montoEfectivo! : 0,
        tarjeta: entrada.metodoPago === 'tarjeta' ? entrada.total : 0,
        transferencia: entrada.metodoPago === 'transferencia' ? entrada.total : entrada.metodoPago === 'mixto' ? entrada.montoTransferencia! : 0,
        fiado: entrada.metodoPago === 'fiado' ? entrada.total : 0,
    };

    return {
        venta,
        detalles,
        cargoFiado,
        movimientosStock,
        seriales,
        stockPorItem: entrada.items.map((item, index) => ({ productoId: detalles[index].producto_id, cantidadVendida: item.cantidad,
            consumos: item.sinStock ? [] : item.ingredientes?.length
                ? item.ingredientes.map(i => ({ productoId: i.productoId, cantidad: consumoRecetaEntero(i.cantidadNecesaria, item.cantidad) }))
                : [{ productoId: item.productoId, cantidad: item.cantidad }] })),
        impactoCaja,
        secuencia: {
            cajaCodigo: entrada.cajaCodigo,
            numeroTicket: entrada.numeroTicket,
            ncf: entrada.ncf,
        },
    };
}
