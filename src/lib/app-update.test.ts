import { describe, expect, it, vi } from 'vitest';
import { prepareAppUpdate } from './app-update';

function dependencies() {
    return {
        installedVersion: 'old-build',
        canReload: vi.fn(() => true),
        readAvailableVersion: vi.fn(async () => 'new-build'),
        updateServiceWorker: vi.fn(async () => {}),
        cacheNames: vi.fn(async () => ['ventard-pages', 'start-url', 'ventard-static', 'unrelated-cache']),
        deleteCache: vi.fn(async (name: string) => { void name; }),
        resetPrecache: vi.fn(() => {}),
        reload: vi.fn(() => {}),
    };
}

describe('actualizacion controlada', () => {
    it('adquiere pausa antes de red/cache y la conserva hasta la nueva página', async () => {
        const deps = dependencies(); const release = vi.fn();
        const acquireSync = vi.fn(async () => release);
        await prepareAppUpdate({ ...deps, acquireSync });
        expect(acquireSync).toHaveBeenCalledTimes(1);
        expect(acquireSync.mock.invocationCallOrder[0]).toBeLessThan(deps.readAvailableVersion.mock.invocationCallOrder[0]);
        expect(release).not.toHaveBeenCalled(); expect(deps.reload).toHaveBeenCalledTimes(1);
    });
    it('si falla adquirir pausa conserva caches y no intenta actualizar', async () => {
        const deps = dependencies();
        await expect(prepareAppUpdate({ ...deps, acquireSync: async () => { throw new Error('app_update_sync_timeout'); } }))
            .rejects.toThrow('app_update_sync_timeout');
        expect(deps.readAvailableVersion).not.toHaveBeenCalled(); expect(deps.deleteCache).not.toHaveBeenCalled();
    });
    it.each(['readAvailableVersion', 'updateServiceWorker', 'cacheNames', 'deleteCache', 'reload'] as const)
        ('libera pausa y no recarga cuando falla %s', async stage => {
            const deps = dependencies(); const release = vi.fn();
            if (stage === 'reload') deps.reload.mockImplementation(() => { throw new Error('failed'); });
            else deps[stage].mockRejectedValue(new Error('failed'));
            await expect(prepareAppUpdate({ ...deps, acquireSync: async () => release })).rejects.toThrow('failed');
            expect(release).toHaveBeenCalledTimes(1);
            if (stage !== 'reload') expect(deps.reload).not.toHaveBeenCalled();
        });
    it('si aparece carrito durante drenaje libera pausa sin borrar caches', async () => {
        const deps = dependencies(); const release = vi.fn();
        const acquireSync = async () => { deps.canReload.mockReturnValue(false); return release; };
        await expect(prepareAppUpdate({ ...deps, acquireSync })).rejects.toThrow('app_update_busy');
        expect(release).toHaveBeenCalledTimes(1); expect(deps.deleteCache).not.toHaveBeenCalled();
    });
    it('si el carrito ya está activo no solicita pausa ni toca caches', async () => {
        const deps = dependencies(); deps.canReload.mockReturnValue(false); const acquireSync = vi.fn();
        await expect(prepareAppUpdate({ ...deps, acquireSync })).rejects.toThrow('app_update_busy');
        expect(acquireSync).not.toHaveBeenCalled(); expect(deps.deleteCache).not.toHaveBeenCalled();
    });
    it('si la red falla conserva cache offline y no recarga', async () => {
        const deps = dependencies();
        deps.readAvailableVersion.mockRejectedValue(new Error('offline'));
        await expect(prepareAppUpdate(deps)).rejects.toThrow('offline');
        expect(deps.deleteCache).not.toHaveBeenCalled();
        expect(deps.reload).not.toHaveBeenCalled();
    });

    it('si falla actualizar el worker conserva cache y no recarga', async () => {
        const deps = dependencies();
        deps.updateServiceWorker.mockRejectedValue(new Error('worker-unavailable'));
        await expect(prepareAppUpdate(deps)).rejects.toThrow('worker-unavailable');
        expect(deps.deleteCache).not.toHaveBeenCalled();
        expect(deps.reload).not.toHaveBeenCalled();
    });

    it('recomprueba carrito/sync tras esperar la red', async () => {
        const deps = dependencies();
        deps.canReload.mockReturnValueOnce(true).mockReturnValue(false);
        await expect(prepareAppUpdate(deps)).rejects.toThrow('app_update_busy');
        expect(deps.deleteCache).not.toHaveBeenCalled();
        expect(deps.reload).not.toHaveBeenCalled();
    });

    it('borra solo shells tras confirmar version y worker, conserva assets y recarga una vez', async () => {
        const deps = dependencies();
        await prepareAppUpdate(deps);
        expect(deps.deleteCache.mock.calls.map(([name]) => name)).toEqual(['ventard-pages', 'start-url']);
        expect(deps.readAvailableVersion.mock.invocationCallOrder[0]).toBeLessThan(deps.updateServiceWorker.mock.invocationCallOrder[0]);
        expect(deps.updateServiceWorker.mock.invocationCallOrder[0]).toBeLessThan(deps.deleteCache.mock.invocationCallOrder[0]);
        expect(deps.reload).toHaveBeenCalledTimes(1);
    });
});
