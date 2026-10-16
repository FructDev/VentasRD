// src/components/shared/VentaLibreModal.tsx
'use client';

import { useState } from 'react';
import { useCartStore, mismoScope, type CartScope, type CartItem } from '@/store/useCartStore';
import { useConfigStore } from '@/store/useConfigStore';
import { localCommandError } from '@/lib/domain/local/errors';
import { v4 as uuidv4 } from 'uuid';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    scope: CartScope | null;
}

export default function VentaLibreModal({ isOpen, onClose, scope }: Props) {
    if (!isOpen) return null;
    // Cada apertura/ámbito monta un formulario nuevo; ningún reset por effect.
    return <VentaLibreForm key={JSON.stringify(scope)} onClose={onClose} scope={scope} />;
}

function VentaLibreForm({ onClose, scope }: Omit<Props, 'isOpen'>) {
    const { addItem } = useCartStore();
    const [nombre, setNombre] = useState('');
    const [precio, setPrecio] = useState('');
    const [cantidad, setCantidad] = useState('1');
    const [tasaItbis, setTasaItbis] = useState('0.18'); // '0' = exento, '0.18' = 18%

    const agregarVentaLibre = (e: React.FormEvent) => {
        e.preventDefault();
        const config = useConfigStore.getState();
        if (!scope || !mismoScope(scope, useCartStore.getState().scope) || !mismoScope(scope,
            { negocioId: config.negocioId ?? '', sucursalId: config.sucursalId || null }) || useCartStore.getState().bloqueado) {
            config.showToast(localCommandError(new Error('cart_scope_incompatible')), 'error'); return;
        }
        const precioNum = Number(precio);
        const cantidadNum = Number(cantidad);
        if (!nombre.trim() || !Number.isFinite(precioNum) || precioNum <= 0 || !Number.isSafeInteger(cantidadNum) || cantidadNum <= 0) {
            config.showToast('Revisa precio y cantidad. La cantidad debe ser un entero positivo.', 'error'); return;
        }

        // Crear un producto virtual temporal
        const productoVirtual: CartItem = {
            id: uuidv4(),
            negocio_id: scope.negocioId,
            venta_libre: true,
            cantidad: 1,
            nombre: nombre.trim(),
            codigo_barras: '',
            precio_venta: precioNum,
            costo: 0,
            stock_actual: 0,
            stock_minimo: 0,
            tasa_itbis: parseFloat(tasaItbis) || 0,
            tipo: 'simple',
        };

        // Sin un bucle por unidad que pueda congelar la interfaz.
        addItem(productoVirtual);
        if (cantidadNum !== 1) useCartStore.getState().updateQuantity(productoVirtual.id, cantidadNum);

        onClose();
    };

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
                            autoFocus
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
