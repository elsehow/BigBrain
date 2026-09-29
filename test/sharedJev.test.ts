import {test,expect} from 'bun:test';
import {evaluateJev,JEV_MODEL} from '../lib/sharedJev';
test('Jev evaluates the entire source in one request with the inclusion rule unchanged',async()=>{
 const source={title:'Example project discussion',body:'x'.repeat(40000)+' Final context changes the interpretation.'};
 const rule='Sources about @Example. Audience: project collaborators.';
 let calls=0;
 const transport=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  expect(String(input)).toBe('https://api.typesafe.ai/v1/systemone');
  const b=JSON.parse(String(init!.body));expect(b.model).toBe(JEV_MODEL);
  expect(b.state.source).toEqual(source);
  expect(b.questions).toEqual({relevant:{type:'noul',instructions:{question:'Does this meet the inclusion rule?',rule},criteria:{true:'Meets the inclusion rule.',false:'Does not meet the inclusion rule.'}}});
  calls++;return Response.json({answers:{relevant:{noul:.77}},usage:{input_tokens:10000}});
 }) as typeof fetch;
 const r=await evaluateJev('fake',rule,[],source,transport);
 expect(calls).toBe(1);expect(r.include).toBe(false);expect(r.inputTokens).toBe(10000);
});
test('Jev rejects invalid probabilities and only includes scores meeting the threshold',async()=>{
 for(const score of [-1,8,null,'0.99'])await expect(evaluateJev('fake','rule',[],{title:'x',body:'y'},(async()=>Response.json({answers:{relevant:{noul:score}}})) as typeof fetch)).rejects.toThrow('invalid decision');
 for(const score of [.7,.79,.8,.99])expect((await evaluateJev('fake','rule',[],{title:'Example',body:'Some text'},(async()=>Response.json({answers:{relevant:{noul:score}}})) as typeof fetch)).include).toBe(score>=.8);
});
test('provider size rejection fails without retrying fragments',async()=>{
 let calls=0;
 const transport=(async()=>{calls++;return new Response('too large',{status:413})}) as typeof fetch;
 await expect(evaluateJev('fake','rule',[],{title:'Example',body:'x'.repeat(200000)},transport)).rejects.toThrow('Jev request failed (413)');
 expect(calls).toBe(1);
});
