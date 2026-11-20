'use strict';
// Playwright's waitForFunction treats an async predicate's Promise as truthy,
// even when that Promise resolves to false. Poll the resolved value instead.
async function waitForAsync(page,predicate,arg=null,options={}){
 const timeout=options.timeout??30000,deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(await page.evaluate(predicate,arg))return;await new Promise(resolve=>setTimeout(resolve,50));}
 throw new Error(`Timed out after ${timeout} ms waiting for async condition`);
}
module.exports={waitForAsync};
