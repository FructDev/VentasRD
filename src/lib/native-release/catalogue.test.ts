import {describe,it,expect} from 'vitest';
import {readDesktopRelease,releaseResponse,downloadResponse} from './catalogue';
const release={protocol:'ventard.desktop.release.1',status:'published',channel:'production',version:'1.0.0',publishedAt:'2026-10-17T12:00:00Z',notes:'Primera versión Windows',platform:'windows-x86_64',installer:{url:'https://downloads.example.test/1.0.0/VentaRD.exe',bytes:1000,sha256:'a'.repeat(64),signature:Buffer.from('untrusted comment: signature\nfixture\ntrusted comment: fixture\tversion:1.0.0\nfixture').toString('base64')}};
const env=(value:unknown=release)=>({VENTARD_DESKTOP_RELEASE_JSON:JSON.stringify(value),VENTARD_DESKTOP_DOWNLOAD_ORIGIN:'https://downloads.example.test',VENTARD_DESKTOP_RELEASE_CHANNEL:'production'});
describe('official desktop release catalogue',()=>{
 it('never advertises a missing, draft, foreign-channel or invalid release',()=>{
  for(const e of [{},env({...release,status:'draft'}),env({...release,channel:'staging'}),env({...release,version:'../1.0.0'}),env({...release,version:'2.0.0'}),env({...release,installer:{...release.installer,url:'https://other.example.test/app.exe'}}),env({...release,installer:{...release.installer,signature:''}}),env({...release,privateKey:'must-never-be-public'})])expect(readDesktopRelease(e)).toBeNull();
 });
 it('publishes only the validated installer and the Tauri platform/signature metadata',async()=>{
  expect(readDesktopRelease(env())?.version).toBe('1.0.0');
  const response=releaseResponse(env());expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({version:'1.0.0',notes:release.notes,pub_date:release.publishedAt,platforms:{'windows-x86_64':{url:release.installer.url,signature:release.installer.signature}}});
  const download=downloadResponse(env());expect(download.status).toBe(307);expect(download.headers.get('location')).toBe(release.installer.url);
 });
 it('offline/unpublished configuration gives no update and no invented download',async()=>{
  expect(releaseResponse({}).status).toBe(204);const response=downloadResponse({});expect(response.status).toBe(503);expect(await response.json()).toEqual({code:'DESKTOP_DOWNLOAD_UNAVAILABLE'});
 });
 it('rejects credentials, insecure URLs, fragments, query strings and malformed signature encodings',()=>{
  for(const url of ['http://downloads.example.test/app.exe','https://user:password@downloads.example.test/app.exe','https://downloads.example.test/app.exe#secret','https://downloads.example.test/app.exe?token=secret'])expect(readDesktopRelease(env({...release,installer:{...release.installer,url}}))).toBeNull();
  for(const signature of ['not-base64','a'.repeat(20000)])expect(readDesktopRelease(env({...release,installer:{...release.installer,signature}}))).toBeNull();
 });
});
