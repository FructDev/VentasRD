// Existing public activation route. Expiry and single-use binding are atomic in PostgreSQL.
import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {supabaseAdmin,leerJson,excedeLimite,demasiadasPeticiones} from '@/lib/api/guardia';
import {readTeamInvitation,acceptTeamInvitation} from '@/lib/native-access/team-invites';
const schema=z.object({token:z.string().uuid(),password:z.string().min(6).max(200)}).strict();
const reply=(status:number,body:unknown)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(req:NextRequest){
 if(excedeLimite(req,'activar-get',20,5*60*1000))return demasiadasPeticiones();
 const token=z.string().uuid().safeParse(req.nextUrl.searchParams.get('token'));
 if(!token.success)return reply(400,{error:'Token inválido'});
 try{const result=await readTeamInvitation(token.data);return result.data?reply(200,result.data):reply(result.status,{error:result.status===404?'Token inválido, vencido o ya utilizado':'Activación temporalmente no disponible'});}catch{return reply(503,{error:'Activación temporalmente no disponible'});}
}
export async function POST(req:NextRequest){
 try{
 if(excedeLimite(req,'activar-post',10,15*60*1000))return demasiadasPeticiones();
 const parsed=await leerJson(req,schema);if(parsed.resp)return parsed.resp;
 const {token,password}=parsed.data,invitation=await readTeamInvitation(token);
 if(!invitation.data)return reply(invitation.status,{error:'Invitación no disponible. Actualiza el enlace o consulta al administrador.'});
 const {data,error}=await supabaseAdmin.auth.admin.createUser({email:invitation.data.email,password,email_confirm:true,user_metadata:{nombre_empleado:invitation.data.nombre,is_empleado:true}});
 if(error){if(['email_exists','user_already_exists'].includes(error.code||''))return reply(409,{code:'ACCOUNT_EXISTS',error:'Este correo ya tiene una cuenta. Inicia sesión para aceptar la invitación.'});if(error.code==='weak_password')return reply(400,{error:'La contraseña no cumple los requisitos de la cuenta. Elige una contraseña más segura.'});return reply(503,{error:'No se pudo crear la cuenta. Intenta de nuevo.'});}
 if(!data.user)return reply(503,{error:'No se pudo comprobar la cuenta creada.'});
 const result=await acceptTeamInvitation(token,data.user.id);
 if(!result.ok)return reply(result.status,{code:'SIGN_IN_TO_RECOVER',error:'La cuenta está creada. Inicia sesión para recuperar la activación; si el enlace venció, solicita uno nuevo.'});
 return reply(200,{ok:true});
 }catch{return reply(503,{error:'No se pudo completar la activación. Si ya creaste tu cuenta, inicia sesión para recuperar el acceso.'});}
}
