import { describe, expect, it, vi } from 'vitest';
import { createRemoteSnapshotHandler } from '@/lib/diagnostics/reconciliation/readers/remote-handler';
import { branch, id, tenant } from '@/lib/diagnostics/reconciliation/fixtures/local';

describe('isolated two-tenant remote route integration', () => {
    it('only owner/admin see their business; seller/other tenant see nothing; data hash unchanged', async () => {
        const other = id(99);
        const rows = [{ id: id(20), negocioId: tenant, sucursalId: branch, sourceId: 'supabase', observedAt: 100, fecha: 100, total: '1', metodoPago: 'efectivo' }, { id: id(21), negocioId: other, sucursalId: id(98), sourceId: 'supabase', observedAt: 100, fecha: 100, total: '9', metodoPago: 'efectivo' }];
        const before = JSON.stringify(rows);
        const audit = { rpc: vi.fn(), sync: vi.fn(), retry: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), upsert: vi.fn() };
        const roles = new Map([['owner', 'dueño'], ['admin', 'admin'], ['seller', 'vendedor']]);
        const handler = createRemoteSnapshotHandler({ authenticate: async token => ({ id: token }), role: async (userId, negocioId) => negocioId === tenant ? roles.get(userId) ?? null : null, branchBelongs: async (business, b) => business === tenant && b === branch, queryPage: async q => ({ records: rows.filter(r => r.negocioId === q.negocioId && (!q.id || r.id === q.id)), hasMore: false }), rateLimited: () => false, now: () => 200, cursorSecret: 'integration-secret' });
        const url = `http://localhost/api/diagnostics/remote-snapshot?negocioId=${tenant}&sucursalId=${branch}&entity=ventas&id=${id(20)}&asOf=200`;
        for (const role of ['owner', 'admin']) { const res = await handler(new Request(url, { headers: { Authorization: `Bearer ${role}` } })); expect(res.status).toBe(200); expect((await res.json()).records.map((r: { negocioId: string }) => r.negocioId)).toEqual([tenant]); }
        expect((await handler(new Request(url, { headers: { Authorization: 'Bearer seller' } }))).status).toBe(403);
        expect((await handler(new Request(url.replace(tenant, other), { headers: { Authorization: 'Bearer owner' } }))).status).toBe(403);
        expect(JSON.stringify(rows)).toBe(before);
        Object.values(audit).forEach(fn => expect(fn).not.toHaveBeenCalled());
    });
});
