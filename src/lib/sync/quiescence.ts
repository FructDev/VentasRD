/** Cooperative, per-document admission gate. Never cancels effects or edits queues. */
export class SyncQuiescence {
    private readonly activities = new Set<symbol>();
    private owner: symbol | null = null;
    private onIdle: (() => void) | null = null;

    enter(): (() => void) | null {
        if (this.owner) return null;
        const token = Symbol('sync-activity');
        this.activities.add(token);
        return () => {
            if (!this.activities.delete(token)) return;
            if (!this.activities.size) this.onIdle?.();
        };
    }

    async acquire(input: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<() => void> {
        if (input.signal?.aborted) throw new Error('app_update_cancelled');
        if (this.owner) throw new Error('app_update_busy');
        const timeoutMs = input.timeoutMs ?? 30_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new Error('app_update_invalid_timeout');
        const owner = Symbol('update-owner');
        this.owner = owner; // Close admission synchronously, before the first await.
        return new Promise((resolve, reject) => {
            const release = () => { if (this.owner === owner) this.owner = null; };
            const cleanup = () => {
                clearTimeout(timer);
                input.signal?.removeEventListener('abort', abort);
                if (this.onIdle === idle) this.onIdle = null;
            };
            const fail = (code: string) => { cleanup(); release(); reject(new Error(code)); };
            const abort = () => fail('app_update_cancelled');
            const idle = () => { cleanup(); resolve(release); };
            const timer = setTimeout(() => fail('app_update_sync_timeout'), timeoutMs);
            input.signal?.addEventListener('abort', abort, { once: true });
            this.onIdle = idle;
            if (!this.activities.size) idle();
        });
    }
}

// All background dispatchers in this document share the same module instance.
// Another tab/old build is not paused: durable claims/idempotency still apply.
export const syncQuiescence = new SyncQuiescence();
