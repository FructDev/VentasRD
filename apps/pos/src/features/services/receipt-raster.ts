// Capture the definitive ticket, not a separately re-created thermal template.
import type {PrinterProfile,PrintRaster} from '../../platform/management';
export async function printReceipt(send:(raster?:PrintRaster)=>Promise<{status:string;submitted?:boolean}>,container:HTMLElement|null,target?:PrinterProfile){
 // Recover a frozen attempt first. A fresh direct attempt requests presentation
 // before writing anything; it cannot send until its raster is persisted.
 try{return await send()}catch(error){if(!error||typeof error!=='object'||!('code' in error)||error.code!=='PRINT_RASTER_REQUIRED')throw error;if(!target||target.mode==='DIALOG')throw{code:'PRINT_TARGET_CHANGED'};return send(await receiptRaster(container,target));}
}
export async function receiptRaster(container:HTMLElement|null,target?:PrinterProfile):Promise<PrintRaster|undefined>{
 if(!target||target.mode==='DIALOG')return undefined;
 const element=container?.querySelector<HTMLElement>('.native-ticket-document');if(!element)throw{code:'PRINT_RASTER_INVALID'};
 await document.fonts.ready;for(const img of element.querySelectorAll('img'))await img.decode();
 const {captureReceipt}=await import('./receipt-svg');const canvas=await captureReceipt(element,target.dots);
 const normalized=document.createElement('canvas');normalized.width=target.dots;normalized.height=canvas.height;if(!normalized.height||normalized.height>20000)throw{code:'PRINT_RASTER_INVALID'};
 const context=normalized.getContext('2d')!;context.fillStyle='#fff';context.fillRect(0,0,normalized.width,normalized.height);context.drawImage(canvas,0,0,normalized.width,normalized.height);const pixels=context.getImageData(0,0,normalized.width,normalized.height).data,stride=target.dots/8,bytes=new Uint8Array(stride*normalized.height);
 for(let y=0;y<normalized.height;y++)for(let x=0;x<normalized.width;x++){const i=(y*normalized.width+x)*4;if(299*pixels[i]+587*pixels[i+1]+114*pixels[i+2]<160000)bytes[y*stride+(x>>3)]|=0x80>>(x&7);}
 let data='';for(let i=0;i<bytes.length;i+=8192)data+=String.fromCharCode(...bytes.subarray(i,i+8192));return{width:target.dots,height:normalized.height,data:btoa(data)};
}
