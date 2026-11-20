'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {waitForAsync}=require('./wait_for_async.cjs');
test('waits for an async predicate to resolve true',async()=>{let calls=0;const page={evaluate:async(fn,arg)=>fn(arg)};await waitForAsync(page,async expected=>{calls++;return calls===expected;},3,{timeout:1000});assert.equal(calls,3);});
test('rejects when an async predicate keeps resolving false',async()=>{const page={evaluate:async(fn,arg)=>fn(arg)};await assert.rejects(waitForAsync(page,async()=>false,null,{timeout:120}),/Timed out/);});
