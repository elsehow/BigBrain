// Eight-second light-theme take: all 36 unread messages attach to Pilot.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {mkdirSync,writeFileSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {execFileSync}=require('node:child_process');
const base=process.env.DEMO_URL||'http://127.0.0.1:5181';
const output=resolve(process.env.DEMO_OUTPUT||join(__dirname,'..'));
const take=new Date().toISOString().replace(/[:.]/g,'-');
const dir=join(output,'takes',`assembly-${take}`);mkdirSync(dir,{recursive:true});

(async()=>{
 const browser=await chromium.launch({channel:process.env.DEMO_BROWSER||'chrome',headless:true});
 const ctx=await browser.newContext({viewport:{width:1920,height:1080},recordVideo:{dir,size:{width:1920,height:1080}}});
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));const frames=[];
 try{
  await page.goto(`${base}/inbox-demo.html?theme=default&assembly=1`);
  await page.locator('.g-canvas canvas').last().waitFor();await page.waitForTimeout(1000);
  const cdp=await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame',frame=>{
    const file=join(dir,`frame-${String(frames.length).padStart(5,'0')}.png`);
    writeFileSync(file,Buffer.from(frame.data,'base64'));
    frames.push({file,time:frame.metadata.timestamp});
    void cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId});
  });
  await cdp.send('Page.startScreencast',{format:'png',maxWidth:1920,maxHeight:1080,everyNthFrame:1});
  await page.waitForTimeout(1800);
  await page.keyboard.press('Shift+Enter');
  await page.locator('.pilot-panel .context').filter({hasText:'36'}).waitFor();
  await page.mouse.move(1900,1050);
  await page.waitForTimeout(6200);
  await cdp.send('Page.stopScreencast');
  await page.screenshot({path:join(dir,'all-connected.png')});
  writeFileSync(join(dir,'timings.json'),JSON.stringify({theme:'default',unreads:36,openPilotMs:1800,holdAfterConnectionMs:6200,editorialEffects:false},null,2));
  if(errors.length)throw Error(errors.join('\n'));
 }finally{await ctx.close();await browser.close();}
 if(frames.length<60)throw Error(`Too few captured frames: ${frames.length}`);
 const duration=frames.at(-1).time-frames[0].time;
 const concat=join(dir,'frames.txt');
 writeFileSync(concat,frames.map((f,i)=>`file '${f.file.replaceAll("'", "'\\''")}'\nduration ${i+1<frames.length?(frames[i+1].time-f.time):Math.max(1/30,duration-(f.time-frames[0].time))}`).join('\n')+`\nfile '${frames.at(-1).file}'\n`);
 const result=join(output,`BigBrain-messages-assembling-light-${take}-8s-1080p.mp4`);
 execFileSync('ffmpeg',['-y','-loglevel','error','-f','concat','-safe','0','-i',concat,'-vf',`setpts=(PTS-STARTPTS)*${8/(duration+1/30)},fps=30,tpad=stop_mode=clone:stop_duration=0.1`,'-frames:v','240','-c:v','libx264','-crf','12','-pix_fmt','yuv420p','-movflags','+faststart',result]);
 console.log(result);
})().catch(e=>{console.error(e);process.exitCode=1});
