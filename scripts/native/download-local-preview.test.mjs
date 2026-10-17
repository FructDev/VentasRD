// Acceptance of the REAL locally built candidate on the definitive Next page.
// Requires the explicitly started loopback preview; never logs in or installs.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {resolve} from 'node:path';
import {createHash} from 'node:crypto';import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../..'),origin='http://127.0.0.1:3023';
test('local official page downloads the exact signed production candidate without authentication', {timeout:120000},async()=>{
 const release=JSON.parse(await readFile(resolve(root,'scratch/production-release.json'),'utf8'));
 const manifest=JSON.parse(await readFile(resolve(root,'scratch/windows-production-distribution',release.version,'package.json'),'utf8'));
 assert.equal(release.channel,'production');assert.equal(manifest.fiscal,'DISABLED');
 const response=await fetch(origin+'/api/native/releases/windows-x86_64');assert.equal(response.status,200);
 const update=await response.json();assert.equal(update.version,release.version);
 assert.equal(update.platforms['windows-x86_64'].signature,release.installer.signature);
 let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:900},acceptDownloads:true});
  const remoteRequests=[];
  await page.route('**/*',route=>{if(route.request().url().startsWith(origin+'/'))return route.continue();remoteRequests.push(new URL(route.request().url()).origin);return route.abort()});
  await page.goto(origin+'/descargar');await page.getByRole('heading',{name:'VentaRD para Windows',exact:true}).waitFor();
  await page.getByRole('note').getByText(/Revisión local en este PC/).waitFor();
  await page.getByText(`Versión ${release.version} · Windows de 64 bits`,{exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Entrar a mi cuenta',exact:true}).count(),0);
  const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'Descargar VentaRD',exact:true}).click();const download=await downloading;
  assert.equal(await download.failure(),null);assert.equal(download.suggestedFilename(),manifest.installer.file);
  const bytes=await readFile(await download.path());assert.equal(bytes.length,release.installer.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),release.installer.sha256);
  await page.screenshot({path:resolve(root,'docs/native/evidence/desktop-download-local.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve(root,'docs/native/evidence/desktop-download-local-mobile.png'),fullPage:true});
  assert.deepEqual(remoteRequests,[]);
 }finally{await browser?.close()}
});
