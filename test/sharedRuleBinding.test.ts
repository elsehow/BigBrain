import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setRule,tickRules} from '../lib/sharedRules';
test('automatic sharing is bound to the personal vault that saved the rule',async()=>{
 const root=mkdtempSync(join(tmpdir(),'inclusion-binding-')),store=join(root,'connections.json');
 try{
  writeFileSync(store,JSON.stringify([{id:'example',name:'Example',endpoint:'https://example.invalid',token:'fabricated'}]));
  const rule=setRule(store,'example','Sources about collaboration.',root);expect(rule?.root).toBe(root);
  const before=readFileSync(store+'.rules.json','utf8');
  await tickRules(root+'-other',store);expect(readFileSync(store+'.rules.json','utf8')).toBe(before);
  const legacy={...rule};delete legacy.root;writeFileSync(store+'.rules.json',JSON.stringify({example:legacy}));
  const unbound=readFileSync(store+'.rules.json','utf8');await tickRules(root,store);expect(readFileSync(store+'.rules.json','utf8')).toBe(unbound);
 }finally{rmSync(root,{recursive:true,force:true});}
});
