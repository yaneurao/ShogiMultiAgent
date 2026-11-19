'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {gameUrl}=require('../app/game-url');

test('constructs permanent game URLs for both supported services',()=>{
 assert.equal(gameUrl('shogizone.com:4081','shogizone+hayazashi-300-2F+miao-s+YowauraOu-2T+20261119102254'),'https://shogizone.com/shogi/x/2026/11/19/shogizone%2Bhayazashi-300-2F%2Bmiao-s%2BYowauraOu-2T%2B20261119102254.html');
 assert.equal(gameUrl('wdoor.c.u-tokyo.ac.jp:4081','wdoor+floodgate-300-10F+rustify_dl+elmo_WCSC27_479_1000k+20261118233005'),'https://wdoor.c.u-tokyo.ac.jp/shogi/x/2026/11/18/wdoor%2Bfloodgate-300-10F%2Brustify_dl%2Belmo_WCSC27_479_1000k%2B20261118233005.html');
});
test('rejects unsupported hosts, mismatched IDs, invalid dates and path injection',()=>{
 for(const [host,id] of [['example.com:4081','wdoor+floodgate+A+B+20261118233005'],['shogizone.com:4081','wdoor+floodgate+A+B+20261118233005'],['wdoor.c.u-tokyo.ac.jp:4081','wdoor+floodgate+A+B+20260230233005'],['wdoor.c.u-tokyo.ac.jp:4081','wdoor+floodgate+A/..+B+20261118233005'],['shogizone.com:4081',''],['shogizone.com:4081',null]])assert.equal(gameUrl(host,id),null);
});
