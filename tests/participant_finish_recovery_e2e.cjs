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
  app=await electron.launch(options);let page=await app.firstWindow();
  await app.evaluate(()=>{const fs=process.mainModule.require('node:fs/promises');const rename=fs.rename;fs.rename=(from,to)=>String(to).endsWith('.json')&&String(to).includes('game-history')?new Promise(()=>{}):rename(from,to);});
  const ids=await page.evaluate(async ({engine})=>Promise.all(['Finished','Interrupted'].map(name=>arena.save({label:name,name,host:'example:4081',engine,pool:'test',options:''}))),{engine});
  for(const id of ids)await page.evaluate(id=>arena.start(id),id);
  await waitForAsync(page,async()=>(await arena.state()).sessions.filter(s=>s.gameInProgress).length===2);
  const sessions=(await page.evaluate(()=>arena.state())).sessions;await page.evaluate(id=>arena.stop(id),sessions.find(s=>s.name==='Finished').id);
  const pending=path.join(tmp,'config','shogizone-participant','game-history','pending');let hasFinish=false;
  for(let i=0;i<150;i++){hasFinish=fs.existsSync(pending)&&fs.readdirSync(pending).filter(n=>n.endsWith('.ndjson')).some(n=>fs.readFileSync(path.join(pending,n),'utf8').includes('"type":"finish"'));if(hasFinish)break;await new Promise(r=>setTimeout(r,50));}
  assert(hasFinish,'terminal result must be journaled before history finalization');await kill();
  app=await electron.launch(options);page=await app.firstWindow();await waitForAsync(page,async()=>(await arena.records()).length===2);
  const records=await page.evaluate(()=>arena.records()),finished=records.find(r=>r.label==='Finished'),interrupted=records.find(r=>r.label==='Interrupted');
  assert.equal(finished.result,'#WIN');assert.equal(finished.reason,'#RESIGN');assert.equal(finished.recordError,null);
  assert.equal(interrupted.result,'#UNKNOWN');assert.match(interrupted.recordError,/中断/);
  await page.locator('#view-tab-records').click();const row=page.locator('#records tr.record-row').filter({hasText:'Interrupted'});await row.locator('.record-write-error').waitFor();assert(await row.getByRole('button',{name:'コピー'}).isDisabled());
  assert(await page.evaluate(async id=>{try{await arena.copyRecord(id);return false;}catch(e){return e.message.includes('中断');}},interrupted.id));
  console.log('PASS: journaled terminal result survives crash; interrupted CSA is flagged and blocked');
 }finally{if(app)await kill();fs.rmSync(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(e=>{console.error(e);process.exitCode=1;});
