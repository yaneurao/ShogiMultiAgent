#!/usr/bin/env python3
"""Exercise real USI/CSA hit, miss, terminal and disabled pondering."""
import json, os, socket, subprocess, tempfile, time
from pathlib import Path
AGENT=Path(os.environ.get('SHOGIZONE_USI_AGENT','target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory(prefix='agent-ponder-') as d:
 root=Path(d);engine=root/'engine.py';log=root/'commands'
 engine.write_text('''#!/usr/bin/env python3
import os,sys,time
mode=os.environ.get("PONDER_TEST_CASE","")
log=open(sys.argv[1],'a',buffering=1)
search=0
for line in sys.stdin:
 line=line.strip();print(line,file=log,flush=True)
 if line=='usi':print('usiok',flush=True)
 elif line=='isready':print('readyok',flush=True)
 elif line=='usinewgame':search=0
 elif line.startswith('go ponder'):pass
 elif line.startswith('go '):
  search+=1
  if search==1:
   print('info score cp 12 pv 7g7f 3c3d',flush=True)
   print({'white':'bestmove 3c3d ponder 2g2f','invalid':'bestmove 7g7f ponder 1a1a','malformed':'bestmove 7g7f ponder !!!!','missing':'bestmove 7g7f'}.get(mode,'bestmove 7g7f ponder 3c3d'),flush=True)
  else:print('bestmove 2g2f',flush=True)
 elif line=='ponderhit':print('bestmove 8c8d' if mode=='white' else 'bestmove 2g2f',flush=True)
 elif line=='stop':
  if mode in ('miss_terminal','miss_disconnect'):time.sleep(.3)
  print('bestmove 2g2f',flush=True)
 elif line=='quit':break
''');engine.chmod(0o755)
 def commands():return log.read_text().splitlines() if log.exists() else []
 def wait_for(predicate, timeout=8):
  end=time.monotonic()+timeout
  while time.monotonic()<end:
   if predicate():return
   time.sleep(.02)
  raise AssertionError('timed out; commands='+repr(commands()))
 def case(mode):
  log.unlink(missing_ok=True);server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(10)
  args=[str(AGENT),'--engine',str(engine),'--host',f'127.0.0.1:{server.getsockname()[1]}','--name','Test','--pool','test-60-2F','--once']
  if mode!='disabled':args.append('--ponder')
  if mode=='hit':args.extend(['--option','USI_Ponder=false'])
  args+=['--',str(log)]
  p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,env={**os.environ,'PONDER_TEST_CASE':mode})
  try:
   conn,_=server.accept();conn.settimeout(10)
   with conn,conn.makefile('rwb',buffering=0) as f:
    assert f.readline().startswith(b'LOGIN ');summary=b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:test+20261118000000\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nIncrement:2\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n';f.write(summary.replace(b'Your_Turn:+',b'Your_Turn:-') if mode=='white' else summary);assert f.readline()==b'AGREE\n';f.write(b'START:test\n');
    if mode=='white':f.write(b'+7776FU,T0\n');assert f.readline().startswith(b'-3334FU');f.write(b'-3334FU,T0\n')
    else:assert f.readline().startswith(b'+7776FU');f.write(b'+7776FU,T0\n')
    if mode not in ('disabled','invalid','malformed','missing'):wait_for(lambda:any(x.startswith('go ponder ') for x in commands()))
    else:time.sleep(.15);assert not any(x.startswith('go ponder ') for x in commands())
    if mode=='drain':
     p.stdin.write('q\n');p.stdin.flush();conn.settimeout(.2)
     try:assert not conn.recv(1), '終了予約で対局が切断されました'
     except socket.timeout:pass
     conn.settimeout(10)
    if mode in ('miss_terminal','miss_disconnect'):
     f.write(b'-8384FU,T0\n');wait_for(lambda:'stop' in commands())
     if mode=='miss_terminal':f.write(b'#RESIGN\n#LOSE\n');wait_for(lambda:'gameover lose' in commands());assert not any('8c8d' in x for x in commands() if x.startswith('position '))
     else:conn.shutdown(socket.SHUT_RDWR)
    elif mode=='terminal':f.write(b'#RESIGN\n#LOSE\n');wait_for(lambda:'gameover lose' in commands());assert commands().index('stop')<commands().index('gameover lose')
    elif mode=='disconnect':conn.shutdown(socket.SHUT_RDWR)
    else:
     f.write(b'+2726FU,T0\n' if mode=='white' else b'-8384FU,T0\n' if mode=='miss' else b'-3334FU,T0\n');assert f.readline().startswith(b'-8384FU' if mode=='white' else b'+2726FU'),commands();f.write(b'-8384FU,T0\n#RESIGN\n#WIN\n' if mode=='white' else b'+2726FU,T0\n#RESIGN\n#WIN\n')
   p.wait(timeout=12);assert p.returncode==0,(mode,p.stderr.read(),commands());c=commands()
   if mode in ('hit','white'):assert 'ponderhit' in c and 'stop' not in c,c
   if mode=='hit':
    i=next(i for i,x in enumerate(c) if x.startswith('go ponder '))
    assert c[i-1]=='position startpos moves 7g7f 3c3d',c
    assert c[i]=='go ponder btime 62000 wtime 60000 binc 2000 winc 2000',c
   if mode=='white':
    i=next(i for i,x in enumerate(c) if x.startswith('go ponder '))
    assert c[i-1]=='position startpos moves 7g7f 3c3d 2g2f',c
   if mode=='hit':assert c.index('setoption name USI_Ponder value false')<c.index('setoption name USI_Ponder value true'),c
   if mode=='miss':assert 'ponderhit' not in c and 'stop' in c and c.index('stop')<next(i for i,x in enumerate(c) if x.startswith('position ') and '8c8d' in x),c
   if mode=='disconnect':assert 'stop' in c,c
   if mode!='disabled':assert 'setoption name USI_Ponder value true' in c,c
   else:assert 'setoption name USI_Ponder value true' not in c,c
  finally:
   if p.poll() is None:p.kill();p.wait()
   server.close()
 def consecutive_games():
  log.unlink(missing_ok=True);server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(10)
  p=subprocess.Popen([str(AGENT),'--engine',str(engine),'--host',f'127.0.0.1:{server.getsockname()[1]}','--name','Test','--pool','test-60-2F','--ponder','--',str(log)],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,env={**os.environ,'PONDER_TEST_CASE':'miss_terminal'})
  try:
   for game in range(2):
    conn,_=server.accept();conn.settimeout(10)
    with conn,conn.makefile('rwb',buffering=0) as f:
     assert f.readline().startswith(b'LOGIN ')
     f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:test+20261118000000\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nIncrement:2\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n')
     assert f.readline()==b'AGREE\n';f.write(b'START:test\n');assert f.readline().startswith(b'+7776FU');f.write(b'+7776FU,T0\n')
     wait_for(lambda:sum(x.startswith('go ponder ') for x in commands())>=game+1)
     if game==0:
      f.write(b'-8384FU,T0\n');wait_for(lambda:'stop' in commands());f.write(b'#RESIGN\n#LOSE\n')
     else:
      f.write(b'-3334FU,T0\n');assert f.readline().startswith(b'+2726FU');f.write(b'+2726FU,T0\n#RESIGN\n#WIN\n');p.stdin.write('q\n');p.stdin.flush()
   p.wait(timeout=12);assert p.returncode==0,(p.stderr.read(),commands())
   c=commands();assert c.count('usinewgame')==2 and c.count('gameover lose')==1 and c.count('gameover win')==1,c
   assert c.index('stop')<c.index('gameover lose')<c.index('usinewgame',c.index('usinewgame')+1),c
  finally:
   if p.poll() is None:p.kill();p.wait()
   server.close()
 for mode in ('hit','miss','terminal','disconnect','disabled','invalid','malformed','missing','white','drain','miss_terminal','miss_disconnect'):case(mode)
 consecutive_games()
print('PASS: ponder hit, miss, end, disconnect and disabled')
