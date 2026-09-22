import type { Coverage, CoverageStatus } from './types';

/** A COMPLETE label is not evidence when the capture itself contradicts it. */
export function effectiveCoverage(value: Coverage): CoverageStatus {
    if (value.status !== 'COMPLETE') return value.status;
    if (value.startedAt > value.finishedAt || value.exhausted !== true || value.concurrentChangePossible || (value.retentionHorizon !== undefined && value.scope.desde !== undefined && value.scope.desde < value.retentionHorizon)) return 'PARTIAL';
    return 'COMPLETE';
}

export function canProveAbsence(value: Coverage | undefined, target: { negocioId: string; sucursalId?: string; fecha?: number; id?: string }): boolean {
    if (!value || effectiveCoverage(value) !== 'COMPLETE' || value.scope.negocioId !== target.negocioId) return false;
    if (value.scope.sucursalId && value.scope.sucursalId !== target.sucursalId) return false;
    if (target.sucursalId && value.scope.sucursalId !== target.sucursalId) return false;
    if (target.fecha !== undefined && ((value.scope.desde !== undefined && target.fecha < value.scope.desde) || (value.scope.hasta !== undefined && target.fecha > value.scope.hasta))) return false;
    if (target.id && value.scope.requestedIds && !value.scope.requestedIds.includes(target.id)) return false;
    if (target.id && !value.scope.requestedIds && value.scope.desde !== undefined) return false;
    return true;
}

export function coverageFor(values: readonly Coverage[], entity: Coverage['entity']): Coverage | undefined {
    return values.find(value => value.entity === entity);
}
