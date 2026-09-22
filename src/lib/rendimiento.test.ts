import { describe, expect, it } from 'vitest';
import { resumirMetricas, type MetricaRendimiento } from './rendimiento';

const muestra = (nombre: string, duracionMs: number, resultado: MetricaRendimiento['resultado'] = 'ok'): MetricaRendimiento => ({
    nombre, duracionMs, resultado, fecha: 1,
});

describe('resumirMetricas', () => {
    it('calcula percentiles y errores por operación', () => {
        const resumen = resumirMetricas([
            muestra('venta.total', 10),
            muestra('venta.total', 20),
            muestra('venta.total', 30, 'error'),
            muestra('sync.total', 100),
        ]);

        expect(resumen.find(r => r.nombre === 'venta.total')).toEqual({
            nombre: 'venta.total', muestras: 3, promedioMs: 20,
            p50Ms: 20, p95Ms: 30, maxMs: 30, errores: 1,
        });
        expect(resumen.find(r => r.nombre === 'sync.total')?.p95Ms).toBe(100);
    });

    it('devuelve una colección vacía sin muestras', () => {
        expect(resumirMetricas([])).toEqual([]);
    });
});

