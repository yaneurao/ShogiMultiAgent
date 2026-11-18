#!/usr/bin/env python3
"""A silent CSA login times out and reconnects without falsely reporting success."""
import json, os, socket, subprocess, tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT',root/'target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory() as d:
 engine=Path(d,'engine.py');engine.write_text("#!/usr/bin/env python3\nimport sys\nfor l in sys.stdin:\n if l.strip()=='usi':print('usiok',flush=True)\n elif l.strip()=='isready':print('readyok',flush=True)\n elif l.strip()=='quit':break\n");engine.chmod(0o755)
 listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(15)
 p=subprocess.Popen([agent,'--app-mode'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  p.stdin.write(json.dumps({'engine':str(engine),'host':f'127.0.0.1:{listener.getsockname()[1]}','name':'Test'})+'\n');p.stdin.flush()
  conn,_=listener.accept();conn.settimeout(36)
  with conn,conn.makefile('rwb',buffering=0) as f:
   assert f.readline().startswith(b'LOGIN Test ');line=f.readline();assert line in (b'',b'\n');
   if line:assert f.readline()==b''
  while True:
   event=json.loads(p.stdout.readline())
   if event['event']=='state' and event.get('state')=='reconnecting':break
  assert 'ログイン応答が30秒' in event.get('message',''),event
  p.stdin.write('q\n');p.stdin.flush();p.communicate(timeout=10);assert p.returncode==0
 finally:
  listener.close()
  if p.poll() is None:p.kill();p.wait()
print('PASS: silent CSA login times out and reports reconnecting')
