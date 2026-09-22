import type {
    MovimientoStockLocal,
    TransaccionFiadoLocal,
    VentaDetalleLocal,
    VentaLocal,
} from '@/types/database';

export const VERSION_CONTRATO_VENTA = 1 as const;

export interface IngredienteVenta {
    productoId: string;
    cantidadNecesaria: number;
}

export interface ItemVentaContrato {
    productoId: string;
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

const CENTAVO = 0.01;

function esNumeroValido(valor: number): boolean {
    return Number.isFinite(valor) && valor >= 0;
}

export function validarConfirmacionVenta(entrada: ConfirmarVentaEntrada): string[] {
    const errores: string[] = [];

    if (entrada.version !== VERSION_CONTRATO_VENTA) errores.push('version_no_soportada');
    if (!entrada.operacionId) errores.push('operacion_id_requerido');
    if (!entrada.negocioId) errores.push('negocio_requerido');
    if (!entrada.cajaCodigo) errores.push('caja_requerida');
    if (!Number.isInteger(entrada.numeroTicket) || entrada.numeroTicket <= 0) errores.push('ticket_invalido');
    if (!esNumeroValido(entrada.total)) errores.push('total_invalido');
    if (!Number.isFinite(entrada.fecha) || entrada.fecha <= 0) errores.push('fecha_invalida');
    if (entrada.items.length === 0) errores.push('venta_sin_items');

    const seriales = new Set<string>();
    entrada.items.forEach((item, indice) => {
        if (!item.productoId) errores.push(`item_${indice}_producto_requerido`);
        if (!item.nombre.trim()) errores.push(`item_${indice}_nombre_requerido`);
        if (!Number.isFinite(item.cantidad) || item.cantidad <= 0) errores.push(`item_${indice}_cantidad_invalida`);
        if (!esNumeroValido(item.precioUnitario)) errores.push(`item_${indice}_precio_invalido`);
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
        if (Math.abs(efectivo + transferencia - entrada.total) > CENTAVO) errores.push('pago_mixto_no_cuadra');
    }

    return errores;
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

    const detalles: VentaDetalleLocal[] = entrada.items.map((item, indice) => ({
        id: crearId('detalle', indice),
        venta_id: entrada.operacionId,
        producto_id: item.productoId,
        negocio_id: entrada.negocioId,
        sucursal_id: entrada.sucursalId,
        nombre: item.nombre,
        cantidad: item.cantidad,
        precio_unitario: item.precioUnitario,
        subtotal: item.precioUnitario * item.cantidad,
        estado_sincronizacion: 0,
        fecha_creacion: entrada.fecha,
    }));

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
        const objetivos = item.ingredientes?.length
            ? item.ingredientes.map(i => ({ productoId: i.productoId, cantidad: i.cantidadNecesaria * item.cantidad }))
            : [{ productoId: item.productoId, cantidad: item.cantidad }];

        for (const objetivo of objetivos) {
            movimientosStock.push({
                id: crearId('movimiento_stock', movimientoIndice++),
                negocio_id: entrada.negocioId,
                sucursal_id: entrada.sucursalId,
                producto_id: objetivo.productoId,
                delta: -objetivo.cantidad,
                tipo: 'venta',
                referencia_id: entrada.operacionId,
                fecha_creacion: entrada.fecha,
                estado_sincronizacion: 0,
            });
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
        impactoCaja,
        secuencia: {
            cajaCodigo: entrada.cajaCodigo,
            numeroTicket: entrada.numeroTicket,
            ncf: entrada.ncf,
        },
    };
}
