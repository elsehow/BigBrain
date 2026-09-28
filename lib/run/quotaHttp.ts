/** Quota endpoints are optional observations. Never redirect credentials, retry,
 * persist tokens, or allow an unavailable account reading to fail model work. */
export async function quotaJson(url: string, headers: Record<string,string>, signal: AbortSignal, request: typeof fetch = fetch): Promise<any> {
  if (signal.aborted) return undefined;
  try {
    const response = await request(url, {headers,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(2000)])});
    if (!response.ok) return undefined;
    const reader=response.body?.getReader(); if(!reader)return undefined;
    const chunks:Uint8Array[]=[];let size=0;
    try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();return undefined;}chunks.push(value);}}
    finally{reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{return undefined;}
}
