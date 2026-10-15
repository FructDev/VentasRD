// Existing invitation binding route. Never trusts an arbitrary userId from the body.
import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {leerJson,usuarioDesdeToken,excedeLimite,demasiadasPeticiones} from '@/lib/api/guardia';
import {acceptTeamInvitation} from '@/lib/native-access/team-invites';
const schema=z.object({token:z.string().uuid(),userId:z.string().uuid().optional()}).strict();
const reply=(status:number,body:unknown)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function POST(req:NextRequest){
 try{
 if(excedeLimite(req,'vincular',10,15*60*1000))return demasiadasPeticiones();
 const user=await usuarioDesdeToken(req);if(!user)return reply(401,{error:'Inicia sesión para aceptar esta invitación.'});
 const parsed=await leerJson(req,schema);if(parsed.resp)return parsed.resp;
 if(!user.email_confirmed_at||(parsed.data.userId&&parsed.data.userId!==user.id))return reply(403,{error:'La cuenta debe estar verificada y pertenecer al destinatario.'});
 const result=await acceptTeamInvitation(parsed.data.token,user.id);
 return result.ok?reply(200,{ok:true}):reply(result.status,{error:'No se pudo aceptar la invitación. Comprueba el correo de tu cuenta y la vigencia del enlace.'});
 }catch{return reply(503,{error:'No se pudo comprobar la invitación. Intenta de nuevo.'});}
}
