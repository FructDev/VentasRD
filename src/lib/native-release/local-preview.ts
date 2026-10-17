// Optional review download for the same definitive page on THIS PC. Production
// paths never read a local artifact unless this explicit private flag is set.
import {readFileSync,lstatSync} from 'node:fs';import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {readDesktopRelease} from './catalogue';
type Environment=Record<string,string|undefined>;
function smallFile(path:string,max:number):Buffer{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw Error('PREVIEW_FILE_INVALID');return readFileSync(path)}
export function previewEnvironment(env:Environment,root=process.cwd()):Environment{
 if(env.VENTARD_DESKTOP_LOCAL_PREVIEW!=='1')return env;
 let manifest='';try{manifest=smallFile(resolve(root,'scratch/production-release.json'),20000).toString()}catch{/* not prepared yet */}
 return{...env,VENTARD_DESKTOP_RELEASE_CHANNEL:'production',VENTARD_DESKTOP_DOWNLOAD_ORIGIN:'https://ventard.vercel.app',VENTARD_DESKTOP_RELEASE_JSON:manifest};
}
export async function localDownload(env:Environment,request:Request,root=process.cwd()):Promise<Response|null>{
 if(env.VENTARD_DESKTOP_LOCAL_PREVIEW!=='1')return null;
 const url=new URL(request.url),headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 // Next may normalize its internal URL to localhost. Authorize the actual
 // loopback Host as well; never trust forwarded host/origin headers here.
 if(url.protocol!=='http:'||url.port!=='3023'||!['127.0.0.1','localhost'].includes(url.hostname)||request.headers.get('host')!=='127.0.0.1:3023')return Response.json({code:'LOCAL_PREVIEW_ONLY'},{status:403,headers});
 try{
  const release=readDesktopRelease(previewEnvironment(env,root));if(!release)throw Error('RELEASE_MISSING');
  const directory=resolve(root,'scratch/windows-production-distribution',release.version),manifest=JSON.parse(smallFile(resolve(directory,'package.json'),65536).toString());
  const name=manifest?.installer?.file;
  if(typeof name!=='string'||!(/^[A-Za-z0-9_. -]+\.exe$/.test(name))||new URL(release.installer.url).pathname!==`/downloads/windows-x86_64/${release.version}/${encodeURIComponent(name)}`||manifest.version!==release.version||manifest.installer.bytes!==release.installer.bytes||manifest.installer.sha256!==release.installer.sha256)throw Error('ARTIFACT_MISMATCH');
  const bytes=smallFile(resolve(directory,name),128*1024*1024);
  if(bytes.length!==release.installer.bytes||createHash('sha256').update(bytes).digest('hex')!==release.installer.sha256)throw Error('ARTIFACT_CHANGED');
  return new Response(new Uint8Array(bytes),{headers:{...headers,'Content-Type':'application/octet-stream','Content-Length':String(bytes.length),'Content-Disposition':`attachment; filename="${name}"`,'X-Artifact-SHA256':release.installer.sha256}});
 }catch{return Response.json({code:'LOCAL_REVIEW_DOWNLOAD_UNAVAILABLE'},{status:503,headers})}
}
