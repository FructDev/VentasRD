import {beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),limit:vi.fn()}));
vi.mock('@/lib/api/guardia',()=>({supabaseAdmin:{rpc:mocks.rpc,from:mocks.from},excedeLimite:()=>false,demasiadasPeticiones:vi.fn()}));
import {GET} from './route';
const tenant='96000000-0000-4000-8000-000000000001';
const get=(query='')=>GET(new NextRequest('https://staging.example.test/api/catalogo/'+tenant+query),{params:Promise.resolve({negocioId:tenant})});
describe('catálogo público existente',()=>{
 beforeEach(()=>vi.resetAllMocks());
 it('usa la proyección nativa sin caché y conserva la paginación',async()=>{
  const page={negocio:{nombre:'Negocio sintético'},productos:[],nextId:tenant};mocks.rpc.mockResolvedValue({data:page,error:null});
  const r=await get('?after='+tenant);expect(r.status).toBe(200);expect(await r.json()).toEqual(page);expect(r.headers.get('cache-control')).toBe('no-store');expect(mocks.rpc).toHaveBeenCalledWith('native_public_catalogue_page_v1',{p_negocio_id:tenant,p_after_id:tenant});expect(mocks.from).not.toHaveBeenCalled();
 });
 it('no fabrica catálogo vacío ni reabre el lector antiguo ante fallos del RPC',async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:{code:'P0001',message:'NATIVE_CATALOGUE_UNAVAILABLE'}});expect((await get()).status).toBe(404);
  mocks.rpc.mockResolvedValue({data:null,error:{code:'XX000',message:'secret detail'}});const r=await get();expect(r.status).toBe(503);expect(JSON.stringify(await r.json())).not.toContain('secret');expect(mocks.from).not.toHaveBeenCalled();
 });
 it('rechaza un cursor arbitrario antes de consultar',async()=>{expect((await get('?after=bad')).status).toBe(400);expect(mocks.rpc).not.toHaveBeenCalled()});
 it('mantiene la versión web anterior sólo si aún no existe el RPC',async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:{code:'PGRST202'}});
  const negocio={nombre:'Anterior',catalogo_publico:true,whatsapp_dueno:'8095550100'};
  const products=Array.from({length:201},(_,n)=>({id:String(n),nombre:'Producto '+n,precio_venta:1,imagen_url:null}));
  const businessQuery={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:negocio,error:null})};
  const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),or:vi.fn().mockReturnThis(),order:vi.fn().mockReturnThis(),limit:vi.fn().mockResolvedValue({data:products,error:null})};
  mocks.from.mockImplementation(table=>table==='negocios'?businessQuery:query);
  const r=await get();const page=await r.json();expect(page.productos).toHaveLength(200);expect(page.nextId).toBe('199');expect(r.headers.get('cache-control')).toBe('no-store');
 });
});
