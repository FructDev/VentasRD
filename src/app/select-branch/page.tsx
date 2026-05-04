// src/app/select-branch/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useConfigStore } from '@/store/useConfigStore';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db/dexie';
import { SucursalLocal } from '@/types/database';

export default function SelectBranchPage() {
    const { negocioId, negocioNombre, setSucursal, isOnline } = useConfigStore();
    const router = useRouter();
    const [sucursales, setSucursales] = useState<SucursalLocal[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const fetchSucursales = async () => {
            if (!negocioId) return;

            // Si hay conexión, intentar Supabase primero y actualizar cache local
            if (isOnline) {
                try {
                    const { data } = await supabase
                        .from('sucursales')
                        .select('id, negocio_id, nombre, direccion')
                        .eq('negocio_id', negocioId);

                    if (data && data.length > 0) {
                        // Guardar en Dexie como cache offline
                        await db.sucursales.bulkPut(data);
                        setSucursales(data);
                        setIsLoading(false);
                        return;
                    }
                } catch {
                    // Sin conexión real o error — caer al cache local
                }
            }

            // Fallback: leer desde Dexie (cache offline)
            const cached = await db.sucursales
                .where('negocio_id').equals(negocioId)
                .toArray();
            setSucursales(cached);
            setIsLoading(false);
        };

        fetchSucursales();
    }, [negocioId, isOnline]);

    const handleSelect = (sucursalId: string) => {
        setSucursal(sucursalId);
        router.push('/');
    };

    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-navy">
                <div className="animate-pulse flex flex-col items-center">
                    <div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin mb-4"></div>
                    <p className="text-vr-gray font-medium">Cargando sucursales...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-navy flex items-center justify-center p-4">
            <div className="max-w-2xl w-full bg-navy-2 rounded-2xl shadow-2xl overflow-hidden border border-navy-3">
                <div className="p-8 text-center border-b border-navy-3">
                    <h1 className="text-3xl font-display font-extrabold text-gold mb-1">
                        {negocioNombre || 'VentaRD'}
                    </h1>
                    <p className="text-vr-gray">¿En qué sucursal se encuentra esta caja?</p>
                    {!isOnline && (
                        <p className="text-xs text-yellow-400/70 mt-1">
                            📴 Sin conexión — mostrando sucursales guardadas localmente
                        </p>
                    )}
                </div>

                <div className="p-8">
                    {sucursales.length === 0 ? (
                        <div className="text-center py-12">
                            <div className="text-6xl mb-4">🏪</div>
                            <h2 className="text-2xl font-bold text-white mb-2">Aún no tienes sucursales</h2>
                            <p className="text-vr-gray mb-8">
                                {isOnline
                                    ? 'Para empezar a vender, crea al menos un local comercial en tu panel administrativo.'
                                    : 'Sin conexión y sin sucursales en cache. Conéctate a internet para continuar.'}
                            </p>
                            {isOnline && (
                                <Link href="/admin" className="px-8 py-4 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all inline-block">
                                    Ir al Panel Administrativo
                                </Link>
                            )}
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {sucursales.map(sucursal => (
                                <button
                                    key={sucursal.id}
                                    onClick={() => handleSelect(sucursal.id)}
                                    className="p-6 border border-navy-3 bg-navy rounded-2xl hover:border-gold/40 hover:bg-navy-3 transition-all text-left group"
                                >
                                    <h3 className="text-xl font-bold text-white group-hover:text-gold transition-colors mb-1">{sucursal.nombre}</h3>
                                    <p className="text-sm text-vr-gray">{sucursal.direccion || 'Sin dirección registrada'}</p>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {sucursales.length > 0 && isOnline && (
                    <div className="p-6 bg-navy border-t border-navy-3 text-center">
                        <Link href="/admin" className="text-sm font-bold text-vr-gray hover:text-gold transition-colors underline">
                            Administrar mis Sucursales
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}
