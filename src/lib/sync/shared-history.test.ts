import {expect,it} from 'vitest';
import {sharedHistoryValue} from './shared-history';
it('decodes a copy including nested money, negative differences and timestamp tags',()=>{
 const original={total:{$number:'10.25'},diferencia:{$number:'-0.25'},items:[{monto:{$number:'2.25'},fecha:{$milliseconds:'1792082416191'},tiny:{$number:'0.0000001'}}],memo:'$number is text'};
 const before=JSON.stringify(original);
 expect(sharedHistoryValue(original)).toEqual({total:10.25,diferencia:-0.25,items:[{monto:2.25,fecha:1792082416191,tiny:0.0000001}],memo:'$number is text'});expect(JSON.stringify(original)).toBe(before);
});
it('refuses rounded, out-of-range and malformed tagged values',()=>{
 for(const value of [{$number:'90071992547409.91'},{$number:'9007199254740992'},{$number:'0.10000000000000001'},{$number:'NaN'},{$number:'Infinity'},{$number:''},{$number:'1',extra:true},{$milliseconds:123},{$number:'1e9999'}])expect(()=>sharedHistoryValue(value)).toThrow('SHARED_HISTORY_NUMBER_INVALID');
});
