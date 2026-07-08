// Tests de la secuencia NCF: nunca debe repetir ni saltarse números,
// y debe agotar los bloques reservados en orden.
import { describe, it, expect, beforeEach } from 'vitest';
import { useConfigStore, NCF_DEFAULT } from './useConfigStore';
import { firmarAcceso } from '@/lib/firmaAcceso';

const setNcf = (ncf: Partial<typeof NCF_DEFAULT>) =>
    useConfigStore.setState({ ncf: { ...NCF_DEFAULT, ...ncf } });

describe('consumirNcf', () => {
    beforeEach(() => setNcf({}));

    it('deshabilitado devuelve null', () => {
        setNcf({ habilitado: false });
        expect(useConfigStore.getState().consumirNcf()).toBeNull();
    });

    it('consume del bloque reservado en orden y formatea B02+8 dígitos', () => {
        setNcf({ habilitado: true, tipo: 'B02', sembrado: true, bloques: [{ desde: 1, hasta: 3, proximo: 1 }] });
        const { consumirNcf } = useConfigStore.getState();
        expect(consumirNcf()).toBe('B0200000001');
        expect(consumirNcf()).toBe('B0200000002');
        expect(consumirNcf()).toBe('B0200000003');
        // Bloque agotado y sin más bloques → null (requiere reservar online)
        expect(consumirNcf()).toBeNull();
    });

    it('salta a un segundo bloque cuando el primero se agota', () => {
        setNcf({
            habilitado: true, tipo: 'B02', sembrado: true,
            bloques: [{ desde: 1, hasta: 1, proximo: 1 }, { desde: 10, hasta: 11, proximo: 10 }],
        });
        const { consumirNcf } = useConfigStore.getState();
        expect(consumirNcf()).toBe('B0200000001');
        expect(consumirNcf()).toBe('B0200000010');
        expect(consumirNcf()).toBe('B0200000011');
        expect(consumirNcf()).toBeNull();
    });

    it('modo legado (sin sembrar): consume desde-hasta sin repetir', () => {
        setNcf({ habilitado: true, tipo: 'B01', sembrado: false, desde: 5, hasta: 6, actual: 0 });
        const { consumirNcf } = useConfigStore.getState();
        expect(consumirNcf()).toBe('B0100000005');
        expect(consumirNcf()).toBe('B0100000006');
        expect(consumirNcf()).toBeNull(); // rango agotado
    });

    it('modo legado continúa desde el último emitido', () => {
        setNcf({ habilitado: true, tipo: 'B02', sembrado: false, desde: 1, hasta: 100, actual: 42 });
        expect(useConfigStore.getState().consumirNcf()).toBe('B0200000043');
    });

    it('nunca emite el mismo número dos veces (bloques)', () => {
        setNcf({ habilitado: true, tipo: 'B02', sembrado: true, bloques: [{ desde: 1, hasta: 50, proximo: 1 }] });
        const emitidos = new Set<string>();
        for (let i = 0; i < 50; i++) {
            const n = useConfigStore.getState().consumirNcf();
            expect(n).not.toBeNull();
            expect(emitidos.has(n!)).toBe(false);
            emitidos.add(n!);
        }
        expect(emitidos.size).toBe(50);
    });
});

describe('firmarAcceso (integridad anti-edición)', () => {
    const base = { negocioId: 'n1', accesoHasta: 1000, trialHasta: null, planActivo: true, ultimaFechaVista: 500, aperturasSinServidor: 3 };

    it('es determinista', () => {
        expect(firmarAcceso(base)).toBe(firmarAcceso({ ...base }));
    });

    it('cambia si editan accesoHasta (el ataque típico)', () => {
        expect(firmarAcceso({ ...base, accesoHasta: 9999999999999 })).not.toBe(firmarAcceso(base));
    });

    it('cambia si editan planActivo, la marca de agua o el contador', () => {
        expect(firmarAcceso({ ...base, planActivo: false })).not.toBe(firmarAcceso(base));
        expect(firmarAcceso({ ...base, ultimaFechaVista: 1 })).not.toBe(firmarAcceso(base));
        expect(firmarAcceso({ ...base, aperturasSinServidor: 0 })).not.toBe(firmarAcceso(base));
    });

    it('cambia si la usan con otro negocio', () => {
        expect(firmarAcceso({ ...base, negocioId: 'n2' })).not.toBe(firmarAcceso(base));
    });
});

describe('contador de aperturas sin servidor', () => {
    it('incrementa por apertura y se resetea con contacto al servidor', () => {
        useConfigStore.setState({ aperturasSinServidor: 0 });
        useConfigStore.getState().registrarApertura();
        useConfigStore.getState().registrarApertura();
        expect(useConfigStore.getState().aperturasSinServidor).toBe(2);
        useConfigStore.getState().resetAperturasServidor();
        expect(useConfigStore.getState().aperturasSinServidor).toBe(0);
    });
});
