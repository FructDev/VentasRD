'use client';

import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db/dexie';
import { useConfigStore } from '@/store/useConfigStore';
import Link from 'next/link';

const STORAGE_KEY = 'vrd_tutorial_dismissed';

interface Paso {
    id: string;
    label: string;
    href: string;
    done: boolean;
}

export default function TutorialChecklist() {
    const [open, setOpen] = useState(false);
    const [dismissed, setDismissed] = useState(true); // true inicial evita flash

    const { sucursalId, ncf, negocioId } = useConfigStore();

    const productCount  = useLiveQuery(() => db.productos.count(),  []) ?? 0;
    const ventaCount    = useLiveQuery(() => db.ventas.count(),     []) ?? 0;
    const clienteCount  = useLiveQuery(() => db.clientes.count(),   []) ?? 0;

    useEffect(() => {
        setDismissed(localStorage.getItem(STORAGE_KEY) === 'true');
    }, []);

    const pasos: Paso[] = [
        { id: 'sucursal', label: 'Crear tu primer local',       href: '/admin',         done: !!sucursalId },
        { id: 'producto', label: 'Agregar tu primer producto',   href: '/inventario',    done: productCount > 0 },
        { id: 'venta',    label: 'Realizar tu primera venta',    href: '/',              done: ventaCount > 0 },
        { id: 'cliente',  label: 'Agregar un cliente',           href: '/clientes',      done: clienteCount > 0 },
        { id: 'ncf',      label: 'Configurar NCF (opcional)',    href: '/configuracion', done: ncf.habilitado },
    ];

    const completados = pasos.filter(p => p.done).length;
    const todosLisots = completados === pasos.length;

    // Auto-dismiss cuando todos están completos
    useEffect(() => {
        if (todosLisots && !dismissed) {
            const t = setTimeout(() => {
                localStorage.setItem(STORAGE_KEY, 'true');
                setDismissed(true);
            }, 2500);
            return () => clearTimeout(t);
        }
    }, [todosLisots, dismissed]);

    const descartar = () => {
        localStorage.setItem(STORAGE_KEY, 'true');
        setDismissed(true);
        setOpen(false);
    };

    // No mostrar en páginas públicas ni si ya fue descartado
    if (dismissed || !negocioId) return null;

    const progreso = (completados / pasos.length) * 100;
    // Circunferencia de r=9: 2π·9 ≈ 56.55
    const CIRC = 56.55;

    return (
        <div className="fixed bottom-6 left-4 z-50 flex flex-col items-start gap-2">
            {open && (
                <div className="w-72 bg-navy-2 border border-navy-3 rounded-2xl shadow-2xl overflow-hidden animate-fade-in">
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-navy-3">
                        <div>
                            <p className="font-bold text-white text-sm">Primeros pasos</p>
                            <p className="text-xs text-vr-gray">{completados} de {pasos.length} completados</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setOpen(false)}
                                aria-label="Minimizar"
                                className="w-6 h-6 flex items-center justify-center text-vr-gray hover:text-white text-lg leading-none transition-colors"
                            >
                                −
                            </button>
                            <button
                                onClick={descartar}
                                aria-label="Descartar tutorial"
                                className="w-6 h-6 flex items-center justify-center text-vr-gray hover:text-white text-sm leading-none transition-colors"
                            >
                                ✕
                            </button>
                        </div>
                    </div>

                    {/* Barra de progreso */}
                    <div className="h-1 bg-navy-3">
                        <div
                            className="h-1 bg-gold transition-all duration-500"
                            style={{ width: `${progreso}%` }}
                        />
                    </div>

                    {/* Pasos */}
                    <ul className="p-2 space-y-0.5">
                        {pasos.map(paso => (
                            <li key={paso.id}>
                                {paso.done ? (
                                    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl opacity-40 cursor-default">
                                        <CheckCircle />
                                        <span className="text-sm text-vr-gray line-through">{paso.label}</span>
                                    </div>
                                ) : (
                                    <Link
                                        href={paso.href}
                                        onClick={() => setOpen(false)}
                                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-navy-3 transition-colors group"
                                    >
                                        <EmptyCircle />
                                        <span className="text-sm text-white group-hover:text-gold transition-colors">{paso.label}</span>
                                        <span className="ml-auto text-vr-gray text-xs group-hover:text-gold transition-colors">→</span>
                                    </Link>
                                )}
                            </li>
                        ))}
                    </ul>

                    {todosLisots && (
                        <div className="px-4 pb-4 pt-1 text-center">
                            <p className="text-xs text-vr-green font-bold">¡Todo listo! Cerrando en un momento...</p>
                        </div>
                    )}
                </div>
            )}

            {/* Botón flotante */}
            <button
                onClick={() => setOpen(v => !v)}
                className="flex items-center gap-2.5 pl-2.5 pr-4 py-2 bg-navy-2 border border-navy-3 rounded-full shadow-lg hover:border-gold/40 hover:bg-navy-3 transition-all group"
            >
                {/* Anillo de progreso SVG */}
                <div className="relative w-7 h-7 flex-shrink-0">
                    <svg viewBox="0 0 24 24" className="w-7 h-7 -rotate-90" aria-hidden>
                        <circle cx="12" cy="12" r="9" fill="none" stroke="#1e3a5f" strokeWidth="3" />
                        <circle
                            cx="12" cy="12" r="9" fill="none"
                            stroke="#D4A017" strokeWidth="3"
                            strokeLinecap="round"
                            strokeDasharray={`${(completados / pasos.length) * CIRC} ${CIRC}`}
                            className="transition-all duration-500"
                        />
                    </svg>
                    <span className="absolute inset-0 flex items-center justify-center text-[9px] font-black text-gold">
                        {completados}
                    </span>
                </div>
                <span className="text-xs font-bold text-vr-gray group-hover:text-white transition-colors whitespace-nowrap">
                    Primeros pasos
                </span>
            </button>
        </div>
    );
}

function CheckCircle() {
    return (
        <div className="w-5 h-5 rounded-full bg-vr-green flex items-center justify-center flex-shrink-0">
            <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none">
                <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        </div>
    );
}

function EmptyCircle() {
    return (
        <div className="w-5 h-5 rounded-full border-2 border-navy-4 flex-shrink-0" />
    );
}
