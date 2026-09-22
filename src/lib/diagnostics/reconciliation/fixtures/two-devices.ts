import { asOf, baseCoverage, baseInput, baseRecords, baseSnapshot, branch, id, line, movement, product, sale, tenant } from './local';
import type { ReconciliationInput, SourceSnapshot } from '../types';

export function twoDevices(options: { remote?: 'ABSENT' | 'APPLIED' | 'PARTIAL' | 'DENIED'; b?: 'ABSENT' | 'UPDATED' | 'OLD'; syncFlag?: 0 | 1; ordered?: boolean; skewedClocks?: boolean } = {}): ReconciliationInput {
    const a = baseSnapshot({ ventas: [sale()], ventaDetalles: [line()], productos: [product('4')], movimientosStock: [{ ...movement(), syncFlag: options.syncFlag ?? 1 }] });
    a.source.sucursalId = branch;
    a.records.ventas[0].sucursalId = branch;
    a.records.ventaDetalles[0].sucursalId = branch;
    a.records.productos[0].sucursalId = branch;
    a.records.movimientosStock[0].sucursalId = branch;
    a.coverage.forEach(c => { c.scope.sucursalId = branch; });
    const remote: SourceSnapshot = {
        contractVersion: '1.0', source: { sourceId: 'supabase', kind: 'REMOTE', negocioId: tenant, sucursalId: branch, serverIdentityVerified: options.remote !== 'DENIED' },
        capture: { startedAt: asOf, finishedAt: asOf, asOf, temporalConsistency: 'WINDOWED', ...(options.ordered !== false && { observedAfterSourceIds: ['pc-a'] }) },
        coverage: baseCoverage(options.remote === 'PARTIAL' ? 'PARTIAL' : options.remote === 'DENIED' ? 'DENIED' : 'COMPLETE').map(c => ({ ...c, scope: { ...c.scope, sucursalId: branch, requestedIds: [id(30), id(20), id(10)] } })),
        records: { ...baseRecords(), ...(options.remote === 'APPLIED' && { ventas: [{ ...sale(), sourceId: 'supabase', syncFlag: undefined, sucursalId: branch }], movimientosStock: [{ ...movement(), sourceId: 'supabase', syncFlag: undefined, sucursalId: branch }] }) },
    };
    const b: SourceSnapshot = {
        contractVersion: '1.0', source: { sourceId: 'pc-b', kind: 'LOCAL', deviceLabel: 'PC B', negocioId: tenant, sucursalId: branch, serverIdentityVerified: false },
        capture: { startedAt: options.skewedClocks ? asOf - 50_000 : asOf, finishedAt: options.skewedClocks ? asOf - 50_000 : asOf, asOf, temporalConsistency: 'COHERENT', ...(options.ordered !== false && { observedAfterSourceIds: ['supabase'] }) },
        coverage: baseCoverage().map(c => ({ ...c, scope: { ...c.scope, sucursalId: branch, requestedIds: [id(30), id(20), id(10)] } })),
        records: { ...baseRecords(), ...(options.b === 'UPDATED' && { ventas: [{ ...sale(), sourceId: 'pc-b', sucursalId: branch }], movimientosStock: [{ ...movement(), sourceId: 'pc-b', sucursalId: branch }] }), ...(options.b === 'OLD' && { productos: [{ ...product('5'), sourceId: 'pc-b', sucursalId: branch }] }) },
    };
    const input = baseInput(a);
    input.request.sucursalId = branch;
    input.snapshots = [a, remote, b];
    return input;
}

export function isolatedLastUnit(): ReconciliationInput {
    const input = twoDevices({ remote: 'PARTIAL', ordered: false });
    const a = input.snapshots[0]; const b = input.snapshots[2];
    a.records.productos[0].stockMaterializado = '0';
    b.records.productos = [{ ...product('0'), sourceId: 'pc-b', sucursalId: branch }];
    b.records.ventas = [{ ...sale(), id: id(22), sourceId: 'pc-b', sucursalId: branch }];
    b.records.movimientosStock = [{ ...movement(), id: id(32), referenciaOperacionId: id(22), sourceId: 'pc-b', sucursalId: branch }];
    return input;
}
