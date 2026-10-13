import {describe,it,expect} from 'vitest';
import {transferLink} from '../../apps/pos/src/features/sales/transfer-link';
const business={name:'Papelería Ñ · QA',rnc:null,address:null,phone:null,bank:{name:'Banco QA',account:'001-0123',holder:'María'}};
describe('Original public transfer link with exact native cents',()=>{
 it('preserves unicode, leading zero account and cents exclusively in the fragment',()=>{
  const url=new URL(transferLink(business,'11801')!);
  expect(url.origin+url.pathname).toBe('https://ventard.vercel.app/pagar');expect(url.search).toBe('');
  const data=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(url.hash.slice(3)),c=>c.charCodeAt(0))));
  expect(data).toEqual({banco:'Banco QA',cuenta:'001-0123',titular:'María',monto:118.01,nombre:business.name});
 });
 it('never rounds incompatible large values or fabricates a bank account',()=>{
  for(const cents of ['9007199254740991','900719925474099100','-1','1.1','bad'])expect(transferLink(business,cents)).toBeNull();
  expect(transferLink({...business,bank:null},'100')).toBeNull();
 });
});
