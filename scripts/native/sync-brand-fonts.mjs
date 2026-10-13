// Bundle the original VentaRD Google Fonts locally. No runtime network/font fallback.
// Public assets only; preserves each family OFL licence and records content hashes.
import {mkdir,writeFile,readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const families={syne:['syne','Syne[wght].ttf'],poppins:['poppins','Poppins-Bold.ttf'],montserrat:['montserrat','Montserrat[wght].ttf'],spacegro:['spacegrotesk','SpaceGrotesk[wght].ttf'],sora:['sora','Sora[wght].ttf'],outfit:['outfit','Outfit[wght].ttf'],playfair:['playfairdisplay','PlayfairDisplay[wght].ttf'],dmsans:['dmsans','DMSans[opsz,wght].ttf'],dmmono:['dmmono','DMMono-Regular.ttf']};
families.poppins600=['poppins','Poppins-SemiBold.ttf'];families.poppins800=['poppins','Poppins-ExtraBold.ttf'];families.dmmono500=['dmmono','DMMono-Medium.ttf'];
const root=new URL('../../apps/pos/src/assets/fonts/',import.meta.url);await mkdir(root,{recursive:true});const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8').catch(()=>'{}'));
for(const[key,[family,file]]of Object.entries(families)){
 if(process.argv.includes('--extra-weights')&&!['poppins600','poppins800','dmmono500'].includes(key))continue;
 const url=`https://raw.githubusercontent.com/google/fonts/main/ofl/${family}/${encodeURIComponent(file)}`;
 const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(`FONT_ASSET_MISSING_${key}_${r.status}`);const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length<1000||bytes.length>1500000||![0x00010000,0x4f54544f].includes(bytes.readUInt32BE()))throw Error('FONT_INVALID');
 const licenseUrl=`https://raw.githubusercontent.com/google/fonts/main/ofl/${family}/OFL.txt`;const l=await fetch(licenseUrl,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!l.ok)throw Error('FONT_LICENSE_MISSING');const license=await l.text();if(!license.includes('SIL OPEN FONT LICENSE'))throw Error('FONT_LICENSE_INVALID');
 await writeFile(new URL(`${key}.ttf`,root),bytes);await writeFile(new URL(`${key}-OFL.txt`,root),license.replace(/[ \t]+(?=\r?$)/gm,''));manifest[key]={source:url,sha256:createHash('sha256').update(bytes).digest('hex'),license:licenseUrl};console.log(`FONT_BUNDLED ${key}`);
}
await writeFile(new URL('manifest.json',root),JSON.stringify(manifest,null,2)+'\n');
