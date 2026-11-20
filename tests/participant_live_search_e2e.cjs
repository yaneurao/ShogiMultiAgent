'use strict';
const {waitForAsync}=require('./wait_for_async.cjs');
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
  print('info depth 32 seldepth 55 time 2345 nodes 1234 score cp 42 lowerbound nps 123456 pv 7g7f 3c3d 2g2f 8c8d 2f2e',flush=True)
  print('info depth 33 seldepth 56 time 12034 nodes 9876 score cp 35 upperbound nps 234567 pv 2g2f 8c8d',flush=True)
  print('info nodes 11111 nps 345678',flush=True)
  print('bestmove 7g7f',flush=True)
 elif line=='quit': break
`);fs.chmodSync(engine,0o755);
 const server=net.createServer(s=>{socket=s;let buf='';s.on('data',data=>{buf+=data;let n;while((n=buf.indexOf('\n'))>=0){const line=buf.slice(0,n);buf=buf.slice(n+1);if(line.startsWith('LOGIN '))s.write('LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:live-ui\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n');else if(line==='AGREE')s.write('START:live-ui\n');}});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox','--password-store=basic',root],env:{...process.env,HOME:tmp,XDG_CONFIG_HOME:path.join(tmp,'config')}});
  const page=await app.firstWindow();assert.deepEqual(await page.evaluate(()=>[null,0,1000,59999,60000,3599999,3600000,7200000,36000000].map(searchTime)),['—','00:00','00:01','00:59','01:00','59:59','1:00:00','2:00:00','10:00:00']);assert.match(await page.locator('#live-search h3').textContent(),/思考ログ/);await page.evaluate(()=>renderLiveSearch({search:{mode:'history',rows:[]}}));assert.equal(await page.locator('#live-search-rows').textContent(),'');
  await page.evaluate(async({engine,port})=>{await window.arena.save({label:'通常思考',name:'Test',host:`127.0.0.1:${port}`,pool:'test',engine,options:'',ponder:false});const state=await window.arena.state();await window.arena.start(state.profiles[0].id);},{engine,port:server.address().port});
  await page.locator('#view-tab-participation').click();
  await waitForAsync(page,async()=>{const s=(await window.arena.state()).sessions[0];return s?.search?.rows?.length===2&&s.search.mode==='waiting';});
  await page.waitForFunction(()=>document.querySelectorAll('.live-search-row').length===2);
  assert.equal(await page.locator('.sessions-table th').nth(7).textContent(),'評価値');const web=page.getByRole('button',{name:'ブラウザで対局を開く'});assert(await web.isDisabled());assert.equal(await web.textContent(),'e');assert(await page.evaluate(async()=>{try{await arena.openGameUrl((await arena.state()).sessions[0].id);return false;}catch{return true;}}));
  assert.equal(await page.locator('#live-search-mode').textContent(),'待機中');
  const cells=await page.locator('.live-search-row').evaluateAll(rows=>rows.map(row=>[...row.children].map(cell=>cell.textContent)));
  assert.deepEqual(cells[0].slice(0,4),['00:12','33/56','35','++']);
  assert.deepEqual(cells[1].slice(0,4),['00:02','32/55','42','--']);
  assert.match(cells[0][4],/２六歩/);assert(!cells[1][4].includes('２五歩'));
  assert.equal(await page.locator('#live-search-nodes').textContent(),'探索局面数: 11,111');assert.equal(await page.locator('#live-search-nps').textContent(),'nps: 345,678');
  assert(!((await page.locator('#live-search').textContent()).includes('Bound')));
  const columns=await page.locator('.live-search-row').evaluateAll(rows=>rows.map(row=>[...row.children].map(cell=>cell.getBoundingClientRect().left)));assert.deepEqual(columns[0],columns[1]);
  const geometry=await page.evaluate(()=>{const pane=document.querySelector('#live-search'),graph=document.querySelector('#analysis');graph.hidden=false;const before=[pane.getBoundingClientRect().height,graph.getBoundingClientRect().top];renderLiveSearch({ponder:false,search:{mode:'thinking',rows:Array(50).fill({depth:1,pv:[]})}});const after=[pane.getBoundingClientRect().height,graph.getBoundingClientRect().top];return {before,after,scroll:document.querySelector('.live-search-scroll').scrollHeight>document.querySelector('.live-search-scroll').clientHeight};});
  assert(Math.abs(geometry.before[0]-geometry.after[0])<1&&Math.abs(geometry.before[1]-geometry.after[1])<1,JSON.stringify(geometry));assert(geometry.scroll);
  socket.write('+7776FU,T0\n');await waitForAsync(page,async()=>(await window.arena.state()).sessions[0].ply===1);assert.equal((await page.evaluate(async()=>(await window.arena.state()).sessions[0].search.rows.length)),2);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(720,700));await page.waitForFunction(()=>window.innerWidth===720);assert(await page.evaluate(()=>{const controls=document.querySelector('.game-controls').getBoundingClientRect(),analysis=document.querySelector('#analysis').getBoundingClientRect(),graph=document.querySelector('#graph').getBoundingClientRect();return analysis.top>=controls.bottom&&graph.top>=analysis.bottom;}));await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1350,860));
  await page.locator('#back').click();await page.locator('#live-search-mode').filter({hasText:'過去の局面'}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.live-search-row').length===2);assert.equal((await page.locator('.live-search-row').first().locator('span').nth(1).textContent()),'33/56');
  await page.evaluate(()=>{const node=document.querySelector('.live-search-row span:nth-child(2)').firstChild;window.savedSearchNode=node;const range=document.createRange();range.selectNodeContents(node);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);});
  for(let i=0;i<4;i++){await page.evaluate(()=>render(current));await page.waitForTimeout(180);}
  assert(await page.evaluate(()=>window.savedSearchNode===document.querySelector('.live-search-row span:nth-child(2)').firstChild));assert.equal(await page.evaluate(()=>window.getSelection().toString()),'33/56');
  await page.locator('#last').click();await page.waitForFunction(()=>document.querySelectorAll('.live-search-row').length===2);assert(await page.evaluate(()=>{const active=current.sessions.find(s=>s.id===selected),node=document.querySelector('.live-search-row');renderLiveSearch({...active,search:{...active.search,nodes:999999}});return node===document.querySelector('.live-search-row');}));
  await page.locator('#back').click();await page.waitForFunction(()=>document.querySelectorAll('.live-search-row').length===2&&document.querySelector('#live-search-mode').textContent==='過去の局面');
  const state=await page.evaluate(()=>window.arena.state());assert(!('searchHistory' in state.sessions[0]));const game=await page.evaluate(id=>window.arena.game(id),state.sessions[0].id);assert(!('searchHistory' in game));
  await page.locator('#last').click();await page.locator('#sessions').getByRole('button',{name:'強制終了',exact:true}).click();assert(!(await page.locator('#sessions').textContent()).includes('対局中なら切断負けになります。'));await page.locator('#sessions').getByRole('button',{name:'強制終了する'}).click();await waitForAsync(page,async()=>!(await window.arena.state()).sessions[0].isActive);assert(!(await page.locator('#sessions').textContent()).includes('終了コード'));await page.locator('#log').filter({hasText:'強制終了'}).waitFor();
  console.log('PASS: live search history, fixed layout and forced shutdown logging');
 }finally{if(app)app.process().kill('SIGKILL');socket?.destroy();server.close();fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
