interface StartupPort<T> {
    probe(): Promise<boolean>;
    getSession(): PromiseLike<T | undefined>;
    sessionTimeoutMs?: number;
}

/** Probe before refresh: a dead connection must not wait for expired-token renewal. */
export async function resolveStartupSession<T>(port: StartupPort<T>): Promise<{ user: T | undefined; offline: boolean }> {
    try {
        if (!await port.probe()) return { user: undefined, offline: true };
    } catch { return { user: undefined, offline: true }; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve(port.getSession()).then(user => ({ user, offline: false })),
            new Promise<{ user: undefined; offline: true }>(resolve => {
                timer = setTimeout(() => resolve({ user: undefined, offline: true }), port.sessionTimeoutMs ?? 1500);
            }),
        ]);
    } catch { return { user: undefined, offline: true }; }
    finally { if (timer) clearTimeout(timer); }
}
