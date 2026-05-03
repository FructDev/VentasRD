// src/lib/db/transactions.ts
import { db } from './dexie';
import { VentaLocal } from '@/types/database';
import { v4 as uuidv4 } from 'uuid';

export const registrarVentaLocal = async (
    negocio_id: string,
    total: number,
    metodo_pago: VentaLocal['metodo_pago']
) => {
    // Construimos el objeto VentaLocal con los datos que faltan
    const nuevaVenta: VentaLocal = {
        id: uuidv4(), // ID único para que no choque con otros cuando se suba a la nube
        negocio_id,
        total,
        metodo_pago,
        estado_sincronizacion: 0, // 0 = Pendiente de subir
        fecha_creacion: Date.now(),
    };

    try {
        // Guardamos en la bóveda local (IndexedDB)
        await db.ventas.add(nuevaVenta);
        console.log("✅ Venta guardada localmente:", nuevaVenta.id);
        return { success: true, id: nuevaVenta.id };
    } catch (error) {
        console.error("❌ Error guardando venta local:", error);
        return { success: false, error };
    }
};