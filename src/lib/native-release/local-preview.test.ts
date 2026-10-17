import {describe,it,expect} from 'vitest';import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,sep,basename} from 'node:path';import {createHash} from 'node:crypto';
import {previewEnvironment,localDownload} from './local-preview';
describe('same download page, explicit loopback preview',()=>{
 it('does nothing outside the explicit local mode and rejects a foreign request origin',async()=>{
  const env={VENTARD_DESKTOP_RELEASE_CHANNEL:'production'};expect(previewEnvironment(env)).toBe(env);expect(await localDownload(env,new Request('https://ventard.vercel.app/api/native/download/windows-x86_64'))).toBeNull();
  expect((await localDownload({...env,VENTARD_DESKTOP_LOCAL_PREVIEW:'1'},new Request('https://ventard.vercel.app/api/native/download/windows-x86_64')))?.status).toBe(403);
 });
 it('serves only the exact locally reviewed artifact, rejects tampering and path traversal',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ventard-download-preview-test-')),folder=join(root,'scratch/windows-production-distribution/0.1.9');
  try{
   await mkdir(folder,{recursive:true});const bytes=Buffer.from('SYNTHETIC installer fixture only'),sha=createHash('sha256').update(bytes).digest('hex');
   const manifest={version:'0.1.9',installer:{file:'fixture.exe',bytes:bytes.length,sha256:sha}};
   const release={protocol:'ventard.desktop.release.1',status:'published',channel:'production',version:'0.1.9',publishedAt:'2026-10-17T00:00:00Z',notes:'Fixture',platform:'windows-x86_64',installer:{url:'https://ventard.vercel.app/downloads/windows-x86_64/0.1.9/fixture.exe',bytes:bytes.length,sha256:sha,signature:Buffer.from('untrusted comment: fixture\nfixture\ntrusted comment: fixture\tversion:0.1.9\nfixture').toString('base64')}};
   await writeFile(join(root,'scratch/production-release.json'),JSON.stringify(release));await writeFile(join(folder,'package.json'),JSON.stringify(manifest));await writeFile(join(folder,'fixture.exe'),bytes);
   const env={VENTARD_DESKTOP_LOCAL_PREVIEW:'1'},request=new Request('http://127.0.0.1:3023/api/native/download/windows-x86_64',{headers:{host:'127.0.0.1:3023'}});
   expect(previewEnvironment(env,root).VENTARD_DESKTOP_RELEASE_CHANNEL).toBe('production');const response=await localDownload(env,request,root);expect(response?.status).toBe(200);expect(Buffer.from(await response!.arrayBuffer())).toEqual(bytes);expect(response?.headers.get('content-disposition')).toBe('attachment; filename="fixture.exe"');
   // Next normalizes its internal request URL to localhost; the real Host must
   // still be the explicitly bound preview address, never a forwarded host.
   expect((await localDownload(env,new Request('http://localhost:3023/api/native/download/windows-x86_64',{headers:{host:'127.0.0.1:3023'}}),root))?.status).toBe(200);
   expect((await localDownload(env,new Request(request.url,{headers:{host:'foreign.test'}}),root))?.status).toBe(403);
   await writeFile(join(folder,'fixture.exe'),'altered');expect((await localDownload(env,request,root))?.status).toBe(503);
   await writeFile(join(folder,'package.json'),JSON.stringify({...manifest,installer:{...manifest.installer,file:'../private.json'}}));expect((await localDownload(env,request,root))?.status).toBe(503);
  }finally{const actual=await realpath(root),allowed=await realpath(tmpdir());expect(actual.toLowerCase().startsWith(allowed.toLowerCase()+sep)).toBe(true);expect(basename(actual)).toMatch(/^ventard-download-preview-test-/);await rm(actual,{recursive:true,force:true})}
 });
});
