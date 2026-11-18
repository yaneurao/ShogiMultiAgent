'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
(async()=>{
 const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'live-search-ui-')),engine=path.join(tmp,'engine');let app,socket;
 fs.writeFileSync(engine,`#!/usr/bin/env python3
import sys
for line in sys.stdin:
 line=line.strip()
 if line=='usi': print('usiok',flush=True)
 elif line=='isready': print('readyok',flush=True)
 elif line.startswith('go '):
  print('info depth 32 seldepth 55 score cp 42 lowerbound nps 123456 pv 7g7f 3c3d 2g2f 8c8d 2f2e',flush=True)
  print('info depth 33 seldepth 56 score cp 35 upperbound nps 234567 pv 2g2f 8c8d',flush=True)
  print('bestmove 7g7f',flush=True)
 elif line=='quit': break
`);fs.chmodSync(engine,0o755);
 const server=net.createServer(s=>{socket=s;let buf='';s.on('data',data=>{buf+=data;let n;while((n=buf.indexOf('\n'))>=0){const line=buf.slice(0,n);buf=buf.slice(n+1);if(line.startsWith('LOGIN '))s.write('LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:live-ui\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n');else if(line==='AGREE')s.write('START:live-ui\n');}});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox','--password-store=basic',root],env:{...process.env,HOME:tmp,XDG_CONFIG_HOME:path.join(tmp,'config')}});
  const page=await app.firstWindow();
  await page.evaluate(async({engine,port})=>{await window.arena.save({label:'通常思考',name:'Test',host:`127.0.0.1:${port}`,pool:'test',engine,options:'',ponder:false});const state=await window.arena.state();await window.arena.start(state.profiles[0].id);},{engine,port:server.address().port});
  await page.locator('#view-tab-participation').click();
  await page.waitForFunction(async()=>{const s=(await window.arena.state()).sessions[0];return s?.search?.rows?.length===2&&s.search.mode==='waiting';});
  await page.waitForFunction(()=>document.querySelectorAll('.live-search-row').length===2);
  assert.equal(await page.locator('#live-search-mode').textContent(),'待機中');
  const rows=await page.locator('.live-search-row').allTextContents();
  assert.match(rows[0],/33\/56.*35.*--.*234567.*２六歩/);
  assert.match(rows[1],/32\/55.*42.*\+\+.*123456.*７六歩/);
  assert(!rows[1].includes('２五歩'));
  const geometry=await page.evaluate(()=>{const pane=document.querySelector('#live-search'),graph=document.querySelector('#analysis');graph.hidden=false;const before=[pane.getBoundingClientRect().height,graph.getBoundingClientRect().top];renderLiveSearch({ponder:false,search:{mode:'thinking',rows:Array(50).fill({depth:1,pv:[]})}});const after=[pane.getBoundingClientRect().height,graph.getBoundingClientRect().top];return {before,after,scroll:document.querySelector('#live-search-rows').scrollHeight>document.querySelector('#live-search-rows').clientHeight};});
  assert(Math.abs(geometry.before[0]-geometry.after[0])<1&&Math.abs(geometry.before[1]-geometry.after[1])<1,JSON.stringify(geometry));assert(geometry.scroll);
  socket.write('+7776FU,T0\n');await page.waitForFunction(async()=>(await window.arena.state()).sessions[0].ply===1);assert.equal((await page.evaluate(async()=>(await window.arena.state()).sessions[0].search.rows.length)),2);
  console.log('PASS: unpondered rapid PV updates, ordering, bounds, four moves, fixed layout and waiting display');
 }finally{if(app)app.process().kill('SIGKILL');socket?.destroy();server.close();fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
