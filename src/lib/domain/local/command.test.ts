import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { VentaRDDatabase } from '@/lib/db/dexie';
import { canonicalCommand, commandHash, moneyCents } from './command';
import { localCommandError } from './errors';

const dbs: Dexie[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) { db.close(); await db.delete(); } });
describe('PRO-01 contrato local y compatibilidad', () => {
    it('canonical y hash son deterministas sin depender del orden de claves', () => {
        expect(canonicalCommand({ b: -0, a: [1, 2], optional: undefined })).toBe('{"a":[1,2],"b":0,"optional":null}');
        expect(commandHash({ a: [1, 2], b: 0 })).toBe(commandHash({ b: -0, a: [1, 2] }));
        expect(commandHash({ a: [2, 1], b: 0 })).not.toBe(commandHash({ a: [1, 2], b: 0 }));
        expect(() => commandHash({ a: NaN })).toThrow('command_number_invalid');
    });
    it('importe exacto conserva centavos y ruido binario, rechaza fracción real', () => {
        expect(moneyCents(0.1 + 0.2)).toBe(30);
        expect(moneyCents(129.8)).toBe(12980);
        expect(() => moneyCents(1.001)).toThrow();
        expect(() => moneyCents(-1)).toThrow();
        expect(() => moneyCents(Infinity)).toThrow();
    });
    it('mensajes UI no filtran notas, credenciales ni IDs de excepción', () => {
        expect(localCommandError(new Error('token=secret telefono=555 nota=privada'))).not.toContain('secret');
        expect(localCommandError(new Error('turno_requerido:id_privado'))).toBe('Abre la caja de esta sucursal antes de recibir efectivo.');
    });
    it('v22→v23 preserva legacy byte a byte: sin inventar journal, caja o recibo', async () => {
        const name = `PRO01_Migration_Synthetic_${crypto.randomUUID()}`;
        const old = new Dexie(name); dbs.push(old);
        old.version(22).stores({ ventas: 'id, negocio_id', productos: 'id, negocio_id', movimientos_stock: 'id, negocio_id' });
        const legacy = { id: 'legacy', negocio_id: 'qa', total: 20.001, metodo_pago: 'efectivo', estado_sincronizacion: 1, fecha_creacion: 1000 };
        const product = { id: 'p', negocio_id: 'qa', stock_actual: 1.5 };
        const movement = { id: 'm', negocio_id: 'qa', delta: -.5, estado_sincronizacion: 1 };
        await old.table('ventas').add(legacy);
        await old.table('productos').add(product);
        await old.table('movimientos_stock').add(movement);
        old.close();
        const current = new VentaRDDatabase(name); dbs.push(current);
        await current.open();
        expect(current.verno).toBe(24);
        expect(await current.ventas.get('legacy')).toEqual(legacy);
        expect(await current.productos.get('p')).toEqual(product);
        expect(await current.movimientos_stock.get('m')).toEqual(movement);
        expect(await current.operaciones_locales.count()).toBe(0);
    });
});
