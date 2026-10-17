// Explicit public-page acceptance only. Never signs in or calls business RPCs.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {resolve} from 'node:path';
import {createHash} from 'node:crypto';import {chromium} from 'playwright';
test('official production page downloads the verified candidate without authentication',{
 skip:process.env.VENTARD_PRODUCTION_PUBLIC_SMOKE!=='1',timeout:90000,
},async()=>{
 const root=resolve(import.meta.dirname,'../..'),release=JSON.parse(await readFile(resolve(root,'scratch/production-release.json'),'utf8')),origin='https://ventard.vercel.app';
 let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({acceptDownloads:true,viewport:{width:1280,height:900}});
  const external=[];await page.route('**/*',route=>{if(route.request().url().startsWith(origin+'/'))return route.continue();external.push(new URL(route.request().url()).origin);return route.abort()});
  const response=await page.goto(origin+'/descargar');assert.equal(response.status(),200);
  await page.getByRole('heading',{name:'VentaRD para Windows',exact:true}).waitFor();await page.getByText('Versión '+release.version+' · Windows de 64 bits',{exact:true}).waitFor();
  assert.equal(await page.getByText(/Revisión local en este PC/).count(),0);
  const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'Descargar VentaRD',exact:true}).click();const download=await downloading;assert.equal(await download.failure(),null);
  const bytes=await readFile(await download.path());assert.equal(bytes.length,release.installer.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),release.installer.sha256);
  await page.screenshot({path:resolve(root,'docs/native/evidence/desktop-download-production.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve(root,'docs/native/evidence/desktop-download-production-mobile.png'),fullPage:true});assert.deepEqual(external,[]);
 }finally{await browser?.close()}
});
