import { describe, expect, it, vi } from 'vitest';
import { captureRemote } from './remote';
import { asOf, baseInput, id, tenant } from '../fixtures/local';

const request = baseInput().request;
const page = (records: unknown[], status: 'COMPLETE' | 'PARTIAL', nextCursor?: string) => ({ contractVersion: '1.0', entity: 'ventas', scope: { negocioId: tenant, id: id(20) }, capture: { startedAt: asOf, finishedAt: asOf, temporalConsistency: 'WINDOWED' }, records, coverage: { status, rowsRead: records.length, pagesRead: 1, exhausted: !nextCursor }, ...(nextCursor && { nextCursor }) });
describe('remote snapshot reader', () => {
    it('consumes every page, yet multi-page window cannot prove absence', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(page([], 'PARTIAL', 'cursor')), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(page([], 'COMPLETE')), { status: 200 }));
        const snapshot = await captureRemote({ request, token: 'token', fetcher, entities: ['ventas'], ids: { ventas: id(20) }, sourceId: 'supabase' });
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(snapshot.coverage.find(c => c.entity === 'ventas')?.status).toBe('PARTIAL');
    });
    it('exact ID empty COMPLETE with one authorized page is conclusive', async () => {
        const snapshot = await captureRemote({ request, token: 'token', fetcher: vi.fn(async () => new Response(JSON.stringify(page([], 'COMPLETE')), { status: 200 })), entities: ['ventas'], ids: { ventas: id(20) }, sourceId: 'supabase' });
        expect(snapshot.coverage.find(c => c.entity === 'ventas')).toMatchObject({ status: 'COMPLETE', exhausted: true });
    });
    it.each([[401, 'UNAVAILABLE'], [403, 'DENIED'], [429, 'UNAVAILABLE'], [503, 'UNAVAILABLE']] as const)('%s yields %s, no retry', async (code, status) => {
        const fetcher = vi.fn(async () => new Response('{}', { status: code }));
        const snapshot = await captureRemote({ request, token: 'token', fetcher, entities: ['ventas'], ids: { ventas: id(20) }, sourceId: 'supabase' });
        expect(snapshot.coverage.find(c => c.entity === 'ventas')?.status).toBe(status);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('interrupted next page remains partial', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(page([], 'PARTIAL', 'cursor')), { status: 200 })).mockResolvedValueOnce(new Response('{}', { status: 503 }));
        const snapshot = await captureRemote({ request, token: 'token', fetcher, entities: ['ventas'], ids: { ventas: id(20) }, sourceId: 'supabase' });
        expect(snapshot.coverage.find(c => c.entity === 'ventas')?.status).toBe('PARTIAL');
    });
});
