// Same Next page, isolated empty browser, no authentication or remote database.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';import {resolve} from 'node:path';import {open,readFile,writeFile} from 'node:fs/promises';import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../..'),url='http://127.0.0.1:3023';
test('official download page is public without a published installer; API refuses an empty release', {timeout:180000},async()=>{
 const originalConfig=await readFile(resolve(root,'tsconfig.json'),'utf8');
 const log=await open(resolve(root,'scratch/desktop-download-web-fixture.log'),'w');let child,browser;
 try{
  const env={...process.env,NEXT_PUBLIC_SUPABASE_URL:'https://blzzinivvzadqjbnpsre.supabase.co',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',SUPABASE_SERVICE_ROLE_KEY:'fixture-disabled',NEXT_PUBLIC_VENTARD_SHARED_JOURNAL:'staging',NEXT_FONT_GOOGLE_MOCKED_RESPONSES:resolve(root,'scratch/shared-ui-fonts.cjs'),NEXT_TELEMETRY_DISABLED:'1',SENTRY_AUTH_TOKEN:'',VENTARD_DESKTOP_RELEASE_JSON:'',VENTARD_DESKTOP_RELEASE_CHANNEL:'staging'};
  // An unrelated service on this port must never be mistaken for our fixture.
  try{await fetch(url,{signal:AbortSignal.timeout(500)});throw Error('FIXTURE_PORT_ALREADY_USED')}catch(e){if(e.message==='FIXTURE_PORT_ALREADY_USED')throw e}
  env.VENTARD_DESKTOP_WEB_FIXTURE='1';
  child=spawn(process.execPath,[resolve(root,'node_modules/next/dist/bin/next'),'dev','--webpack','--hostname','127.0.0.1','--port','3023'],{cwd:root,env,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
  let ready=false;for(let i=0;i<120;i++){
   if(child.exitCode!==null)throw Error('FIXTURE_SERVER_FAILED');
   try{if((await fetch(url+'/descargar',{signal:AbortSignal.timeout(3000)})).ok){ready=true;break}}catch{/* compiling */}
   await new Promise(r=>setTimeout(r,500));
  }assert.ok(ready,'Next page compiled');
  assert.equal((await fetch(url+'/api/native/releases/windows-x86_64')).status,204);
  assert.equal((await fetch(url+'/api/native/download/windows-x86_64',{redirect:'manual'})).status,503);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.route('**/*',r=>r.request().url().startsWith(url+'/')?r.continue():r.abort());
  await page.goto(url+'/descargar');await page.getByRole('heading',{name:'VentaRD para Windows',exact:true}).waitFor();
  await page.getByRole('status').getByText('La descarga para Windows todavía no está publicada. Puedes continuar usando VentaRD en la web.',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/descargar');assert.equal(await page.getByRole('link',{name:'Descargar VentaRD',exact:true}).count(),0);
  assert.equal(await page.getByRole('link',{name:'Entrar a mi cuenta',exact:true}).getAttribute('href'),'/login');
  await page.screenshot({path:resolve(root,'docs/native/evidence/desktop-download-unpublished.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{
  await browser?.close();if(child?.pid){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGTERM')}
  await log.close();
  const generated=JSON.parse(await readFile(resolve(root,'tsconfig.json'),'utf8'));
  generated.include=generated.include.filter(v=>!v.startsWith('.next-desktop-check/'));
  if(JSON.stringify(generated)===JSON.stringify(JSON.parse(originalConfig)))await writeFile(resolve(root,'tsconfig.json'),originalConfig);

 }
});
