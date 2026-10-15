import {beforeEach,describe,expect,it,vi} from 'vitest';import {NextRequest} from 'next/server';
const m=vi.hoisted(()=>({read:vi.fn(),accept:vi.fn(),create:vi.fn()}));
vi.mock('@/lib/api/guardia',()=>({supabaseAdmin:{auth:{admin:{createUser:m.create}}},excedeLimite:()=>false,demasiadasPeticiones:vi.fn(),leerJson:async(req:Request,s:{safeParse:(v:unknown)=>{success:boolean;data:unknown}})=>{const parsed=s.safeParse(await req.json());return parsed.success?{data:parsed.data}:{resp:Response.json({error:'invalid'},{status:400})}}}));
vi.mock('@/lib/native-access/team-invites',()=>({readTeamInvitation:m.read,acceptTeamInvitation:m.accept}));
import {GET,POST} from './route';
const token='96000000-0000-4000-8000-000000000001',id='96000000-0000-4000-8000-000000000002';
const req=()=>new NextRequest('https://staging.example.test/api/usuarios/activar',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,password:'synthetic-password'})});
describe('activar invitación existente',()=>{
 beforeEach(()=>{vi.resetAllMocks();m.read.mockResolvedValue({data:{nombre:'Ana QA',email:'ana@example.test'},status:200});m.create.mockResolvedValue({data:{user:{id}},error:null});m.accept.mockResolvedValue({ok:true,status:200})});
 it('no crea cuentas con una invitación vencida o un esquema ausente',async()=>{for(const status of [404,503]){m.read.mockResolvedValue({data:null,status});expect((await POST(req())).status).toBe(status)}expect(m.create).not.toHaveBeenCalled()});
 it('crea y vincula sólo el correo devuelto por el servicio',async()=>{expect((await POST(req())).status).toBe(200);expect(m.create.mock.calls[0][0].email).toBe('ana@example.test');expect(m.accept).toHaveBeenCalledWith(token,id)});
 it('recupera cuenta existente sin reemplazar contraseña ni borrar cuentas',async()=>{m.create.mockResolvedValue({data:{user:null},error:{code:'email_exists',status:422}});const r=await POST(req());expect(r.status).toBe(409);expect((await r.json()).code).toBe('ACCOUNT_EXISTS');expect(m.accept).not.toHaveBeenCalled()});
 it('rechaza tokens malformados antes de consultar',async()=>{expect((await GET(new NextRequest('https://staging.example.test/api/usuarios/activar?token=no'))).status).toBe(400);expect(m.read).not.toHaveBeenCalled()});
});
