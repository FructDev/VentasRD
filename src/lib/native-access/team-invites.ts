// Only server routes import this adapter. Service credentials never reach UI.
import {z} from 'zod';
import {supabaseAdmin} from '@/lib/api/guardia';
const invitation=z.object({nombre:z.string().min(1).max(100),email:z.string().email().max(200)}).strict();
export async function readTeamInvitation(token:string){
 const {data,error}=await supabaseAdmin.rpc('native_team_invite_read_v1',{p_token:token});
 if(error)return{data:null,status:error.message==='NATIVE_TEAM_INVITE_UNAVAILABLE'?404:503};
 const parsed=invitation.safeParse(data);return parsed.success?{data:parsed.data,status:200}:{data:null,status:503};
}
export async function acceptTeamInvitation(token:string,userId:string){
 const {data,error}=await supabaseAdmin.rpc('native_team_invite_accept_v1',{p_token:token,p_user_id:userId});
 if(error)return{ok:false,status:error.message==='NATIVE_TEAM_INVITE_UNAVAILABLE'?404:error.message==='NATIVE_TEAM_INVITE_DENIED'?403:503};
 return{ok:data?.status==='ACCEPTED',status:data?.status==='ACCEPTED'?200:503};
}
