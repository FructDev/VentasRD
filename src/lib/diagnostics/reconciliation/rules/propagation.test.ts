import { describe, expect, it } from 'vitest';
import { twoDevices, isolatedLastUnit } from '../fixtures/two-devices';
import { analyzeReconciliation } from '../analyze';

describe('US2 propagation evidence', () => {
    it('reports the first stopped stage while sync=0 is pending upload', () => {
        const report = analyzeReconciliation(twoDevices({ syncFlag: 0, remote: 'ABSENT' }));
        expect(report.findings.some(f => f.code === 'SYNC_PENDING' && f.stage === 'UPLOAD')).toBe(true);
        expect(report.findings.some(f => f.code === 'SYNC_FALSE_CONFIRMED')).toBe(false);
    });
    it('calls sync=1 falsely confirmed only with complete authorized ordered remote absence', () => {
        const report = analyzeReconciliation(twoDevices({ remote: 'ABSENT' }));
        expect(report.findings.find(f => f.code === 'SYNC_FALSE_CONFIRMED')).toMatchObject({ severity: 'CRITICAL', stage: 'REMOTE_APPLY', interpretedSyncState: 'FALSE_CONFIRMED' });
    });
    it.each(['PARTIAL', 'DENIED'] as const)('keeps remote %s unverified', remote => {
        const report = analyzeReconciliation(twoDevices({ remote }));
        expect(report.findings.some(f => f.code === 'SYNC_FALSE_CONFIRMED')).toBe(false);
        expect(report.findings.some(f => f.code === 'SYNC_REMOTE_UNVERIFIABLE' && f.stage === 'REMOTE_APPLY' && f.interpretedSyncState === 'UNKNOWN')).toBe(true);
    });
    it('requires causal capture ordering despite skewed PC clocks', () => {
        const report = analyzeReconciliation(twoDevices({ remote: 'ABSENT', ordered: false, skewedClocks: true }));
        expect(report.findings.some(f => f.code === 'SYNC_FALSE_CONFIRMED')).toBe(false);
    });
    it('identifies B receive gap after remote applied, independent of clock skew', () => {
        const report = analyzeReconciliation(twoDevices({ remote: 'APPLIED', b: 'ABSENT', skewedClocks: true }));
        expect(report.findings.find(f => f.code === 'DEVICE_PROPAGATION_GAP')).toMatchObject({ stage: 'DEVICE_RECEIVE' });
    });
    it('keeps two isolated last-unit sales as a risk, not proved loss', () => {
        const report = analyzeReconciliation(isolatedLastUnit());
        expect(report.findings.find(f => f.code === 'DEVICE_PROPAGATION_GAP')?.severity).not.toBe('CRITICAL');
    });
    it('does not elevate an unversioned pending edit to proven loss', () => {
        const input = twoDevices({ remote: 'APPLIED' });
        input.snapshots[0].records.productos[0].syncFlag = 0;
        input.snapshots[0].records.productos[0].pendingEditEvidence = { priorValue: '5', intendedValue: '4', currentValue: '5', versionComparable: false };
        const report = analyzeReconciliation(input);
        expect(report.findings.filter(f => f.code === 'PRODUCT_PENDING_EDIT_CONFLICT').every(f => f.severity !== 'CRITICAL')).toBe(true);
    });
});
