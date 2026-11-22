'use strict';
const {app,BrowserWindow,ipcMain,dialog,safeStorage,shell,clipboard} = require('electron');
const {spawn,execFile} = require('node:child_process');
const {promisify}=require('node:util');
const {gameUrl}=require('./game-url');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline');
app.setName('ShogiMultiAgent');
// Preserve settings created by the earlier ShogiZone participant app.
app.setPath('userData',path.join(app.getPath('appData'),'shogizone-participant'));
const singleInstance=app.requestSingleInstanceLock();if(!singleInstance)app.quit();
app.on('second-instance',()=>{if(windowRef&&!windowRef.isDestroyed()){if(windowRef.isMinimized())windowRef.restore();windowRef.show();windowRef.focus();}});
let windowRef,profiles=[],closing=false,appSettings={disconnectSelfPlay:false,defaultRecordDir:'',showInfoString:true},nextSessionOrder=0;const sessions=new Map(),startingProfiles=new Set();
const file=()=>path.join(app.getPath('userData'),'connections.json');
const settingsFile=()=>path.join(app.getPath('userData'),'settings.json');
const historyDir=()=>path.join(app.getPath('userData'),'game-history');
const pendingDir=()=>path.join(historyDir(),'pending');
const defaultRecordDir=()=>appSettings.defaultRecordDir||path.join(app.getPath('documents'),'ShogiMultiAgent','kif');
const records=new Map();let historyWrites=Promise.resolve(),historyReady=Promise.resolve(),historyLoading=true,historyRecoveryPending=false,historyLoadErrors=0;let releasePendingScan;const pendingScanReady=new Promise(resolve=>{releasePendingScan=resolve;});
function definitiveResult(record){return ['#WIN','#LOSE','#DRAW'].includes(record.result)||(record.result==='#CENSORED'&&record.reason==='#MAX_MOVES');}
function mergeGameData(previous,current){
 if(!previous?.frames?.length)return current;
 const base=previous.frames.length>current.frames.length?previous:current;
 const other=base===previous?current:previous;
 const byPosition=new Map(other.frames.map(frame=>[`${frame.ply}\0${frame.sfen}`,frame]));
 const frames=base.frames.map(frame=>{const supplement=byPosition.get(`${frame.ply}\0${frame.sfen}`);if(!supplement)return frame;return {...frame,evaluation:frame.evaluation??supplement.evaluation,pv:frame.pv?.length?frame.pv:supplement.pv,clocks:frame.clocks??supplement.clocks,elapsed:frame.elapsed??supplement.elapsed};});
 return {...base,finalClocks:base.finalClocks??other.finalClocks,frames};
}
function saveHistory(s,result,reason){if(!s.game)return;const g=structuredClone(s.game),recordPath=g.recordPath||null;const key=historyKey(s.host,s.game_id,g.black,g.white);const selfSides=[g.side];const other=[...sessions.values()].find(x=>x!==s&&x.host===s.host&&x.game_id===s.game_id&&x.game?.black===g.black&&x.game?.white===g.white);if(other?.game?.side&&!selfSides.includes(other.game.side))selfSides.push(other.game.side);if(other?.game){other.game.selfPlay=true;g.selfPlay=true;}if(g.selfPlay)selfSides.push(g.side==='black'?'white':'black');
 const checkpoint=s.checkpoint?.generation===g.generation?s.checkpoint:null;
 const entry={id:key,startedAt:g.startedAt,label:g.label,host:s.host,black:g.black,white:g.white,result,reason:reason||null,ply:g.frames.at(-1)?.ply??0,recordPath,recordPaths:recordPath?[recordPath]:[],recordErrors:{...(g.recordErrors||{})},recordError:g.recordError||null,gameSide:g.side,selfSides:[...new Set(selfSides)],game:g};
 historyWrites=historyWrites.then(async()=>{await checkpoint?.writes;await historyReady;const previous=records.get(key);if(previous){const usePreviousResult=definitiveResult(previous)&&!definitiveResult(entry);if(usePreviousResult){entry.result=previous.result;entry.reason=previous.reason;entry.gameSide=previous.gameSide;}try{const old=JSON.parse(await fs.readFile(path.join(historyDir(),key+'.json'),'utf8'));entry.game=mergeGameData(old.game,entry.game);entry.ply=entry.game.frames.at(-1)?.ply??entry.ply;}catch(e){throw new Error('既存の対局履歴を読み込めないため、上書きせず復旧情報を保持しました: '+e.message);}entry.selfSides=[...new Set([...previous.selfSides,...entry.selfSides])];entry.recordPaths=[...new Set([...(previous.recordPaths||[previous.recordPath]),...entry.recordPaths].filter(Boolean))];entry.recordErrors={...(previous.recordErrors||{}),...entry.recordErrors};const preferred=(!definitiveResult(previous)&&definitiveResult(entry)?entry.recordPath:previous.recordPath)||entry.recordPath;entry.recordPath=[preferred,...entry.recordPaths].find(p=>p&&!entry.recordErrors[p])||preferred;entry.recordError=entry.recordPath&&!entry.recordErrors[entry.recordPath]?null:(entry.recordErrors[entry.recordPath]||entry.recordError||previous.recordError||null);entry.startedAt=previous.startedAt;entry.label=previous.label===entry.label?entry.label:[...new Set([previous.label,entry.label])].join(' / ');}await fs.mkdir(historyDir(),{recursive:true});const target=path.join(historyDir(),key+'.json'),temp=target+'.tmp';await fs.writeFile(temp,JSON.stringify(entry));await fs.rename(temp,target);const {game:_,...metadata}=entry;records.set(key,metadata);if(checkpoint)await fs.unlink(checkpoint.path).catch(e=>{if(e.code!=='ENOENT')console.error('復旧用ファイルを削除できません:',e.message);});if(windowRef&&!windowRef.isDestroyed())windowRef.webContents.send('records-changed');}).catch(err=>{s.log.push('対局履歴の保存に失敗しました: '+err.message);s.error='対局履歴の保存に失敗しました: '+err.message;notify();});}
// A small append-only recovery journal avoids rewriting the complete game on
// every move. Each game's writes are serialized before its finalization.
function queueCheckpoint(s,kind){
 if(!s.game)return;
 if(kind==='start')s.checkpoint={generation:s.game.generation,path:path.join(pendingDir(),`${s.id}-${s.game.generation}.ndjson`),failed:false,writes:Promise.resolve()};
 const checkpoint=s.checkpoint;if(!checkpoint||checkpoint.generation!==s.game.generation)return;
 const data=kind==='start'?{type:'start',host:s.host,game_id:s.game_id,game:structuredClone(s.game)}:kind==='record'?{type:'record',path:s.game.recordPath}:kind==='record_error'?{type:'record_error',path:s.game.recordPath||null,message:s.game.recordError}:kind==='finish'?{type:'finish',result:s.result,reason:s.finishReason||null,finalClocks:s.game.finalClocks||null}:{type:'move',frame:structuredClone(s.game.frames.at(-1))};
 const line=JSON.stringify(data)+'\n';
 checkpoint.writes=checkpoint.writes.then(async()=>{await pendingScanReady;if(checkpoint.failed)return;if(kind==='start'){await fs.mkdir(pendingDir(),{recursive:true});const temp=checkpoint.path+'.tmp';await fs.writeFile(temp,line);await fs.rename(temp,checkpoint.path);}else await fs.appendFile(checkpoint.path,line);}).catch(e=>{checkpoint.failed=true;s.error='対局中の復旧情報を保存できません: '+e.message;s.log.push(s.error);notify();});
}
async function readPendingGames(){
 let names;try{names=await fs.readdir(pendingDir());}catch(e){if(e.code==='ENOENT')return [];throw e;}
 const recovered=[];for(const name of names){if(!/^[a-f0-9-]+-[0-9]+\.ndjson$/.test(name))continue;const checkpoint=path.join(pendingDir(),name);try{const data=await fs.readFile(checkpoint,'utf8'),lines=data.split('\n'),tail=lines.pop();let start=null,finish=null,damaged=!!tail;for(const line of lines){try{const event=JSON.parse(line);if(!start&&event.type==='start'&&typeof event.host==='string'&&typeof event.game_id==='string'&&['black','white'].includes(event.game?.side)&&event.game?.frames?.length)start=event;else if(start&&!finish&&event.type==='move'&&event.frame?.sfen)start.game.frames.push(event.frame);else if(start&&!finish&&event.type==='record'&&typeof event.path==='string')start.game.recordPath=event.path;else if(start&&!finish&&event.type==='record_error'&&typeof event.message==='string'){start.game.recordError=event.message;if(typeof event.path==='string')start.game.recordErrors={...(start.game.recordErrors||{}),[event.path]:event.message};}else if(start&&!finish&&event.type==='finish'&&['#WIN','#LOSE','#DRAW','#CENSORED'].includes(event.result)){finish=event;if(Array.isArray(event.finalClocks)&&event.finalClocks.length===2&&event.finalClocks.every(Number.isFinite))start.game.finalClocks=event.finalClocks;}else{damaged=true;break;}}catch{damaged=true;break;}}if(!start)throw Error('開始局面がありません');if(damaged)historyLoadErrors++;if(!finish)markIncompleteRecord(start.game);recovered.push({id:name,host:start.host,game_id:start.game_id,game:start.game,finish,checkpoint:{generation:start.game.generation,path:checkpoint},log:[]});}catch(e){historyLoadErrors++;console.error('対局の復旧情報を読み込めません:',name,e.message);}}
 return recovered;
}
function finishQuit(){Promise.allSettled([historyWrites,profileWrites]).then(()=>app.quit());}
function markIncompleteRecord(game){if(!game?.recordPath||game.recordError)return;const message='対局が中断したため、CSA棋譜が最後まで保存されていません。';game.recordError=message;game.recordErrors={...(game.recordErrors||{}),[game.recordPath]:message};}
function saveInterrupted(s){s.gameInProgress=false;if(s.game&&!s.game.recorded){markIncompleteRecord(s.game);s.game.recorded=true;saveHistory(s,'#UNKNOWN');}}
function freezeGameClock(game,e){const frame=game?.frames?.at(-1);if(!frame?.clocks||!frame.received)return;const clocks=frame.clocks.slice(),turn=frame.sfen?.split(' ')[1]==='w'?1:0;const elapsed=Number.isFinite(e.terminal_elapsed_ms)?Math.max(0,e.terminal_elapsed_ms)/1000:Math.max(0,Date.now()-frame.received)/1000;clocks[turn]=e.reason==='#TIME_UP'?0:Math.max(0,clocks[turn]-elapsed);game.finalClocks=clocks;game.clockStopped=true;}
const historyKey=(host,id,black,white)=>crypto.createHash('sha256').update(JSON.stringify([host,id,black,white])).digest('hex');
function recordCandidates(entry){return [...new Set([entry?.recordPath,...(entry?.recordPaths||[])].filter(Boolean))].filter(p=>!entry.recordErrors?.[p]&&!(p===entry.recordPath&&entry.recordError));}
function removeDeletedRecordPaths(entry,removed){
 const paths=[...new Set([entry.recordPath,...(entry.recordPaths||[])].filter(p=>p&&!removed.has(p)))];
 const errors=Object.fromEntries(Object.entries(entry.recordErrors||{}).filter(([p])=>!removed.has(p)));
 const preferred=paths.includes(entry.recordPath)?entry.recordPath:null;
 const recordPath=[preferred,...paths].find(p=>p&&!errors[p])||preferred||paths[0]||null;
 return {...entry,recordPath,recordPaths:paths,recordErrors:errors,recordError:recordPath?(errors[recordPath]||(recordPath===entry.recordPath?entry.recordError:null)||null):null};
}
async function reconcileDeletedRecordPaths(removed){
 const problems=[];
 for(const [id,entry] of records){
  if(![entry.recordPath,...(entry.recordPaths||[])].some(p=>removed.has(p)))continue;
  const updated=removeDeletedRecordPaths(entry,removed);records.set(id,updated);
  try{const target=path.join(historyDir(),id+'.json');let full=JSON.parse(await fs.readFile(target,'utf8'));full=removeDeletedRecordPaths(full,removed);if(full.game)full.game=removeDeletedRecordPaths(full.game,removed);const temp=target+'.repair.tmp';await fs.writeFile(temp,JSON.stringify(full));await fs.rename(temp,target);}
  catch(e){problems.push(`${id}: ${e.message}`);}
 }
 return problems;
}
const recordsList=()=>[...records.values()].sort((a,b)=>b.startedAt-a.startedAt).map(({game,...entry})=>entry);
const inspectRecord=promisify(execFile);
let completedScanPending=false;
function reconcileCompletedRecords(){
 if(completedScanPending||historyLoading||historyRecoveryPending)return;completedScanPending=true;
 const operation=historyWrites.then(async()=>{
  await historyReady;
  for(const [id,entry] of records){
   const p=entry.recordPath;if(entry.result!=='#UNKNOWN'||!p||!entry.recordError?.includes('対局が中断したため'))continue;
   if([...sessions.values()].some(s=>s.gameInProgress&&s.game&&historyKey(s.host,s.game_id,s.game.black,s.game.white)===id))continue;
   try{
    const stat=await fs.stat(p);if(stat.size>16*1024*1024)continue;const text=await fs.readFile(p,'utf8');if(!/\n'\$END_TIME:[^\n]*\n?$/.test(text))continue;
    const {stdout}=await inspectRecord(agentPath(),['--inspect-record',p],{timeout:10000,maxBuffer:16*1024*1024,windowsHide:true});const parsed=JSON.parse(stdout);
    const target=path.join(historyDir(),id+'.json'),full=JSON.parse(await fs.readFile(target,'utf8'));
    if(historyKey(entry.host,parsed.event,parsed.black,parsed.white)!==id)continue;
    if(parsed.black!==entry.black||parsed.white!==entry.white||!parsed.frames?.length||!full.game?.frames?.every((frame,i)=>parsed.frames[i]?.sfen===frame.sfen))continue;
    const originalFrames=full.game.frames,increments=full.game.increments||(Number.isFinite(full.game.increment)?[full.game.increment,full.game.increment]:null);let clocks=originalFrames.at(-1)?.clocks?.slice();
    if(clocks&&Array.isArray(increments)&&increments.length===2&&increments.every(Number.isFinite)){for(let i=originalFrames.length;i<parsed.frames.length;i++){const frame=parsed.frames[i];if(!Number.isFinite(frame.elapsed))break;const mover=frame.sfen?.split(' ')[1]==='w'?0:1;clocks[mover]=Math.max(0,clocks[mover]+increments[mover]-frame.elapsed);frame.clocks=clocks.slice();}}
    full.game=mergeGameData(full.game,{...full.game,frames:parsed.frames});full.game.recordError=null;if(full.game.recordErrors)delete full.game.recordErrors[p];
    full.ply=full.game.frames.at(-1)?.ply??full.ply;full.result=parsed.result;full.reason=parsed.reason||null;full.recordError=null;if(full.recordErrors)delete full.recordErrors[p];
    const temp=target+'.tmp';await fs.writeFile(temp,JSON.stringify(full));await fs.rename(temp,target);const {game:_,...metadata}=full;records.set(id,metadata);if(windowRef&&!windowRef.isDestroyed())windowRef.webContents.send('records-changed');
   }catch(e){console.error('完了した棋譜を復旧できません:',p,e.message);}
  }
 });historyWrites=operation.catch(()=>{});operation.finally(()=>{completedScanPending=false;}).catch(()=>{});
}
async function loadHistory(){try{await fs.mkdir(historyDir(),{recursive:true});const recovered=await readPendingGames();historyRecoveryPending=recovered.length>0;releasePendingScan();const names=(await fs.readdir(historyDir())).filter(name=>/^[a-f0-9]{64}\.json$/.test(name));for(let offset=0;offset<names.length;offset+=8){await Promise.all(names.slice(offset,offset+8).map(async name=>{try{const entry=JSON.parse(await fs.readFile(path.join(historyDir(),name),'utf8'));if(entry.id===name.slice(0,-5)&&entry.game?.frames?.length&&!records.has(entry.id)){const {game:_,...metadata}=entry;records.set(entry.id,metadata);}else if(entry.id!==name.slice(0,-5)||!entry.game?.frames?.length){historyLoadErrors++;}}catch(e){historyLoadErrors++;console.error('対局履歴の読み込み失敗:',name,e.message);}}));}return recovered;}catch(e){historyLoadErrors++;dialog.showErrorBox('対局履歴を読み込めません',e.message);}finally{releasePendingScan();historyLoading=false;notify();if(windowRef&&!windowRef.isDestroyed())windowRef.webContents.send('records-changed');}}


const publicProfile=p=>({id:p.id,label:p.label,name:p.name,host:p.host,engine:p.engine,pool:p.pool,record_dir:p.record_dir,options:p.options,ponder:!!p.ponder,hasTrip:!!p.trip});
const state=()=>({version:app.getVersion(),appSettings:{...appSettings},settingsPath:file(),defaultRecordDir:defaultRecordDir(),historyLoading,historyRecoveryPending,historyLoadErrors,startingProfiles:[...startingProfiles],profiles:profiles.map(publicProfile),sessions:[...sessions.values()].sort((a,b)=>a.order-b.order).map(({child,game,pending,checkpoint,searchHistory,order,...s})=>({...s,isActive:!!child,gameUrlAvailable:!!gameUrl(s.host,s.game_id)}))});
let notifyTimer=null;function notify(){if(notifyTimer)return;notifyTimer=setTimeout(()=>{notifyTimer=null;if(windowRef&&!windowRef.isDestroyed())windowRef.webContents.send('changed',state());},100);}
let profileWrites=Promise.resolve();function changeProfiles(fn){const next=profileWrites.then(fn);profileWrites=next.catch(()=>{});return next;}
async function persist(){const temp=file()+'.tmp';await fs.writeFile(temp,JSON.stringify(profiles,null,2),{mode:0o600});await fs.rename(temp,file());}
function validate(input){
 const out={};for(const key of ['label','name','host','engine','pool','record_dir'])out[key]=String(input[key]||'').trim();
 if(!out.label||!out.name||!out.host||!out.engine)throw Error('設定名、プレイヤー名、接続先、エンジン本体を入力してください。');
 if(!/^[A-Za-z0-9_@.\-]{1,40}$/.test(out.name))throw Error('プレイヤー名は40文字以内の半角英数字、_ - . @ で入力してください。');
 if(!/^([^\s:]+|\[[0-9a-fA-F:]+\]):\d{1,5}$/.test(out.host)||Number(out.host.split(':').at(-1))>65535||Number(out.host.split(':').at(-1))<1)throw Error('接続先は host:port で指定してください。');
 out.pool ||= 'floodgate-300-10F';if(/[\s,]/.test(out.pool))throw Error('対局条件には空白やカンマを使えません。');
 out.ponder=input.ponder===true;
 out.options=String(input.options||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(out.options.some(s=>!s.includes('=')||/[\r\n\x00]/.test(s)))throw Error('USIオプションは1行に Name=Value で入力してください。');
 const trip=String(input.trip||'');if(/[\s,\x00-\x1f\x7f]/.test(trip))throw Error('tripに空白やカンマは使えません。');
 return {out,trip};
}
function forceSession(s,reason='強制終了を実行しました。'){
 if(!s?.child||s.forceRequested)return;
 s.forceRequested=true;s.log.push(reason);
 if(process.platform==='win32'){
  const killer=spawn('taskkill',['/PID',String(s.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  killer.on('error',e=>{s.error='強制終了に失敗しました: '+e.message;notify();});
  killer.on('close',code=>{if(code!==0&&s.child){s.error=`強制終了に失敗しました（taskkill: ${code}）`;s.log.push(s.error);notify();}});
 }else if(!s.child.kill()){s.error='強制終了に失敗しました。';s.log.push(s.error);}
 s.stopRequested=true;s.status='stopping';notify();
}
function confirmMatch(s,e){
 const own=e.side==='black'?e.black:e.white,opponent=e.side==='black'?e.white:e.black;
 s.matchCandidate={game_id:e.game_id,black:e.black,white:e.white};
 const peer=appSettings.disconnectSelfPlay&&own===s.name&&opponent&&[...sessions.values()].find(other=>{
  if(other===s||other.host.toLowerCase()!==s.host.toLowerCase()||other.name!==opponent)return false;
  const match=other.matchCandidate;
  if(match)return match.game_id===e.game_id&&match.black===e.black&&match.white===e.white;
  return !!other.child&&!other.gameInProgress;
 });
 if(peer){forceSession(s,`自分が参加させたプレイヤー ${opponent} との対局を検出したため強制切断しました。`);}
 else if(s.child)s.child.stdin.write('allow\n');
}
function eventFor(s,e){
 if(e.event==='state') {if(e.state==='reconnecting'){s.matchCandidate=null;s.search={mode:'waiting'};saveInterrupted(s);if(e.message){s.error=e.message;s.log.push('再接続中: '+e.message);}}if(!s.stopRequested)s.status=e.state;if(e.state==='waiting'){s.matchCandidate=null;s.search={mode:'waiting'};s.error=null;s.ply=null;s.score=null;s.pv=[];s.opponent=null;}}
 if(e.event==='match_found')confirmMatch(s,e);
 if(e.event==='record'){if(s.gameInProgress&&s.game){s.game.recordPath=e.path;if(s.game.recordError)s.game.recordErrors={...(s.game.recordErrors||{}),[e.path]:s.game.recordError};queueCheckpoint(s,'record');}else s.pendingRecordPath=e.path;}
 if(e.event==='record_error'){const message=e.message||'棋譜を保存できません。';s.error=message;s.log.push(message);if(s.gameInProgress&&s.game){if(e.path){s.game.recordPath||=e.path;s.game.recordErrors={...(s.game.recordErrors||{}),[e.path]:message};}s.game.recordError=message;}else{s.pendingRecordError=message;if(e.path)s.pendingRecordPath=e.path;}}
 if(e.event==='game_started'){s.searchHistory=new Map();s.search={mode:'waiting'};s.gameInProgress=true;s.game={startedAt:Date.now(),label:s.label,side:e.side,recordPath:s.pendingRecordPath||null,recordError:s.pendingRecordError||null,recordErrors:s.pendingRecordError&&s.pendingRecordPath?{[s.pendingRecordPath]:s.pendingRecordError}:{},frames:(e.frames?.length?e.frames:[{sfen:e.sfen,ply:e.ply}]).map(f=>({...f})),black:e.black,white:e.white,byoyomi:e.byoyomi,increment:e.increment,increments:e.increments,generation:(s.gameGeneration=(s.gameGeneration||0)+1),revision:s.gameRevision||0};Object.assign(s.game.frames.at(-1),{clocks:e.clocks,received:Date.now()});s.pending=null;s.pendingRecordPath=null;s.pendingRecordError=null;for(const other of sessions.values())if(other!==s&&other.host===s.host&&other.game_id===e.game_id&&other.game?.black===e.black&&other.game?.white===e.white&&other.game?.side!==e.side){other.game.selfPlay=true;s.game.selfPlay=true;}if(!s.stopRequested)s.status='playing';s.side=e.side;s.opponent=(e.side==='black'?e.white:e.black)||null;s.game_id=e.game_id;s.ply=e.ply;s.board=e.board;s.score=null;s.pv=[];}
 if(e.event==='move'){if(s.search?.mode==='pondering'&&s.search.sfen&&s.search.sfen!==e.sfen)s.search={mode:s.search.mode,rows:[]};if(s.game){const a=s.pending?.move===e.move?s.pending:null;s.game.frames.push({sfen:e.sfen,ply:e.ply,move:e.move,clocks:e.clocks,elapsed:e.elapsed,evaluation:e.evaluation??a?.evaluation,pv:e.pv?.length?e.pv:a?.pv,received:Date.now()});s.pending=null;}s.ply=e.ply;s.board=e.board;s.move=e.move;}
 if(e.event==='search_state'){const newSearch=e.mode==='pondering'||(e.mode==='thinking'&&s.search?.mode!=='pondering');s.search={...s.search,...(newSearch?{nodes:null,nps:null,metricsForNewSearch:true}:{}),mode:e.mode};}
 if(e.event==='search_metrics'){s.search={...s.search,nodes:e.nodes??s.search?.nodes,nps:e.nps??s.search?.nps};if(!s.search.metricsForNewSearch&&s.search?.sfen&&s.searchHistory?.has(s.search.sfen))s.searchHistory.set(s.search.sfen,s.search);}
 if(e.event==='search_string'){const rows=s.search?.sfen===e.sfen?(s.search.rows||[]):[];s.search={...s.search,mode:e.mode||'thinking',sfen:e.sfen,rows:[{message:e.message},...rows].slice(0,100)};if(e.sfen&&s.searchHistory)s.searchHistory.set(e.sfen,s.search);}
 if(e.event==='analysis_update'){const rows=s.search?.sfen===e.sfen?(s.search.rows||[]):[];s.search={...s.search,metricsForNewSearch:false,mode:e.mode||'thinking',sfen:e.sfen,rows:[{depth:e.depth,seldepth:e.seldepth,time_ms:e.time_ms,score:e.score,bound:e.bound,pv:(e.pv||[]).slice(0,4),sfen:e.sfen},...rows].slice(0,100)};if(e.sfen&&s.searchHistory)s.searchHistory.set(e.sfen,s.search);if(e.mode!=='pondering'&&e.primary!==false&&e.score!=null){s.score=e.score;s.pv=e.pv||[];}}
 if(e.event==='analysis'){s.pending=e;s.score=e.score;s.pv=e.pv||[];s.move=e.move;}
 if(e.event==='game_ending'&&s.game)freezeGameClock(s.game,e);
 if(e.event==='game_finished'){s.search={mode:'finished'};s.gameInProgress=false;if(!s.stopRequested)s.status='finished';s.result=e.result;s.finishReason=e.reason;if(s.game&&!s.game.recorded){if(!s.game.clockStopped)freezeGameClock(s.game,e);queueCheckpoint(s,'finish');s.game.recorded=true;saveHistory(s,e.result,e.reason);}}
 if(e.event==='stopping'&&!s.resumeRequested){s.stopRequested=true;s.status='stopping';}if(e.event==='resumed'){s.resumeRequested=false;s.stopRequested=false;s.status=s.gameInProgress?'playing':'waiting';}
 if(e.event==='log'||e.event==='engine_log'||e.event==='error'||e.event==='record'||e.event==='stopping'||e.event==='resumed')s.log.push(e.message||e.path||'');
 if(e.event==='error'){s.status='failed';s.error=e.message;}
 if(s.game&&(['game_started','move'].includes(e.event)||(e.event==='record_error'&&s.gameInProgress)))queueCheckpoint(s,e.event==='game_started'?'start':e.event==='record_error'?'record_error':'move');
 if(s.game&&['game_started','move','game_ending','game_finished'].includes(e.event)){s.game.revision=(s.gameRevision=(s.gameRevision||0)+1);if(windowRef&&!windowRef.isDestroyed())windowRef.webContents.send('game-event',s.id,e.event,s.game.revision,e.event==='move'?s.game.frames.at(-1):['game_ending','game_finished'].includes(e.event)?{finalClocks:s.game.finalClocks,clockStopped:s.game.clockStopped}:null);}if(s.log.length>500)s.log.splice(0,s.log.length-500);notify();
}
function agentPath(){return app.isPackaged?path.join(process.resourcesPath,'app','agent',process.platform==='win32'?'usi-agent3.exe':'usi-agent'):path.join(__dirname,'..','agent',process.platform==='win32'?'usi-agent3.exe':'usi-agent');}
async function start(id){
 const profile=profiles.find(p=>p.id===id);if(!profile)throw Error('接続設定が見つかりません。');
 if(startingProfiles.has(id)||[...sessions.values()].some(s=>s.profileId===id&&s.child))throw Error('この設定はすでに参加中です。');
 if(closing)throw Error('アプリを終了しています。');
 startingProfiles.add(id);notify();
 try {
 let trip='';if(profile.trip){if(!await safeStorage.isAsyncEncryptionAvailable())throw Error('tripを復号できません。');trip=(await safeStorage.decryptStringAsync(Buffer.from(profile.trip,'base64'))).result;}
 const recordDir=profile.record_dir||defaultRecordDir();await fs.mkdir(recordDir,{recursive:true});
 try{await fs.access(profile.engine);}catch{throw Error('エンジンの実行ファイルが見つからないか、読み取れません。');}await fs.access(agentPath());
 if(closing)throw Error('アプリを終了しています。');
 const child=spawn(agentPath(),['--app-mode'],{stdio:['pipe','pipe','pipe'],windowsHide:true,windowsVerbatimArguments:false});
 const previous=[...sessions.values()].find(s=>s.profileId===id&&!s.child);
 const session={id:crypto.randomUUID(),order:previous?.order??nextSessionOrder++,profileId:id,label:profiles.find(p=>p.id===id)?.label||profile.label,name:profile.name,host:profile.host,status:'starting',ponder:!!profile.ponder,search:{mode:'waiting'},ply:null,score:null,pv:[],board:'',log:[],child};sessions.set(session.id,session);notify();
 child.on('error',e=>{session.status='failed';session.error=e.message;session.log.push(e.message);notify();});
 const parse=readline.createInterface({input:child.stdout,crlfDelay:Infinity});parse.on('line',line=>{try{eventFor(session,JSON.parse(line));}catch{session.log.push(line.slice(0,4096));notify();}});
 const errors=readline.createInterface({input:child.stderr,crlfDelay:Infinity});errors.on('line',line=>{session.log.push(line.slice(0,4096));if(session.log.length>500)session.log.shift();notify();});
 child.on('close',(code,signal)=>{saveInterrupted(session);session.child=null;if(session.status!=='failed')session.status=(code===0||session.forceRequested)?'stopped':'failed';if(code!==0){if(session.forceRequested)session.log.push(`強制終了しました（終了コード: ${code??signal}）`);else session.error||=`終了コード: ${code??signal}`;}else if(session.forceRequested)session.log.push('強制終了しました。');notify();if(!closing&&!session.forceRequested&&(session.resumeRequested||(!session.stopRequested&&code===0&&Date.now()-(session.lastResumeAt||0)<10000))){start(session.profileId).then(()=>{sessions.delete(session.id);notify();}).catch(e=>{session.error='再参加に失敗しました: '+e.message;notify();});}if(closing&&!startingProfiles.size&&![...sessions.values()].some(s=>s.child))finishQuit();});
 child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify({engine:profile.engine,host:profile.host,name:profile.name,pool:profile.pool,trip,record_dir:recordDir,options:profile.options,ponder:!!profile.ponder,match_gate:true})+'\n');return session.id;
 } finally {startingProfiles.delete(id);notify();if(closing&&!startingProfiles.size&&![...sessions.values()].some(s=>s.child))finishQuit();}
}
app.whenReady().then(async()=>{
 if(!singleInstance)return;
 try{const value=JSON.parse(await fs.readFile(settingsFile(),'utf8'));appSettings.disconnectSelfPlay=value.disconnectSelfPlay===true;appSettings.showInfoString=value.showInfoString!==false;if(typeof value.defaultRecordDir==='string'&&(!value.defaultRecordDir||(path.isAbsolute(value.defaultRecordDir)&&!/[\x00-\x1f\x7f]/.test(value.defaultRecordDir))))appSettings.defaultRecordDir=value.defaultRecordDir;}catch(e){if(e.code!=='ENOENT'){dialog.showErrorBox('アプリ設定を読み込めません',e.message);app.quit();return;}}
 try{const value=JSON.parse(await fs.readFile(file(),'utf8'));if(Array.isArray(value))profiles=value;}catch(e){if(e.code!=='ENOENT'){dialog.showErrorBox('設定を読み込めません',e.message);app.quit();return;}}

 windowRef=new BrowserWindow({width:1350,height:860,minWidth:720,minHeight:560,title:'ShogiMultiAgent',icon:path.join(__dirname,'assets','icon.png'),webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 windowRef.setMenuBarVisibility(false);windowRef.loadFile(path.join(__dirname,'index.html'));
 windowRef.on('close',e=>{if(!closing&&(startingProfiles.size||[...sessions.values()].some(s=>s.child))){e.preventDefault();windowRef.webContents.send('close-requested');}});
 ipcMain.handle('state',()=>state());
 ipcMain.handle('save-app-settings',(_e,input)=>changeProfiles(async()=>{if(typeof input?.disconnectSelfPlay!=='boolean'||(input.showInfoString!==undefined&&typeof input.showInfoString!=='boolean')||(input.defaultRecordDir!==undefined&&typeof input.defaultRecordDir!=='string'))throw Error('アプリ設定が不正です。');const directory=input.defaultRecordDir===undefined?appSettings.defaultRecordDir:input.defaultRecordDir.trim();if(directory&&(!path.isAbsolute(directory)||/[\x00-\x1f\x7f]/.test(directory)))throw Error('棋譜のデフォルト保存先は絶対パスで指定してください。');await fs.mkdir(app.getPath('userData'),{recursive:true});const temp=settingsFile()+'.tmp';const next={disconnectSelfPlay:input.disconnectSelfPlay,defaultRecordDir:directory,showInfoString:input.showInfoString??appSettings.showInfoString};await fs.writeFile(temp,JSON.stringify(next,null,2),{mode:0o600});await fs.rename(temp,settingsFile());appSettings=next;notify();return next;}));
 ipcMain.handle('open-default-record-dir',async()=>{const dir=defaultRecordDir();try{await fs.mkdir(dir,{recursive:true});const error=await shell.openPath(dir);if(error)throw Error(error);}catch(e){throw Error('デフォルトの保存先を開けません: '+e.message);}});
 ipcMain.handle('records',()=>recordsList());
 ipcMain.handle('delete-records',(_e,ids,options={removeHistory:true,removeCsa:true})=>{
  if(!Array.isArray(ids)||ids.length>10000||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw Error('選択された棋譜が不正です。');
  if(!options||typeof options.removeHistory!=='boolean'||typeof options.removeCsa!=='boolean'||(!options.removeHistory&&!options.removeCsa))throw Error('削除する対象を選択してください。');
  if(historyLoading||historyRecoveryPending)throw Error('棋譜の読み込み・復旧が完了してから削除してください。');
  const unique=[...new Set(ids)];
  const operation=historyWrites.then(async()=>{await historyReady;const deleted=[],updated=[],failed=[],owners=new Map(),selected=new Set(unique);
   const pathsOf=entry=>[...new Set([entry.recordPath,...(entry.recordPaths||[])].filter(Boolean))];
   for(const [id,entry] of records)for(const p of pathsOf(entry)){if(!owners.has(p))owners.set(p,new Set());owners.get(p).add(id);}
   const active=id=>[...sessions.values()].some(s=>s.gameInProgress&&s.game&&historyKey(s.host,s.game_id,s.game.black,s.game.white)===id);
   for(const id of unique){const entry=records.get(id);if(!entry){failed.push({id,error:'棋譜が見つかりません。'});continue;}if(active(id)){failed.push({id,error:'対局中のため削除できません。'});continue;}const removed=new Set();
    try{const paths=pathsOf(entry);if(options.removeCsa){for(const filePath of paths){if([...owners.get(filePath)].some(other=>other!==id&&(!selected.has(other)||active(other))))throw Error('CSAファイルが他の棋譜から参照されています。関連する棋譜も選択してください。');}
     for(const filePath of paths)try{await fs.unlink(filePath);removed.add(filePath);}catch(e){if(e.code!=='ENOENT')throw Error('CSAファイルを削除できません: '+e.message);removed.add(filePath);}}
     const target=path.join(historyDir(),id+'.json');if(options.removeHistory){try{await fs.unlink(target);}catch(e){if(e.code!=='ENOENT')throw Error('対局履歴を削除できません: '+e.message);}records.delete(id);deleted.push(id);}
     else{const full=JSON.parse(await fs.readFile(target,'utf8'));full.recordPath=null;full.recordPaths=[];full.recordError=null;full.recordErrors={};if(full.game){full.game.recordPath=null;full.game.recordError=null;full.game.recordErrors={};}const temp=target+'.tmp';await fs.writeFile(temp,JSON.stringify(full));await fs.rename(temp,target);const {game:_,...metadata}=full;records.set(id,metadata);updated.push(id);}
     if(options.removeHistory||options.removeCsa)for(const p of paths)owners.get(p).delete(id);
     if(removed.size){const problems=await reconcileDeletedRecordPaths(removed);if(problems.length)failed.push({id,error:'CSAは削除済みですが、関連する履歴の更新に失敗しました: '+problems.join(' / ')});}
    }catch(e){let error=e.message;if(removed.size){const problems=await reconcileDeletedRecordPaths(removed);error+=`（CSA ${removed.size}件は削除済み）`;if(problems.length)error+='。履歴の更新にも失敗しました: '+problems.join(' / ');}failed.push({id,error});}
   }
   if(windowRef&&!windowRef.isDestroyed())windowRef.webContents.send('records-changed');return {deleted,updated,failed};
  });historyWrites=operation.catch(()=>{});return operation;
 });

 ipcMain.handle('export-records',async(event,ids)=>{
  if(!Array.isArray(ids)||ids.length>10000||!ids.length||ids.some(id=>typeof id!=="string"||!/^[a-f0-9]{64}$/.test(id)))throw Error('選択された棋譜が不正です。');
  if(historyLoading||historyRecoveryPending)throw Error('棋譜の読み込み・復旧が完了してから書き出してください。');
  const choice=await dialog.showOpenDialog(windowRef,{title:'棋譜の書き出し先',properties:['openDirectory','createDirectory']});
  if(choice.canceled||!choice.filePaths[0])return {canceled:true};
  const destination=choice.filePaths[0],unique=[...new Set(ids)];
  let lastProgress=0;const progress=(completed,force=false)=>{const now=Date.now();if((force||now-lastProgress>=100)&&!event.sender.isDestroyed()){lastProgress=now;event.sender.send('export-records-progress',{completed,total:unique.length,destination});}};
  progress(0,true);
  const operation=historyWrites.then(async()=>{const exported=[],failed=[];
   for(const id of unique){try{const entry=records.get(id);if(!entry){failed.push({id,error:'棋譜が見つかりません。'});continue;}
    if([...sessions.values()].some(s=>s.gameInProgress&&s.game&&historyKey(s.host,s.game_id,s.game.black,s.game.white)===id)){failed.push({id,error:'対局中の棋譜は書き出せません。'});continue;}
    const sources=recordCandidates(entry);if(!sources.length){failed.push({id,error:entry.recordError||'CSAファイルが保存されていません。'});continue;}
    let copied=false,lastError='CSAファイルが見つかりません。';
    for(const source of sources){const name=path.basename(source),ext=path.extname(name),stem=path.basename(name,ext);for(let n=0;n<10000;n++){const filename=n===0?name:`${stem}-${n}${ext}`;try{await fs.copyFile(source,path.join(destination,filename),require('node:fs').constants.COPYFILE_EXCL);exported.push({id,filename});copied=true;break;}catch(e){if(e.code==='EEXIST'){lastError='同名ファイルが多すぎるため書き出せません。';continue;}if(e.code==='ENOENT'){lastError='CSAファイルまたは書き出し先が見つかりません。';break;}lastError='書き出しに失敗しました: '+e.message;break;}}if(copied)break;}
    if(!copied)failed.push({id,error:lastError});
   }finally{progress(exported.length+failed.length,exported.length+failed.length===unique.length);}}
   return {canceled:false,destination,exported,failed};
  });historyWrites=operation.catch(()=>{});return operation;
 });
 ipcMain.handle('record-game',async(_e,id)=>{if(!records.has(id))return null;const entry=JSON.parse(await fs.readFile(path.join(historyDir(),id+'.json'),'utf8'));return entry.game||null;});
 ipcMain.handle('reveal-record',async(_e,id)=>{const entry=records.get(id),paths=[...new Set([...recordCandidates(entry),entry?.recordPath].filter(Boolean))];if(!paths.length)throw Error('CSAファイルがありません。');for(const p of paths){try{await fs.access(p);shell.showItemInFolder(p);return;}catch{}}throw Error('CSAファイルが見つかりません。移動または削除されている可能性があります。');});
 ipcMain.handle('copy-record',async(_e,id)=>{const entry=records.get(id),paths=recordCandidates(entry);if(!paths.length)throw Error(entry?.recordError||'CSAファイルがありません。');let error;for(const p of paths){try{clipboard.writeText(await fs.readFile(p,'utf8'));return;}catch(e){error=e;}}throw Error('CSAファイルをコピーできません: '+error.message);});
 ipcMain.handle('open-record',async(_e,id)=>{const entry=records.get(id),paths=recordCandidates(entry);if(!paths.length)throw Error(entry?.recordError||'CSAファイルがありません。');let error;for(const p of paths){try{await fs.access(p);error=await shell.openPath(p);if(!error)return;}catch(e){error=e.message;}}throw Error('CSAファイルを開けません: '+error);});
 ipcMain.handle('open-game-url',async(_e,id)=>{const s=sessions.get(id),url=s&&gameUrl(s.host,s.game_id);if(!url)throw Error('この対局の観戦ページは利用できません。');await shell.openExternal(url);});
 ipcMain.handle('game',(_e,id)=>sessions.get(id)?.game||null);
 ipcMain.handle('search-history',(_e,id,sfen,generation)=>{const s=sessions.get(id);return s?.game?.generation===generation?s.searchHistory?.get(sfen)||null:null;});
 ipcMain.handle('pick-engine',async()=>{const r=await dialog.showOpenDialog(windowRef,{title:'USIエンジンを選択',properties:['openFile'],filters:process.platform==='win32'?[{name:'実行ファイル',extensions:['exe']},{name:'すべて',extensions:['*']}]:[{name:'すべて',extensions:['*']}]});return r.canceled?null:r.filePaths[0];});
 ipcMain.handle('pick-directory',async()=>{const r=await dialog.showOpenDialog(windowRef,{title:'棋譜の保存先',properties:['openDirectory','createDirectory']});return r.canceled?null:r.filePaths[0];});
 ipcMain.handle('save-profile',(_e,input)=>changeProfiles(async()=>{const {out,trip}=validate(input);const before=profiles.slice();const previous=profiles.find(p=>p.id===input.id);const source=input.sourceId?profiles.find(p=>p.id===input.sourceId):null;if(input.sourceId&&!source)throw Error('複製元の設定が見つかりません。');let encrypted=previous?.trip||source?.trip||'';if(input.clearTrip)encrypted='';if(trip){if(!await safeStorage.isAsyncEncryptionAvailable())throw Error('tripの暗号化を利用できません。');encrypted=(await safeStorage.encryptStringAsync(trip)).toString('base64');}const profile={...out,id:previous?.id||crypto.randomUUID(),trip:encrypted};if(previous)profiles[profiles.indexOf(previous)]=profile;else profiles.push(profile);try{await persist();}catch(e){profiles=before;throw e;}if(previous)for(const session of sessions.values())if(session.profileId===profile.id)session.label=profile.label;notify();return profile.id;}));
 ipcMain.handle('reveal-trip',async(_e,id)=>{const p=profiles.find(p=>p.id===id);if(!p?.trip)throw Error('tripが設定されていません。');if(!await safeStorage.isAsyncEncryptionAvailable())throw Error('tripを復号できません。');return (await safeStorage.decryptStringAsync(Buffer.from(p.trip,'base64'))).result;});
 ipcMain.handle('delete-profile',(_e,id)=>changeProfiles(async()=>{if(startingProfiles.has(id)||[...sessions.values()].some(s=>s.profileId===id&&s.child))throw Error('参加中の設定は削除できません。');const before=profiles;profiles=profiles.filter(p=>p.id!==id);try{await persist();}catch(e){profiles=before;throw e;}notify();}));
 ipcMain.handle('move-profile',(_e,id,direction)=>changeProfiles(async()=>{if(![-1,1].includes(direction))throw Error('移動方向が不正です。');const index=profiles.findIndex(p=>p.id===id),next=index+direction;if(index<0||next<0||next>=profiles.length)throw Error('設定を移動できません。');const before=profiles.slice();[profiles[index],profiles[next]]=[profiles[next],profiles[index]];try{await persist();}catch(e){profiles=before;throw e;}notify();}));
 ipcMain.handle('delete-profiles',(_e,ids)=>changeProfiles(async()=>{if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw Error('選択された設定が不正です。');const selected=new Set(ids),busy=profiles.filter(p=>selected.has(p.id)&&(startingProfiles.has(p.id)||[...sessions.values()].some(s=>s.profileId===p.id&&s.child)));if(busy.length)throw Error('参加中の設定は削除できません: '+busy.map(p=>p.label).join('、'));const before=profiles;profiles=profiles.filter(p=>!selected.has(p.id));try{await persist();}catch(e){profiles=before;throw e;}notify();}));
 ipcMain.handle('start',(_e,id)=>start(id));
 ipcMain.handle('resume',(_e,id)=>{const s=sessions.get(id);if(!s?.child||!s.stopRequested||s.forceRequested)throw Error('終了予約を取り消せません。');if(closing)throw Error('アプリを終了しています。');s.resumeRequested=true;s.lastResumeAt=Date.now();s.child.stdin.write('c\n');notify();});
 ipcMain.handle('stop',(_e,id)=>{const s=sessions.get(id);if(!s?.child)return;s.resumeRequested=false;s.lastResumeAt=0;s.child.stdin.write('q\n');s.stopRequested=true;s.status='stopping';notify();});
 ipcMain.handle('force',(_e,id)=>{forceSession(sessions.get(id));});
 ipcMain.handle('remove-session',(_e,id)=>{const s=sessions.get(id);if(s&&!s.child){sessions.delete(id);notify();}});
 historyReady=loadHistory().then(recovered=>{for(const session of recovered||[])saveHistory(session,session.finish?.result||'#UNKNOWN',session.finish?session.finish.reason:'#ABNORMAL');if(historyRecoveryPending){const recoveryWrites=historyWrites;recoveryWrites.finally(()=>{historyRecoveryPending=false;notify();});}});
 const completedScan=setInterval(reconcileCompletedRecords,2000);completedScan.unref();
 ipcMain.handle('close-gracefully',()=>{closing=true;for(const s of sessions.values())if(s.child){s.child.stdin.write('q\n');s.stopRequested=true;s.status='stopping';}notify();if(!startingProfiles.size&&![...sessions.values()].some(s=>s.child))finishQuit();});
});
app.on('window-all-closed',()=>{if(!startingProfiles.size&&![...sessions.values()].some(s=>s.child))finishQuit();});
