'use strict';
const {waitForAsync}=require('./wait_for_async.cjs');
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'participant-finish-recovery-')),project=path.join(tmp,'project'),engine=path.join(tmp,'engine');
 fs.mkdirSync(project);fs.cpSync(path.join(root,'app'),path.join(project,'app'),{recursive:true});fs.copyFileSync(path.join(root,'package.json'),path.join(project,'package.json'));fs.mkdirSync(path.join(project,'agent'));fs.writeFileSync(engine,'engine');
 const fake=path.join(project,'agent','usi-agent');fs.writeFileSync(fake,`#!/usr/bin/env python3
import json,sys,os
cfg=json.loads(sys.stdin.readline());name=cfg['name'];p=os.path.join(cfg['record_dir'],name+'.csa')
with open(p,'w') as f:f.write('V2.2\\n')
def emit(event,**args):print(json.dumps(dict(event=event,**args)),flush=True)
emit('record',path=p)
emit('game_started',side='black',game_id=name,black=name,white='Other',sfen='lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1',ply=0,clocks=[60,60])
sys.stdin.readline()
emit('game_finished',result='#WIN',reason='#RESIGN')
`);fs.chmodSync(fake,0o755);
 const options={executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox','--password-store=basic',project],env:{...process.env,HOME:tmp,XDG_CONFIG_HOME:path.join(tmp,'config')}};let app;
 async function kill(){const exit=new Promise(resolve=>app.process().once('exit',resolve));app.process().kill('SIGKILL');await exit;app=null;}
 try{
  app=await electron.launch(options);const page=await app.firstWindow();
  const id=await page.evaluate(({engine})=>arena.save({label:'断線',name:'Test',host:'example:4081',engine,pool:'test',options:''}),{engine});await page.evaluate(id=>arena.start(id),id);
  await waitForAsync(page,async()=>(await arena.state()).sessions.some(s=>s.gameInProgress));
  const session=(await page.evaluate(()=>arena.state())).sessions[0];await page.evaluate(id=>arena.force(id),session.id);
  await waitForAsync(page,async()=>(await arena.records()).length===1);
  const r=(await page.evaluate(()=>arena.records()))[0];await page.locator('#view-tab-records').click();const row=page.locator('#records tr.record-row').first();await row.waitFor();console.log('saved result:',r.result,'reason:',r.reason,'visible:',await row.innerText());assert.equal(r.result,'#UNKNOWN');assert((await row.innerText()).includes('結果不明'));assert.equal(await page.evaluate(()=>recordResult({result:'#CENSORED',recordError:'対局が中断したため、CSA棋譜が最後まで保存されていません。'}).label),'結果不明');assert.equal(await page.evaluate(()=>recordResult({result:'#CENSORED',reason:'#ABNORMAL'}).label),'無効試合');

 }finally{if(app)await kill();try{fs.rmSync(tmp,{recursive:true,force:true,maxRetries:20,retryDelay:100});}catch{}}
})().catch(e=>{console.error(e);process.exitCode=1;});
