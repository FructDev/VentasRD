import { describe, expect, it } from 'vitest';
import { id } from './fixtures/local';
import { sanitizeFindingDraft, sanitizeText } from './privacy';
import type { FindingDraft } from './types';

const secrets = {
    token: 'tok_live_super_secreto_987',
    password: 'ClaveMuyPrivada!',
    pin: '7391',
    email: 'dueno@tienda.example',
    phone: '+1 809-555-0199',
    note: 'El cliente debe dinero y vive al lado',
    imei: '490154203237518',
};

function unsafeDraft(): FindingDraft {
    return {
        code: 'SNAPSHOT_INCOMPLETE',
        severity: 'WARNING',
        category: 'UNKNOWN',
        entity: 'ventas',
        ids: { saleId: id(20) },
        sources: [`pc-${secrets.email}`],
        explanation: `token=${secrets.token}; password=${secrets.password}; PIN=${secrets.pin}; correo=${secrets.email}; teléfono=${secrets.phone}; notas=${secrets.note}; IMEI=${secrets.imei}`,
        localEvidence: [{
            sourceId: 'pc-a',
            entity: 'ventas',
            id: id(20),
            field: 'password',
            observedValue: secrets.password,
            capturedAt: 1_800_000_000_000,
            coverageStatus: 'COMPLETE',
        }],
        remoteEvidence: [{
            sourceId: 'supabase',
            entity: 'ventas',
            id: id(20),
            field: 'metodoPago',
            observedValue: `transferencia ${secrets.email} ${secrets.phone}`,
            capturedAt: 1_800_000_000_000,
            coverageStatus: 'COMPLETE',
        }],
        missingEvidence: [`nota:${secrets.note}`],
        verificability: 'UNVERIFIABLE',
        diagnosticRecommendation: `UPDATE ventas SET token='${secrets.token}' WHERE id='${id(20)}'`,
    };
}

describe('T044 — privacidad antes de serializar', () => {
    it('filtra secretos, PII, notas libres e IMEI completo de explicaciones y evidencia', () => {
        const clean = sanitizeFindingDraft(unsafeDraft());
        const serialized = JSON.stringify(clean);

        for (const value of Object.values(secrets)) expect(serialized).not.toContain(value);
        expect(serialized).toContain('[REDACTED]');
        expect(clean.localEvidence[0].field).toBeUndefined();
        expect(clean.localEvidence[0].observedValue).toBeUndefined();
        expect(clean.remoteEvidence[0].field).toBe('metodoPago');
    });

    it('sanea texto determinísticamente sin depender del reloj', () => {
        const raw = `Bearer ${secrets.token}; ${secrets.email}; ${secrets.phone}; IMEI: ${secrets.imei}`;
        expect(sanitizeText(raw)).toBe(sanitizeText(raw));
        expect(sanitizeText(raw)).not.toMatch(/dueno@|809-555|490154203237518|tok_live/);
    });
});
