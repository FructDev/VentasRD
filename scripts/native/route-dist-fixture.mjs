// Local compiled UI assets supplied directly by Playwright. No browser network,
// permission changes, remote source or authentication is involved.
import {readFile} from 'node:fs/promises';
export async function routeDistFixture(page,url,root){
 await page.route(url+'/**',async route=>{
  try{const path=new URL(route.request().url()).pathname,file=new URL(path==='/'?'index.html':'.'+path,root);if(!file.href.startsWith(root.href))return await route.fulfill({status:403});const type=path==='/'?'text/html':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.ttf')?'font/ttf':'application/octet-stream';await route.fulfill({contentType:type,body:await readFile(file)})}catch{await route.fulfill({status:404})}
 });
}
