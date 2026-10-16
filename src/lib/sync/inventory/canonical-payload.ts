import type { InventoryOperationPayload } from './contract';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_INPUT_PATTERN = /^[+-]?\d+$/;
const POSTGRES_INT4_MIN = BigInt(-2_147_483_648);
const POSTGRES_INT4_MAX = BigInt(2_147_483_647);

/** Normaliza sin redondear; la salida siempre cumple `^-?(0|[1-9][0-9]*)$`. */
export function normalizeInventoryInteger(input: string | number): string {
    if (typeof input === 'number' && !Number.isSafeInteger(input)) {
        throw new Error('inventory_integer_invalid');
    }
    const raw = String(input).trim();
    if (!INTEGER_INPUT_PATTERN.test(raw)) throw new Error('inventory_integer_invalid');
    let value: bigint;
    try {
        value = BigInt(raw);
    } catch {
        throw new Error('inventory_integer_invalid');
    }
    if (value < POSTGRES_INT4_MIN || value > POSTGRES_INT4_MAX) {
        throw new Error('inventory_integer_invalid');
    }
    return value === BigInt(0) ? '0' : value.toString();
}

export function isInventoryInt4(input: unknown): input is number {
    if (typeof input !== 'number') return false;
    try {
        normalizeInventoryInteger(input);
        return true;
    } catch {
        return false;
    }
}

function assertUuid(value: string | null, code: string, nullable = false): void {
    if (value === null && nullable) return;
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error(code);
}

export function normalizeInventoryPayload(payload: InventoryOperationPayload): InventoryOperationPayload {
    if (payload.version !== 2) throw new Error('inventory_contract_version_invalid');
    assertUuid(payload.operationId, 'inventory_operation_id_invalid');
    assertUuid(payload.negocioId, 'inventory_negocio_id_invalid');
    assertUuid(payload.sucursalId, 'inventory_sucursal_id_invalid', true);
    assertUuid(payload.productoId, 'inventory_producto_id_invalid');
    if (payload.referenciaId !== null) assertUuid(payload.referenciaId, 'inventory_referencia_id_invalid');
    if (!Number.isSafeInteger(payload.fechaOrigen) || payload.fechaOrigen <= 0) {
        throw new Error('inventory_fecha_origen_invalid');
    }
    if (payload.effect.kind === 'ABSOLUTE' && payload.expectedRemoteSequence === null) {
        throw new Error('inventory_absolute_sequence_required');
    }
    if (payload.expectedRemoteSequence !== null && !/^\d+$/.test(payload.expectedRemoteSequence)) {
        throw new Error('inventory_expected_sequence_invalid');
    }
    return {
        version: 2,
        operationId: payload.operationId,
        negocioId: payload.negocioId,
        sucursalId: payload.sucursalId,
        productoId: payload.productoId,
        effect: { kind: payload.effect.kind, value: normalizeInventoryInteger(payload.effect.value) },
        tipo: payload.tipo,
        referenciaId: payload.referenciaId,
        fechaOrigen: payload.fechaOrigen,
        expectedRemoteSequence: payload.expectedRemoteSequence,
    };
}

export function canonicalizeInventoryPayload(payload: InventoryOperationPayload): string {
    return JSON.stringify(normalizeInventoryPayload(payload));
}

function rightRotate(value: number, amount: number): number {
    return (value >>> amount) | (value << (32 - amount));
}

/** SHA-256 síncrono y portable para poder crear la operación dentro del commit Dexie. */
export function sha256Hex(input: string): string {
    const bytes = new TextEncoder().encode(input);
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    view.setUint32(paddedLength - 8, high, false);
    view.setUint32(paddedLength - 4, low, false);

    const constants = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    const hash = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, false);
        for (let i = 16; i < 64; i += 1) {
            const s0 = rightRotate(words[i - 15], 7) ^ rightRotate(words[i - 15], 18) ^ (words[i - 15] >>> 3);
            const s1 = rightRotate(words[i - 2], 17) ^ rightRotate(words[i - 2], 19) ^ (words[i - 2] >>> 10);
            words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = hash;
        for (let i = 0; i < 64; i += 1) {
            const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = (h + s1 + choice + constants[i] + words[i]) >>> 0;
            const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + majority) >>> 0;
            h = g; g = f; f = e; e = (d + temp1) >>> 0;
            d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
    }
    return [...hash].map(value => value.toString(16).padStart(8, '0')).join('');
}

export function hashInventoryPayload(payload: InventoryOperationPayload): string {
    return sha256Hex(canonicalizeInventoryPayload(payload));
}
