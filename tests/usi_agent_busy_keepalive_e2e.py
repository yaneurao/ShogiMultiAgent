#!/usr/bin/env python3
"""Search output must not starve CSA keepalives while a game is active."""
import json, os, socket, subprocess, tempfile, time
from pathlib import Path
root=Path(__file__).resolve().parents[1]
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT',root/'target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory() as d:
 engine=Path(d,'engine.py');engine.write_text('''#!/usr/bin/env python3
import sys,time
for line in sys.stdin:
 line=line.strip()
 if line=='usi': print('usiok',flush=True)
 elif line=='isready': print('readyok',flush=True)
 elif line.startswith('go '):
  end=time.monotonic()+32
  while time.monotonic()<end:
   print('info depth 8 score cp 12 pv 7g7f',flush=True)
   time.sleep(.002)
  print('bestmove 7g7f',flush=True)
 elif line=='quit': break
''');engine.chmod(0o755)
 listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(15)
 p=subprocess.Popen([agent,'--app-mode'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  p.stdin.write(json.dumps({'engine':str(engine),'host':f'127.0.0.1:{listener.getsockname()[1]}','name':'Test'})+'\n');p.stdin.flush()
  conn,_=listener.accept();conn.settimeout(36)
  with conn,conn.makefile('rwb',buffering=0) as f:
   assert f.readline().startswith(b'LOGIN Test ')
   f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:busy\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n')
   assert f.readline()==b'AGREE\n';f.write(b'START:busy\n')
   assert f.readline()==b'\n', 'keepalive was not delivered during search output'
   p.stdin.write('q\n');p.stdin.flush();time.sleep(.2);f.write(b'#ABNORMAL\n#CENSORED\n')
   assert f.readline()==b'LOGOUT\n'
  out,err=p.communicate(timeout=10);assert p.returncode==0,(out,err)
 finally:
  listener.close()
  if p.poll() is None:p.kill();p.wait()
print('PASS: CSA keepalive is sent while the engine streams search output')
