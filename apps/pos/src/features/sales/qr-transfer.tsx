// Original QrTransferencia markup with typed captured public settings.
import {useEffect,useState} from 'react';
import type {BusinessHeader} from '../../platform/management';
import {showCents} from '../../platform/pos-adapter';
import {transferLink} from './transfer-link';
export function QrTransfer({business,cents}:{business:BusinessHeader;cents:string}) {
 const link=transferLink(business,cents),[image,setImage]=useState<{link:string;src:string}|null>(null),[failed,setFailed]=useState<string|null>(null);
 useEffect(()=>{let live=true;if(link)void import('qrcode').then(q=>q.toDataURL(link,{width:280,margin:1,color:{dark:'#0D1B2E',light:'#FFFFFF'}})).then(src=>{if(live)setImage({link,src})}).catch(()=>{if(live)setFailed(link)});return()=>{live=false}},[link]);
 if(!business.bank?.account)return null;
 const bank=business.bank,src=image?.link===link?image.src:null;
 return <div className="bg-navy rounded-xl border border-navy-3 p-4 flex flex-col sm:flex-row items-center gap-4">{src?<img src={src} alt="QR de transferencia" className="w-36 h-36 rounded-lg bg-white p-1 shrink-0"/>:!link||failed===link?<p role="status" className="text-xs text-vr-gray w-36">QR no disponible. Usa los datos de la cuenta.</p>:<div className="w-36 h-36 rounded-lg bg-navy-3 animate-pulse shrink-0"/>}<div className="text-center sm:text-left min-w-0"><p className="text-xs font-black text-vr-gray uppercase tracking-wider mb-1">El cliente escanea y transfiere</p><p className="text-sm text-white font-bold truncate">{bank.name||'Banco'}</p><p className="text-base text-gold font-mono font-bold">{bank.account}</p>{bank.holder&&<p className="text-xs text-vr-gray truncate">{bank.holder}</p>}<p className="text-lg font-black font-mono text-white mt-1">{showCents(cents)}</p></div></div>;
}
