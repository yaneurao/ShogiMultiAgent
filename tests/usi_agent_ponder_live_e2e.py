#!/usr/bin/env python3
"""Ponder analysis reaches the right app session without changing CSA play."""
import json, os, queue, socket, subprocess, tempfile, threading
from pathlib import Path
root=Path(__file__).resolve().parents[1]
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT',root/'target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory(prefix='ponder-live-') as d:
 engine=Path(d)/'engine.py'
 engine.write_text('''#!/usr/bin/env python3
import sys
for line in sys.stdin:
 line=line.strip()
 if line=='usi':print('usiok',flush=True)
 elif line=='isready':print('readyok',flush=True)
 elif line.startswith('go ponder '):print('info depth 17 score cp 42 pv 2g2f 8c8d',flush=True)
 elif line.startswith('go '):print('info depth 8 score cp 10 pv 7g7f 3c3d',flush=True);print('bestmove 7g7f ponder 3c3d',flush=True)
 elif line=='ponderhit':print('info depth 18 score cp 45 pv 2g2f 8c8d',flush=True);print('bestmove 2g2f',flush=True)
 elif line=='stop':print('bestmove 2g2f',flush=True)
 elif line=='quit':break
''');engine.chmod(0o755)
 server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(10)
 proc=subprocess.Popen([agent,'--app-mode'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 events=queue.Queue()
 threading.Thread(target=lambda:[events.put(json.loads(line)) for line in proc.stdout],daemon=True).start()
 def find(predicate):
  while True:
   event=events.get(timeout=10)
   if predicate(event):return event
 try:
  proc.stdin.write(json.dumps({'engine':str(engine),'host':f'127.0.0.1:{server.getsockname()[1]}','name':'Test','pool':'test-60-2F','ponder':True})+'\n');proc.stdin.flush()
  conn,_=server.accept();conn.settimeout(10)
  with conn,conn.makefile('rwb',buffering=0) as f:
   assert f.readline().startswith(b'LOGIN ')
   f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:test\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nIncrement:2\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n')
   assert f.readline()==b'AGREE\n';f.write(b'START:test\n');assert f.readline().startswith(b'+7776FU');f.write(b'+7776FU,T0\n')
   find(lambda e:e.get('event')=='search_state' and e.get('mode')=='pondering')
   e=find(lambda e:e.get('event')=='analysis_update' and e.get('mode')=='pondering')
   assert e['depth']==17 and e['score']=='42' and e['pv']==['2g2f','8c8d'] and e['sfen'].split()[-1]=='3',e
   f.write(b'-3334FU,T0\n');find(lambda e:e.get('event')=='search_state' and e.get('mode')=='thinking');assert f.readline().startswith(b'+2726FU')
   f.write(b'+2726FU,T0\n#RESIGN\n#WIN\n');proc.stdin.write('q\n');proc.stdin.flush()
  proc.wait(timeout=10);assert proc.returncode==0,proc.stderr.read()
 finally:
  server.close()
  if proc.poll() is None:proc.kill();proc.wait()
print('PASS: ponder depth, score and PV are reported live from the predicted position')
