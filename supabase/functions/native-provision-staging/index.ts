import {createHostedStagingProvision} from '../../../src/lib/native-access/hosted-provision.ts';
const names=['SUPABASE_URL','VENTARD_NATIVE_ENV','VENTARD_NATIVE_STAGING_URL','VENTARD_NATIVE_STAGING_PUBLISHABLE_KEY','VENTARD_NATIVE_GRANT_KEY_ID','VENTARD_NATIVE_GRANT_PRIVATE_KEY_PEM'] as const;
const environment=Object.fromEntries(names.map(name=>[name,Deno.env.get(name)]));
Deno.serve(createHostedStagingProvision(environment));
