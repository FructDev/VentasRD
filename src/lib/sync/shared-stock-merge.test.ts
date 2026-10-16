import {describe,it,expect} from 'vitest';
import {sharedStockBefore} from './shared-stock-merge';
import {sharedEffectId} from './shared-effects';
const productId='96000001-0000-4000-8000-000000000020',op='96000001-0000-4000-8000-000000008160';
const proof={remoteBaseQty:'100',remoteSequence:'0',pending:[],effectiveQty:'100'};
const entry={operationId:op,effectId:sharedEffectId(op,'stock/'+productId),delta:'-1',remoteSequence:'1',kind:'SALE_CONFIRM'};
const row=()=>({productId,merge:{protocol:'ventard.stock.merge.1',quotedBefore:'100',appliedBefore:'99',concurrent:[{...entry}]}});
describe('authoritative additive stock evidence',()=>{
 it('accepts the original proof and a separate concurrent effect',()=>expect(sharedStockBefore(row(),proof,'2')).toBe(BigInt(99)));
 it.each(['amount','effect','sequence','count','duplicate','overflow','quote','pending'])('rejects %s evidence',kind=>{
  const r=row(),p={...proof,pending:[] as {effectId:string;delta:string}[]};
  if(kind==='amount')r.merge.appliedBefore='98';if(kind==='effect')r.merge.concurrent[0].effectId=op;
  if(kind==='sequence')r.merge.concurrent[0].remoteSequence='2';if(kind==='count')r.merge.concurrent[0].kind='INVENTORY_COUNT';
  if(kind==='duplicate')r.merge.concurrent.push({...entry});if(kind==='overflow')r.merge.concurrent[0].delta='2147483648';
  if(kind==='quote')r.merge.quotedBefore='99';if(kind==='pending')p.pending=[{effectId:entry.effectId,delta:'0'}];
  expect(()=>sharedStockBefore(r,p,'2')).toThrow('SHARED_RECEIPT_MISMATCH');
 });
});
