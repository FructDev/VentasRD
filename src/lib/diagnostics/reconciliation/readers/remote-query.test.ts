import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readRemotePage } from './remote-query';
import { branch, id, tenant } from '../fixtures/local';

describe('remote SELECT projection and tenant scope', () => {
    it('uses only SELECT, filters tenant/branch/ID, and never calls RPC or write methods', async () => {
        const calls: [string, ...unknown[]][] = [];
        const builder: Record<string, (...args: unknown[]) => unknown> = {};
        for (const name of ['select', 'eq', 'gte', 'lte', 'order']) builder[name] = (...args: unknown[]) => { calls.push([name, ...args]); return builder; };
        builder.range = async (...args: unknown[]) => { calls.push(['range', ...args]); return { data: [{ id: id(30), negocio_id: tenant, sucursal_id: branch, producto_id: id(10), delta: -1, valor_absoluto: null, tipo: 'venta', referencia_id: id(20), fecha_creacion: 100 }], error: null }; };
        const writes = { rpc: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), upsert: vi.fn() };
        const client = { from: vi.fn(() => ({ ...builder, ...Object.fromEntries(Object.entries(writes).filter(([key]) => key !== 'rpc')) })), rpc: writes.rpc } as unknown as SupabaseClient;
        // The fluent mock must return itself after each allowed builder method.
        (client.from as ReturnType<typeof vi.fn>).mockImplementation(() => builder);
        const result = await readRemotePage({ negocioId: tenant, sucursalId: branch, entity: 'movimientosStock', id: id(30), asOf: 200, limit: 20, offset: 0, token: 'session' }, client);
        expect(client.from).toHaveBeenCalledWith('movimientos_stock');
        expect(calls).toContainEqual(['eq', 'negocio_id', tenant]);
        expect(calls).toContainEqual(['eq', 'sucursal_id', branch]);
        expect(calls).toContainEqual(['eq', 'id', id(30)]);
        expect(calls.find(c => c[0] === 'select')?.[1]).toBe('id,negocio_id,sucursal_id,producto_id,delta,valor_absoluto,tipo,referencia_id,fecha_creacion');
        expect(result.records[0]).toMatchObject({ negocioId: tenant, sucursalId: branch, productoId: id(10), delta: '-1' });
        Object.values(writes).forEach(fn => expect(fn).not.toHaveBeenCalled());
    });
    it('rejects a row outside the verified business even if a data source misbehaves', async () => {
        const builder: Record<string, (...args: unknown[]) => unknown> = {};
        for (const name of ['select', 'eq', 'order']) builder[name] = () => builder;
        builder.range = async () => ({ data: [{ id: id(20), negocio_id: id(99) }], error: null });
        const client = { from: () => builder } as unknown as SupabaseClient;
        await expect(readRemotePage({ negocioId: tenant, entity: 'ventas', id: id(20), asOf: 200, limit: 20, offset: 0, token: 'session' }, client)).rejects.toThrow('REMOTE_SCOPE_UNVERIFIED');
    });
});
