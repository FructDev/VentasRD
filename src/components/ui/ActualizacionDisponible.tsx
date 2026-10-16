'use client';

import { useCallback, useEffect, useState } from 'react';
import { APP_BUILD_ID, hasDeployUpdate } from '@/lib/app-version';
import { CLAVE_PRECARGA_TS } from '@/lib/precarga';
import { useCartStore } from '@/store/useCartStore';
import { prepareAppUpdate } from '@/lib/app-update';
import { syncQuiescence } from '@/lib/sync/quiescence';
import ConfirmModal from './ConfirmModal';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const INITIAL_CHECK_MS = 8_000;

interface VersionResponse {
    version?: unknown;
}

export default function ActualizacionDisponible() {
    const activeItems = useCartStore(state => state.items.length);
    const [availableVersion, setAvailableVersion] = useState<string | null>(null);
    const [updating, setUpdating] = useState(false);
    const [confirmUpdate, setConfirmUpdate] = useState(false);
    const [updateError, setUpdateError] = useState<string | null>(null);
    const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);

    const checkVersion = useCallback(async () => {
        if (!navigator.onLine) return;
        try {
            const response = await fetch('/api/version', { cache: 'no-store' });
            if (!response.ok) return;
            const body = await response.json() as VersionResponse;
            if (typeof body.version === 'string' && hasDeployUpdate(APP_BUILD_ID, body.version)) {
                setAvailableVersion(body.version);
            }
        } catch {
            // Una comprobacion oportunista nunca debe interrumpir el POS.
        }
    }, []);

    useEffect(() => {
        const initial = window.setTimeout(() => { void checkVersion(); }, INITIAL_CHECK_MS);
        const interval = window.setInterval(() => { void checkVersion(); }, CHECK_INTERVAL_MS);
        const onOnline = () => {
            setOnline(true);
            void checkVersion();
        };
        const onOffline = () => setOnline(false);
        const onVisibility = () => {
            if (document.visibilityState === 'visible') void checkVersion();
        };
        const onControllerChange = () => { void checkVersion(); };

        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        document.addEventListener('visibilitychange', onVisibility);
        navigator.serviceWorker?.addEventListener('controllerchange', onControllerChange);
        return () => {
            clearTimeout(initial);
            clearInterval(interval);
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
            document.removeEventListener('visibilitychange', onVisibility);
            navigator.serviceWorker?.removeEventListener('controllerchange', onControllerChange);
        };
    }, [checkVersion]);

    const updateNow = async () => {
        if (useCartStore.getState().items.length > 0 || !navigator.onLine || updating) return;
        setUpdating(true);
        setUpdateError(null);
        try {
            await prepareAppUpdate({
                installedVersion: APP_BUILD_ID,
                canReload: () => navigator.onLine && useCartStore.getState().items.length === 0,
                acquireSync: () => syncQuiescence.acquire(),
                readAvailableVersion: async () => {
                    const response = await fetch('/api/version', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
                    if (!response.ok) throw new Error('app_update_unreachable');
                    const body = await response.json() as VersionResponse;
                    if (typeof body.version !== 'string') throw new Error('app_update_invalid_version');
                    return body.version;
                },
                updateServiceWorker: async () => {
                    const registration = await navigator.serviceWorker?.getRegistration();
                    await registration?.update();
                },
                cacheNames: async () => 'caches' in window ? caches.keys() : [],
                deleteCache: async name => { await caches.delete(name); },
                resetPrecache: () => localStorage.removeItem(CLAVE_PRECARGA_TS),
                reload: () => window.location.reload(),
            });
        } catch (error) {
            setConfirmUpdate(false);
            setUpdating(false);
            setUpdateError(error instanceof Error && error.message === 'app_update_sync_timeout'
                ? 'La sincronización sigue trabajando. No se recargó ni se eliminó la caché; vuelve a intentar más tarde.'
                : error instanceof Error && error.message === 'app_update_busy'
                ? 'Hay una venta o actualización en curso. Termínala antes de actualizar.'
                : 'No se pudo descargar la actualización. Puedes seguir trabajando e intentar más tarde.');
        }
    };

    if (!availableVersion) return null;

    const cartIsActive = activeItems > 0;
    return (
        <>
        {!confirmUpdate && (
        <aside
            className="fixed inset-x-3 bottom-3 z-[90] mx-auto max-w-2xl rounded-2xl border border-gold/30 bg-navy-2 p-3 shadow-2xl sm:p-4"
            role="status"
            aria-live="polite"
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                    <p className="font-bold text-white">Hay una actualización de VentaRD lista</p>
                    <p className="mt-0.5 text-xs text-vr-gray">
                        {cartIsActive
                            ? 'Termina o pausa la venta actual para actualizar sin interrumpir el cobro.'
                            : 'La actualización conserva tus datos locales y ventas en espera.'}
                    </p>
                    {updateError && <p className="mt-1 text-xs text-vr-orange">{updateError}</p>}
                </div>
                <button
                    type="button"
                    onClick={() => { setUpdateError(null); setConfirmUpdate(true); }}
                    disabled={cartIsActive || !online || updating}
                    className="shrink-0 rounded-xl bg-gold-gradient px-5 py-3 text-sm font-extrabold text-navy transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    {updating ? 'Esperando punto seguro…' : !online ? 'Conéctate para actualizar' : 'Actualizar ahora'}
                </button>
            </div>
        </aside>
        )}
        <ConfirmModal
            isOpen={confirmUpdate}
            title="Actualizar VentaRD"
            mensaje="Guarda los formularios y el conteo de caja que tengas abiertos. La pantalla se recargará; las ventas guardadas y las ventas en espera se conservan."
            confirmLabel="Ya guardé, actualizar"
            cancelLabel="Continuar trabajando"
            tono="normal"
            procesando={updating}
            onConfirm={() => { void updateNow(); }}
            onClose={() => setConfirmUpdate(false)}
        />
        </>
    );
}
