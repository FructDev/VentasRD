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
    precio_venta: number;
    costo: number;
    stock_actual: number;
    stock_minimo: number;
    tasa_itbis: number; // Ej: 0.18, 0.16, 0.0
    tipo: 'simple' | 'insumo' | 'combo';
    estado_sincronizacion?: 0 | 1;
    fecha_actualizacion?: number;
}

export interface VentaLocal {
    id: string;
    negocio_id: string;
    sucursal_id?: string;
    numero_ticket?: number; // Secuencial por negocio
    total: number;
    metodo_pago: 'efectivo' | 'tarjeta' | 'transferencia' | 'fiado' | 'mixto';
    estado_sincronizacion: 0 | 1;
    fecha_creacion: number;
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
    notas?: string;
}