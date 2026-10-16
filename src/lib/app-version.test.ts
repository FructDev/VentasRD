import { describe, expect, it } from 'vitest';
import { hasDeployUpdate } from './app-version';

describe('hasDeployUpdate', () => {
    it('detecta un deploy distinto', () => {
        expect(hasDeployUpdate('abc1234', 'def5678')).toBe(true);
    });

    it('no anuncia la misma version', () => {
        expect(hasDeployUpdate('abc1234', 'abc1234')).toBe(false);
    });

    it.each([
        ['local', 'abc1234'],
        ['abc1234', 'local'],
        ['', 'abc1234'],
        ['abc1234', ''],
    ])('no fabrica una actualizacion sin versiones comparables: %s / %s', (installed, available) => {
        expect(hasDeployUpdate(installed, available)).toBe(false);
    });
});
