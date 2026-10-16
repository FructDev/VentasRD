/** RPC transport that retains HTTP status/Retry-After, which PostgREST's JSON
 * error alone does not expose. Tokens stay transient in authenticated headers. */
export function createInventoryHttpTransport(input: {
    baseUrl: string; publishableKey: string; getAccessToken: () => Promise<string | null>;
    fetcher?: typeof fetch; now?: () => number;
}) {
    const fetcher = input.fetcher ?? fetch;
    return {
        async rpc(name: string, args: Record<string, unknown>) {
            if (!['aplicar_movimiento_stock_v2', 'leer_feed_inventario_v2'].includes(name)) {
                throw new Error('inventory_rpc_not_allowed');
            }
            const token = await input.getAccessToken();
            if (!token) return { data: null, error: { code: 'AUTH_REQUIRED' }, status: 401 };
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            try {
                const response = await fetcher(`${input.baseUrl}/rest/v1/rpc/${name}`, {
                    method: 'POST', headers: { apikey: input.publishableKey,
                        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(args), signal: controller.signal,
                });
                const data: unknown = await response.json().catch(() => null);
                const header = response.headers.get('Retry-After');
                const milliseconds = header === null ? undefined : /^\d+(\.\d+)?$/.test(header)
                    ? Math.ceil(Number(header) * 1000) : Date.parse(header) - (input.now ?? Date.now)();
                const retry = milliseconds !== undefined && Number.isFinite(milliseconds) && milliseconds >= 0
                    ? { retryAfterMs: milliseconds } : {};
                return { data: response.ok ? data : null, error: response.ok ? null : data ?? {}, status: response.status, ...retry };
            } finally { clearTimeout(timer); }
        },
    };
}
