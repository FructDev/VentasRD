interface BranchScope { negocioId: string | null; sucursalId: string | null }
interface CachedBranchPort {
    getScope(): BranchScope;
    readBranch(id: string): Promise<{ id: string; negocio_id: string } | undefined>;
    invalidate(): void;
}

/** Local metadata is not remote authorization. Missing legacy cache is unknown,
 * not proof that the branch disappeared. Never delete rows or fabricate scope. */
export async function validateCachedBranch(port: CachedBranchPort): Promise<
    'UNSELECTED' | 'MATCH' | 'UNVERIFIED' | 'STALE' | 'INVALIDATED'
> {
    const { negocioId, sucursalId } = port.getScope();
    if (!negocioId || !sucursalId) return 'UNSELECTED';
    let branch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        branch = await Promise.race([
            port.readBranch(sucursalId),
            new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 250); }),
        ]);
    }
    catch { return 'UNVERIFIED'; }
    finally { if (timer) clearTimeout(timer); }
    const current = port.getScope();
    if (current.negocioId !== negocioId || current.sucursalId !== sucursalId) return 'STALE';
    if (!branch || branch.id !== sucursalId) return 'UNVERIFIED';
    if (branch.negocio_id === negocioId) return 'MATCH';
    port.invalidate();
    return 'INVALIDATED';
}
