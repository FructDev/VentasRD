// src/app/admin/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useConfigStore } from '@/store/useConfigStore';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { v4 as uuidv4 } from 'uuid';
import PinGuard from '@/components/ui/PinGuard';
import ConfirmModal from '@/components/ui/ConfirmModal';
import { db } from '@/lib/db/dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatDOP, hashPin } from '@/lib/utils';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';

export default function AdminDashboard() {
    const { negocioId, negocioNombre, sucursalId, user, isOnline, planTier, setSucursal, setAuth, setPinAdmin, showToast, cerrarSesionUsuario, desconectarDispositivo } = useConfigStore();
    const router = useRouter();

    // Pro: métricas de reparaciones y apartados (lectura local)
    const esPro = planTier === 'pro';
    const reparacionesPro = useLiveQuery(
        () => (esPro && negocioId) ? db.reparaciones.where('negocio_id').equals(negocioId).toArray() : [],
        [esPro, negocioId]
    ) ?? [];
    const apartadosPro = useLiveQuery(
        () => (esPro && negocioId) ? db.apartados.where('negocio_id').equals(negocioId).toArray() : [],
        [esPro, negocioId]
    ) ?? [];

    const [sucursales, setSucursales] = useState<any[]>([]);
    const [ventas, setVentas] = useState<any[]>([]);
    const [rankingProductos, setRankingProductos] = useState<{nombre: string, cantidad: number, total: number}[]>([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [formData, setFormData] = useState({ nombre: '', direccion: '' });
    const [isLoading, setIsLoading] = useState(true);
    const [newPin, setNewPin] = useState('');
    const [isPinSaving, setIsPinSaving] = useState(false);

    useEffect(() => {
        if (!negocioId) return;

        const fetchData = async () => {
            // Fetch Sucursales
            const { data: dataSucursales } = await supabase
                .from('sucursales')
                .select('*')
                .eq('negocio_id', negocioId)
                .order('fecha_creacion', { ascending: false });
            
            // Fetch Ventas (Solo un resumen rápido)
            const { data: dataVentas } = await supabase
                .from('ventas')
                .select('id, sucursal_id, total, metodo_pago')
                .eq('negocio_id', negocioId);

            // Fetch Productos
            const { data: dataProductos } = await supabase
                .from('productos')
                .select('id, nombre')
                .eq('negocio_id', negocioId);

            // Fetch Detalles para Ranking
            const { data: dataDetalles } = await supabase
                .from('venta_detalles')
                .select('producto_id, cantidad, subtotal')
                .eq('negocio_id', negocioId);

            setSucursales(dataSucursales || []);
            setVentas(dataVentas || []);

            // Calcular Ranking
            const mapaRanking: Record<string, { cantidad: number, total: number, nombre: string }> = {};
            dataProductos?.forEach(p => {
                mapaRanking[p.id] = { cantidad: 0, total: 0, nombre: p.nombre };
            });

            dataDetalles?.forEach(d => {
                if (!mapaRanking[d.producto_id]) {
                    mapaRanking[d.producto_id] = { cantidad: 0, total: 0, nombre: 'Sincronizando producto...' };
                }
                mapaRanking[d.producto_id].cantidad += Number(d.cantidad);
                mapaRanking[d.producto_id].total += Number(d.subtotal);
            });

            const rankingOrdenado = Object.values(mapaRanking).sort((a, b) => b.cantidad - a.cantidad);
            setRankingProductos(rankingOrdenado);

            setIsLoading(false);
        };

        fetchData();
    }, [negocioId]);

    const crearSucursal = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId) return;

        const nuevaSucursal = {
            id: uuidv4(),
            negocio_id: negocioId,
            nombre: formData.nombre,
            direccion: formData.direccion,
            fecha_creacion: Date.now()
        };

        const { error } = await supabase.from('sucursales').insert(nuevaSucursal);
        
        if (!error) {
            setSucursales([nuevaSucursal, ...sucursales]);
            setIsModalOpen(false);
            setFormData({ nombre: '', direccion: '' });
            showToast("Sucursal creada exitosamente", "success");
        } else {
            showToast("Error creando sucursal", "error");
        }
    };

    const cambiarPin = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId || newPin.length !== 4) return;
        
        setIsPinSaving(true);
        // Guardar siempre hasheado (nunca texto plano en la BD)
        const pinHasheado = await hashPin(newPin);
        const { error } = await supabase
            .from('negocios')
            .update({ pin_admin: pinHasheado })
            .eq('id', negocioId);

        if (!error) {
            setPinAdmin(pinHasheado);
            showToast("PIN actualizado correctamente", "success");
            setNewPin('');
        } else {
            showToast("Error actualizando PIN", "error");
        }
        setIsPinSaving(false);
    };

    const repararBaseDatosLocal = async () => {
        if (!negocioId || !sucursalId) {
            showToast("Falta negocio o sucursal. Inicia sesión y ve al POS antes de usar esto.", "error");
            return;
        }

        try {
            let arreglados = 0;
            const modificar = async (tabla: any) => {
                await tabla.toCollection().modify((item: any) => {
                    let changed = false;
                    if (item.negocio_id && item.negocio_id !== negocioId) { item.negocio_id = negocioId; changed = true; }
                    if (item.sucursal_id && item.sucursal_id !== sucursalId) { item.sucursal_id = sucursalId; changed = true; }
                    if (item.estado_sincronizacion !== 0) { item.estado_sincronizacion = 0; changed = true; }
                    if (changed) arreglados++;
                });
            };
            await modificar(db.productos);
            await modificar(db.ventas);
            await modificar(db.venta_detalles);
            await modificar(db.clientes);
            await modificar(db.transacciones_fiado);
            showToast(`¡Rescate completo! Se corrigieron ${arreglados} registros. Sincronizando...`, "success");
        } catch (e) {
            showToast("Error reparando la base de datos.", "error");
            console.error(e);
        }
    };

    const cerrarSesion = async () => {
        try {
            cerrarSesionUsuario();
            await supabase.auth.signOut();
            router.push('/login');
        } catch (e) {
            console.error(e);
            router.push('/login');
        }
    };

    const [confirmDesvincular, setConfirmDesvincular] = useState(false);

    const desvincularDispositivo = async () => {
        try {
            await supabase.auth.signOut();
            // Borramos la base de datos local
            await db.delete();
            // Limpiamos el caché global
            desconectarDispositivo();
            showToast("Dispositivo desvinculado exitosamente", "success");
            router.push('/login');
        } catch (e) {
            console.error(e);
            showToast("Error al desvincular", "error");
        }
    };

    const totalIngresos = ventas.reduce((acc, v) => acc + v.total, 0);

    // Calcular desglose de pagos
    const pagosDesglose = ventas.reduce((acc, v) => {
        acc[v.metodo_pago] = (acc[v.metodo_pago] || 0) + v.total;
        return acc;
    }, {} as Record<string, number>);

    const top5 = rankingProductos.slice(0, 5);
    const productosMuertos = rankingProductos.filter(p => p.cantidad === 0);

    // Pro: cálculos de reparaciones y apartados (histórico)
    const repEntregadas = reparacionesPro.filter(r => r.estado === 'entregado');
    const repIngreso = repEntregadas.reduce((s, r) => s + r.total, 0);
    const repEnProceso = reparacionesPro.filter(r => r.estado !== 'entregado' && r.estado !== 'cancelado').length;
    const apActivosList = apartadosPro.filter(a => a.estado === 'activo');
    const apPorCobrar = apActivosList.reduce((s, a) => s + Math.max(0, a.total - a.abonado), 0);
    const apCompletados = apartadosPro.filter(a => a.estado === 'completado');
    const apIngreso = apCompletados.reduce((s, a) => s + a.total, 0);

    if (isLoading) {
        return <div className="min-h-screen flex items-center justify-center bg-navy"><div className="animate-pulse flex flex-col items-center"><div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin mb-4"></div><p className="text-vr-gray font-medium">Cargando Panel...</p></div></div>;
    }

    return (
        <PinGuard title="Panel Administrativo">
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <OfflineBanner />
                <div className="flex-1 p-4 sm:p-8">
                <div className="max-w-6xl mx-auto">
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6 sm:mb-8">
                    <div>
                        <h1 className="text-2xl sm:text-3xl font-display font-extrabold text-white">Panel Administrativo</h1>
                        <p className="text-vr-gray mt-1 text-sm truncate max-w-xs">{user?.email}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Link href="/select-branch" className="px-4 py-2.5 bg-navy-2 border border-navy-3 text-vr-gray font-bold rounded-xl hover:text-white hover:border-navy-4 transition-all text-sm">
                            Ir al POS
                        </Link>
                        <button onClick={cerrarSesion} className="px-4 py-2.5 bg-navy-3 border border-navy-4 text-white font-bold rounded-xl hover:bg-navy-4 transition-all text-sm">
                            Cerrar Sesión
                        </button>
                        <button onClick={() => setConfirmDesvincular(true)} className="px-4 py-2.5 bg-vr-red/10 border border-vr-red/20 text-vr-red font-bold rounded-xl hover:bg-vr-red/20 transition-all flex items-center gap-2 text-sm">
                            <span>⚠️</span> <span className="hidden sm:inline">Desvincular</span>
                        </button>
                    </div>
                </div>

                {/* Banner de Rescate Local */}
                <div className="mb-6 sm:mb-8 bg-gold/5 border border-gold/15 rounded-2xl p-4 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
                    <div>
                        <h3 className="text-gold font-bold text-sm sm:text-base">¿Faltan ventas de antes de limpiar la base de datos?</h3>
                        <p className="text-xs sm:text-sm text-vr-gray">Presiona aquí para enlazar tus ventas locales y resubirlas a la nube.</p>
                    </div>
                    <button onClick={repararBaseDatosLocal} className="px-4 py-2 bg-gold-gradient text-navy font-bold rounded-lg hover:brightness-110 transition-all text-sm shrink-0">
                        Forzar Resincronización
                    </button>
                </div>

                {/* Métricas Globales */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 mb-6 sm:mb-8">
                    <div className="bg-navy-2 border border-navy-3 p-4 sm:p-6 rounded-2xl glow-gold">
                        <p className="text-xs font-bold text-vr-gray uppercase tracking-wider">Ingresos Globales</p>
                        <h3 className="text-2xl sm:text-4xl font-black font-mono mt-2 text-gold truncate">{formatDOP(totalIngresos)}</h3>
                    </div>
                    <div className="bg-navy-2 border border-navy-3 p-4 sm:p-6 rounded-2xl">
                        <p className="text-xs font-bold text-vr-gray uppercase tracking-wider">Total Ventas</p>
                        <h3 className="text-2xl sm:text-4xl font-black font-mono mt-2 text-white">{ventas.length}</h3>
                    </div>
                    <div className="bg-navy-2 border border-navy-3 p-4 sm:p-6 rounded-2xl">
                        <p className="text-xs font-bold text-vr-gray uppercase tracking-wider">Sucursales Activas</p>
                        <h3 className="text-2xl sm:text-4xl font-black font-mono mt-2 text-white">{sucursales.length}</h3>
                    </div>
                </div>

                {/* Pro: Reparaciones y Apartados (histórico) */}
                {esPro && (
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 mb-6 sm:mb-8">
                        <div className="bg-navy-2 border border-navy-3 p-4 sm:p-6 rounded-2xl">
                            <p className="text-xs font-bold text-vr-gray uppercase tracking-wider flex items-center gap-1.5">🔧 Reparac. Ingreso</p>
                            <h3 className="text-xl sm:text-3xl font-black font-mono mt-2 text-vr-green truncate">{formatDOP(repIngreso)}</h3>
                            <p className="text-[11px] text-vr-gray mt-1">{repEntregadas.length} entregadas</p>
                        </div>
                        <div className="bg-navy-2 border border-navy-3 p-4 sm:p-6 rounded-2xl">
                            <p className="text-xs font-bold text-vr-gray uppercase tracking-wider">🔧 En proceso</p>
                            <h3 className="text-xl sm:text-3xl font-black font-mono mt-2 text-vr-orange">{repEnProceso}</h3>
                            <p className="text-[11px] text-vr-gray mt-1">reparaciones activas</p>
                        </div>
                        <div className="bg-navy-2 border border-navy-3 p-4 sm:p-6 rounded-2xl">
                            <p className="text-xs font-bold text-vr-gray uppercase tracking-wider">🔖 Apartados activos</p>
                            <h3 className="text-xl sm:text-3xl font-black font-mono mt-2 text-white">{apActivosList.length}</h3>
                            <p className="text-[11px] text-vr-orange mt-1">{formatDOP(apPorCobrar)} por cobrar</p>
                        </div>
                        <div className="bg-navy-2 border border-navy-3 p-4 sm:p-6 rounded-2xl">
                            <p className="text-xs font-bold text-vr-gray uppercase tracking-wider">🔖 Apartados Ingreso</p>
                            <h3 className="text-xl sm:text-3xl font-black font-mono mt-2 text-vr-green truncate">{formatDOP(apIngreso)}</h3>
                            <p className="text-[11px] text-vr-gray mt-1">{apCompletados.length} completados</p>
                        </div>
                    </div>
                )}

                {/* SÚPER DASHBOARD DE INTELIGENCIA */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6 mb-6 sm:mb-8">
                    {/* Top 5 Vendidos */}
                    <div className="bg-navy-2 rounded-2xl border border-navy-3 p-6">
                        <h2 className="text-lg font-display font-bold text-white mb-4 flex items-center gap-2">🔥 Top 5 Más Vendidos</h2>
                        {top5.length > 0 && top5[0].cantidad > 0 ? (
                            <div className="space-y-4">
                                {top5.map((prod, i) => prod.cantidad > 0 && (
                                    <div key={i} className="flex justify-between items-center">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 rounded-full bg-navy-3 flex items-center justify-center font-bold text-gold text-sm font-mono">{i + 1}</div>
                                            <span className="font-bold text-white text-sm">{prod.nombre}</span>
                                        </div>
                                        <div className="text-right">
                                            <p className="font-black text-gold font-mono text-sm">{prod.cantidad} uds</p>
                                            <p className="text-xs text-vr-gray font-mono">{formatDOP(prod.total)}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="text-vr-gray text-sm italic py-4">Aún no hay ventas registradas.</p>
                        )}
                    </div>

                    {/* Métodos de Pago & Productos Muertos */}
                    <div className="space-y-6">
                        <div className="bg-navy-2 rounded-2xl border border-navy-3 p-6">
                            <h2 className="text-lg font-display font-bold text-white mb-4 flex items-center gap-2">💳 Ingresos por Pago</h2>
                            {ventas.length > 0 ? (
                                <div className="space-y-3">
                                    {Object.entries(pagosDesglose).map(([metodo, monto]) => {
                                        const montoNum = monto as number;
                                        return (
                                        <div key={metodo}>
                                            <div className="flex justify-between text-sm font-bold mb-1">
                                                <span className="capitalize text-vr-gray">{metodo}</span>
                                                <span className="text-white font-mono">{formatDOP(montoNum)}</span>
                                            </div>
                                            <div className="w-full bg-navy-3 rounded-full h-1.5">
                                                <div className="bg-gold h-1.5 rounded-full transition-all" style={{ width: `${(montoNum / totalIngresos) * 100}%` }}></div>
                                            </div>
                                        </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <p className="text-vr-gray text-sm italic py-2">Sin ingresos registrados.</p>
                            )}
                        </div>

                        <div className="bg-vr-red/5 rounded-2xl border border-vr-red/15 p-6">
                            <h2 className="text-lg font-display font-bold text-vr-red mb-2 flex items-center gap-2">⚠️ Productos Muertos</h2>
                            <p className="text-sm text-vr-gray mb-3">Sin movimiento de ventas.</p>
                            <div className="flex flex-wrap gap-2">
                                {productosMuertos.length > 0 ? (
                                    productosMuertos.slice(0, 10).map((prod, i) => (
                                        <span key={i} className="px-3 py-1 bg-vr-red/10 text-vr-red text-xs font-bold rounded-full border border-vr-red/20">
                                            {prod.nombre}
                                        </span>
                                    ))
                                ) : (
                                    <span className="text-sm font-bold text-vr-green">¡Todo tu inventario tiene movimiento!</span>
                                )}
                                {productosMuertos.length > 10 && (
                                    <span className="px-3 py-1 bg-vr-red/10 text-vr-red text-xs font-bold rounded-full">
                                        + {productosMuertos.length - 10} más
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Gestión de Sucursales */}
                <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                    <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                        <h2 className="text-lg font-display font-bold text-white">Mis Sucursales</h2>
                        <button 
                            onClick={() => setIsModalOpen(true)} 
                            disabled={!isOnline}
                            className="px-4 py-2 bg-gold/10 text-gold font-bold rounded-lg hover:bg-gold/20 border border-gold/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                            title={!isOnline ? "Requiere conexión a internet" : ""}
                        >
                            + Nueva Sucursal
                        </button>
                    </div>
                    <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="border-b border-navy-3 text-vr-gray text-xs uppercase tracking-wider">
                                <th className="p-3 sm:p-4 font-semibold">Nombre</th>
                                <th className="p-3 sm:p-4 font-semibold hidden sm:table-cell">Dirección</th>
                                <th className="p-3 sm:p-4 font-semibold text-right">Ingresos</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sucursales.length === 0 ? (
                                <tr><td colSpan={3} className="p-8 text-center text-vr-gray">No tienes sucursales creadas.</td></tr>
                            ) : (
                                sucursales.map(suc => {
                                    const ventasSucursal = ventas.filter(v => v.sucursal_id === suc.id);
                                    const aportado = ventasSucursal.reduce((acc, v) => acc + v.total, 0);
                                    return (
                                        <tr key={suc.id} className="border-t border-navy-3/50 hover:bg-navy-3/30 transition-colors">
                                            <td className="p-3 sm:p-4">
                                                <span className="font-bold text-white block">{suc.nombre}</span>
                                                <span className="sm:hidden text-xs text-vr-gray">{suc.direccion || '-'}</span>
                                            </td>
                                            <td className="p-3 sm:p-4 text-vr-gray hidden sm:table-cell">{suc.direccion || '-'}</td>
                                            <td className="p-3 sm:p-4 text-right font-black font-mono text-vr-green">{formatDOP(aportado)}</td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                    </div>
                </div>

                {/* Cambio de PIN */}
                <div className="mt-6 sm:mt-8 bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                    <div className="p-4 sm:p-6 border-b border-navy-3">
                        <h2 className="text-lg font-display font-bold text-white">Seguridad</h2>
                        <p className="text-sm text-vr-gray">Cambia el PIN de acceso para proteger el POS.</p>
                    </div>
                    <form onSubmit={cambiarPin} className="p-4 sm:p-6 flex flex-col sm:flex-row sm:items-end gap-4">
                        <div>
                            <label className="block text-sm font-bold text-vr-gray mb-1">Nuevo PIN (4 dígitos)</label>
                            <input
                                type="password" maxLength={4} minLength={4} required
                                value={newPin} onChange={e => setNewPin(e.target.value.replace(/[^0-9]/g, ''))}
                                className="w-full sm:w-48 bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none tracking-widest text-center text-xl font-mono"
                                placeholder="****"
                            />
                        </div>
                        <button type="submit" disabled={isPinSaving || newPin.length !== 4 || !isOnline}
                            title={!isOnline ? "Requiere conexión a internet" : ""}
                            className="w-full sm:w-auto px-6 py-3 bg-gold-gradient text-navy font-bold rounded-xl hover:brightness-110 disabled:opacity-30 transition-all"
                        >
                            {isPinSaving ? 'Guardando...' : 'Cambiar PIN'}
                        </button>
                    </form>
                </div>

                {/* MODAL CREAR SUCURSAL */}
                {isModalOpen && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                        <div className="bg-navy-2 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                            <div className="p-6 border-b border-navy-3 flex justify-between items-center">
                                <h2 className="text-xl font-display font-bold text-white">Crear Sucursal</h2>
                                <button onClick={() => setIsModalOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                            </div>
                            <form onSubmit={crearSucursal} className="p-6 space-y-4">
                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">Nombre Comercial *</label>
                                    <input required type="text" placeholder="Ej: Piantini, Bella Vista" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" value={formData.nombre} onChange={e => setFormData({ ...formData, nombre: e.target.value })} />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">Dirección (Opcional)</label>
                                    <input type="text" className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" value={formData.direccion} onChange={e => setFormData({ ...formData, direccion: e.target.value })} />
                                </div>
                                <div className="pt-4">
                                    <button type="submit" className="w-full py-4 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 text-lg transition-all">Guardar Sucursal</button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}
            </div>
            </div>

            {/* Confirmación de desvinculación (acción destructiva) */}
            <ConfirmModal
                isOpen={confirmDesvincular}
                title="⚠️ Desvincular dispositivo"
                mensaje={<>Todas las <span className="font-bold text-white">ventas no sincronizadas</span> y configuraciones locales de este dispositivo se perderán <span className="font-bold text-vr-red">irreversiblemente</span>. ¿Estás absolutamente seguro?</>}
                confirmLabel="Sí, desvincular"
                onConfirm={() => { setConfirmDesvincular(false); desvincularDispositivo(); }}
                onClose={() => setConfirmDesvincular(false)}
            />
        </div>
        </PinGuard>
    );
}
