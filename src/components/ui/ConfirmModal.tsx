// src/components/ui/ConfirmModal.tsx
// Modal de confirmación propio (reemplaza los confirm() nativos del navegador).
// Soporta "autorización de supervisor": pedir el PIN del administrador antes
// de confirmar — patrón estándar de POS para acciones sensibles del cajero.
'use client';

import { useState, useEffect, ReactNode } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { verificarPin } from '@/lib/utils';

interface ConfirmModalProps {
    isOpen: boolean;
    title: string;
    mensaje: string | ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    tono?: 'peligro' | 'normal';
    /** Pide el PIN del administrador para autorizar (void con supervisor) */
    requierePinAdmin?: boolean;
    procesando?: boolean;
    onConfirm: () => void;
    onClose: () => void;
}

export default function ConfirmModal({
    isOpen, title, mensaje, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar',
    tono = 'peligro', requierePinAdmin = false, procesando = false, onConfirm, onClose,
}: ConfirmModalProps) {
    const { pinAdmin } = useConfigStore();
    const [pin, setPin] = useState('');
    const [pinError, setPinError] = useState(false);

    useEffect(() => {
        if (isOpen) { setPin(''); setPinError(false); }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleConfirm = async () => {
        if (requierePinAdmin) {
            const ok = await verificarPin(pin, pinAdmin || '1234');
            if (!ok) {
                setPinError(true);
                setPin('');
                return;
            }
        }
        onConfirm();
    };

    const colorConfirm = tono === 'peligro'
        ? 'bg-vr-red/80 hover:bg-vr-red text-white'
        : 'bg-gold-gradient text-navy hover:brightness-110';

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[60] flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
            <div className="bg-navy-2 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                <div className="p-5 sm:p-6">
                    <h2 className={`text-lg font-display font-bold mb-2 ${tono === 'peligro' ? 'text-vr-red' : 'text-white'}`}>{title}</h2>
                    <div className="text-sm text-vr-gray leading-relaxed">{mensaje}</div>

                    {requierePinAdmin && (
                        <div className="mt-4">
                            <label className="block text-xs font-bold text-vr-gray uppercase tracking-wider mb-1.5">
                                🔒 PIN del administrador requerido
                            </label>
                            <input
                                type="password"
                                inputMode="numeric"
                                maxLength={4}
                                autoFocus
                                placeholder="• • • •"
                                className={`w-full bg-navy-3 border rounded-xl p-3 text-white font-mono font-black text-xl text-center tracking-[0.5em] outline-none transition-all ${pinError ? 'border-vr-red animate-bounce' : 'border-navy-3 focus:border-gold'}`}
                                value={pin}
                                onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setPinError(false); }}
                                onKeyDown={e => { if (e.key === 'Enter' && pin.length === 4) { e.preventDefault(); handleConfirm(); } }}
                            />
                            {pinError && <p className="text-vr-red text-xs font-bold mt-1.5 text-center">PIN incorrecto</p>}
                            <p className="text-[11px] text-vr-gray mt-1.5 text-center">Pide al administrador que autorice esta acción.</p>
                        </div>
                    )}
                </div>

                <div className="p-4 sm:px-6 sm:pb-6 sm:pt-0 flex gap-3">
                    <button
                        onClick={onClose}
                        disabled={procesando}
                        className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors disabled:opacity-50"
                    >
                        {cancelLabel}
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={procesando || (requierePinAdmin && pin.length !== 4)}
                        className={`flex-1 py-3 font-extrabold rounded-xl transition-all disabled:opacity-40 ${colorConfirm}`}
                    >
                        {procesando ? 'Procesando…' : confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
