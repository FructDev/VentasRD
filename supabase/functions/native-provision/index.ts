import {createHostedProductionProvision} from '../../../src/lib/native-access/hosted-production-provision.ts';
const names=['SUPABASE_URL','VENTARD_NATIVE_ENV','VENTARD_NATIVE_PRODUCTION_URL','VENTARD_NATIVE_PRODUCTION_PUBLISHABLE_KEY','VENTARD_NATIVE_PRODUCTION_GRANT_KEY_ID','VENTARD_NATIVE_PRODUCTION_GRANT_PRIVATE_KEY_PEM'] as const;
const environment=Object.fromEntries(names.map(name=>[name,Deno.env.get(name)]));
Deno.serve(createHostedProductionProvision(environment));
