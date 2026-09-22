import { createClient } from '@supabase/supabase-js';
import { excedeLimite, rolEnNegocio, usuarioDesdeToken } from '@/lib/api/guardia';
import { createRemoteSnapshotHandler } from '@/lib/diagnostics/reconciliation/readers/remote-handler';
import { readRemotePage } from '@/lib/diagnostics/reconciliation/readers/remote-query';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
    const secret = process.env.DIAGNOSTIC_CURSOR_SECRET;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!secret || secret.length < 16 || !url || !publicKey) return Response.json({ error: 'DIAGNOSTIC_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
    const userClient = createClient(url, publicKey, { auth: { autoRefreshToken: false, persistSession: false }, global: { headers: { ...(token && { Authorization: `Bearer ${token}` }) } } });
    const handler = createRemoteSnapshotHandler({
        authenticate: async token => usuarioDesdeToken(new Request(request.url, { headers: { authorization: `Bearer ${token}` } })),
        role: rolEnNegocio,
        branchBelongs: async (negocioId, sucursalId) => {
            const { data, error } = await userClient.from('sucursales').select('id').eq('id', sucursalId).eq('negocio_id', negocioId).maybeSingle();
            if (error) throw new Error('BRANCH_READ_FAILED');
            return !!data;
        },
        queryPage: query => readRemotePage(query, userClient),
        rateLimited: (userId, req) => excedeLimite(req, `diagnostic-read:${userId}`, 60, 60_000),
        now: () => Date.now(),
        cursorSecret: secret,
    });
    return handler(request);
}
