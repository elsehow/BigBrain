import {expect,test} from 'bun:test';
import {createAnthropicQuota,anthropicWindows} from '../lib/run/anthropicQuota';
test('Claude quota uses Pi identity, caches bounded observations, and never journals account details',async()=>{
  const calls:string[]=[];
  const quota=createAnthropicQuota((async(url,options)=>{
    calls.push(String(url));expect(options!.redirect).toBe('error');
    expect(options!.headers).toEqual({Authorization:'Bearer sk-ant-oat-fixture','anthropic-beta':'oauth-2025-04-20'});
    return Response.json(String(url).endsWith('/profile')?{account:{uuid:'fixture-account',email:'fixture@example.com'},organization:{uuid:'fixture-org'}}:{five_hour:{utilization:20,resets_at:'2026-10-01T00:00:00Z'},seven_day:null});
  }) as typeof fetch);
  const signal=new AbortController().signal;
  const id=await quota.account('sk-ant-oat-fixture',signal);expect(id).toHaveLength(64);
  const first=await quota.read('sk-ant-oat-fixture',signal);await Bun.sleep(5);
  const second=await quota.read('sk-ant-oat-fixture',signal);
  expect(first).toEqual(second);expect(first[0]).toMatchObject({accountId:id,window:'five_hour',used:.2});expect(calls).toHaveLength(2);
  expect(JSON.stringify(first)).not.toContain('fixture');
});
test('invalid identity, failed observations and malformed windows stay unavailable',async()=>{
  const quota=createAnthropicQuota((async()=>Response.json({error:'unavailable'})) as typeof fetch);
  expect(await quota.read('sk-ant-oat-fixture',new AbortController().signal)).toEqual([]);
  expect(await quota.read('fixture',new AbortController().signal)).toEqual([]);
  for(const utilization of [-1,101,NaN,'20'])expect(anthropicWindows({five_hour:{utilization,resets_at:'2026-10-01T00:00:00Z'}})).toEqual([]);
  expect(anthropicWindows({five_hour:{utilization:20,resets_at:'invalid'}})).toEqual([]);
});
