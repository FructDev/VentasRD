import {beforeEach,describe,expect,it,vi} from 'vitest';import {NextRequest} from 'next/server';
const m=vi.hoisted(()=>({user:vi.fn(),accept:vi.fn()}));
vi.mock('@/lib/api/guardia',()=>({usuarioDesdeToken:m.user,excedeLimite:()=>false,demasiadasPeticiones:vi.fn(),leerJson:async(req:Request,s:{safeParse:(v:unknown)=>{success:boolean;data:unknown}})=>{const parsed=s.safeParse(await req.json());return parsed.success?{data:parsed.data}:{resp:Response.json({error:'invalid'},{status:400})}}}));
vi.mock('@/lib/native-access/team-invites',()=>({acceptTeamInvitation:m.accept}));
import {POST} from './route';
const token='96000000-0000-4000-8000-000000000001',id='96000000-0000-4000-8000-000000000002';
const req=(body:unknown)=>new NextRequest('https://staging.example.test/api/usuarios/vincular',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
describe('vincular cuenta invitada',()=>{
 beforeEach(()=>{vi.resetAllMocks();m.accept.mockResolvedValue({ok:true,status:200})});
 it('requiere sesión verificada y rechaza un userId arbitrario',async()=>{m.user.mockResolvedValue(null);expect((await POST(req({token,userId:id}))).status).toBe(401);m.user.mockResolvedValue({id,email_confirmed_at:null});expect((await POST(req({token}))).status).toBe(403);m.user.mockResolvedValue({id,email_confirmed_at:'now'});expect((await POST(req({token,userId:token}))).status).toBe(403);expect(m.accept).not.toHaveBeenCalled()});
 it('envía exclusivamente la identidad autenticada al canje atómico',async()=>{m.user.mockResolvedValue({id,email_confirmed_at:'now'});const r=await POST(req({token}));expect(r.status).toBe(200);expect(m.accept).toHaveBeenCalledWith(token,id);expect(r.headers.get('cache-control')).toBe('no-store')});
});
