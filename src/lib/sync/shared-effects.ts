import {sha256Hex} from './inventory/canonical-payload';
export function sharedEffectId(operationId:string,part:string):string{const h=sha256Hex('ventard.local-effect.v1/'+operationId+'/'+part);return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-${((parseInt(h[16],16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`}
