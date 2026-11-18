#!/usr/bin/env python3
"""CSA waiting connections send a real empty keepalive and drain cleanly."""
import json, os, socket, subprocess, tempfile, time
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
   assert f.readline().startswith(b'LOGIN Test ');f.write(b'LOGIN:Test OK\n')
   started=time.monotonic();assert f.readline()==b'\n';elapsed=time.monotonic()-started
   assert 25<=elapsed<=35,elapsed
   p.stdin.write('q\n');p.stdin.flush();assert f.readline()==b'LOGOUT\n'
  out,err=p.communicate(timeout=10);assert p.returncode==0,(out,err)
 finally:
  listener.close()
  if p.poll() is None:p.kill();p.wait()
print('PASS: waiting CSA connection sends an empty keepalive')
