import { describe, expect, it } from 'vitest';
import { parseReconciliationInput } from './schema';

const negocioId = '00000000-0000-4000-8000-000000000001';
const otroNegocio = '00000000-0000-4000-8000-000000000002';

function snapshot(kind: 'LOCAL' | 'REMOTE' = 'LOCAL', sourceId = 'pc-a') {
    const entities = ['ventas', 'ventaDetalles', 'productos', 'movimientosStock', 'transaccionesFiado', 'seriales', 'devoluciones', 'cajas', 'cortesCaja', 'gastos', 'reparaciones', 'apartados', 'reportes'];
    return {
        contractVersion: '1.0',
        source: { sourceId, kind, negocioId, ...(kind === 'LOCAL' && { deviceLabel: sourceId }) },
        capture: { startedAt: 100, finishedAt: 101, asOf: 101, temporalConsistency: kind === 'LOCAL' ? 'COHERENT' : 'WINDOWED' },
        coverage: entities.map(entity => ({ entity, scope: { negocioId, desde: 0, hasta: 100 }, status: 'COMPLETE', startedAt: 100, finishedAt: 101, rowsRead: 0, exhausted: true, concurrentChangePossible: false })),
        records: Object.fromEntries(entities.map(entity => [entity, []])),
    };
}

function input() {
    return {
        contractVersion: '1.0',
        request: { negocioId, desde: 0, hasta: 100, asOf: 101, pendingThresholdMs: 300_000 },
        snapshots: [snapshot()],
    };
}

describe('snapshot contract 1.0', () => {
    it('acepta una captura local completa y no altera la entrada', () => {
        const value = input();
        expect(parseReconciliationInput(value).snapshots).toHaveLength(1);
        expect(value.snapshots[0].records.ventas).toEqual([]);
    });

    it('rechaza versión, UUID, intervalo y asOf inválidos', () => {
        expect(() => parseReconciliationInput({ ...input(), contractVersion: '2.0' })).toThrow();
        expect(() => parseReconciliationInput({ ...input(), request: { ...input().request, negocioId: 'otro' } })).toThrow();
        expect(() => parseReconciliationInput({ ...input(), request: { ...input().request, desde: 200 } })).toThrow();
        expect(() => parseReconciliationInput({ ...input(), request: { ...input().request, asOf: undefined } })).toThrow();
    });

    it('requiere LOCAL y limita las capturas a A, remoto y B', () => {
        expect(() => parseReconciliationInput({ ...input(), snapshots: [snapshot('REMOTE', 'cloud')] })).toThrow();
        expect(() => parseReconciliationInput({ ...input(), snapshots: [snapshot(), snapshot('LOCAL', 'b'), snapshot('LOCAL', 'c')] })).toThrow();
        expect(() => parseReconciliationInput({ ...input(), snapshots: [snapshot(), snapshot('REMOTE', 'cloud'), snapshot('LOCAL', 'b'), snapshot('LOCAL', 'c')] })).toThrow();
        const unlabeledB = snapshot('LOCAL', 'b');
        delete (unlabeledB.source as { deviceLabel?: string }).deviceLabel;
        expect(() => parseReconciliationInput({ ...input(), snapshots: [snapshot(), unlabeledB] })).toThrow();
    });

    it('rechaza ámbito cruzado, ventanas imposibles y campos de escritura', () => {
        const wrong = snapshot();
        wrong.source.negocioId = otroNegocio;
        expect(() => parseReconciliationInput({ ...input(), snapshots: [wrong] })).toThrow();
        const time = snapshot();
        time.capture.startedAt = 200;
        expect(() => parseReconciliationInput({ ...input(), snapshots: [time] })).toThrow();
        expect(() => parseReconciliationInput({ ...input(), request: { ...input().request, repair: true } })).toThrow();
        expect(() => parseReconciliationInput({ ...input(), request: { ...input().request, asOf: 50 } })).toThrow();
    });

    it('preserva ausencia de campos históricos como unknown, sin convertirla a cero', () => {
        const value = input();
        value.snapshots[0].records.ventas.push({ id: '00000000-0000-4000-8000-000000000010', negocioId, sourceId: 'pc-a', observedAt: 101, fecha: 90, total: '100.00', metodoPago: 'efectivo', syncFlag: 0 } as never);
        const parsed = parseReconciliationInput(value);
        expect(parsed.snapshots[0].records.ventas[0].historicalTotalFactsComplete).toBeUndefined();
    });
});
