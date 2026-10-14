import {useEffect} from 'react';
import type {PosProduct} from '../../platform/pos-adapter';
export function useProductPhotos(products:PosProduct[],load?:((requests:{id:string;version:string}[])=>Promise<void>)){
 const key=JSON.stringify(products.filter(p=>p.photoVersion&&!p.photo&&!p.photoUnavailable).slice(0,12).map(p=>({id:p.id,version:p.photoVersion!})));
 useEffect(()=>{if(load&&key!=='[]')void load(JSON.parse(key));},[key,load]);
}
