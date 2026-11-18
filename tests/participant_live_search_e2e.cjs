'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'live-search-ui-'));let app;
 try{
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox','--password-store=basic',root],env:{...process.env,HOME:tmp,XDG_CONFIG_HOME:path.join(tmp,'config')}});
  const page=await app.firstWindow();
  await page.evaluate(()=>renderLiveSearch({ponder:true,search:{mode:'pondering',depth:17,score:'42',pv:['7g7f'],sfen:'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1'}}));
  assert.equal(await page.locator('#live-search-mode').textContent(),'先読み中');
  assert.match(await page.locator('#live-search-info').textContent(),/depth: 17.*評価値: 42/);
  assert.match(await page.locator('#live-search-pv').textContent(),/７六歩/);
  await page.evaluate(()=>renderLiveSearch({ponder:false,search:{mode:'waiting'}}));
  assert.equal(await page.locator('#live-search-mode').textContent(),'先読み無効');
  assert.match(await page.locator('#live-search-pv').textContent(),/—/);
  console.log('PASS: live search panel renders ponder state and Japanese PV');
 }finally{if(app)await app.close();fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
