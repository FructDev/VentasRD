import { hasDeployUpdate } from './app-version';

export async function prepareAppUpdate(input: {
    installedVersion: string;
    canReload: () => boolean;
    acquireSync?: () => Promise<() => void>;
    readAvailableVersion: () => Promise<string>;
    updateServiceWorker: () => Promise<void>;
    cacheNames: () => Promise<string[]>;
    deleteCache: (name: string) => Promise<void>;
    resetPrecache: () => void;
    reload: () => void;
}): Promise<void> {
    if (!input.canReload()) throw new Error('app_update_busy');
    const release = await input.acquireSync?.();
    try {
        if (!input.canReload()) throw new Error('app_update_busy');
        const available = await input.readAvailableVersion();
        if (!hasDeployUpdate(input.installedVersion, available)) throw new Error('app_update_not_available');
        // Check connectivity/update first: a failed network check must not destroy
        // the pages the device needs to open the next shift offline.
        await input.updateServiceWorker();
        if (!input.canReload()) throw new Error('app_update_busy');
        const names = await input.cacheNames();
        if (!input.canReload()) throw new Error('app_update_busy');
        await Promise.all(names
            .filter(name => name === 'ventard-pages' || name === 'start-url')
            .map(name => input.deleteCache(name)));
        input.resetPrecache();
        input.reload();
        // Success keeps admission closed until the new document owns its workers.
    } catch (error) {
        release?.();
        throw error;
    }
}
