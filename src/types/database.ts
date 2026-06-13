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
    estado: 'disponible' | 'vendido';
    venta_id?: string | null;        // Venta en la que se vendió
    fecha_venta?: number | null;
    estado_sincronizacion: 0 | 1;
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
    tipo: 'venta' | 'devolucion' | 'entrada' | 'merma' | 'conteo' | 'importacion';
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