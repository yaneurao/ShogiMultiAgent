'use strict';

// Both services expose individual games under /shogi/x/YYYY/MM/DD/.
// Only construct links for the configured public servers and their game IDs.
function gameUrl(host,gameId){
 if(typeof host!=='string'||typeof gameId!=='string')return null;
 const server=host.toLowerCase();
 const service=server==='shogizone.com:4081'?{origin:'https://shogizone.com',prefix:'shogizone'}:
  server==='wdoor.c.u-tokyo.ac.jp:4081'?{origin:'https://wdoor.c.u-tokyo.ac.jp',prefix:'wdoor'}:null;
 if(!service)return null;
 const parts=gameId.split('+');
 if(parts.length!==5||parts[0]!==service.prefix||parts.slice(1,4).some(part=>!part||!/^[A-Za-z0-9_.@-]+$/.test(part))||!/^\d{14}$/.test(parts[4]))return null;
 const stamp=parts[4],year=Number(stamp.slice(0,4)),month=Number(stamp.slice(4,6)),day=Number(stamp.slice(6,8));
 const date=new Date(Date.UTC(year,month-1,day));
 if(year<2000||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
 return `${service.origin}/shogi/x/${stamp.slice(0,4)}/${stamp.slice(4,6)}/${stamp.slice(6,8)}/${encodeURIComponent(gameId)}.html`;
}
module.exports={gameUrl};
