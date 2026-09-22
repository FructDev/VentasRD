import { describe, expect, it } from 'vitest';
import { analyzeLocalSync } from './local-sync';
import { asOf, baseInput, baseSnapshot, movement, product } from '../fixtures/local';

describe('estado local de sincronización', () => {
    it('sync=0 es pendiente normal sin conectividad; nunca aplicado remoto', () => {
        const snapshot = baseSnapshot({ movimientosStock: [movement()] });
        const findings = analyzeLocalSync(snapshot, baseInput(snapshot).request);
        expect(findings.some(f => f.code === 'SYNC_PENDING' && f.interpretedSyncState === 'PENDING')).toBe(true);
        expect(findings.some(f => f.interpretedSyncState === 'APPLIED_VERIFIED')).toBe(false);
    });
    it('pendiente vencido exige asOf y conectividad observada', () => {
        const old = { ...movement(), fecha: asOf - 600_000 };
        const offline = baseSnapshot({ movimientosStock: [old] });
        expect(analyzeLocalSync(offline, baseInput(offline).request).some(f => f.code === 'SYNC_PENDING_AGED')).toBe(false);
        const online = { ...offline, capture: { ...offline.capture, connectivityObserved: true } };
        expect(analyzeLocalSync(online, baseInput(online).request).some(f => f.code === 'SYNC_PENDING_AGED' && f.severity === 'WARNING')).toBe(true);
    });
    it('sync=1 sin nube permanece UNKNOWN, no APPLIED_VERIFIED', () => {
        const snapshot = baseSnapshot({ movimientosStock: [{ ...movement(), syncFlag: 1 }] });
        const findings = analyzeLocalSync(snapshot, baseInput(snapshot).request);
        expect(findings.some(f => f.interpretedSyncState === 'UNKNOWN' && f.verificability === 'UNVERIFIABLE')).toBe(true);
        expect(findings.some(f => f.interpretedSyncState === 'APPLIED_VERIFIED')).toBe(false);
    });
    it('edición perdida exige versiones comparables; sin historia es no verificable', () => {
        const p = { ...product(), syncFlag: 0 as const, pendingEditEvidence: { intendedValue: '7', priorValue: '4', currentValue: '4', versionComparable: true } };
        const proved = baseSnapshot({ productos: [p] });
        expect(analyzeLocalSync(proved, baseInput(proved).request).some(f => f.code === 'PRODUCT_PENDING_EDIT_CONFLICT' && f.severity === 'CRITICAL')).toBe(true);
        const uncertain = baseSnapshot({ productos: [{ ...p, pendingEditEvidence: { ...p.pendingEditEvidence, versionComparable: false } }] });
        expect(analyzeLocalSync(uncertain, baseInput(uncertain).request).some(f => f.code === 'PRODUCT_PENDING_EDIT_CONFLICT' && f.verificability === 'UNVERIFIABLE')).toBe(true);
    });
});
