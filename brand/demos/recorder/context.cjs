// One continuous seven-second shot, including graph and panel transitions.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {mkdirSync,writeFileSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {execFileSync}=require('node:child_process');
const base=process.env.DEMO_URL||'http://127.0.0.1:5181';
const output=resolve(process.env.DEMO_OUTPUT||join(__dirname,'..'));
const take=new Date().toISOString().replace(/[:.]/g,'-');
const dir=join(output,'takes',`context-${take}`);mkdirSync(dir,{recursive:true});
const cues=[{ms:1500,count:3,answer:false},{ms:1900,count:5,answer:false},{ms:2300,count:8,answer:false},{ms:2700,count:11,answer:false},{ms:3100,count:13,answer:false},{ms:3600,count:13,answer:true}];
(async()=>{
 const browser=await chromium.launch({channel:process.env.DEMO_BROWSER||'chrome',headless:true});
 const ctx=await browser.newContext({viewport:{width:1920,height:1080},recordVideo:{dir,size:{width:1920,height:1080}}});
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));let raw;const frames=[];
 try{
  await page.goto(`${base}/context-demo.html`);await page.getByText('What’s next on the Atlas project?',{exact:true}).waitFor();await page.waitForTimeout(1600);
  const cdp=await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame',frame=>{
    const file=join(dir,`frame-${String(frames.length).padStart(5,'0')}.png`);
    writeFileSync(file,Buffer.from(frame.data,'base64'));
    frames.push({file,time:frame.metadata.timestamp});
    void cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId});
  });
  await cdp.send('Page.startScreencast',{format:'png',maxWidth:1920,maxHeight:1080,everyNthFrame:1});
  await page.evaluate(async cues=>{
    const start=performance.now();window.contextBeats=[];window.layoutSamples=[];
    const sample=()=>{const drawer=document.querySelector('.drawer');const r=drawer?.getBoundingClientRect();window.layoutSamples.push({x:r?.x,y:r?.y,width:r?.width,height:r?.height,bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()});if(performance.now()-start<7300)requestAnimationFrame(sample)};sample();
    for(const cue of cues)setTimeout(()=>{
      window.contextBeats.push({...cue,actualMs:performance.now()-start});
      window.dispatchEvent(new CustomEvent('bb:context-cue',{detail:cue}));
    },cue.ms);
    await new Promise(resolve=>setTimeout(resolve,7300));
  },cues);
  await cdp.send('Page.stopScreencast');
  await page.getByText('Three next steps for Atlas',{exact:true}).waitFor();
  const samples=await page.evaluate(()=>window.layoutSamples);
  const geometries=[...new Set(samples.filter(s=>s.width).map(s=>JSON.stringify([s.x,s.y,s.width,s.height])))];
  const backgrounds=[...new Set(samples.map(s=>s.bg))];
  if(geometries.length!==1 || backgrounds.length!==1)throw Error(JSON.stringify({geometries,backgrounds}));
  writeFileSync(join(dir,'layout-check.json'),JSON.stringify({frames:samples.length,geometries,backgrounds},null,2));
  raw=await page.video().path();
  writeFileSync(join(dir,'timings.json'),JSON.stringify({cues,actual:await page.evaluate(()=>window.contextBeats),frames:210,theme:'phosphor',continuous:true},null,2));
  if(errors.length)throw Error(errors.join('\n'));
 }finally{await ctx.close();await browser.close();}
 if(frames.length<60)throw Error(`Too few captured frames: ${frames.length}`);
 const duration=7.3;
 const concat=join(dir,'frames.txt');
 writeFileSync(concat,frames.map((f,i)=>`file '${f.file.replaceAll("'", "'\\''")}'\nduration ${i+1<frames.length?(frames[i+1].time-f.time):Math.max(1/30,7.3-(f.time-frames[0].time))}`).join('\n')+`\nfile '${frames.at(-1).file}'\n`);
 const result=join(output,`BigBrain-atlas-context-phosphor-unzoomed-${take}-7s-1080p.mp4`);
 execFileSync('ffmpeg',['-y','-loglevel','error','-f','concat','-safe','0','-i',concat,'-vf',`setpts=(PTS-STARTPTS)*${7/(duration+1/30)},fps=30,tpad=stop_mode=clone:stop_duration=0.1`,'-frames:v','210','-c:v','libx264','-crf','12','-pix_fmt','yuv420p','-movflags','+faststart',result]);
 console.log(result);
})().catch(e=>{console.error(e);process.exitCode=1});
