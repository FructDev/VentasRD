// Tests del motor de insights del Asistente del Negocio.
import { describe, it, expect } from 'vitest';
import { generarInsights, DatosAsistente } from './asistente';

const DIA = 24 * 60 * 60 * 1000;
const AHORA = new Date('2026-07-15T12:00:00').getTime(); // miércoles

const base = (over: Partial<DatosAsistente> = {}): DatosAsistente => ({
    ventas: [], detalles: [], productos: [], clientes: [], transacciones: [],
    ahora: AHORA, ...over,
});

describe('generarInsights', () => {
    it('sin datos no inventa nada', () => {
        expect(generarInsights(base())).toEqual([]);
    });

    it('compara ayer contra el mismo día de la semana pasada', () => {
        const d = base({
            ventas: [
                { total: 1220, fecha_creacion: AHORA - DIA },        // ayer (martes)
                { total: 1000, fecha_creacion: AHORA - 8 * DIA },    // martes pasado
            ],
        });
        const ins = generarInsights(d);
        const ventas = ins.find(i => i.tipo === 'ventas')!;
        expect(ventas.texto).toContain('22% más');
        expect(ventas.emoji).toBe('📈');
    });

    it('no reporta comparación con cambios menores al 10%', () => {
        const d = base({
            ventas: [
                { total: 1050, fecha_creacion: AHORA - DIA },
                { total: 1000, fecha_creacion: AHORA - 8 * DIA },
            ],
        });
        expect(generarInsights(d).filter(i => i.tipo === 'ventas' && i.texto.includes('%'))).toHaveLength(0);
    });

    it('detecta productos por agotarse según su velocidad de venta', () => {
        const d = base({
            productos: [{ id: 'p1', nombre: 'Aceite 1L', stock_actual: 4, tipo: 'simple' }],
            // 14 unidades en 14 días = 1/día → 4 de stock = ~4 días
            detalles: Array.from({ length: 14 }, (_, i) => ({ producto_id: 'p1', cantidad: 1, fecha_creacion: AHORA - i * DIA })),
        });
        const stock = generarInsights(d).find(i => i.tipo === 'stock')!;
        expect(stock.texto).toContain('Aceite 1L');
        expect(stock.texto).toMatch(/~4 días/);
        expect(stock.prioridad).toBe(1); // lo más urgente
    });

    it('no pronostica productos sin velocidad real de venta', () => {
        const d = base({
            productos: [{ id: 'p1', nombre: 'Lento', stock_actual: 1, tipo: 'simple' }],
            detalles: [{ producto_id: 'p1', cantidad: 1, fecha_creacion: AHORA - DIA }], // solo 1 venta
        });
        expect(generarInsights(d).filter(i => i.tipo === 'stock')).toHaveLength(0);
    });

    it('detecta fiados fríos (30+ días sin movimiento y deuda viva)', () => {
        const d = base({
            clientes: [{ id: 'c1', nombre: 'Juan Pérez' }],
            transacciones: [
                { cliente_id: 'c1', tipo: 'cargo', monto: 3450, fecha_creacion: AHORA - 45 * DIA },
            ],
        });
        const fiado = generarInsights(d).find(i => i.tipo === 'fiados')!;
        expect(fiado.texto).toContain('Juan Pérez');
        expect(fiado.texto).toContain('45 días');
    });

    it('un cliente que abonó recientemente NO es fiado frío', () => {
        const d = base({
            clientes: [{ id: 'c1', nombre: 'María' }],
            transacciones: [
                { cliente_id: 'c1', tipo: 'cargo', monto: 2000, fecha_creacion: AHORA - 60 * DIA },
                { cliente_id: 'c1', tipo: 'abono', monto: 500, fecha_creacion: AHORA - 5 * DIA },
            ],
        });
        expect(generarInsights(d).filter(i => i.tipo === 'fiados')).toHaveLength(0);
    });

    it('deuda saldada no genera insight', () => {
        const d = base({
            clientes: [{ id: 'c1', nombre: 'Pedro' }],
            transacciones: [
                { cliente_id: 'c1', tipo: 'cargo', monto: 1000, fecha_creacion: AHORA - 90 * DIA },
                { cliente_id: 'c1', tipo: 'abono', monto: 1000, fecha_creacion: AHORA - 80 * DIA },
            ],
        });
        expect(generarInsights(d).filter(i => i.tipo === 'fiados')).toHaveLength(0);
    });

    it('identifica el mejor día de la semana con historial suficiente', () => {
        // 4 semanas: sábados venden 5000, resto 1000
        const ventas: DatosAsistente['ventas'] = [];
        for (let i = 1; i <= 27; i++) {
            const fecha = AHORA - i * DIA;
            const total = new Date(fecha).getDay() === 6 ? 5000 : 1000;
            ventas.push({ total, fecha_creacion: fecha });
        }
        const patron = generarInsights(base({ ventas })).find(i => i.tipo === 'patron')!;
        expect(patron.texto).toContain('sábado');
    });

    it('productos estancados solo con historial y 3+ productos parados', () => {
        const d = base({
            ventas: [{ total: 100, fecha_creacion: AHORA - 25 * DIA }], // hay historial
            productos: [
                { id: 'a', nombre: 'Funda roja', stock_actual: 5, tipo: 'simple' },
                { id: 'b', nombre: 'Funda azul', stock_actual: 3, tipo: 'simple' },
                { id: 'c', nombre: 'Mica vieja', stock_actual: 8, tipo: 'simple' },
            ],
            detalles: [],
        });
        const est = generarInsights(d).find(i => i.tipo === 'estancado')!;
        expect(est.texto).toContain('3 productos');
    });

    it('los insights salen ordenados por prioridad (stock urgente primero)', () => {
        const d = base({
            ventas: [
                { total: 2000, fecha_creacion: AHORA - DIA },
                { total: 1000, fecha_creacion: AHORA - 8 * DIA },
            ],
            productos: [{ id: 'p1', nombre: 'Aceite', stock_actual: 2, tipo: 'simple' }],
            detalles: Array.from({ length: 14 }, (_, i) => ({ producto_id: 'p1', cantidad: 1, fecha_creacion: AHORA - i * DIA })),
        });
        const ins = generarInsights(d);
        expect(ins[0].tipo).toBe('stock');
    });
});
