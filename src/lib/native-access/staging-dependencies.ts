import {createPrivateKey} from 'node:crypto';
import type {ProvisionDependencies, RegistrationInput} from './provision-handler';

export const NATIVE_STAGING_URL = 'https://blzzinivvzadqjbnpsre.supabase.co';
type Environment = Record<string, string | undefined>;
type Http = (url: string, init?: RequestInit) => Promise<Response>;
function publicKey(value: string): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true;
  try {
    const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString());
    return claims.role === 'anon' && claims.ref === 'blzzinivvzadqjbnpsre';
  } catch { return false; }
}
export function stagingDependencies(env: Environment, http: Http = fetch): ProvisionDependencies {
  // No .env.local/production variables, service_role, or fallback signing key.
  const disabled: ProvisionDependencies = {enabled: false, keyId: '', privateKey: null,
    authenticate: async () => null, register: async () => { throw new Error('NATIVE_PROVISION_UNAVAILABLE'); }};
  const url = env.VENTARD_NATIVE_STAGING_URL;
  const apiKey = env.VENTARD_NATIVE_STAGING_PUBLISHABLE_KEY;
  const keyId = env.VENTARD_NATIVE_GRANT_KEY_ID;
  if (env.VENTARD_NATIVE_ENV !== 'staging' || url !== NATIVE_STAGING_URL || !apiKey || !publicKey(apiKey)
    || !keyId || !/^[A-Za-z0-9-]{1,64}$/.test(keyId) || !env.VENTARD_NATIVE_GRANT_PRIVATE_KEY_PEM) return disabled;
  try {
    const privateKey = createPrivateKey(env.VENTARD_NATIVE_GRANT_PRIVATE_KEY_PEM);
    if (privateKey.asymmetricKeyType !== 'ed25519') return disabled;
    const headers = (token: string) => ({apikey: apiKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'});
    return {enabled: true, keyId, privateKey,
      async authenticate(token) {
        const response = await http(`${url}/auth/v1/user`, {headers: headers(token), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000)});
        if (response.status === 401 || response.status === 403) return null;
        if (!response.ok) throw new Error('NATIVE_AUTH_UNAVAILABLE');
        const user = await response.json();
        if (user.is_anonymous === true) return null;
        return typeof user.id === 'string' ? {id: user.id} : null;
      },
      async register(input: RegistrationInput, token: string) {
        const response = await http(`${url}/rest/v1/rpc/native_registrar_instalacion_v1`, {
          method: 'POST', headers: headers(token), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
          body: JSON.stringify({p_registration_id: input.registrationId, p_negocio_id: input.tenantId,
            p_installation_id: input.installationId, p_device_id: input.deviceId, p_scope_kind: input.scopeType, p_sucursal_id: input.branchId}),
        });
        if (!response.ok) {
          if (response.status === 403 && response.body) {
            const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
            try {
              for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384)break;chunks.push(value);}
              if(size<=16384){
                let error:unknown;try{error=JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));}catch{error=null;}
                if(typeof error==='object'&&error!==null&&'code' in error&&'message' in error&&error.code==='42501'&&error.message==='NATIVE_OWNER_SETUP_REQUIRED')throw new Error('NATIVE_OWNER_SETUP_REQUIRED');
                if(typeof error==='object'&&error!==null&&'code' in error&&'message' in error&&error.code==='42501'&&error.message==='NATIVE_POLICY_CHANGED')throw new Error('NATIVE_POLICY_CHANGED');
              }
            } finally {await reader.cancel().catch(()=>undefined);reader.releaseLock();}
          }
          throw new Error('NATIVE_REGISTRATION_UNAVAILABLE');
        }
        return response.json();
      },
    };
  } catch { return disabled; }
}
