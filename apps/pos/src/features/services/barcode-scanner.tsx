// Original VentaRD scanner, native presentation with no DB/network port.

import { useEffect, useRef, useState } from 'react';

interface BarcodeScannerProps {
    onScan: (code: string) => void;
    onClose: () => void;
}

// Formatos de barras más comunes en productos de colmado / retail
const BARCODE_FORMATS_NATIVE = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];

async function iniciarConBarcodeDetector(
    video: HTMLVideoElement,
    onResult: (code: string) => void,

): Promise<() => void> {
    const BarcodeDetectorAPI = (window as unknown as {BarcodeDetector:{new(options:{formats:string[]}):{detect(video:HTMLVideoElement):Promise<{rawValue:string}[]>};getSupportedFormats?:()=>Promise<string[]>}}).BarcodeDetector;
    const supported=await BarcodeDetectorAPI.getSupportedFormats?.();
    const formats=supported?BARCODE_FORMATS_NATIVE.filter(f=>supported.includes(f)):BARCODE_FORMATS_NATIVE;
    if(!formats.length)throw Error('BARCODE_FORMATS_UNAVAILABLE');
    const detector = new BarcodeDetectorAPI({ formats });

    let animId: number;
    let stopped = false;

    const tick = async () => {
        if(stopped)return;
        if (video.readyState < 2) {
            animId = requestAnimationFrame(tick);
            return;
        }
        try {
            const codes = await detector.detect(video);
            if(stopped)return;
            if (codes.length > 0) {
                onResult(codes[0].rawValue);
                return; // detener después del primer resultado
            }
        } catch {
            // ignorar errores de frame transitorio
        }
        if(!stopped)animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => { stopped = true; cancelAnimationFrame(animId); };
}

async function iniciarConZxing(
    video: HTMLVideoElement,
    onResult: (code: string) => void,

): Promise<() => void> {
    const { BrowserMultiFormatReader } = await import('@zxing/browser');
    const { DecodeHintType, BarcodeFormat } = await import('@zxing/library');

    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.ITF,
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);

    const reader = new BrowserMultiFormatReader(hints);
    const controls = await reader.decodeFromVideoElement(video, (result) => {
        if (result) {
            onResult(result.getText());
        }
    });

    return () => controls.stop();
}

export default function BarcodeScanner({ onScan, onClose }: BarcodeScannerProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const closeRef=useRef<HTMLButtonElement>(null);
    const callbacks=useRef({onScan,onClose});
    useEffect(()=>{callbacks.current={onScan,onClose}},[onScan,onClose]);
    const stopRef = useRef<(() => void) | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [scanned, setScanned] = useState(false);
    const [engine, setEngine] = useState<'native' | 'zxing' | null>(null);

    useEffect(() => {
        let mounted = true;
        let delivered=false;
        let stream: MediaStream | null = null;
        const previousFocus=document.activeElement;
        closeRef.current?.focus();
        const closeOnEscape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();callbacks.current.onClose()}};
        window.addEventListener('keydown',closeOnEscape,true);
        const release=()=>{stopRef.current?.();stopRef.current=null;stream?.getTracks().forEach(t=>t.stop());if(videoRef.current)videoRef.current.srcObject=null};

        const iniciar = async () => {
            try {
                // 1. Obtener stream de cámara con configuración óptima para barcodes
                stream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        facingMode: { ideal: 'environment' },
                        width:  { ideal: 1280 },
                        height: { ideal: 720 },
                    },
                    audio: false,
                });

                if (!mounted) { stream.getTracks().forEach(t => t.stop()); return; }

                const video = videoRef.current!;
                video.srcObject = stream;
                await video.play();
                if(!mounted){release();return}

                const handleResult = (code: string) => {
                    if (!mounted||delivered||!code) return;
                    delivered=true;
                    setScanned(true);
                    if ('vibrate' in navigator) navigator.vibrate(80);
                    release();
                    callbacks.current.onScan(code);
                };

                // 2. Elegir motor: API nativa (Chrome Android) > ZXing (fallback)
                let stop:(()=>void)|null=null;
                if ('BarcodeDetector' in window) {
                    try{stop=await iniciarConBarcodeDetector(video,handleResult);setEngine('native')}catch{/* Unsupported native formats use the bundled decoder. */}
                }
                if(!mounted||delivered){stop?.();release();return}
                if(!stop){
                    setEngine('zxing');
                    stop=await iniciarConZxing(video,handleResult);
                }
                if(!mounted||delivered)stop();else stopRef.current=stop;
            } catch (e: unknown) {
                release();
                if (!mounted) return;
                if (e instanceof Error && e.name === 'NotAllowedError') {
                    setError('Permiso de cámara denegado. Revisa los permisos de cámara de Windows.');
                } else if (e instanceof Error && e.name === 'NotFoundError') {
                    setError('No se encontró ninguna cámara disponible.');
                } else {
                    setError('No se pudo iniciar la cámara.');
                }
            }
        };

        iniciar();

        return () => {
            mounted = false;
            window.removeEventListener('keydown',closeOnEscape,true);
            release();
            if(previousFocus instanceof HTMLElement&&previousFocus.isConnected)previousFocus.focus();
        };
    }, []);

    return (
        <div role="dialog" aria-modal="true" aria-label="Escanear código de barras" onKeyDown={e=>{e.stopPropagation();if(e.key==='Tab'){const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));const first=buttons[0],last=buttons.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}}} className="fixed inset-0 z-[200] bg-black flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-black/80 backdrop-blur-sm">
                <div>
                    <p className="text-white font-bold text-sm">Escanear código de barras</p>
                    <p className="text-vr-gray text-xs">
                        {engine === 'native' ? 'Cámara nativa activa' : engine === 'zxing' ? 'Motor ZXing activo' : 'Iniciando cámara…'}
                    </p>
                </div>
                <button
                    ref={closeRef}
                    type="button"
                    aria-label="Cerrar cámara"
                    onClick={onClose}
                    className="w-9 h-9 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
                >
                    ✕
                </button>
            </div>

            {/* Camera / Error */}
            <div className="flex-1 relative flex items-center justify-center overflow-hidden">
                {error ? (
                    <div className="text-center px-8">
                        <p className="text-4xl mb-4">📷</p>
                        <p className="text-white font-bold mb-2">Sin acceso a la cámara</p>
                        <p className="text-vr-gray text-sm leading-relaxed mb-6">{error}</p>
                        <button onClick={onClose} className="px-6 py-2.5 bg-gold-gradient text-navy font-bold rounded-xl">
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

                        {/* Scan zone */}
                        <div className="relative z-10 flex flex-col items-center">
                            <div className="w-72 h-44 relative">
                                <span className="absolute top-0 left-0 w-8 h-8 border-gold rounded-tl-lg"
                                    style={{ borderWidth: '3px', borderTopStyle: 'solid', borderLeftStyle: 'solid' }} />
                                <span className="absolute top-0 right-0 w-8 h-8 border-gold rounded-tr-lg"
                                    style={{ borderWidth: '3px', borderTopStyle: 'solid', borderRightStyle: 'solid' }} />
                                <span className="absolute bottom-0 left-0 w-8 h-8 border-gold rounded-bl-lg"
                                    style={{ borderWidth: '3px', borderBottomStyle: 'solid', borderLeftStyle: 'solid' }} />
                                <span className="absolute bottom-0 right-0 w-8 h-8 border-gold rounded-br-lg"
                                    style={{ borderWidth: '3px', borderBottomStyle: 'solid', borderRightStyle: 'solid' }} />

                                {!scanned && (
                                    <div className="absolute left-2 right-2 h-0.5 bg-gold/80 shadow-[0_0_8px_2px_rgba(212,160,23,0.6)] animate-scan-line" />
                                )}
                                {scanned && (
                                    <div className="absolute inset-0 flex items-center justify-center bg-vr-green/20 rounded-lg border-2 border-vr-green">
                                        <span className="text-4xl">✓</span>
                                    </div>
                                )}
                            </div>
                            <p className="mt-4 text-white/70 text-xs text-center max-w-[240px]">
                                {scanned
                                    ? 'Código capturado'
                                    : 'Apunta la cámara al código. No hace falta encuadrarlo perfectamente.'}
                            </p>
                        </div>

                        {/* Vignette */}
                        <div className="absolute inset-0 pointer-events-none" style={{
                            background: 'radial-gradient(ellipse 320px 200px at 50% 50%, transparent 55%, rgba(0,0,0,0.8) 100%)',
                        }} />
                    </>
                )}
            </div>
        </div>
    );
}
