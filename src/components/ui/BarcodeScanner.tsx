'use client';

import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, NotFoundException } from '@zxing/browser';

interface BarcodeScannerProps {
    onScan: (code: string) => void;
    onClose: () => void;
}

export default function BarcodeScanner({ onScan, onClose }: BarcodeScannerProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [error, setError] = useState<string | null>(null);
    const [scanned, setScanned] = useState(false);
    const readerRef = useRef<BrowserMultiFormatReader | null>(null);

    useEffect(() => {
        let mounted = true;

        const iniciar = async () => {
            try {
                const reader = new BrowserMultiFormatReader();
                readerRef.current = reader;

                const devices = await BrowserMultiFormatReader.listVideoInputDevices();
                if (devices.length === 0) {
                    setError('No se encontró ninguna cámara en este dispositivo.');
                    return;
                }

                // Preferir cámara trasera en móvil
                const camaraTrasera = devices.find(d =>
                    /back|rear|environment/i.test(d.label)
                ) ?? devices[devices.length - 1];

                await reader.decodeFromVideoDevice(
                    camaraTrasera.deviceId,
                    videoRef.current!,
                    (result, err) => {
                        if (!mounted || scanned) return;
                        if (result) {
                            setScanned(true);
                            // Vibrar si el dispositivo lo soporta
                            if ('vibrate' in navigator) navigator.vibrate(80);
                            onScan(result.getText());
                        } else if (err && !(err instanceof NotFoundException)) {
                            console.warn('[scanner]', err);
                        }
                    }
                );
            } catch (e: any) {
                if (!mounted) return;
                if (e?.name === 'NotAllowedError') {
                    setError('Permiso de cámara denegado. Habilítalo en la configuración del navegador.');
                } else if (e?.name === 'NotFoundError') {
                    setError('No se encontró ninguna cámara disponible.');
                } else {
                    setError('No se pudo iniciar la cámara. Intenta recargar.');
                }
            }
        };

        iniciar();

        return () => {
            mounted = false;
            readerRef.current?.reset();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="fixed inset-0 z-[200] bg-black flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-black/80 backdrop-blur-sm z-10">
                <div>
                    <p className="text-white font-bold text-sm">Escanear código de barras</p>
                    <p className="text-vr-gray text-xs">Apunta la cámara al código del producto</p>
                </div>
                <button
                    onClick={onClose}
                    className="w-9 h-9 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
                >
                    ✕
                </button>
            </div>

            {/* Camera / Error area */}
            <div className="flex-1 relative flex items-center justify-center overflow-hidden">
                {error ? (
                    <div className="text-center px-8">
                        <p className="text-4xl mb-4">📷</p>
                        <p className="text-white font-bold mb-2">Sin acceso a la cámara</p>
                        <p className="text-vr-gray text-sm leading-relaxed mb-6">{error}</p>
                        <button
                            onClick={onClose}
                            className="px-6 py-2.5 bg-gold-gradient text-navy font-bold rounded-xl"
                        >
                            Volver
                        </button>
                    </div>
                ) : (
                    <>
                        <video
                            ref={videoRef}
                            className="absolute inset-0 w-full h-full object-cover"
                            playsInline
                            muted
                        />

                        {/* Scan zone overlay */}
                        <div className="relative z-10 flex flex-col items-center">
                            <div className="w-72 h-44 relative">
                                {/* Corner brackets */}
                                <span className="absolute top-0 left-0 w-8 h-8 border-t-3 border-l-3 border-gold rounded-tl-lg" style={{ borderWidth: '3px' }} />
                                <span className="absolute top-0 right-0 w-8 h-8 border-t-3 border-r-3 border-gold rounded-tr-lg" style={{ borderWidth: '3px' }} />
                                <span className="absolute bottom-0 left-0 w-8 h-8 border-b-3 border-l-3 border-gold rounded-bl-lg" style={{ borderWidth: '3px' }} />
                                <span className="absolute bottom-0 right-0 w-8 h-8 border-b-3 border-r-3 border-gold rounded-br-lg" style={{ borderWidth: '3px' }} />

                                {/* Scan line animation */}
                                {!scanned && (
                                    <div className="absolute left-2 right-2 h-0.5 bg-gold/80 shadow-[0_0_8px_2px_rgba(212,160,23,0.6)] animate-scan-line" />
                                )}

                                {/* Success state */}
                                {scanned && (
                                    <div className="absolute inset-0 flex items-center justify-center bg-vr-green/20 rounded-lg">
                                        <span className="text-4xl">✓</span>
                                    </div>
                                )}
                            </div>

                            <p className="mt-5 text-white/70 text-xs text-center">
                                {scanned ? 'Código capturado' : 'Centra el código dentro del recuadro'}
                            </p>
                        </div>

                        {/* Dark vignette outside scan zone */}
                        <div className="absolute inset-0 pointer-events-none"
                            style={{
                                background: 'radial-gradient(ellipse 320px 200px at 50% 50%, transparent 60%, rgba(0,0,0,0.75) 100%)',
                            }}
                        />
                    </>
                )}
            </div>
        </div>
    );
}
