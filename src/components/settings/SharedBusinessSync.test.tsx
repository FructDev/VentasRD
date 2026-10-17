import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,describe,expect,it,vi} from 'vitest';
import SharedBusinessSync from './SharedBusinessSync';

const fixture=vi.hoisted(()=>({tenant:'864d08e5-2975-4b2d-a1e2-ba5a14f3d677'}));
vi.mock('dexie-react-hooks',()=>({useLiveQuery:()=>undefined}));
vi.mock('@/lib/db/dexie',()=>({db:{}}));
vi.mock('@/lib/supabase/client',()=>({supabase:{}}));
vi.mock('@/lib/sync/shared-runtime',()=>({prepareSharedBrowser:vi.fn(),syncSharedBrowser:vi.fn()}));
vi.mock('@/lib/sync/shared-brand',()=>({hydrateSharedBrand:vi.fn()}));
vi.mock('@/store/useConfigStore',()=>({useConfigStore:(select:(state:unknown)=>unknown)=>select({negocioId:fixture.tenant,user:{id:'owner'},sucursalId:'branch'})}));
afterEach(()=>{vi.unstubAllEnvs();fixture.tenant='864d08e5-2975-4b2d-a1e2-ba5a14f3d677'});

describe('preparación web del piloto de producción',()=>{
 it('permite preparar sólo Pica en el canal de producción autorizado',()=>{
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://oxbekqoecunsbjheqgqg.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_VENTARD_SHARED_JOURNAL','production-pilot');
  const html=renderToStaticMarkup(<SharedBusinessSync/>);
  expect(html).toContain('Preparar este navegador');
  expect(html).not.toContain('Disponible sólo para las pruebas de Staging');
 });
 it('no expone la preparación a otros negocios ni con canal incorrecto',()=>{
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://oxbekqoecunsbjheqgqg.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_VENTARD_SHARED_JOURNAL','production-pilot');
  fixture.tenant='other-business';
  expect(renderToStaticMarkup(<SharedBusinessSync/>)).toBe('');
  fixture.tenant='864d08e5-2975-4b2d-a1e2-ba5a14f3d677';
  vi.stubEnv('NEXT_PUBLIC_VENTARD_SHARED_JOURNAL','staging');
  expect(renderToStaticMarkup(<SharedBusinessSync/>)).toBe('');
 });
 it('conserva la preparación de los negocios QA autorizados en Staging',()=>{
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://blzzinivvzadqjbnpsre.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_VENTARD_SHARED_JOURNAL','staging');
  fixture.tenant='96000000-0000-4000-8000-000000000001';
  expect(renderToStaticMarkup(<SharedBusinessSync/>)).toContain('Preparar este navegador');
 });
});
