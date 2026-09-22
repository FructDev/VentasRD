import { describe, expect, it } from 'vitest';
import { twoDevices } from './fixtures/two-devices';
import { analyzeReconciliation } from './analyze';

describe('two-device acceptance', () => {
    it('A sale -> remote applied -> B behind names receive stage', () => {
        const report = analyzeReconciliation(twoDevices({ remote: 'APPLIED', b: 'ABSENT' }));
        expect(report.findings.find(f => f.code === 'DEVICE_PROPAGATION_GAP')?.stage).toBe('DEVICE_RECEIVE');
        expect(report.findings.some(f => f.code === 'SYNC_FALSE_CONFIRMED')).toBe(false);
    });
    it('no remote permission/page/order cannot assert disappearance', () => {
        for (const option of [{ remote: 'PARTIAL' as const }, { remote: 'DENIED' as const }, { remote: 'ABSENT' as const, ordered: false }]) {
            const report = analyzeReconciliation(twoDevices(option));
            expect(report.findings.some(f => f.code === 'SYNC_FALSE_CONFIRMED')).toBe(false);
            expect(report.findings.some(f => f.verificability === 'UNVERIFIABLE')).toBe(true);
        }
    });
});
