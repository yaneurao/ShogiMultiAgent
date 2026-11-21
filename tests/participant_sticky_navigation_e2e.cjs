'use strict';
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'participant-sticky-nav-'));let app;
 try{
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox','--password-store=basic',root],env:{...process.env,HOME:tmp,XDG_CONFIG_HOME:path.join(tmp,'config')}});
  const page=await app.firstWindow();await page.evaluate(()=>{for(const id of ['participation','settings','records']){const spacer=document.createElement('div');spacer.style.height='1800px';document.getElementById('view-'+id).append(spacer);}});
  for(const width of [1350,800]){
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,600),width);
   for(const name of ['participation','settings','records']){
    await page.locator('#view-tab-'+name).click();await page.evaluate(()=>window.scrollTo(0,700));
    await page.waitForFunction(()=>window.scrollY>500&&Math.abs(document.querySelector('.view-tabs').getBoundingClientRect().top)<1);
    const rect=await page.evaluate(()=>{const nav=document.querySelector('.view-tabs'),r=nav.getBoundingClientRect(),header=document.querySelector('header').getBoundingClientRect();return {top:r.top,bottom:r.bottom,headerBottom:header.bottom,background:getComputedStyle(nav).backgroundColor,front:document.elementFromPoint(r.left+30,r.top+15)?.closest('.view-tabs')===nav};});
    assert(Math.abs(rect.top)<1&&rect.headerBottom<=0&&rect.front,JSON.stringify({width,name,rect}));assert.notEqual(rect.background,'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('#view-tab-'+name).getAttribute('aria-selected'),'true');
   }
  }
  console.log('PASS: navigation remains visible and clickable while the header scrolls away');
 }finally{if(app)await app.close();fs.rmSync(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(e=>{console.error(e);process.exitCode=1;});
