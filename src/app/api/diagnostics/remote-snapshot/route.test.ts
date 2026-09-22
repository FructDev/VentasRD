import { describe, expect, it, vi } from 'vitest';
import { createRemoteSnapshotHandler } from '@/lib/diagnostics/reconciliation/readers/remote-handler';
import { branch, id, tenant } from '@/lib/diagnostics/reconciliation/fixtures/local';

const other = id(99);
function setup(role: string | null = 'dueño') {
    const queryPage = vi.fn(async (): Promise<{ records: Record<string, unknown>[]; hasMore: boolean }> => ({ records: [{ id: id(20), negocioId: tenant, sourceId: 'supabase', observedAt: 100, fecha: 100, total: '1', metodoPago: 'efectivo' }], hasMore: false }));
    const deps = { authenticate: vi.fn(async (token: string) => token === 'good' ? { id: id(88) } : null), role: vi.fn(async () => role), branchBelongs: vi.fn(async (_b: string, s: string) => s === branch), queryPage, rateLimited: vi.fn(() => false), now: vi.fn(() => 200), cursorSecret: 'test-secret-for-cursors' };
    return { get: createRemoteSnapshotHandler(deps), deps };
}
function req(query = '', token = 'good') {
    return new Request(`http://localhost/api/diagnostics/remote-snapshot?negocioId=${tenant}&entity=ventas&asOf=200&desde=0&hasta=200${query}`, { headers: { Authorization: `Bearer ${token}` } });
}

describe('remote diagnostic GET contract', () => {
    it('rejects invalid bearer and seller without reading business rows', async () => {
        const a = setup(); expect((await a.get(req('', 'bad'))).status).toBe(401); expect(a.deps.queryPage).not.toHaveBeenCalled();
        const b = setup('vendedor'); expect((await b.get(req())).status).toBe(403); expect(b.deps.queryPage).not.toHaveBeenCalled();
    });
    it('rejects foreign tenant and branch', async () => {
        const a = setup(null); expect((await a.get(req())).status).toBe(403);
        const b = setup(); expect((await b.get(req(`&sucursalId=${other}`))).status).toBe(403); expect(b.deps.queryPage).not.toHaveBeenCalled();
    });
    it('rejects forged cursor, >500 rows, excessive range, unsupported entity', async () => {
        const s = setup();
        for (const q of ['&cursor=forged', '&limit=501', '&hasta=40000000000', '&entity=usuarios']) expect((await s.get(req(q))).status).toBe(400);
        expect(s.deps.queryPage).not.toHaveBeenCalled();
    });
    it('returns no-store, allowlisted shape, no mutation surface and partial page until exhausted', async () => {
        const s = setup();
        const res = await s.get(req('&id=' + id(20)));
        expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toContain('no-store');
        const body = await res.json();
        expect(body.capture.temporalConsistency).toBe('WINDOWED');
        expect(body.coverage.status).toBe('COMPLETE');
        expect(body.records[0]).toEqual({ id: id(20), negocioId: tenant, sourceId: 'supabase', observedAt: 100, fecha: 100, total: '1', metodoPago: 'efectivo' });
        expect(s.deps.queryPage).toHaveBeenCalledTimes(1);
    });
    it('rejects extra sensitive fields from a faulty reader and binds cursor to user/scope', async () => {
        const s = setup();
        s.deps.queryPage.mockResolvedValueOnce({ records: [{ id: id(20), negocioId: tenant, sourceId: 'supabase', observedAt: 100, fecha: 100, total: '1', metodoPago: 'efectivo', secret: 'do not expose' }], hasMore: false });
        expect((await s.get(req())).status).toBe(503);
        s.deps.queryPage.mockResolvedValueOnce({ records: [{ id: id(20), negocioId: tenant, sourceId: 'supabase', observedAt: 100, fecha: 100, total: '1', metodoPago: 'efectivo' }], hasMore: true });
        const first = await (await s.get(req())).json();
        expect(first.coverage.status).toBe('PARTIAL');
        expect((await s.get(req(`&cursor=${encodeURIComponent(first.nextCursor)}&limit=5`))).status).toBe(400);
    });
    it('returns stable 429 and 503 without reading twice or retrying', async () => {
        const limited = setup(); limited.deps.rateLimited.mockReturnValue(true);
        expect((await limited.get(req())).status).toBe(429); expect(limited.deps.queryPage).not.toHaveBeenCalled();
        const unavailable = setup(); unavailable.deps.queryPage.mockRejectedValue(new Error('database details must not leak'));
        const response = await unavailable.get(req()); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'REMOTE_READ_UNAVAILABLE' });
        expect(unavailable.deps.queryPage).toHaveBeenCalledTimes(1);
    });
});
