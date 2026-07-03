// Tests de utilidades de dinero, tickets, stock y PIN.
import { describe, it, expect } from 'vitest';
import { formatDOP, formatTicket, getEstadoStock, calcularITBIS, hashPin, verificarPin } from './utils';
import { telefonoWa, linkWhatsApp } from './whatsapp';
import { generarCodigoReferido } from './referidos';

describe('formatDOP', () => {
    it('formatea con 2 decimales', () => {
        expect(formatDOP(1500)).toMatch(/RD\$1[,.]500\.00/);
    });
    it('redondea a 2 decimales', () => {
        expect(formatDOP(9.999)).toBe('RD$10.00');
    });
});

describe('formatTicket', () => {
    it('con caja: PREFIJO-00042', () => {
        expect(formatTicket(42, 'C7K')).toBe('C7K-00042');
    });
    it('legado sin caja: 00042', () => {
        expect(formatTicket(42)).toBe('00042');
    });
    it('sin número: placeholder', () => {
        expect(formatTicket()).toBe('-----');
    });
});

describe('getEstadoStock', () => {
    it('0 o negativo = crítico', () => {
        expect(getEstadoStock(0, 5)).toBe('critico');
        expect(getEstadoStock(-1, 5)).toBe('critico');
    });
    it('igual o bajo el mínimo = bajo', () => {
        expect(getEstadoStock(5, 5)).toBe('bajo');
        expect(getEstadoStock(3, 5)).toBe('bajo');
    });
    it('sobre el mínimo = ok', () => {
        expect(getEstadoStock(6, 5)).toBe('ok');
    });
});

describe('calcularITBIS', () => {
    it('18% de 100 = 18', () => {
        expect(calcularITBIS(100, 0.18)).toBeCloseTo(18, 10);
    });
    it('tasa 0 = 0', () => {
        expect(calcularITBIS(100, 0)).toBe(0);
    });
});

describe('PIN', () => {
    it('hash es sha-256 hex de 64 chars y determinista', async () => {
        const h1 = await hashPin('1234');
        const h2 = await hashPin('1234');
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });
    it('verifica PIN legado en texto plano (4 dígitos)', async () => {
        expect(await verificarPin('1234', '1234')).toBe(true);
        expect(await verificarPin('9999', '1234')).toBe(false);
    });
    it('verifica PIN hasheado', async () => {
        const h = await hashPin('4321');
        expect(await verificarPin('4321', h)).toBe(true);
        expect(await verificarPin('1111', h)).toBe(false);
    });
    it('PIN almacenado vacío nunca verifica', async () => {
        expect(await verificarPin('1234', '')).toBe(false);
    });
});

describe('telefonoWa (normalización RD)', () => {
    it('10 dígitos → antepone el 1', () => {
        expect(telefonoWa('809-555-1234')).toBe('18095551234');
    });
    it('11 dígitos con 1 → se queda igual', () => {
        expect(telefonoWa('1 (829) 555-1234')).toBe('18295551234');
    });
    it('vacío o null → cadena vacía', () => {
        expect(telefonoWa('')).toBe('');
        expect(telefonoWa(null)).toBe('');
        expect(telefonoWa(undefined)).toBe('');
    });
    it('linkWhatsApp sin teléfono abre el selector', () => {
        expect(linkWhatsApp('hola')).toBe('https://wa.me/?text=hola');
    });
    it('linkWhatsApp con teléfono apunta al destinatario y codifica el texto', () => {
        expect(linkWhatsApp('hola mundo', '8095551234')).toBe('https://wa.me/18095551234?text=hola%20mundo');
    });
});

describe('generarCodigoReferido', () => {
    it('formato REF-XXXXX sin caracteres ambiguos', () => {
        for (let i = 0; i < 50; i++) {
            expect(generarCodigoReferido()).toMatch(/^REF-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
        }
    });
});
