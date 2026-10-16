import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { OperacionLocal } from '@/types/database';
import type { CartScope } from '@/store/useCartStore';
import { commandHash } from '@/lib/domain/local/command';

export type NcfTipo = 'B01' | 'B02';
export interface NcfContexto { negocioId: string; actorId: string; source: string; fecha: number; requestId: string }
export interface NcfSecuencia { negocio_id: string; tipo: NcfTipo; desde: number; hasta: number; proximo: number; habilitado: boolean }
export interface NcfTransport { sequence(): Promise<unknown>; reserve(): Promise<unknown> }
interface RequestFacts extends NcfContexto { version: 1; deviceId: string; cantidad: 20 }
interface Range { desde: number; hasta: number; tipo: NcfTipo }
interface Request { facts: RequestFacts; estado: 'IN_FLIGHT' | 'UNKNOWN' | 'RECEIVED' | 'NO_BLOCK' | 'ABANDONED'; range?: Range; revisadaEn?: number }
interface Block { facts: RequestFacts & Range; proximo: number }
interface Pool { facts: { negocioId: string; deviceId: string; tipo: NcfTipo; blocks: string[] } }
export interface ReservaNcf {
    facts: { version: 1; negocioId: string; sucursalId: string | null; deviceId: string; cartId: string;
        intentionHash: string; blockId: string; ncf: string; numero: number; tipo: NcfTipo };
    estado: 'PREPARED' | 'COMMITTED' | 'ABANDONED';
}
const localDeviceKey = '__LOCAL_NCF__:DEVICE:v1';
const slotKey = (tenant: string, device: string) => `${tenant}:NCF_SLOT:${device}`;
const requestKey = (tenant: string, device: string, id: string) => `${tenant}:NCF_REQUEST:${device}:${id}`;
const blockKey = (f: RequestFacts) => `${f.negocioId}:NCF_BLOCK:${f.deviceId}:${f.requestId}`;
const poolKey = (tenant: string, device: string, tipo: NcfTipo) => `${tenant}:NCF_POOL:${device}:${tipo}`;
const numberKey = (tenant: string, ncf: string) => `${tenant}:NCF_NUMBER:${ncf}`;
const watermarkKey = (tenant: string, tipo: NcfTipo) => `${tenant}:NCF_WATERMARK:${tipo}`;
const validNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 99_999_999;
const tipoValido = (v: unknown): v is NcfTipo => v === 'B01' || v === 'B02';
const integerValue = (v: unknown) => typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;

async function read<T extends { facts: unknown }>(db: VentaRDDatabase, id: string, tipo: string): Promise<T | undefined> {
    const row = await db.operaciones_locales.get(id);
    if (!row) return undefined;
    const value = row.resultado as T;
    if (row.id !== id || row.operation_id !== id || !id.startsWith(`${row.negocio_id}:`) || row.tipo !== tipo || row.contract_version !== 1 || !value?.facts || row.payload_hash !== commandHash(value.facts)) throw new Error('ncf_integridad_invalida');
    return value;
}
async function write<T extends { facts: unknown }>(db: VentaRDDatabase, id: string, tenant: string, tipo: string, result: T,
    estado: OperacionLocal['estado_local'] = 'COMMITTED', fecha = 0) {
    await db.operaciones_locales.put({ id, negocio_id: tenant, operation_id: id, tipo, contract_version: 1,
        payload_hash: commandHash(result.facts), estado_local: estado, estado_remoto: 'NOT_ENABLED', fecha_origen: fecha, resultado: result });
}
/** Identidad local técnica, no claims/Auth ni el prefijo corto del ticket. */
export async function identidadNcfLocal(db: VentaRDDatabase): Promise<string> {
    return db.transaction('rw', db.operaciones_locales, async () => {
        const old = await read<{ facts: { deviceId: string } }>(db, localDeviceKey, 'NCF_DEVICE');
        if (old) return old.facts.deviceId;
        const deviceId = crypto.randomUUID();
        await write(db, localDeviceKey, '__LOCAL_NCF__', 'NCF_DEVICE', { facts: { deviceId } });
        return deviceId;
    });
}
async function device(db: VentaRDDatabase) {
    return (await read<{ facts: { deviceId: string } }>(db, localDeviceKey, 'NCF_DEVICE'))?.facts.deviceId;
}
async function currentRequest(db: VentaRDDatabase, tenant: string, id: string): Promise<Request | undefined> {
    const slot = await read<{ facts: { requestId: string } }>(db, slotKey(tenant, id), 'NCF_SLOT');
    return slot ? read<Request>(db, requestKey(tenant, id, slot.facts.requestId), 'NCF_REQUEST') : undefined;
}
async function activeBlocks(db: VentaRDDatabase, tenant: string, id: string, tipo: NcfTipo): Promise<Block[]> {
    const pool = await read<Pool>(db, poolKey(tenant, id, tipo), 'NCF_POOL');
    if (!pool) return [];
    if (pool.facts.negocioId !== tenant || pool.facts.deviceId !== id || pool.facts.tipo !== tipo || new Set(pool.facts.blocks).size !== pool.facts.blocks.length) throw new Error('ncf_integridad_invalida');
    const blocks: Block[] = [];
    for (const key of pool.facts.blocks) {
        const b = await read<Block>(db, key, 'NCF_BLOCK');
        if (!b || key !== blockKey(b.facts) || b.facts.negocioId !== tenant || b.facts.deviceId !== id || b.facts.tipo !== tipo ||
            !validNumber(b.facts.desde) || !validNumber(b.facts.hasta) || b.facts.hasta - b.facts.desde >= 20 ||
            !Number.isSafeInteger(b.proximo) || b.proximo < b.facts.desde || b.proximo > b.facts.hasta + 1) throw new Error('ncf_integridad_invalida');
        const req = await read<Request>(db, requestKey(tenant, id, b.facts.requestId), 'NCF_REQUEST');
        if (!req || req.estado !== 'RECEIVED' || commandHash({ ...req.facts, ...req.range }) !== commandHash(b.facts)) throw new Error('ncf_procedencia_invalida');
        // Máximo 20 reads por bloque; no scan del historial de ventas/journals.
        for (let n = b.facts.desde; n < b.proximo; n++) {
            const numero = `${tipo}${String(n).padStart(8, '0')}`;
            const used = await read<ReservaNcf>(db, numberKey(tenant, numero), 'NCF_NUMBER');
            if (!used || used.facts.blockId !== key || used.facts.numero !== n) throw new Error('ncf_cursor_invalido');
        }
        blocks.push(b);
    }
    return blocks.sort((a, b) => a.facts.desde - b.facts.desde);
}
/** Solo lectura; una configuración/bloque antiguo nunca se adopta por inferencia. */
export async function estadoNcfLocal(db: VentaRDDatabase, tenant: string, tipo: NcfTipo) {
    return db.transaction('r', db.operaciones_locales, async () => {
        const id = await device(db);
        if (!id) return { deviceId: undefined, disponibles: 0, incierta: false, requestId: undefined };
        const req = await currentRequest(db, tenant, id);
        const blocks = await activeBlocks(db, tenant, id, tipo);
        return { deviceId: id, disponibles: blocks.reduce((s, b) => s + b.facts.hasta - b.proximo + 1, 0),
            proximo: blocks[0]?.proximo,
            incierta: req?.estado === 'UNKNOWN' || req?.estado === 'IN_FLIGHT', requestId: req?.facts.requestId };
    });
}
function parseSequence(raw: unknown, tenant: string): NcfSecuencia {
    const s = raw as NcfSecuencia;
    if (!s || s.negocio_id !== tenant || !tipoValido(s.tipo) || !validNumber(integerValue(s.desde)) || !validNumber(integerValue(s.hasta)) ||
        integerValue(s.hasta) < integerValue(s.desde) || !Number.isSafeInteger(integerValue(s.proximo)) || integerValue(s.proximo) < integerValue(s.desde) ||
        integerValue(s.proximo) > integerValue(s.hasta) + 1 || typeof s.habilitado !== 'boolean') throw new Error('ncf_secuencia_invalida');
    return { ...s, desde: integerValue(s.desde), hasta: integerValue(s.hasta), proximo: integerValue(s.proximo) };
}
/** Persist-before-send. No seed/upsert, RPC v1 no es idempotente: no retry de incierta. */
export async function abastecerNcfLocal(db: VentaRDDatabase, context: NcfContexto, remote: NcfTransport): Promise<NcfSecuencia | undefined> {
    context = structuredClone(context);
    if (!context.negocioId || !context.actorId || !context.requestId || !Number.isSafeInteger(context.fecha) || context.fecha <= 0 ||
        new URL(context.source).origin !== context.source || !context.source.startsWith('https://')) throw new Error('ncf_contexto_invalido');
    const id = await identidadNcfLocal(db);
    const facts: RequestFacts = { ...context, deviceId: id, version: 1, cantidad: 20 };
    const key = requestKey(context.negocioId, id, context.requestId);
    const prior = await read<Request>(db, key, 'NCF_REQUEST');
    if (prior && commandHash(prior.facts) !== commandHash(facts)) throw new Error('ncf_solicitud_conflicto');
    const raw = await remote.sequence();
    if (raw === null) return undefined; // Secuencia central ausente: no se crea automáticamente.
    const sequence = parseSequence(raw, context.negocioId);
    if (prior || !sequence.habilitado || sequence.proximo > sequence.hasta) return sequence;
    const started = await db.transaction('rw', db.operaciones_locales, async () => {
        const existing = await read<Request>(db, key, 'NCF_REQUEST');
        if (existing && commandHash(existing.facts) !== commandHash(facts)) throw new Error('ncf_solicitud_conflicto');
        if (existing) return false;
        const pending = await currentRequest(db, context.negocioId, id);
        if (pending?.estado === 'IN_FLIGHT' || pending?.estado === 'UNKNOWN') return false;
        const blocks = await activeBlocks(db, context.negocioId, id, sequence.tipo);
        if (blocks.reduce((s, b) => s + b.facts.hasta - b.proximo + 1, 0) > 5 || await db.operaciones_locales.get(key)) return false;
        await write(db, key, context.negocioId, 'NCF_REQUEST', { facts, estado: 'IN_FLIGHT' }, 'PREPARED', context.fecha);
        await write(db, slotKey(context.negocioId, id), context.negocioId, 'NCF_SLOT', { facts: { requestId: context.requestId } });
        return true;
    });
    if (!started) return sequence;
    try {
        const response = await remote.reserve();
        await db.transaction('rw', db.operaciones_locales, db.ventas, async () => {
            const req = await read<Request>(db, key, 'NCF_REQUEST');
            if (!req || req.estado === 'ABANDONED') return; // Respuesta tardía no revive intento abandonado.
            if (response === null) {
                await write(db, key, context.negocioId, 'NCF_REQUEST', { facts, estado: 'NO_BLOCK' }, 'COMMITTED', context.fecha);
                return;
            }
            const b = response as { bloque_desde: unknown; bloque_hasta: unknown; tipo: unknown };
            const range: Range = { desde: integerValue(b?.bloque_desde), hasta: integerValue(b?.bloque_hasta), tipo: b?.tipo as NcfTipo };
            if (!validNumber(range.desde) || !validNumber(range.hasta) || range.hasta < range.desde || range.hasta - range.desde >= 20 ||
                range.tipo !== sequence.tipo || range.desde < sequence.proximo || range.hasta > sequence.hasta) throw new Error('ncf_respuesta_invalida');
            const water = await read<{ facts: { last: number } }>(db, watermarkKey(context.negocioId, range.tipo), 'NCF_WATERMARK');
            if (water && range.desde <= water.facts.last) throw new Error('ncf_rango_solapado');
            for (let n = range.desde; n <= range.hasta; n++) {
                const ncf = `${range.tipo}${String(n).padStart(8, '0')}`;
                if (await db.operaciones_locales.get(numberKey(context.negocioId, ncf)) ||
                    await db.ventas.where('ncf').equals(ncf).filter(v => v.negocio_id === context.negocioId).count()) throw new Error('ncf_rango_solapado');
            }
            const origin = { ...facts, ...range };
            const pool = await read<Pool>(db, poolKey(context.negocioId, id, range.tipo), 'NCF_POOL');
            await write(db, blockKey(facts), context.negocioId, 'NCF_BLOCK', { facts: origin, proximo: range.desde }, 'COMMITTED', context.fecha);
            await write(db, poolKey(context.negocioId, id, range.tipo), context.negocioId, 'NCF_POOL', {
                facts: { negocioId: context.negocioId, deviceId: id, tipo: range.tipo, blocks: [...pool?.facts.blocks ?? [], blockKey(facts)] } });
            await write(db, watermarkKey(context.negocioId, range.tipo), context.negocioId, 'NCF_WATERMARK', { facts: { last: range.hasta } });
            await write(db, key, context.negocioId, 'NCF_REQUEST', { facts, estado: 'RECEIVED', range }, 'COMMITTED', context.fecha);
        });
    } catch {
        await db.transaction('rw', db.operaciones_locales, async () => {
            const req = await read<Request>(db, key, 'NCF_REQUEST');
            if (req?.estado === 'IN_FLIGHT') await write(db, key, context.negocioId, 'NCF_REQUEST', { facts, estado: 'UNKNOWN' }, 'PREPARED', context.fecha);
        });
    }
    const completed = await read<Request>(db, key, 'NCF_REQUEST');
    return completed?.estado === 'RECEIVED' && completed.range
        ? { ...sequence, proximo: Math.max(sequence.proximo, completed.range.hasta + 1) } : sequence;
}
/** Acción explícita: no devuelve el rango remoto ni cambia una secuencia. */
export async function abandonarSolicitudNcf(db: VentaRDDatabase, tenant: string, requestId: string, fecha: number) {
    if (!Number.isSafeInteger(fecha) || fecha <= 0) throw new Error('ncf_contexto_invalido');
    await db.transaction('rw', db.operaciones_locales, async () => {
        const id = await device(db);
        if (!id) throw new Error('ncf_dispositivo_invalido');
        const key = requestKey(tenant, id, requestId);
        const req = await read<Request>(db, key, 'NCF_REQUEST');
        if (!req || !['IN_FLIGHT', 'UNKNOWN', 'ABANDONED'].includes(req.estado)) throw new Error('ncf_solicitud_no_incierta');
        if (req.estado === 'ABANDONED') return;
        await write(db, key, tenant, 'NCF_REQUEST', { ...req, estado: 'ABANDONED', revisadaEn: fecha }, 'ABANDONED', req.facts.fecha);
    });
}
/** Ejecutar solo dentro de la transacción del checkout, nunca con red. */
export async function reservarNcfEn(db: VentaRDDatabase, scope: CartScope, cartId: string, hash: string, tipo: NcfTipo, deviceId: string): Promise<ReservaNcf> {
    if (!tipoValido(tipo) || !deviceId || await device(db) !== deviceId) throw new Error('ncf_dispositivo_invalido');
    const blocks = await activeBlocks(db, scope.negocioId, deviceId, tipo);
    const b = blocks.find(b => b.proximo <= b.facts.hasta);
    if (!b) throw new Error('ncf_no_disponible');
    const ncf = `${tipo}${String(b.proximo).padStart(8, '0')}`;
    if (await db.operaciones_locales.get(numberKey(scope.negocioId, ncf)) ||
        await db.ventas.where('ncf').equals(ncf).filter(v => v.negocio_id === scope.negocioId).count()) throw new Error('ncf_numero_ocupado');
    const result: ReservaNcf = { facts: { version: 1, negocioId: scope.negocioId, sucursalId: scope.sucursalId,
        deviceId, cartId, intentionHash: hash, blockId: blockKey(b.facts), ncf, numero: b.proximo, tipo }, estado: 'PREPARED' };
    await write(db, numberKey(scope.negocioId, ncf), scope.negocioId, 'NCF_NUMBER', result, 'PREPARED', b.facts.fecha);
    await write(db, blockKey(b.facts), scope.negocioId, 'NCF_BLOCK', { ...b, proximo: b.proximo + 1 }, 'COMMITTED', b.facts.fecha);
    if (b.proximo === b.facts.hasta) {
        const pool = await read<Pool>(db, poolKey(scope.negocioId, deviceId, tipo), 'NCF_POOL');
        if (!pool) throw new Error('ncf_integridad_invalida');
        await write(db, poolKey(scope.negocioId, deviceId, tipo), scope.negocioId, 'NCF_POOL', {
            facts: { ...pool.facts, blocks: pool.facts.blocks.filter(id => id !== blockKey(b.facts)) } });
    }
    return result;
}
export async function verificarReservaNcf(db: VentaRDDatabase, expected: ReservaNcf, scope: CartScope, cartId: string, hash: string, ncf: string | undefined) {
    const row = await read<ReservaNcf>(db, numberKey(scope.negocioId, expected.facts.ncf), 'NCF_NUMBER');
    const block = await read<Block>(db, expected.facts.blockId, 'NCF_BLOCK');
    if (block) {
        const req = await read<Request>(db, requestKey(scope.negocioId, block.facts.deviceId, block.facts.requestId), 'NCF_REQUEST');
        if (!req || req.estado !== 'RECEIVED' || commandHash({ ...req.facts, ...req.range }) !== commandHash(block.facts)) throw new Error('ncf_procedencia_invalida');
    }
    if (!row || commandHash(row) !== commandHash(expected) || !block || row.facts.negocioId !== scope.negocioId ||
        row.facts.sucursalId !== scope.sucursalId || row.facts.cartId !== cartId || row.facts.intentionHash !== hash ||
        row.facts.ncf !== ncf || row.facts.deviceId !== block.facts.deviceId || block.facts.negocioId !== scope.negocioId ||
        block.facts.tipo !== row.facts.tipo || row.facts.ncf !== `${row.facts.tipo}${String(row.facts.numero).padStart(8, '0')}` ||
        row.facts.numero < block.facts.desde || row.facts.numero >= block.proximo || row.facts.numero > block.facts.hasta) throw new Error('ncf_reserva_invalida');
    return row;
}
export async function finalizarReservaNcfEn(db: VentaRDDatabase, row: ReservaNcf, estado: ReservaNcf['estado']): Promise<ReservaNcf> {
    const result = { ...row, estado };
    const key = numberKey(row.facts.negocioId, row.facts.ncf);
    const previous = await db.operaciones_locales.get(key);
    if (!previous) throw new Error('ncf_reserva_invalida');
    await write(db, key, row.facts.negocioId, 'NCF_NUMBER', result, estado, previous.fecha_origen);
    return result;
}
