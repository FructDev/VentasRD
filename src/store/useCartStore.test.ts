// Tests del dinero del carrito: subtotal, ITBIS, descuentos y precios por tier.
// En un POS un centavo mal calculado es pérdida de confianza directa.
import { describe, it, expect } from 'vitest';
import { calculateTotals, getPrecioEfectivo, useCartStore, CartItem } from './useCartStore';
import { ProductoLocal } from '@/types/database';

const producto = (over: Partial<ProductoLocal> = {}): ProductoLocal => ({
    id: 'p1', negocio_id: 'n1', nombre: 'Prueba', codigo_barras: '',
    precio_venta: 100, costo: 60, stock_actual: 10, stock_minimo: 1,
    tasa_itbis: 0.18, tipo: 'simple', ...over,
});

const item = (over: Partial<CartItem> = {}): CartItem => ({ ...producto(), cantidad: 1, ...over });

describe('calculateTotals', () => {
    it('carrito vacío = todo en cero', () => {
        expect(calculateTotals([])).toEqual({ subtotal: 0, itbis: 0, descuento: 0, total: 0 });
    });

    it('suma subtotal e ITBIS 18%', () => {
        const r = calculateTotals([item({ cantidad: 2 })]); // 2 x 100
        expect(r.subtotal).toBe(200);
        expect(r.itbis).toBeCloseTo(36, 2);
        expect(r.total).toBeCloseTo(236, 2);
    });

    it('producto exento (tasa 0) no genera ITBIS', () => {
        const r = calculateTotals([item({ tasa_itbis: 0 })]);
        expect(r.itbis).toBe(0);
        expect(r.total).toBe(100);
    });

    it('mezcla de tasas: solo el gravado aporta ITBIS', () => {
        const r = calculateTotals([
            item({ id: 'a', precio_venta: 100, tasa_itbis: 0.18 }),
            item({ id: 'b', precio_venta: 50, tasa_itbis: 0 }),
        ]);
        expect(r.subtotal).toBe(150);
        expect(r.itbis).toBeCloseTo(18, 2);
        expect(r.total).toBeCloseTo(168, 2);
    });

    it('descuento porcentual se aplica sobre el bruto (subtotal+itbis)', () => {
        const r = calculateTotals([item()], 'porcentaje', 10); // bruto 118
        expect(r.descuento).toBeCloseTo(11.8, 2);
        expect(r.total).toBeCloseTo(106.2, 2);
    });

    it('descuento en monto fijo', () => {
        const r = calculateTotals([item()], 'monto', 20);
        expect(r.descuento).toBe(20);
        expect(r.total).toBeCloseTo(98, 2);
    });

    it('descuento nunca deja el total negativo', () => {
        const r = calculateTotals([item()], 'monto', 999);
        expect(r.descuento).toBeCloseTo(118, 2); // tope: el bruto
        expect(r.total).toBe(0);
    });

    it('descuento 100% deja total en cero exacto', () => {
        const r = calculateTotals([item()], 'porcentaje', 100);
        expect(r.total).toBe(0);
    });

    it('el descuento se redondea a 2 decimales', () => {
        const r = calculateTotals([item({ precio_venta: 33.33, tasa_itbis: 0 })], 'porcentaje', 7);
        expect(r.descuento).toBe(Math.round(33.33 * 0.07 * 100) / 100);
    });
});

describe('ventas en espera', () => {
    const reset = () => useCartStore.setState({
        items: [], subtotal: 0, itbis: 0, descuento: 0, total: 0,
        tipoDescuento: 'porcentaje', valorDescuento: 0,
        clienteActivoId: null, tipoPrecios: 1, enEspera: [],
        ventaEnCursoNumero: null, ventaEnCursoEtiqueta: null,
    });

    it('pausar guarda el carrito y lo deja limpio', () => {
        reset();
        useCartStore.getState().addItem(producto());
        expect(useCartStore.getState().pausarVenta('Juan')).toBe(true);
        const s = useCartStore.getState();
        expect(s.items).toHaveLength(0);
        expect(s.total).toBe(0);
        expect(s.enEspera).toHaveLength(1);
        expect(s.enEspera[0].etiqueta).toBe('Juan');
        expect(s.enEspera[0].numero).toBe(1);
    });

    it('no pausa un carrito vacío', () => {
        reset();
        expect(useCartStore.getState().pausarVenta()).toBe(false);
    });

    it('retomar restaura ítems, cliente y totales', () => {
        reset();
        useCartStore.getState().setCliente('c1', 2);
        useCartStore.getState().addItem(producto({ precio_venta: 100, precio_2: 90 }));
        useCartStore.getState().pausarVenta(null);
        const id = useCartStore.getState().enEspera[0].id;
        useCartStore.getState().retomarVenta(id);
        const s = useCartStore.getState();
        expect(s.items).toHaveLength(1);
        expect(s.clienteActivoId).toBe('c1');
        expect(s.tipoPrecios).toBe(2);
        expect(s.total).toBeGreaterThan(0);
        expect(s.enEspera).toHaveLength(0);
    });

    it('retomar con carrito ocupado pausa el actual primero (no se pierde nada)', () => {
        reset();
        useCartStore.getState().addItem(producto({ id: 'a' }));
        useCartStore.getState().pausarVenta('Primera');
        const id = useCartStore.getState().enEspera[0].id;
        useCartStore.getState().addItem(producto({ id: 'b' }));
        useCartStore.getState().retomarVenta(id, 'Segunda');
        const s = useCartStore.getState();
        expect(s.items[0].id).toBe('a');
        expect(s.enEspera).toHaveLength(1);
        expect(s.enEspera[0].etiqueta).toBe('Segunda');
        expect(s.enEspera[0].items[0].id).toBe('b');
    });

    it('re-pausar una venta retomada conserva su número y etiqueta', () => {
        reset();
        useCartStore.getState().addItem(producto());
        useCartStore.getState().pausarVenta('Juan');       // Venta #1
        useCartStore.getState().addItem(producto({ id: 'x' }));
        useCartStore.getState().pausarVenta();             // Venta #2
        const id1 = useCartStore.getState().enEspera.find(v => v.numero === 1)!.id;
        useCartStore.getState().retomarVenta(id1);         // retoma la #1
        useCartStore.getState().pausarVenta();             // re-pausa: sigue siendo #1
        const numeros = useCartStore.getState().enEspera.map(v => v.numero).sort();
        expect(numeros).toEqual([1, 2]);
        expect(useCartStore.getState().enEspera.find(v => v.numero === 1)!.etiqueta).toBe('Juan');
    });

    it('cobrar (clearCart) limpia la identidad de la venta retomada', () => {
        reset();
        useCartStore.getState().addItem(producto());
        useCartStore.getState().pausarVenta();
        const id = useCartStore.getState().enEspera[0].id;
        useCartStore.getState().retomarVenta(id);
        useCartStore.getState().clearCart();               // venta cobrada
        useCartStore.getState().addItem(producto());
        useCartStore.getState().pausarVenta();             // venta nueva: #1 otra vez (lista vacía)
        expect(useCartStore.getState().enEspera[0].numero).toBe(1);
    });

    it('descartar elimina la venta pausada', () => {
        reset();
        useCartStore.getState().addItem(producto());
        useCartStore.getState().pausarVenta();
        const id = useCartStore.getState().enEspera[0].id;
        useCartStore.getState().descartarEnEspera(id);
        expect(useCartStore.getState().enEspera).toHaveLength(0);
    });
});

describe('getPrecioEfectivo', () => {
    const p = producto({ precio_venta: 100, precio_2: 90, precio_3: 80 });

    it('tier 1 usa el precio de menudeo', () => {
        expect(getPrecioEfectivo(p, 1)).toBe(100);
    });

    it('tier 2 y 3 usan sus precios', () => {
        expect(getPrecioEfectivo(p, 2)).toBe(90);
        expect(getPrecioEfectivo(p, 3)).toBe(80);
    });

    it('si el tier no tiene precio definido cae al de menudeo', () => {
        const sinTiers = producto({ precio_venta: 100 });
        expect(getPrecioEfectivo(sinTiers, 2)).toBe(100);
        expect(getPrecioEfectivo(sinTiers, 3)).toBe(100);
    });
});
