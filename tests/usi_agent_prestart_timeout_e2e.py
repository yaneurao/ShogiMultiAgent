#!/usr/bin/env python3
"""An agreed game that never starts is abandoned and retried."""
import json, os, socket, subprocess, tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT',root/'target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory() as d:
 engine=Path(d,'engine.py');engine.write_text("#!/usr/bin/env python3\nimport sys\nfor l in sys.stdin:\n if l.strip()=='usi':print('usiok',flush=True)\n elif l.strip()=='isready':print('readyok',flush=True)\n elif l.strip()=='quit':break\n");engine.chmod(0o755)
 listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(40)
 p=subprocess.Popen([agent,'--app-mode'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  p.stdin.write(json.dumps({'engine':str(engine),'host':f'127.0.0.1:{listener.getsockname()[1]}','name':'Test'})+'\n');p.stdin.flush()
  conn,_=listener.accept();conn.settimeout(36)
  with conn,conn.makefile('rwb',buffering=0) as f:
   assert f.readline().startswith(b'LOGIN Test ')
   f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:example\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n')
   assert f.readline()==b'AGREE\n'
   while True:
    line=f.readline()
    if not line:break
    assert line==b'\n',line
  conn,_=listener.accept();conn.settimeout(15)
  with conn,conn.makefile('rwb',buffering=0) as f:
   assert f.readline().startswith(b'LOGIN Test ');f.write(b'LOGIN:Test OK\n');p.stdin.write('q\n');p.stdin.flush();assert f.readline()==b'LOGOUT\n'
  p.wait(timeout=10);out,err=p.communicate(timeout=10);events=[json.loads(line) for line in out.splitlines()]
  assert p.returncode==0 and any(e.get('state')=='reconnecting' and '対局開始が30秒' in e.get('message','') for e in events),(out,err)
  assert not any(e['event'] in ('game_started','game_finished') for e in events),(out,err)
 finally:
  listener.close()
  if p.poll() is None:p.kill();p.wait()
print('PASS: pre-start timeout reconnects without counting a game')
