#!/usr/bin/env python3
"""A vanished app must not interrupt an already committed CSA game."""
import json,os,socket,subprocess,tempfile,time
from pathlib import Path
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT','target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory(prefix='lost-gui-') as d:
 engine=Path(d)/'engine';engine.write_text('''#!/usr/bin/env python3
import sys,time
for line in sys.stdin:
 line=line.strip()
 if line=='usi':print('usiok',flush=True)
 elif line=='isready':print('readyok',flush=True)
 elif line.startswith('go '):time.sleep(.2);print('info depth 3 score cp 1 pv 7g7f',flush=True);print('bestmove 7g7f',flush=True)
 elif line=='quit':break
''');engine.chmod(0o755)
 server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(10)
 p=subprocess.Popen([agent,'--app-mode'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  p.stdin.write(json.dumps({'engine':str(engine),'host':f'127.0.0.1:{server.getsockname()[1]}','name':'Test','pool':'test'})+'\n');p.stdin.flush()
  conn,_=server.accept();conn.settimeout(10)
  with conn,conn.makefile('rwb',buffering=0) as f:
   assert f.readline().startswith(b'LOGIN ');f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:lost-gui\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n');assert f.readline()==b'AGREE\n';f.write(b'START:lost-gui\n')
   p.stdout.close();p.stdout=None;p.stdin.close();p.stdin=None;p.stderr.close();p.stderr=None
   assert f.readline().startswith(b'+7776FU'),'engine did not complete its move';f.write(b'+7776FU,T0\n');time.sleep(.3);assert p.poll() is None,'agent stopped before game ended';f.write(b'#RESIGN\n#WIN\n');assert f.readline()==b'LOGOUT\n'
  p.wait(timeout=10);assert p.returncode==0,p.returncode
 finally:
  server.close()
  if p.poll() is None:p.kill();p.wait()
print('PASS: closing app stdin, stdout and stderr preserves the active game until termination')
