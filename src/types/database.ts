// src/types/database.ts

export interface Negocio {
    id: string; // ID único del negocio/tenant
    nombre: string;
}

export interface ProductoLocal {
    id: string;
    negocio_id: string;
    nombre: string;
    codigo_barras: string;
    precio_venta: number;   // Precio 1 (menudeo / por defecto)
    precio_2?: number;      // Precio 2 (mayoreo u otro tier)
    precio_3?: number;      // Precio 3 (tier especial)
    costo: number;
    stock_actual: number;
    stock_minimo: number;
    tasa_itbis: number; // Ej: 0.18, 0.16, 0.0
    tipo: 'simple' | 'insumo' | 'combo';
    ubicacion?: string;      // Ubicación física en el local (ej: "Pasillo 2-A")
    imagen_url?: string;     // Foto del producto (Cloudinary)
    serializable?: boolean;  // Si true, cada unidad necesita un número de serie (IMEI, etc.)
    eliminado?: boolean;
    estado_sincronizacion?: 0 | 1;
    fecha_actualizacion?: number;
}

export interface VentaLocal {
    id: string;
    negocio_id: string;
    sucursal_id?: string;
    numero_ticket?: number; // Secuencial por caja (ver caja_codigo)
    caja_codigo?: string;   // Código de la caja que emitió (ej: "C7K") — evita tickets duplicados entre cajas
    ncf?: string;           // Comprobante Fiscal (ej: B0200000001)
    vendedor_nombre?: string; // Nombre de quien atendió la venta (empleado o dueño)
    total: number;
    metodo_pago: 'efectivo' | 'tarjeta' | 'transferencia' | 'fiado' | 'mixto';
    monto_efectivo?: number;      // Para metodo_pago === 'mixto'
    monto_transferencia?: number; // Para metodo_pago === 'mixto'
    cliente_id?: string;          // Para metodo_pago === 'fiado'
    estado_sincronizacion: 0 | 1;
    fecha_creacion: number;
}

export interface CorteCajaLocal {
    id: string;
    negocio_id: string;
    caja_id: string;
    sucursal_id?: string;
    tipo: 'X' | 'Z';               // X = parcial, Z = cierre de turno
    fecha_creacion: number;
    // Desglose por método de pago
    efectivo: number;
    tarjeta: number;
    transferencia: number;
    fiado: number;
    mixto: number;
    total_ventas: number;
    cantidad_transacciones: number;
    // Ingresos del turno por otros módulos (Plan Pro). Los campos efectivo/tarjeta/
    // transferencia ya los incluyen; estos son los subtotales para el desglose.
    ingreso_reparaciones?: number;
    ingreso_apartados?: number;
    // Solo Z: datos del conteo físico
    monto_apertura?: number;
    monto_esperado?: number;
    monto_contado?: number;
    diferencia?: number;
    estado_sincronizacion: 0 | 1;
}

export interface DevolucionLocal {
    id: string;
    negocio_id: string;
    venta_id: string;
    items_devueltos: { producto_id: string; cantidad: number; precio_unitario: number }[];
    monto_devuelto: number;
    razon: string;
    fecha_creacion: number;
    estado_sincronizacion: 0 | 1;
}

export interface VentaDetalleLocal {
    id: string;
    venta_id: string;
    producto_id: string;
    negocio_id: string;
    sucursal_id?: string;
    nombre?: string;         // nombre del producto al momento de la venta (sobrevive a borrados y venta libre)
    cantidad: number;
    precio_unitario: number;
    subtotal: number;
    estado_sincronizacion: 0 | 1;
    fecha_creacion: number;
}

// NUEVA TABLA: ComposicionLocal
export interface ComposicionLocal {
    id: string;
    producto_padre_id: string; // El ID del Combo (ej. Servicio 3 piezas)
    insumo_id: string;         // El ID del Insumo (ej. Pollo Crudo)
    cantidad_necesaria: number; // Cuánto gasta (ej. 0.375 de un pollo)
    estado_sincronizacion?: 0 | 1;
    fecha_actualizacion?: number;
}

export interface ClienteLocal {
    id: string;
    negocio_id: string;
    nombre: string;
    telefono: string | null;
    limite_credito: number; // 0 significa sin límite
    tipo_precio?: 1 | 2 | 3; // Tier de precio asignado (1 = menudeo, 2 = mayoreo, 3 = especial)
    al_por_mayor?: boolean;  // Indicador visual de cliente mayorista
    eliminado?: boolean;     // Borrado suave (se oculta; se conserva para historial)
    estado_sincronizacion: 0 | 1;
    fecha_actualizacion: number;
}

export interface TransaccionFiadoLocal {
    id: string;
    negocio_id: string;
    sucursal_id?: string;
    cliente_id: string;
    venta_id: string | null;
    tipo: 'cargo' | 'abono';
    monto: number;
    concepto: string;
    fecha_creacion: number;
    estado_sincronizacion: 0 | 1;
    fecha_actualizacion: number;
}

export interface CajaLocal {
    id: string;
    negocio_id: string;
    sucursal_id?: string;
    estado: 'abierta' | 'cerrada';
    monto_apertura: number;
    monto_cierre?: number;
    monto_esperado?: number; // calculado: apertura + ventas_efectivo
    diferencia?: number; // cierre - esperado
    denominaciones_apertura?: Record<string, number>; // { "1000": 2, "500": 3, ... }
    denominaciones_cierre?: Record<string, number>;
    fecha_apertura: number;
    fecha_cierre?: number;
    fecha_actualizacion: number;
    notas?: string;
    estado_sincronizacion?: 0 | 1;
}

export interface SerialLocal {
    id: string;
    negocio_id: string;
    producto_id: string;
    numero_serial: string;           // IMEI, serie, código único
    estado: 'disponible' | 'vendido' | 'apartado';
    venta_id?: string | null;        // Venta en la que se vendió
    fecha_venta?: number | null;
    // Garantía (Plan Pro) — se fija al vender. Denormalizamos algunos datos para
    // que la búsqueda por IMEI funcione aunque la venta vieja ya se haya purgado.
    garantia_dias?: number | null;
    garantia_hasta?: number | null;
    cliente_nombre?: string | null;
    precio_venta?: number | null;
    estado_sincronizacion: 0 | 1;
    fecha_actualizacion: number;
}

// ─── Reparaciones (Plan Pro — tiendas de celulares) ───────────────────────────
export type ReparacionEstado =
    | 'recibido'
    | 'diagnostico'
    | 'cotizado'           // diagnóstico + precio listos, esperando decisión del cliente
    | 'en_reparacion'      // cliente aprobó, en reparación
    | 'esperando_repuesto'
    | 'listo'
    | 'entregado'          // terminal
    | 'no_reparado'        // cliente rechazó / irreparable y retiró el equipo (terminal)
    | 'abandonado'         // equipo dejado en tienda (se puede despiezar)
    | 'cancelado';         // terminal

export type MetodoPagoReparacion = 'efectivo' | 'tarjeta' | 'transferencia';

/** Un pago de una reparación (abono parcial, saldo final o cargo de revisión). */
export interface PagoReparacion {
    monto: number;
    metodo: MetodoPagoReparacion;
    fecha: number;
    tipo?: 'abono' | 'final' | 'revision';
}

/** Un repuesto usado en una reparación. Puede venir del inventario (descuenta
 *  stock) o anotarse manualmente (compra externa). */
export interface RepuestoReparacion {
    producto_id?: string;       // presente si el repuesto sale del inventario
    nombre: string;
    cantidad: number;
    costo: number;              // costo unitario (para ganancia)
    precio: number;             // precio unitario cobrado al cliente
    desde_inventario: boolean;
    // Marca interna: si ya se descontó del stock (evita doble descuento al editar)
    stock_aplicado?: boolean;
}

export interface ReparacionLocal {
    id: string;
    negocio_id: string;
    sucursal_id?: string;
    folio: string;                       // consecutivo legible: "REP-001"
    // Cliente (puede no estar registrado: se guarda nombre/teléfono sueltos)
    cliente_id?: string;
    cliente_nombre: string;
    cliente_telefono?: string;
    // Equipo
    equipo_marca?: string;
    equipo_modelo: string;
    equipo_imei?: string;
    equipo_color?: string;
    patron_clave?: string;               // clave o patrón de desbloqueo
    condicion_checklist?: string[];      // estado del equipo al recibirlo (checklist)
    condicion_entrada?: string;          // otros detalles de condición (texto libre)
    accesorios?: string;
    // Servicio
    problema_reportado: string;
    diagnostico?: string;
    estado: ReparacionEstado;
    repuestos: RepuestoReparacion[];
    mano_obra: number;
    total: number;                       // mano_obra + Σ(repuesto.precio × cantidad)
    // Pagos
    abono: number;                       // TOTAL abonado hasta ahora (suma de pagos)
    pagos?: PagoReparacion[];            // historial de pagos (abonos + saldo final)
    metodo_abono?: MetodoPagoReparacion; // legado: método del abono inicial
    metodo_pago_final?: MetodoPagoReparacion; // legado: método del saldo a la entrega
    // Garantía de la reparación (se fija al entregar)
    garantia_dias?: number;
    garantia_hasta?: number;
    tecnico_nombre?: string;             // opcional (futuro: comisiones)
    notas?: string;
    // Garantía / reingreso: si esta reparación es un reingreso por garantía de otra
    es_garantia?: boolean;
    reparacion_origen_id?: string;       // folio/ID de la reparación original
    // Bitácora de cambios de estado (auditoría): quién y cuándo en cada paso
    bitacora?: { estado: ReparacionEstado; fecha: number; usuario: string }[];
    fecha_creacion: number;
    fecha_entrega?: number;
    estado_sincronizacion?: 0 | 1;
    fecha_actualizacion: number;
}

// ─── Apartados (Plan Pro — layaway / plan separe) ─────────────────────────────
export interface AbonoApartado {
    monto: number;
    metodo: MetodoPagoReparacion;   // efectivo | tarjeta | transferencia
    fecha: number;
}

export interface ItemApartado {
    producto_id: string;
    nombre: string;
    cantidad: number;
    precio_unitario: number;
    serial_id?: string;             // si el item es un equipo serializado reservado
    serial_numero?: string;
}

export interface ApartadoLocal {
    id: string;
    negocio_id: string;
    sucursal_id?: string;
    folio: string;                  // consecutivo legible: "AP-001"
    cliente_id?: string;
    cliente_nombre: string;
    cliente_telefono?: string;
    items: ItemApartado[];
    total: number;
    abonado: number;                // suma de abonos
    abonos: AbonoApartado[];
    estado: 'activo' | 'completado' | 'cancelado';
    notas?: string;
    fecha_creacion: number;
    fecha_completado?: number;
    fecha_cancelado?: number;
    estado_sincronizacion?: 0 | 1;
    fecha_actualizacion: number;
}

// Movimiento de stock (kardex): cada cambio de inventario se registra como
// un delta y se aplica atómicamente en la nube — nunca se pisa el stock de otra caja.
export interface MovimientoStockLocal {
    id: string;
    negocio_id: string;
    sucursal_id?: string;
    producto_id: string;
    delta: number;             // negativo = salida (venta/merma), positivo = entrada
    valor_absoluto?: number;   // solo para conteos físicos (establece el stock exacto)
    tipo: 'venta' | 'devolucion' | 'entrada' | 'merma' | 'conteo' | 'importacion' | 'reparacion' | 'apartado';
    referencia_id?: string;    // venta_id / devolucion_id que lo originó
    fecha_creacion: number;
    estado_sincronizacion: 0 | 1;
}

export type GastoCategoria = 'mercancia' | 'servicios' | 'alquiler' | 'sueldos' | 'transporte' | 'otro';

export interface GastoLocal {
    id: string;
    negocio_id: string;
    sucursal_id?: string;
    categoria: GastoCategoria;
    descripcion: string;
    monto: number;
    metodo: 'efectivo' | 'transferencia' | 'tarjeta';
    creado_por?: string;       // Nombre de quien lo registró
    eliminado?: boolean;       // Soft delete (se borra de la nube en el próximo sync)
    fecha_creacion: number;
    fecha_actualizacion: number;
    estado_sincronizacion: 0 | 1;
}

export interface SucursalLocal {
    id: string;
    negocio_id: string;
    nombre: string;
    direccion?: string | null;
    fecha_creacion?: number;
}