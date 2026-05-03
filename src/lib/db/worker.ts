// src/lib/db/worker.ts
import { db } from './dexie';
import { supabase } from '../supabase/client';
import { useConfigStore } from '@/store/useConfigStore';

export const startSyncWorker = () => {
    let isSyncing = false;

    const intervalId = setInterval(async () => {
        if (!navigator.onLine || isSyncing) return;
        isSyncing = true;

        try {
            const { sucursalId, negocioId } = useConfigStore.getState();
            if (!negocioId) { isSyncing = false; return; }
            
            // ==========================================
            // 1. PULL (Descargar de la Nube)
            // ==========================================
            const maxProdObj = await db.productos.orderBy('fecha_actualizacion').last();
            const lastProdSync = maxProdObj?.fecha_actualizacion || 0;

            // --- 1.A PULL CATÁLOGO GLOBAL ---
            const { data: cloudProducts, error: pullProdErr } = await supabase
                .from('productos')
                .select('*')
                .eq('negocio_id', negocioId)
                .gt('fecha_actualizacion', lastProdSync);

            if (!pullProdErr && cloudProducts && cloudProducts.length > 0) {
                console.log(`📥 Descargando ${cloudProducts.length} productos del catálogo global...`);
                
                // Mapear stock local para estos productos
                let cloudStockMap = new Map();
                if (sucursalId) {
                    const { data: stockData } = await supabase
                        .from('inventario_sucursales')
                        .select('producto_id, stock_actual, stock_minimo')
                        .eq('sucursal_id', sucursalId)
                        .in('producto_id', cloudProducts.map(p => p.id));
                    
                    if (stockData) {
                        stockData.forEach(s => cloudStockMap.set(s.producto_id, s));
                    }
                }

                // Fusionar catálogo con stock de la sucursal
                const productosAInsertar = cloudProducts.map(p => {
                    const localStock = cloudStockMap.get(p.id);
                    return {
                        ...p,
                        stock_actual: localStock?.stock_actual || 0,
                        stock_minimo: localStock?.stock_minimo || 0,
                        estado_sincronizacion: 1
                    };
                });
                await db.productos.bulkPut(productosAInsertar);
            }

            // --- 1.B PULL COMPOSICIONES ---
            const maxCompObj = await db.composiciones.orderBy('fecha_actualizacion').last();
            const lastCompSync = maxCompObj?.fecha_actualizacion || 0;

            const { data: cloudComps, error: pullCompErr } = await supabase
                .from('composiciones')
                .select('*')
                .gt('fecha_actualizacion', lastCompSync);

            if (!pullCompErr && cloudComps && cloudComps.length > 0) {
                await db.composiciones.bulkPut(cloudComps.map(c => ({ ...c, estado_sincronizacion: 1 })));
            }

            // --- 1.C PULL CLIENTES ---
            const maxClienteObj = await db.clientes.orderBy('fecha_actualizacion').last();
            const lastClienteSync = maxClienteObj?.fecha_actualizacion || 0;

            const { data: cloudClientes, error: pullClienteErr } = await supabase
                .from('clientes')
                .select('*')
                .eq('negocio_id', negocioId)
                .gt('fecha_actualizacion', lastClienteSync);

            if (!pullClienteErr && cloudClientes && cloudClientes.length > 0) {
                await db.clientes.bulkPut(cloudClientes.map(c => ({ ...c, estado_sincronizacion: 1 })));
            }

            // --- 1.D PULL TRANSACCIONES FIADO ---
            const maxTransObj = await db.transacciones_fiado.orderBy('fecha_actualizacion').last();
            const lastTransSync = maxTransObj?.fecha_actualizacion || 0;

            const { data: cloudTrans, error: pullTransErr } = await supabase
                .from('transacciones_fiado')
                .select('*')
                .eq('negocio_id', negocioId)
                .gt('fecha_actualizacion', lastTransSync);

            if (!pullTransErr && cloudTrans && cloudTrans.length > 0) {
                await db.transacciones_fiado.bulkPut(cloudTrans.map(t => ({ 
                    ...t, 
                    fecha_creacion: new Date(t.fecha_creacion).getTime(),
                    estado_sincronizacion: 1 
                })));
            }

            // ==========================================
            // 2. PUSH (Subir a la Nube)
            // ==========================================
            
            // --- 2.A. VENTAS ---
            const ventasPendientes = await db.ventas.where('estado_sincronizacion').equals(0).toArray();
            if (ventasPendientes.length > 0) {
                for (const venta of ventasPendientes) {
                    const { error } = await supabase.from('ventas').upsert({
                        id: venta.id,
                        negocio_id: venta.negocio_id,
                        sucursal_id: venta.sucursal_id || sucursalId, // Aseguramos que tenga sucursal
                        total: venta.total,
                        metodo_pago: venta.metodo_pago,
                        fecha_creacion: new Date(venta.fecha_creacion).getTime(), // BIGINT
                    });
                    if (!error) await db.ventas.update(venta.id, { estado_sincronizacion: 1 });
                }
            }

            // --- 2.A.2. VENTA_DETALLES ---
            const detallesPendientes = await db.venta_detalles.where('estado_sincronizacion').equals(0).toArray();
            if (detallesPendientes.length > 0) {
                for (const detalle of detallesPendientes) {
                    const { error } = await supabase.from('venta_detalles').upsert({
                        id: detalle.id,
                        venta_id: detalle.venta_id,
                        producto_id: detalle.producto_id,
                        negocio_id: detalle.negocio_id,
                        sucursal_id: detalle.sucursal_id || sucursalId,
                        cantidad: detalle.cantidad,
                        precio_unitario: detalle.precio_unitario,
                        subtotal: detalle.subtotal,
                        fecha_creacion: detalle.fecha_creacion
                    });
                    if (!error) await db.venta_detalles.update(detalle.id, { estado_sincronizacion: 1 });
                }
            }

            // --- 2.B. CATÁLOGO & INVENTARIO (Magia Zero-Friction) ---
            const prodPendientes = await db.productos.where('estado_sincronizacion').equals(0).toArray();
            if (prodPendientes.length > 0) {
                console.log(`⏳ Subiendo ${prodPendientes.length} productos a la nube...`);
                
                // 1. Guardar Catálogo Global
                const { error: prodError } = await supabase.from('productos').upsert(
                    prodPendientes.map(p => ({
                        id: p.id,
                        negocio_id: p.negocio_id,
                        nombre: p.nombre,
                        codigo_barras: p.codigo_barras,
                        precio_venta: p.precio_venta,
                        costo: p.costo,
                        tasa_itbis: p.tasa_itbis,
                        tipo: p.tipo,
                        fecha_actualizacion: p.fecha_actualizacion || Date.now()
                    }))
                );

                if (!prodError) {
                    // 2. Guardar Stock Específico para esta sucursal (si existe sucursalId)
                    if (sucursalId) {
                        await supabase.from('inventario_sucursales').upsert(
                            prodPendientes.map(p => ({
                                sucursal_id: sucursalId,
                                producto_id: p.id,
                                stock_actual: p.stock_actual,
                                stock_minimo: p.stock_minimo,
                                fecha_actualizacion: p.fecha_actualizacion || Date.now()
                            })),
                            { onConflict: 'sucursal_id, producto_id' }
                        );
                    }
                    // Marcar sincronizado localmente
                    await db.productos.bulkPut(prodPendientes.map(p => ({ ...p, estado_sincronizacion: 1 })));
                }
            }

            // --- 2.C. COMPOSICIONES ---
            const compPendientes = await db.composiciones.where('estado_sincronizacion').equals(0).toArray();
            if (compPendientes.length > 0) {
                const { error: compError } = await supabase.from('composiciones').upsert(
                    compPendientes.map(c => ({
                        id: c.id,
                        producto_padre_id: c.producto_padre_id,
                        insumo_id: c.insumo_id,
                        cantidad_necesaria: c.cantidad_necesaria,
                        fecha_actualizacion: c.fecha_actualizacion || Date.now()
                    }))
                );
                if (!compError) await db.composiciones.bulkPut(compPendientes.map(c => ({ ...c, estado_sincronizacion: 1 })));
            }

            // --- 2.D. CLIENTES ---
            const clientesPendientes = await db.clientes.where('estado_sincronizacion').equals(0).toArray();
            if (clientesPendientes.length > 0) {
                const { error: cliError } = await supabase.from('clientes').upsert(
                    clientesPendientes.map(c => ({
                        id: c.id,
                        negocio_id: c.negocio_id,
                        sucursal_id: sucursalId || null,
                        nombre: c.nombre,
                        telefono: c.telefono,
                        limite_credito: c.limite_credito,
                        fecha_actualizacion: c.fecha_actualizacion || Date.now()
                    }))
                );
                if (!cliError) await db.clientes.bulkPut(clientesPendientes.map(c => ({ ...c, estado_sincronizacion: 1 })));
            }

            // --- 2.E. TRANSACCIONES FIADO ---
            const transPendientes = await db.transacciones_fiado.where('estado_sincronizacion').equals(0).toArray();
            if (transPendientes.length > 0) {
                const { error: transError } = await supabase.from('transacciones_fiado').upsert(
                    transPendientes.map(t => ({
                        id: t.id,
                        negocio_id: t.negocio_id,
                        sucursal_id: t.sucursal_id || sucursalId,
                        cliente_id: t.cliente_id,
                        venta_id: t.venta_id,
                        tipo: t.tipo,
                        monto: t.monto,
                        concepto: t.concepto,
                        fecha_creacion: new Date(t.fecha_creacion).getTime(),
                        fecha_actualizacion: t.fecha_actualizacion || Date.now()
                    }))
                );
                if (!transError) await db.transacciones_fiado.bulkPut(transPendientes.map(t => ({ ...t, estado_sincronizacion: 1 })));
            }

        } catch (error) {
            console.error("🚨 Error crítico en el Worker de Sincronización:", error);
        } finally {
            isSyncing = false;
        }
    }, 15000); // 15 segundos

    return intervalId;
};