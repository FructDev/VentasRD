import type {BusinessHeader} from '../../platform/management';
/** Same public /pagar payload as VentaRD. A Tauri origin cannot be scanned
 * from a phone. The existing public portal receives no fragment at the server. */
export function transferLink(business:BusinessHeader,cents:string):string|null {
 if(!business.bank?.account||!/^\d+$/.test(cents))return null;
 const n=BigInt(cents),decimal=(n/100n).toString()+'.'+(n%100n).toString().padStart(2,'0');
 const amount=Number(decimal);
 // The public legacy page expects a number. Decline values that lose cents.
 if(!Number.isFinite(amount)||!Number.isSafeInteger(Number(cents))||amount.toFixed(2)!==decimal)return null;
 const wire=JSON.stringify(amount).match(/^(\d+)(?:\.(\d{1,2}))?$/);
 if(!wire||BigInt(wire[1])*100n+BigInt((wire[2]??'').padEnd(2,'0'))!==n)return null;
 const payload={banco:business.bank.name,cuenta:business.bank.account,titular:business.bank.holder,monto:amount,nombre:business.name};
 const encoded=btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))));
 return 'https://ventard.vercel.app/pagar#d='+encoded;
}
