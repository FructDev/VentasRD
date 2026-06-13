// src/components/ui/PinGuard.tsx
'use client';

import { useState } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { useRouter, usePathname } from 'next/navigation';
import { puedeAcceder } from '@/lib/acceso';
import { verificarPin } from '@/lib/utils';

export default function PinGuard({ children, title = "Zona Restringida" }: { children: React.ReactNode, title?: string }) {
    const { isAdminMode, setAdminMode, pinAdmin, nombreUsuario, rolUsuario } = useConfigStore();
    const router = useRouter();
    const pathname = usePathname();
    const [pinEntry, setPinEntry] = useState('');
    const [error, setError] = useState(false);

    // Empleados autenticados con su propia cuenta: el acceso lo decide su rol
    // (AuthProvider redirige las rutas no permitidas). El PIN existe para
    // proteger las zonas admin en el dispositivo del dueño, no para empleados
    // que ya iniciaron sesión con credenciales propias.
    if (nombreUsuario) {
        // Mientras AuthProvider redirige, no mostrar contenido no permitido
        return puedeAcceder(rolUsuario, pathname) ? <>{children}</> : null;
    }

    if (isAdminMode) {
        return <>{children}</>;
    }

    const handleKeypad = async (num: string) => {
        setError(false);
        if (pinEntry.length < 4) {
            const newPin = pinEntry + num;
            setPinEntry(newPin);

            if (newPin.length === 4) {
                // verificarPin soporta tanto texto plano (legado) como hash SHA-256
                const correcto = await verificarPin(newPin, pinAdmin || '1234');
                if (correcto) {
                    setAdminMode(true);
                } else {
                    setError(true);
                    setPinEntry('');
                }
            }
        }
    };

    const handleDelete = () => {
        setPinEntry(pinEntry.slice(0, -1));
        setError(false);
    };

    const handleVolver = () => {
        router.push('/');
    };

    return (
        <div className="min-h-screen bg-navy flex flex-col items-center justify-center p-4">
            <div className="bg-navy-2 p-8 rounded-3xl border border-navy-3 shadow-2xl w-full max-w-sm text-center">
                <div className="text-4xl mb-4">🔒</div>
                <h2 className="text-2xl font-display font-black text-white mb-1">{title}</h2>
                <p className="text-vr-gray mb-6 text-sm">Ingresa el PIN de administrador para continuar.</p>

                {/* Display de Puntos */}
                <div className={`flex justify-center gap-4 mb-8 ${error ? 'animate-bounce' : ''}`}>
                    {[0, 1, 2, 3].map((index) => (
                        <div
                            key={index}
                            className={`w-4 h-4 rounded-full transition-all duration-200 ${
                                pinEntry.length > index ? 'bg-gold scale-110' : 'bg-navy-3'
                            } ${error ? 'bg-vr-red' : ''}`}
                        />
                    ))}
                </div>

                {/* Keypad Numérico */}
                <div className="grid grid-cols-3 gap-3 mb-8">
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(num => (
                        <button
                            key={num}
                            onClick={() => handleKeypad(num)}
                            className="bg-navy-3 hover:bg-navy-4 text-white font-bold font-mono text-2xl py-4 rounded-2xl transition-all active:scale-95 border border-navy-4"
                        >
                            {num}
                        </button>
                    ))}
                    <div className="col-span-1"></div>
                    <button
                        onClick={() => handleKeypad('0')}
                        className="bg-navy-3 hover:bg-navy-4 text-white font-bold font-mono text-2xl py-4 rounded-2xl transition-all active:scale-95 border border-navy-4"
                    >
                        0
                    </button>
                    <button
                        onClick={handleDelete}
                        className="bg-navy-3 hover:bg-vr-red/20 text-vr-red font-bold text-xl py-4 rounded-2xl transition-all active:scale-95 border border-navy-4 flex items-center justify-center"
                    >
                        ⌫
                    </button>
                </div>

                <button onClick={handleVolver} className="text-vr-gray font-bold text-sm hover:text-gold transition-colors underline">
                    Volver al POS
                </button>
            </div>
        </div>
    );
}
