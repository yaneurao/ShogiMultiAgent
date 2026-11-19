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
  print('info depth 92 multipv 1 score cp 65 nodes 0 nps 0 hashfull 0 time 0 pv 2g2f 9c9d 2f2e 4a3b',flush=True)
  print('info depth 92 multipv 2 score cp 65 nodes 0 nps 0 hashfull 0 time 0 pv 7g7f 8c8d 2g2f 4a3b',flush=True)
  print('info depth 23 multipv 3 score cp 34 nodes 0 nps 0 hashfull 0 time 0 pv 6i7h 4a3b 2g2f 8c8d',flush=True)
  print('info depth 5 multipv 4 score cp 26 nodes 0 nps 0 hashfull 0 time 0 pv 1g1f 3c3d 6i7h 3a3b',flush=True)
  print('info depth 37 multipv 5 score cp 14 nodes 0 nps 0 hashfull 0 time 0 pv 3i3h 3c3d 6i7h 8c8d',flush=True)
  print('info depth 37 multipv 6 score cp 14 nodes 0 nps 0 hashfull 0 time 0 pv 3i4h 8c8d 6i7h 3c3d',flush=True)
  print('bestmove 7g7f',flush=True)
 elif line=='quit': break
`);fs.chmodSync(engine,0o755);
 const server=net.createServer(s=>{socket=s;let buf='';s.on('data',data=>{buf+=data;let n;while((n=buf.indexOf('\n'))>=0){const line=buf.slice(0,n);buf=buf.slice(n+1);if(line.startsWith('LOGIN '))s.write('LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:live-ui\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n');else if(line==='AGREE')s.write('START:live-ui\n');}});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox','--password-store=basic',root],env:{...process.env,HOME:tmp,XDG_CONFIG_HOME:path.join(tmp,'config')}});
  const page=await app.firstWindow();assert.match(await page.locator('#live-search h3').textContent(),/思考ログ/);await page.evaluate(()=>renderLiveSearch({search:{mode:'history',rows:[]}}));assert.equal(await page.locator('#live-search-rows').textContent(),'');
  await page.evaluate(async({engine,port})=>{await window.arena.save({label:'通常思考',name:'Test',host:`127.0.0.1:${port}`,pool:'test',engine,options:'',ponder:false});const state=await window.arena.state();await window.arena.start(state.profiles[0].id);},{engine,port:server.address().port});
  await page.locator('#view-tab-participation').click();
  await page.waitForFunction(async()=>{const s=(await window.arena.state()).sessions[0];return s?.search?.rows?.length===6&&s.search.mode==='waiting';});
  await page.waitForFunction(()=>document.querySelectorAll('.live-search-row').length===6);
  const cells=await page.locator('.live-search-row').evaluateAll(rows=>rows.map(row=>[...row.children].map(cell=>cell.textContent)));
  assert.deepEqual(cells.map(row=>row[1]),['37','37','5','23','92','92']);
  assert.deepEqual(cells.map(row=>row[0]),Array(6).fill('00:00'));
  assert.deepEqual(cells.map(row=>row[2]),['14','14','26','34','65','65']);
  const alignment=await page.evaluate(()=>{const headers=[...document.querySelector('.live-search-columns').children],row=[...document.querySelector('.live-search-row').children];return headers.slice(0,3).map((h,i)=>({header:h.getBoundingClientRect().right,cell:row[i].getBoundingClientRect().right,align:getComputedStyle(h).textAlign,valueAlign:getComputedStyle(row[i]).textAlign,padding:parseFloat(getComputedStyle(row[i]).paddingRight)}));});assert(alignment.every(a=>a.align==='center'&&a.valueAlign==='right'&&a.padding>0&&Math.abs(a.header-a.cell)<1),JSON.stringify(alignment));
  const state=await page.evaluate(()=>window.arena.state());assert.equal(state.sessions[0].score,'65');
  if(process.env.VIEWER_SCREENSHOT)await page.screenshot({path:process.env.VIEWER_SCREENSHOT});
  console.log('PASS: multipv opening lines retain each supplied depth and score');
 }finally{if(app)app.process().kill('SIGKILL');socket?.destroy();server.close();fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
