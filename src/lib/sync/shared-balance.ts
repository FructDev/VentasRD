import {moneyCents} from '@/lib/domain/local/command';
/** Historical transactions stay unchanged. This offset records the authoritative
 * opening balance that was not reconstructible from the downloaded history. */
export function sharedBalanceCents(customer:{negocio_id:string;id:string;shared_balance_offset_cents?:string},rows:readonly {negocio_id:string;cliente_id:string;tipo:string;monto:number}[]):number{
 const offset=customer.shared_balance_offset_cents??'0';if(!(/^-?(0|[1-9][0-9]{0,15})$/).test(offset))throw Error('SHARED_BALANCE_RANGE');let value=BigInt(offset);
 for(const row of rows)if(row.negocio_id===customer.negocio_id&&row.cliente_id===customer.id)value+=BigInt(moneyCents(row.monto))*(row.tipo==='cargo'?BigInt(1):BigInt(-1));
 if(!Number.isSafeInteger(Number(value)))throw Error('SHARED_BALANCE_RANGE');return Number(value);
}
