// src/components/shared/VentaLibreModal.tsx
'use client';

import { useState, useRef, useEffect } from 'react';
import { useCartStore } from '@/store/useCartStore';
import { ProductoLocal } from '@/types/database';
import { v4 as uuidv4 } from 'uuid';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

export default function VentaLibreModal({ isOpen, onClose }: Props) {
    const { addItem } = useCartStore();
    const [nombre, setNombre] = useState('');
    const [precio, setPrecio] = useState('');
    const [cantidad, setCantidad] = useState('1');
    const [tasaItbis, setTasaItbis] = useState('0.18'); // '0' = exento, '0.18' = 18%
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setNombre('');
            setPrecio('');
            setCantidad('1');
            setTasaItbis('0.18');
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [isOpen]);

    const agregarVentaLibre = (e: React.FormEvent) => {
        e.preventDefault();
        const precioNum = parseFloat(precio);
        const cantidadNum = parseInt(cantidad) || 1;
        if (!nombre.trim() || precioNum <= 0) return;

        // Crear un producto virtual temporal
        const productoVirtual: ProductoLocal = {
            id: uuidv4(),
            negocio_id: '',
            nombre: nombre.trim(),
            codigo_barras: '',
            precio_venta: precioNum,
            costo: 0,
            stock_actual: 9999,
            stock_minimo: 0,
            tasa_itbis: parseFloat(tasaItbis) || 0,
            tipo: 'simple',
        };

        // Agregar la cantidad especificada
        for (let i = 0; i < cantidadNum; i++) {
            addItem(productoVirtual);
        }

        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fade-in">
            <div className="bg-navy-2 w-full max-w-sm rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                <div className="p-6 border-b border-navy-3 flex justify-between items-center">
                    <h2 className="text-lg font-display font-bold text-white">⚡ Venta Rápida</h2>
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-mono bg-navy-3 text-vr-gray px-2 py-0.5 rounded">F4</span>
                        <button onClick={onClose} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                    </div>
                </div>

                <form onSubmit={agregarVentaLibre} className="p-6 space-y-4">
                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Descripción *</label>
                        <input
                            ref={inputRef}
                            required type="text"
                            placeholder="Ej: Servicio de reparación, Producto especial..."
                            className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white placeholder-vr-gray-2 focus:border-gold outline-none transition-all"
                            value={nombre} onChange={e => setNombre(e.target.value)}
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Precio (RD$) *</label>
                            <input
                                required type="number" step="0.01" min="0.01"
                                className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono text-lg focus:border-gold outline-none transition-all"
                                placeholder="0.00" value={precio} onChange={e => setPrecio(e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Cantidad</label>
                            <input
                                type="number" min="1"
                                className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono text-lg focus:border-gold outline-none transition-all"
                                value={cantidad} onChange={e => setCantidad(e.target.value)}
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">ITBIS</label>
                        <div className="grid grid-cols-2 gap-2">
                            {([
                                { val: '0.18', label: '18%' },
                                { val: '0', label: 'Exento (0%)' },
                            ] as const).map(o => (
                                <button
                                    key={o.val}
                                    type="button"
                                    onClick={() => setTasaItbis(o.val)}
                                    className={`py-2.5 rounded-xl border font-bold text-sm transition-all ${tasaItbis === o.val ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}
                                >
                                    {o.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="pt-2 flex flex-col gap-2">
                        <button type="submit" className="w-full py-4 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all text-lg">
                            Agregar al Ticket
                        </button>
                        <button type="button" onClick={onClose} className="w-full py-3 font-bold text-vr-gray hover:text-white transition-colors">
                            Cancelar
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
