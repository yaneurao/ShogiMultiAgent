#!/usr/bin/env python3
"""CSA comments and game history match the move actually selected by the engine."""
import json,os,socket,subprocess,tempfile,time
from pathlib import Path
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT','target/debug/shogizone-participant-agent')).resolve()
for mode in ('listed','last_pv','unlisted','ponder','split_score','split_pv','split_other','split_depth','split_stale'):
 with tempfile.TemporaryDirectory(prefix='selected-multipv-') as d:
  root=Path(d);engine=root/'engine'
  engine.write_text('''#!/usr/bin/env python3
import os,sys
mode=os.environ['SELECTED_MODE']
for l in sys.stdin:
 l=l.strip()
 if l=='usi':print('usiok',flush=True)
 elif l=='isready':print('readyok',flush=True)
 elif l.startswith('go ponder'):
  print('info multipv 1 score cp 100 pv 2g2f 8c8d',flush=True)
  print('info multipv 2 score cp 30 pv 6g6f 8c8d',flush=True)
 elif l.startswith('go '):
  if mode=='ponder':print('bestmove 7g7f ponder 3c3d',flush=True)
  elif mode.startswith('split_'):
   if mode=='split_pv':print('info depth 12 multipv 1 pv 7g7f 3c3d',flush=True);print('info depth 12 multipv 1 score cp 123',flush=True)
   else:
    print('info depth 12 multipv 1 score cp 123',flush=True)
    if mode=='split_stale':print('info score cp 999 pv 2g2f 8c8d',flush=True)
    print('info depth 12 multipv 2 pv 7g7f 3c3d' if mode=='split_other' else 'info depth 13 multipv 1 pv 7g7f 3c3d' if mode=='split_depth' else 'info depth 12 multipv 1 pv 7g7f 3c3d',flush=True)
   print('bestmove 7g7f',flush=True)
  else:
   print('info multipv 1 score cp 100 pv 2g2f 8c8d',flush=True)
   print('info multipv 2 score cp 30 pv 7g7f 3c3d',flush=True)
   if mode=='last_pv':print('info depth 0 pv 7g7f 8c8d',flush=True)
   print('bestmove 6g6f' if mode=='unlisted' else 'bestmove 7g7f',flush=True)
 elif l=='ponderhit':print('bestmove 6g6f',flush=True)
 elif l=='stop':print('bestmove 6g6f',flush=True)
 elif l=='quit':break
''');engine.chmod(0o755)
  server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(10)
  p=subprocess.Popen([str(agent),'--app-mode'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'SELECTED_MODE':mode})
  try:
   p.stdin.write(json.dumps({'engine':str(engine),'host':f'127.0.0.1:{server.getsockname()[1]}','name':'Test','record_dir':str(root/'kif'),'ponder':mode=='ponder'})+'\n');p.stdin.flush();conn,_=server.accept();conn.settimeout(10)
   with conn,conn.makefile('rwb',buffering=0) as f:
    assert f.readline().startswith(b'LOGIN ');f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:multi\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n');assert f.readline()==b'AGREE\n';f.write(b'START:multi\n');wire=f.readline().decode().strip()
    if mode=='ponder':
     assert wire=='+7776FU',wire;f.write(b'+7776FU,T0\n');time.sleep(.15);f.write(b'-3334FU,T0\n');wire=f.readline().decode().strip()
    expected={'listed':"+7776FU,'* 30 +7776FU -3334FU",'last_pv':"+7776FU,'* 30 +7776FU -8384FU",'unlisted':'+6766FU','ponder':"+6766FU,'* 30 +6766FU -8384FU",'split_score':"+7776FU,'* 123 +7776FU -3334FU",'split_pv':"+7776FU,'* 123 +7776FU -3334FU",'split_other':'+7776FU','split_depth':"+7776FU,'* pv +7776FU -3334FU",'split_stale':"+7776FU,'* pv +7776FU -3334FU"}[mode];assert wire==expected,(mode,wire)
    f.write((b'+6766FU,T0\n' if mode in ('ponder','unlisted') else b'+7776FU,T0\n'));p.stdin.write('q\n');p.stdin.flush();f.write(b'#RESIGN\n#WIN\n');assert f.readline()==b'LOGOUT\n'
   out,err=p.communicate(timeout=10);assert p.returncode==0,(mode,err);events=[json.loads(x) for x in out.splitlines()];a=[e for e in events if e['event']=='analysis'][-1];assert a['move']==('6g6f' if mode in ('unlisted','ponder') else '7g7f');assert a['evaluation']==(None if mode in ('unlisted','split_other','split_depth','split_stale') else 123 if mode in ('split_score','split_pv') else 30),a
   csa=(root/'kif/multi.csa').read_text();assert ("'** 30 " in csa)==(mode in ('listed','last_pv','ponder')),(mode,csa);assert ("'** 123 " in csa)==(mode in ('split_score','split_pv')),(mode,csa);assert "'** 100 " not in csa,(mode,csa)
  finally:
   server.close()
   if p.poll() is None:p.kill();p.wait()
print('PASS: selected multipv score/PV in CSA and history, including ponder and missing candidates')
