import {test,expect} from 'bun:test';
import {evaluateJev,JEV_MODEL} from '../lib/sharedJev';
test('Jev validates probabilities and evaluates long sources without truncating them',async()=>{
 let calls=0;const transport=(async(input:RequestInfo|URL,init?:RequestInit)=>{expect(String(input)).toBe('https://api.typesafe.ai/v1/systemone');const b=JSON.parse(String(init!.body));expect(b.model).toBe(JEV_MODEL);expect(Object.keys(b.questions)).toEqual(['relevant']);calls++;return Response.json({answers:{relevant:{noul:calls===2?.99:.1}}});}) as typeof fetch;
 const r=await evaluateJev('fake','Sources relevant to collaborators',[],{title:'Example',body:'x'.repeat(40000)},transport);expect(calls).toBe(2);expect(r.include).toBe(true);
 await expect(evaluateJev('fake','rule',[],{title:'x',body:'y'},(async()=>Response.json({answers:{relevant:{noul:8},unsuitable:{noul:0}}})) as typeof fetch)).rejects.toThrow('invalid decision');
});
test('uncertain or unrelated decisions do not authorize inclusion',async()=>{
 const transport=((async()=>Response.json({answers:{relevant:{noul:.7},unsuitable:{noul:0}}})) as typeof fetch);
 expect((await evaluateJev('fake','rule',[],{title:'Example',body:'Some text'},transport)).include).toBe(false);
});
