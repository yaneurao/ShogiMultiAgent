#!/usr/bin/env python3
"""A search evaluation is sent before bestmove without changing CSA play."""
import json, os, socket, subprocess, tempfile, time
from pathlib import Path
root=Path(__file__).resolve().parents[1]
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT',root/'target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory() as d:
 engine=Path(d,'engine.py');engine.write_text('''#!/usr/bin/env python3
import sys,time
for line in sys.stdin:
 line=line.strip()
 if line=='usi':
  sys.stdout.buffer.write(b'id name \\x82\\xa0\\n');sys.stdout.flush();print('usiok',flush=True)
 elif line=='isready': print('readyok',flush=True)
 elif line.startswith('go '):
  sys.stdout.buffer.write(b'info string \\x82\\xa0\\n');sys.stdout.flush()
  print('info depth 8 score cp 321 pv 7g7f 3c3d',flush=True)
  time.sleep(1)
  print('bestmove 7g7f',flush=True)
 elif line=='quit': break
''');engine.chmod(0o755)
 listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(15)
 p=subprocess.Popen([agent,'--app-mode'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  p.stdin.write(json.dumps({'engine':str(engine),'host':f'127.0.0.1:{listener.getsockname()[1]}','name':'Test','pool':'floodgate-300-10F'})+'\n');p.stdin.flush()
  conn,_=listener.accept();conn.settimeout(15)
  with conn,conn.makefile('rwb',buffering=0) as f:
   assert f.readline().startswith(b'LOGIN Test ')
   f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:live\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n')
   assert f.readline()==b'AGREE\n';f.write(b'START:live\n')
   while True:
    event=json.loads(p.stdout.readline())
    if event['event']=='analysis_update':break
   assert event['score']=='321' and event['pv']==['7g7f','3c3d'],event
   conn.settimeout(.2)
   try: assert not conn.recv(1024), 'bestmove was sent before the live evaluation'
   except socket.timeout: pass
   conn.settimeout(15);assert f.readline().startswith(b'+7776FU,')
   f.write(b'+7776FU,T0\n');p.stdin.write('q\n');p.stdin.flush();time.sleep(.2);f.write(b'#RESIGN\n#WIN\n');assert f.readline()==b'LOGOUT\n'
  p.communicate(timeout=10);assert p.returncode==0
 finally:
  listener.close()
  if p.poll() is None:p.kill();p.wait()
print('PASS: live evaluation is delivered before the engine plays')
