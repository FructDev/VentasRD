// src/components/shared/ClientePicker.tsx
// Selector de cliente reutilizable: busca entre los clientes ya registrados del
// negocio y, si es nuevo, ofrece guardarlo (opcional). Usado en Reparaciones y Apartados.
'use client';

import { useMemo, useState } from 'react';
import { useClientesTenant } from '@/lib/db/tenantQuery';

const norm = (s: string | null | undefined): string =>
    (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export interface ClienteSeleccion {
    clienteId?: string;     // definido si se eligió uno existente
    nombre: string;
    telefono: string;
    guardarNuevo: boolean;  // si true y no hay clienteId, el padre lo crea al guardar
}

export default function ClientePicker({ value, onChange }: {
    value: ClienteSeleccion;
    onChange: (v: ClienteSeleccion) => void;
}) {
    const clientes = useClientesTenant();
    const [abierto, setAbierto] = useState(false);

    const sugerencias = useMemo(() => {
        const q = norm(value.nombre).trim();
        if (!q) return [];
        return clientes
            .filter(c => norm(c.nombre).includes(q) || norm(c.telefono).includes(q))
            .slice(0, 6);
    }, [clientes, value.nombre]);

    const esExistente = !!value.clienteId;

    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="relative">
                <label className="block text-sm font-bold text-vr-gray mb-1.5">Cliente *</label>
                <input
                    type="text"
                    required
                    autoComplete="off"
                    placeholder="Buscar o escribir nombre…"
                    className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all"
                    value={value.nombre}
                    onChange={e => { onChange({ ...value, nombre: e.target.value, clienteId: undefined }); setAbierto(true); }}
                    onFocus={() => setAbierto(true)}
                    onBlur={() => setTimeout(() => setAbierto(false), 150)}
                />
                {abierto && sugerencias.length > 0 && (
                    <div className="absolute z-[60] w-full bg-navy shadow-xl rounded-lg mt-1 border border-navy-3 max-h-52 overflow-y-auto">
                        {sugerencias.map(c => (
                            <button
                                key={c.id}
                                type="button"
                                onMouseDown={() => { onChange({ clienteId: c.id, nombre: c.nombre, telefono: c.telefono || '', guardarNuevo: false }); setAbierto(false); }}
                                className="w-full text-left p-2.5 hover:bg-navy-3 text-sm border-b border-navy-3 last:border-0 text-white flex justify-between gap-2"
                            >
                                <span className="truncate font-medium">{c.nombre}</span>
                                {c.telefono && <span className="text-vr-gray font-mono text-xs shrink-0">{c.telefono}</span>}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div>
                <label className="block text-sm font-bold text-vr-gray mb-1.5">Teléfono</label>
                <input
                    type="tel"
                    inputMode="tel"
                    placeholder="809-000-0000"
                    className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono focus:border-gold outline-none transition-all"
                    value={value.telefono}
                    onChange={e => onChange({ ...value, telefono: e.target.value })}
                />
            </div>

            {esExistente ? (
                <p className="sm:col-span-2 text-xs text-vr-green font-bold flex items-center gap-1">✓ Cliente registrado</p>
            ) : value.nombre.trim() ? (
                <button
                    type="button"
                    onClick={() => onChange({ ...value, guardarNuevo: !value.guardarNuevo })}
                    className={`sm:col-span-2 flex items-center justify-between px-3 py-2 rounded-lg border text-left transition-all ${value.guardarNuevo ? 'border-gold/40 bg-gold/10 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}
                >
                    <span className="text-xs font-bold">💾 Guardar como cliente nuevo (opcional)</span>
                    <div className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ml-2 ${value.guardarNuevo ? 'bg-gold' : 'bg-navy-3'}`}>
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${value.guardarNuevo ? 'translate-x-4' : ''}`} />
                    </div>
                </button>
            ) : null}
        </div>
    );
}
