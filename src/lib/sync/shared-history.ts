// The verified migration archive keeps normalized numeric tags. Decode only a
// copy for the existing web tables; never change its bytes, hash or authority.
function invalid():never{throw Error('SHARED_HISTORY_NUMBER_INVALID')}
function decimalSignature(raw:string):string{
 if(raw.length>256)invalid();
 const m=/^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(raw);if(!m)invalid();
 let exponent=Number(m[4]??'0')-(m[3]?.length??0),coefficient=BigInt(m[2]+(m[3]??''));
 if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>1024)invalid();
 if(coefficient===BigInt(0))return '0';
 while(coefficient%BigInt(10)===BigInt(0)){coefficient/=BigInt(10);exponent++}
 return m[1]+coefficient.toString()+'e'+exponent;
}
export function sharedHistoryValue(value:unknown,depth=0):unknown{
 if(depth>64)invalid();
 if(Array.isArray(value))return value.map(v=>sharedHistoryValue(v,depth+1));
 if(value&&typeof value==='object'){
  const record=value as Record<string,unknown>,keys=Object.keys(record);
  if(Object.hasOwn(record,'$number')||Object.hasOwn(record,'$milliseconds')){
   if(keys.length!==1)invalid();const raw=record[keys[0]];if(typeof raw!=='string')invalid();
   const signature=decimalSignature(raw),number=Number(raw);
   if(!Number.isFinite(number)||Math.abs(number)>Number.MAX_SAFE_INTEGER||decimalSignature(String(number))!==signature)invalid();
   return number;
  }
  return Object.fromEntries(keys.map(key=>[key,sharedHistoryValue(record[key],depth+1)]));
 }
 return value;
}
