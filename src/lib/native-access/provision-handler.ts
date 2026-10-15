import {sign, type KeyObject} from 'node:crypto';
import {z} from 'zod';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,15})$/).refine(v => BigInt(v) <= BigInt('9007199254740991'));
const positive = decimal.refine(v => v !== '0');
const requestSchema = z.object({
  registrationId: uuid, tenantId: uuid, deviceId: uuid, installationId: uuid,
  scopeType: z.enum(['GLOBAL', 'BRANCH']), branchId: uuid.nullable(),
}).strict().refine(v => (v.scopeType === 'GLOBAL') === (v.branchId === null));
export type RegistrationInput = z.infer<typeof requestSchema>;
const receiptSchema = z.object({
  registrationId: uuid, tenantId: uuid, deviceId: uuid, installationId: uuid,
  scopeType: z.enum(['GLOBAL', 'BRANCH']), branchId: uuid.nullable(), actorId: uuid,
  writerEpoch: positive, grantSequence: positive, issuedAtMs: decimal,
  role: z.enum(['owner', 'admin', 'vendedor', 'cajero']),
  license: z.object({planActive: z.boolean(), planTier: z.enum(['basico', 'pro']).optional(), accessUntilMs: decimal.nullable(), trialUntilMs: decimal.nullable()}).strict(),
}).strict();
export interface ProvisionDependencies {
  enabled: boolean;
  keyId: string;
  privateKey: KeyObject | null;
  authenticate: (token: string) => Promise<{id: string} | null>;
  register: (input: RegistrationInput, token: string) => Promise<unknown>;
}

/** C-N1 subset used by this ASCII-keyed DTO: integers remain decimal strings. */
export function canonicalGrant(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    // C-N1 does not allow lone UTF-16 surrogates.
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('GRANT_CANONICAL_INVALID');
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('GRANT_CANONICAL_INVALID');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalGrant).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(k => `${canonicalGrant(k)}:${canonicalGrant(record[k])}`).join(',')}}`;
  }
  throw new Error('GRANT_CANONICAL_INVALID');
}
function reply(status: number, value: unknown) {
  return Response.json(value, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
}
async function body(req: Request): Promise<unknown> {
  if (req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || !req.body) throw new Error('BODY_INVALID');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2048) throw new Error('BODY_INVALID');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function createProvisionHandler(dep: ProvisionDependencies) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return reply(405, {code: 'METHOD_NOT_ALLOWED'});
    if (!dep.enabled || !dep.privateKey || dep.privateKey.type !== 'private' || dep.privateKey.asymmetricKeyType !== 'ed25519'
      || !/^[A-Za-z0-9-]{1,64}$/.test(dep.keyId)) return reply(503, {code: 'NATIVE_PROVISION_UNAVAILABLE'});
    let input: RegistrationInput;
    try { input = requestSchema.parse(await body(req)); }
    catch { return reply(400, {code: 'NATIVE_REQUEST_INVALID'}); }
    const token = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!token) return reply(401, {code: 'NATIVE_AUTH_REQUIRED'});
    let actor: {id: string} | null;
    try { actor = await dep.authenticate(token); }
    catch { return reply(503, {code: 'NATIVE_AUTH_UNAVAILABLE'}); }
    if (!actor || !uuid.safeParse(actor.id).success) return reply(401, {code: 'NATIVE_AUTH_REQUIRED'});
    try {
      const parsed = receiptSchema.safeParse(await dep.register(input, token));
      if (!parsed.success) return reply(503, {code: 'NATIVE_REGISTRATION_UNVERIFIABLE'});
      const receipt = parsed.data;
      if (receipt.actorId !== actor.id || Object.keys(input).some(k => receipt[k as keyof RegistrationInput] !== input[k as keyof RegistrationInput])) {
        return reply(403, {code: 'NATIVE_CONTEXT_MISMATCH'});
      }
      const role = receipt.role === 'vendedor' ? 'seller' : receipt.role === 'cajero' ? 'cashier' : receipt.role;
      const payload = {
        protocol: 'ventard.offline-grant.v1', keyId: dep.keyId, issuer: 'ventard.staging',
        audience: 'ventard.native.staging.v1', grantId: receipt.registrationId,
        grantSequence: receipt.grantSequence, policyVersion: '1', tenantId: receipt.tenantId,
        actorId: receipt.actorId, deviceId: receipt.deviceId, installationId: receipt.installationId,
        writerEpoch: receipt.writerEpoch, scope: {type: receipt.scopeType, branchId: receipt.branchId},
        role, capabilities: ['seller','cashier'].includes(role) ? ['READ', 'SELL'] : ['READ', 'SELL', 'INVENTORY_WRITE', 'MANAGE'],
        issuedAtMs: receipt.issuedAtMs, actorExpiresAtMs: null,
        license: {...receipt.license, graceDays: '5', warnAfterOpenings: '200', blockAfterOpenings: '300'},
      };
      const signature = sign(null, Buffer.from(canonicalGrant(payload)), dep.privateKey).toString('hex');
      return reply(200, {payload, signature});
    } catch (error) {
      // No token, SQL diagnostic or private-key exception is returned/logged.
      if(error instanceof Error&&error.message==='NATIVE_OWNER_SETUP_REQUIRED')return reply(403,{code:'NATIVE_OWNER_SETUP_REQUIRED'});
      if(error instanceof Error&&error.message==='NATIVE_POLICY_CHANGED')return reply(409,{code:'NATIVE_POLICY_CHANGED'});
      return reply(503, {code: 'NATIVE_REGISTRATION_UNAVAILABLE'});
    }
  };
}
