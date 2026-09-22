import { describe, expect, it } from 'vitest';
import { effectiveCoverage, canProveAbsence } from './coverage';
import type { Coverage } from './types';

const base: Coverage = { entity: 'movimientosStock', scope: { negocioId: 'tenant', desde: 0, hasta: 100 }, status: 'COMPLETE', startedAt: 100, finishedAt: 101, rowsRead: 0, pagesRead: 1, exhausted: true, concurrentChangePossible: false };

describe('cobertura conservadora', () => {
    it('solo prueba ausencia dentro del alcance completo y agotado', () => {
        expect(canProveAbsence(base, { negocioId: 'tenant', fecha: 50 })).toBe(true);
        expect(canProveAbsence(base, { negocioId: 'other', fecha: 50 })).toBe(false);
        expect(canProveAbsence(base, { negocioId: 'tenant', fecha: 150 })).toBe(false);
    });
    it('degrada página incompleta, retención y cambio concurrente', () => {
        expect(effectiveCoverage({ ...base, exhausted: false })).toBe('PARTIAL');
        expect(effectiveCoverage({ ...base, retentionHorizon: 30 })).toBe('PARTIAL');
        expect(effectiveCoverage({ ...base, concurrentChangePossible: true })).toBe('PARTIAL');
        expect(canProveAbsence({ ...base, exhausted: false }, { negocioId: 'tenant', fecha: 50 })).toBe(false);
    });
    it('no convierte falta de permiso o lectura fallida en cero filas', () => {
        expect(effectiveCoverage({ ...base, status: 'DENIED' })).toBe('DENIED');
        expect(effectiveCoverage({ ...base, status: 'UNAVAILABLE' })).toBe('UNAVAILABLE');
        expect(canProveAbsence({ ...base, status: 'DENIED' }, { negocioId: 'tenant', fecha: 50 })).toBe(false);
    });
});
