import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { EntityName } from '../types';

export const REMOTE_ENTITIES = ['ventas', 'ventaDetalles', 'productos', 'movimientosStock'] as const satisfies readonly EntityName[];
export interface RemoteQuery {
    negocioId: string; sucursalId?: string; entity: typeof REMOTE_ENTITIES[number]; desde?: number; hasta?: number; id?: string; asOf: number; limit: number; offset: number; token: string;
}
export interface RemotePage { records: Record<string, unknown>[]; hasMore: boolean }
export interface RemoteHandlerDeps {
    authenticate(token: string): Promise<{ id: string } | null>;
    role(userId: string, negocioId: string): Promise<string | null>;
    branchBelongs(negocioId: string, sucursalId: string, token: string): Promise<boolean>;
    queryPage(query: RemoteQuery): Promise<RemotePage>;
    rateLimited(userId: string, request: Request): boolean;
    now(): number;
    cursorSecret: string;
}
const uuid = z.uuid();
const integer = z.coerce.number().int().nonnegative();
const maxWindow = 366 * 86_400_000;
const allowedFields: Record<RemoteQuery['entity'], ReadonlySet<string>> = {
    ventas: new Set(['id', 'negocioId', 'sucursalId', 'sourceId', 'observedAt', 'fecha', 'total', 'metodoPago', 'montoEfectivo', 'montoTransferencia']),
    ventaDetalles: new Set(['id', 'negocioId', 'sucursalId', 'sourceId', 'observedAt', 'ventaId', 'productoId', 'cantidad', 'precioUnitario', 'subtotal', 'fecha']),
    productos: new Set(['id', 'negocioId', 'sourceId', 'observedAt', 'stockMaterializado', 'fechaActualizacion', 'tipo', 'serializable', 'eliminado']),
    movimientosStock: new Set(['id', 'negocioId', 'sucursalId', 'sourceId', 'observedAt', 'productoId', 'delta', 'valorAbsoluto', 'tipo', 'referenciaOperacionId', 'fecha']),
};
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
function error(status: 400 | 401 | 403 | 429 | 503, code: string): Response { return Response.json({ error: code }, { status, headers }); }
function encodeCursor(scope: string, offset: number, secret: string): string {
    const data = Buffer.from(JSON.stringify({ scope, offset })).toString('base64url');
    const mac = createHmac('sha256', secret).update(data).digest('base64url');
    return `${data}.${mac}`;
}
function decodeCursor(cursor: string, scope: string, secret: string): number | null {
    const [data, mac, excess] = cursor.split('.');
    if (!data || !mac || excess || data.length > 1024) return null;
    const expected = createHmac('sha256', secret).update(data).digest();
    let received: Buffer;
    try { received = Buffer.from(mac, 'base64url'); } catch { return null; }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    try {
        const parsed: unknown = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        const obj = parsed as { scope?: unknown; offset?: unknown };
        return obj.scope === scope && Number.isSafeInteger(obj.offset) && (obj.offset as number) > 0 && (obj.offset as number) <= 100_000 ? obj.offset as number : null;
    } catch { return null; }
}

/** Injectable GET core; production dependencies live only in the Next route. */
export function createRemoteSnapshotHandler(deps: RemoteHandlerDeps): (req: Request) => Promise<Response> {
    return async req => {
        const params = new URL(req.url).searchParams;
        const allowed = new Set(['negocioId', 'sucursalId', 'entity', 'desde', 'hasta', 'id', 'asOf', 'cursor', 'limit']);
        if ([...params.keys()].some(k => !allowed.has(k) || params.getAll(k).length !== 1)) return error(400, 'INVALID_QUERY');
        const negocioId = params.get('negocioId'); const sucursalId = params.get('sucursalId') ?? undefined;
        const entity = params.get('entity'); const id = params.get('id') ?? undefined;
        if (!negocioId || !uuid.safeParse(negocioId).success || (sucursalId && !uuid.safeParse(sucursalId).success) || (id && !uuid.safeParse(id).success) || !REMOTE_ENTITIES.some(e => e === entity)) return error(400, 'INVALID_SCOPE');
        const asOf = params.has('asOf') ? integer.safeParse(params.get('asOf')) : { success: false as const };
        const limit = params.has('limit') ? integer.safeParse(params.get('limit')) : { success: true as const, data: 200 };
        const desde = params.has('desde') ? integer.safeParse(params.get('desde')) : null;
        const hasta = params.has('hasta') ? integer.safeParse(params.get('hasta')) : null;
        if (!asOf.success || !limit.success || limit.data < 1 || limit.data > 500 || (!!desde !== !!hasta) || (desde && !desde.success) || (hasta && !hasta.success) || (!id && !desde)) return error(400, 'INVALID_RANGE');
        if (desde?.success && hasta?.success && (desde.data > hasta.data || hasta.data - desde.data > maxWindow || hasta.data > asOf.data)) return error(400, 'INVALID_RANGE');
        const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
        if (!token) return error(401, 'UNAUTHENTICATED');
        let user: { id: string } | null;
        try { user = await deps.authenticate(token); } catch { return error(503, 'IDENTITY_UNAVAILABLE'); }
        if (!user) return error(401, 'UNAUTHENTICATED');
        let role: string | null;
        try { role = await deps.role(user.id, negocioId); } catch { return error(503, 'AUTHORIZATION_UNAVAILABLE'); }
        if (role !== 'dueño' && role !== 'admin') return error(403, 'FORBIDDEN');
        if (sucursalId) {
            try { if (!await deps.branchBelongs(negocioId, sucursalId, token)) return error(403, 'FORBIDDEN'); }
            catch { return error(503, 'BRANCH_UNAVAILABLE'); }
        }
        if (deps.rateLimited(user.id, req)) return error(429, 'RATE_LIMITED');
        // The product materialized stock is global; it cannot prove stock for one branch.
        if (entity === 'productos' && sucursalId) return error(503, 'BRANCH_STOCK_UNAVAILABLE');
        const scopeKey = JSON.stringify({ userId: user.id, negocioId, sucursalId, entity, desde: desde?.success ? desde.data : undefined, hasta: hasta?.success ? hasta.data : undefined, id, asOf: asOf.data, limit: limit.data });
        const cursor = params.get('cursor');
        const offset = cursor ? decodeCursor(cursor, scopeKey, deps.cursorSecret) : 0;
        if (offset === null || (id && offset !== 0)) return error(400, 'INVALID_CURSOR');
        const startedAt = deps.now();
        let page: RemotePage;
        try { page = await deps.queryPage({ negocioId, ...(sucursalId && { sucursalId }), entity: entity as RemoteQuery['entity'], ...(desde?.success && { desde: desde.data }), ...(hasta?.success && { hasta: hasta.data }), ...(id && { id }), asOf: asOf.data, limit: limit.data, offset, token }); }
        catch { return error(503, 'REMOTE_READ_UNAVAILABLE'); }
        if (!Array.isArray(page.records) || page.records.length > limit.data || page.records.some(row => row.negocioId !== negocioId || (sucursalId && row.sucursalId !== sucursalId) || Object.keys(row).some(key => !allowedFields[entity as RemoteQuery['entity']].has(key)))) return error(503, 'REMOTE_SCOPE_UNVERIFIED');
        const nextCursor = page.hasMore ? encodeCursor(scopeKey, offset + page.records.length, deps.cursorSecret) : undefined;
        if (page.hasMore && (page.records.length === 0 || offset + page.records.length > 100_000)) return error(503, 'REMOTE_PAGE_INCOMPLETE');
        return Response.json({ contractVersion: '1.0', entity, scope: { negocioId, ...(sucursalId && { sucursalId }), ...(desde?.success && { desde: desde.data }), ...(hasta?.success && { hasta: hasta.data }), ...(id && { id }) }, capture: { startedAt, finishedAt: deps.now(), temporalConsistency: 'WINDOWED' }, records: page.records, coverage: { status: nextCursor ? 'PARTIAL' : 'COMPLETE', rowsRead: page.records.length, pagesRead: 1, exhausted: !nextCursor }, ...(nextCursor && { nextCursor }) }, { headers });
    };
}
