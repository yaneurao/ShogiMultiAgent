#!/usr/bin/env python3
"""Reject unsupported CSA time controls before agreeing to a game."""
import json, os, socket, subprocess, tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT',root/'target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory() as d:
 engine=Path(d,'engine.py');engine.write_text("#!/usr/bin/env python3\nimport sys\nfor l in sys.stdin:\n if l.strip()=='usi':print('usiok',flush=True)\n elif l.strip()=='isready':print('readyok',flush=True)\n");engine.chmod(0o755)
 for fields,expected in [(b'Time_Unit:1msec\nTotal_Time:60000\n','未対応のCSA時間単位'),(b'Time_Unit:1sec\nDelay:2\n','未対応のCSA時間遅延'),(b'Time_Unit:1sec\nIncrement:2\nByoyomi:10\n','秒読みと時間加算')]:
  listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(15)
  p=subprocess.Popen([agent,'--app-mode'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   p.stdin.write(json.dumps({'engine':str(engine),'host':f'127.0.0.1:{listener.getsockname()[1]}','name':'Test'})+'\n');p.stdin.flush()
   conn,_=listener.accept();conn.settimeout(15)
   with conn,conn.makefile('rwb',buffering=0) as f:
    assert f.readline().startswith(b'LOGIN Test ')
    f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nYour_Turn:+\nTotal_Time:60\n'+fields+b'BEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n')
    assert f.readline()==b'', 'unsupported time control must not be accepted'
   p.wait(timeout=10);out,err=p.communicate(timeout=10)
   events=[json.loads(line) for line in out.splitlines()]
   assert p.returncode!=0 and any(e.get('event')=='error' and expected in e.get('message','') for e in events),(out,err)
  finally:
   listener.close()
   if p.poll() is None:p.kill();p.wait()
print('PASS: unsupported CSA time controls are rejected before AGREE')
