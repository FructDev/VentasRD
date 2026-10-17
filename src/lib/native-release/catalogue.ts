import {z} from 'zod';
type Environment=Record<string,string|undefined>;
const version=z.string().regex(/^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/);
const https=z.string().max(2048).refine(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.href===value}catch{return false}});
const schema=z.object({
 protocol:z.literal('ventard.desktop.release.1'),status:z.literal('published'),channel:z.enum(['production','staging']),version,
 publishedAt:z.iso.datetime(),notes:z.string().max(8000),platform:z.literal('windows-x86_64'),
 installer:z.object({url:https,bytes:z.number().int().positive().max(2_000_000_000),sha256:z.string().regex(/^[a-f0-9]{64}$/),signature:z.string().min(16).max(8192).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict(),
}).strict();
export type DesktopRelease=z.infer<typeof schema>;
export function readDesktopRelease(env:Environment):DesktopRelease|null {
 try {
  if(!env.VENTARD_DESKTOP_RELEASE_JSON||env.VENTARD_DESKTOP_RELEASE_JSON.length>20000)return null;
  const release=schema.parse(JSON.parse(env.VENTARD_DESKTOP_RELEASE_JSON));
  if(release.channel!==env.VENTARD_DESKTOP_RELEASE_CHANNEL)return null;
  const origin=env.VENTARD_DESKTOP_DOWNLOAD_ORIGIN;
  if(!origin||new URL(origin).origin!==origin||!https.safeParse(origin+'/').success||new URL(release.installer.url).origin!==origin)return null;
  const signature=Buffer.from(release.installer.signature,'base64');
  if(signature.toString('base64')!==release.installer.signature||!signature.toString('utf8').startsWith('untrusted comment:'))return null;
  const comment=signature.toString('utf8').split(/\r?\n/).find(line=>line.startsWith('trusted comment: '))?.slice('trusted comment: '.length);
  if(!comment?.split('\t').includes('version:'+release.version))return null;
  return release;
 }catch{return null}
}
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
export function releaseResponse(env:Environment):Response {
 const r=readDesktopRelease(env);
 if(!r)return new Response(null,{status:204,headers});
 return Response.json({version:r.version,notes:r.notes,pub_date:r.publishedAt,platforms:{'windows-x86_64':{url:r.installer.url,signature:r.installer.signature}}},{headers});
}
export function downloadResponse(env:Environment):Response {
 const r=readDesktopRelease(env);
 if(!r)return Response.json({code:'DESKTOP_DOWNLOAD_UNAVAILABLE'},{status:503,headers});
 return new Response(null,{status:307,headers:{...headers,Location:r.installer.url}});
}
