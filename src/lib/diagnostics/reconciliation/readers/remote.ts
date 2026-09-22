import { ENTITY_NAMES, type Coverage, type EntityName, type ReconciliationRequest, type SnapshotRecords, type SourceSnapshot } from '../types';
import { REMOTE_ENTITIES } from './remote-handler';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export interface RemoteCaptureOptions {
    request: ReconciliationRequest; token: string; fetcher?: Fetcher; entities?: EntityName[]; ids?: Partial<Record<EntityName, string>>;
    sourceId?: string; observedAfterSourceIds?: string[]; limit?: number;
}
function emptyRecords(): SnapshotRecords { return { ventas: [], ventaDetalles: [], productos: [], movimientosStock: [], transaccionesFiado: [], seriales: [], devoluciones: [], cajas: [], cortesCaja: [], gastos: [], reparaciones: [], apartados: [], reportes: [] }; }
function unavailable(entity: EntityName, request: ReconciliationRequest, id: string | undefined, reason: string, status: Coverage['status'] = 'UNAVAILABLE', rowsRead = 0, pagesRead = 0): Coverage {
    return { entity, scope: { negocioId: request.negocioId, ...(request.sucursalId && { sucursalId: request.sucursalId }), desde: request.desde, hasta: request.hasta, ...(id && { requestedIds: [id] }) }, status, startedAt: request.asOf, finishedAt: request.asOf, rowsRead, pagesRead, exhausted: false, concurrentChangePossible: true, reason };
}
function validPage(value: unknown, entity: EntityName, request: ReconciliationRequest, id: string | undefined, limit: number): value is {
    contractVersion: '1.0'; entity: EntityName; scope: { negocioId: string; sucursalId?: string; id?: string }; capture: { startedAt: number; finishedAt: number; temporalConsistency: 'WINDOWED' }; records: Record<string, unknown>[]; coverage: { status: 'COMPLETE' | 'PARTIAL'; exhausted: boolean; rowsRead: number }; nextCursor?: string;
} {
    if (!value || typeof value !== 'object') return false;
    const p = value as Record<string, unknown>;
    const scope = p.scope as Record<string, unknown> | undefined; const capture = p.capture as Record<string, unknown> | undefined; const coverage = p.coverage as Record<string, unknown> | undefined;
    return p.contractVersion === '1.0' && p.entity === entity && scope?.negocioId === request.negocioId && scope.sucursalId === request.sucursalId && scope.id === id
        && capture?.temporalConsistency === 'WINDOWED' && Number.isSafeInteger(capture.startedAt) && Number.isSafeInteger(capture.finishedAt) && (capture.startedAt as number) <= (capture.finishedAt as number)
        && Array.isArray(p.records) && p.records.length <= limit && p.records.every(row => row && typeof row === 'object' && row.negocioId === request.negocioId && (!request.sucursalId || row.sucursalId === request.sucursalId) && row.sourceId === 'supabase' && (!id || row.id === id))
        && !!coverage && (coverage.status === 'COMPLETE' || coverage.status === 'PARTIAL') && typeof coverage.exhausted === 'boolean' && coverage.rowsRead === p.records.length
        && (p.nextCursor === undefined || (typeof p.nextCursor === 'string' && p.nextCursor.length > 0 && p.nextCursor.length <= 2048));
}

/** Explicit remote capture. No retries, writes, worker calls or client-side role assertions. */
export async function captureRemote(options: RemoteCaptureOptions): Promise<SourceSnapshot> {
    const { request, token, ids = {}, sourceId = 'supabase' } = options;
    if (sourceId !== 'supabase') throw new Error('REMOTE_SOURCE_ID_UNSUPPORTED');
    const fetcher = options.fetcher ?? fetch;
    const chosen = new Set(options.entities ?? REMOTE_ENTITIES);
    const limit = options.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('INVALID_LIMIT');
    const records = emptyRecords(); const coverage: Coverage[] = [];
    let startedAt = Number.MAX_SAFE_INTEGER; let finishedAt = 0; let identityVerified = false;
    for (const entity of ENTITY_NAMES) {
        const id = ids[entity];
        if (!chosen.has(entity) || !REMOTE_ENTITIES.some(e => e === entity)) { coverage.push(unavailable(entity, request, id, 'REMOTE_ENTITY_UNSUPPORTED')); continue; }
        if (entity === 'productos' && request.sucursalId) { coverage.push(unavailable(entity, request, id, 'BRANCH_STOCK_UNAVAILABLE')); continue; }
        let cursor: string | undefined; let pages = 0; let failed: Coverage | undefined;
        const seen = new Set<string>();
        do {
            const params = new URLSearchParams({ negocioId: request.negocioId, entity, asOf: String(request.asOf), desde: String(request.desde), hasta: String(request.hasta), limit: String(limit) });
            if (request.sucursalId) params.set('sucursalId', request.sucursalId);
            if (id) params.set('id', id);
            if (cursor) params.set('cursor', cursor);
            let response: Response;
            try { response = await fetcher(`/api/diagnostics/remote-snapshot?${params}`, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Cache-Control': 'no-store' }, cache: 'no-store' }); }
            catch { failed = unavailable(entity, request, id, 'NETWORK_UNAVAILABLE', pages ? 'PARTIAL' : 'UNAVAILABLE', records[entity].length, pages); break; }
            if (!response.ok) { failed = unavailable(entity, request, id, `HTTP_${response.status}`, pages ? 'PARTIAL' : response.status === 403 ? 'DENIED' : 'UNAVAILABLE', records[entity].length, pages); break; }
            let body: unknown;
            try { body = await response.json(); } catch { failed = unavailable(entity, request, id, 'INVALID_RESPONSE', pages ? 'PARTIAL' : 'UNAVAILABLE', records[entity].length, pages); break; }
            if (!validPage(body, entity, request, id, limit)) { failed = unavailable(entity, request, id, 'INVALID_RESPONSE', pages ? 'PARTIAL' : 'UNAVAILABLE', records[entity].length, pages); break; }
            identityVerified = true; pages++;
            startedAt = Math.min(startedAt, body.capture.startedAt); finishedAt = Math.max(finishedAt, body.capture.finishedAt);
            // Runtime contract is checked before a record can become evidence.
            (records[entity] as unknown as Record<string, unknown>[]).push(...body.records);
            if (!!body.nextCursor === body.coverage.exhausted || (body.nextCursor && body.coverage.status !== 'PARTIAL') || (!body.nextCursor && body.coverage.status !== 'COMPLETE')) { failed = unavailable(entity, request, id, 'INCOMPLETE_PAGE', 'PARTIAL', records[entity].length, pages); break; }
            cursor = body.nextCursor;
            if (cursor) {
                if (seen.has(cursor) || pages >= 200 || records[entity].length >= 100_000) { failed = unavailable(entity, request, id, 'CURSOR_LOOP_OR_LIMIT', 'PARTIAL', records[entity].length, pages); break; }
                seen.add(cursor);
            }
        } while (cursor);
        if (failed) { coverage.push(failed); continue; }
        coverage.push({ entity, scope: { negocioId: request.negocioId, ...(request.sucursalId && { sucursalId: request.sucursalId }), desde: request.desde, hasta: request.hasta, ...(id && { requestedIds: [id] }) }, status: pages === 1 ? 'COMPLETE' : 'PARTIAL', startedAt: startedAt === Number.MAX_SAFE_INTEGER ? request.asOf : startedAt, finishedAt: finishedAt || request.asOf, rowsRead: records[entity].length, pagesRead: pages, exhausted: true, concurrentChangePossible: pages !== 1, ...(pages !== 1 && { reason: 'NON_ATOMIC_PAGINATION' }) });
    }
    const capturedAt = finishedAt || request.asOf;
    return { contractVersion: '1.0', source: { sourceId, kind: 'REMOTE', negocioId: request.negocioId, ...(request.sucursalId && { sucursalId: request.sucursalId }), serverIdentityVerified: identityVerified }, capture: { startedAt: startedAt === Number.MAX_SAFE_INTEGER ? capturedAt : startedAt, finishedAt: capturedAt, asOf: request.asOf, temporalConsistency: 'WINDOWED', ...(options.observedAfterSourceIds && { observedAfterSourceIds: options.observedAfterSourceIds }) }, coverage, records };
}
