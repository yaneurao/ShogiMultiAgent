#!/usr/bin/env python3
"""Record write/finalization failures are sent to the application."""
import json,os,socket,subprocess,sys,tempfile,time
from pathlib import Path
if sys.platform=='win32':
 print('SKIP: RLIMIT_FSIZE requires POSIX');raise SystemExit(0)
import resource,signal
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT','target/debug/shogizone-participant-agent')).resolve()
for limit in (30,115,160):
 with tempfile.TemporaryDirectory(prefix='record-failure-') as d:
  root=Path(d);engine=root/'engine';engine.write_text('''#!/usr/bin/env python3
import sys
for line in sys.stdin:
 line=line.strip()
 if line=='usi':print('usiok',flush=True)
 elif line=='isready':print('readyok',flush=True)
 elif line.startswith('go '):print('info score cp 123 pv 7g7f 3c3d',flush=True);print('bestmove 7g7f',flush=True)
 elif line=='quit':break
''');engine.chmod(0o755)
  server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(10)
  def disk_limit():signal.signal(signal.SIGXFSZ,signal.SIG_IGN);resource.setrlimit(resource.RLIMIT_FSIZE,(limit,limit))
  p=subprocess.Popen([agent,'--app-mode'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,preexec_fn=disk_limit)
  try:
   p.stdin.write(json.dumps({'engine':str(engine),'host':f'127.0.0.1:{server.getsockname()[1]}','name':'Test','pool':'test','record_dir':str(root/'kif')})+'\n');p.stdin.flush()
   conn,_=server.accept();conn.settimeout(10)
   with conn,conn.makefile('rwb',buffering=0) as f:
    assert f.readline().startswith(b'LOGIN ');f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:disk\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n');assert f.readline()==b'AGREE\n';f.write(b'START:disk\n');assert f.readline().startswith(b'+7776FU');f.write(b"+7776FU,T0,'* 123 +7776FU -3334FU\n");p.stdin.write('q\n');p.stdin.flush();time.sleep(.2);f.write(b'#RESIGN\n#WIN\n');assert f.readline()==b'LOGOUT\n'
   out,err=p.communicate(timeout=10);assert p.returncode==0,(limit,err);events=[json.loads(x) for x in out.splitlines()];failure=next(e for e in events if e['event']=='record_error');record=next(e for e in events if e['event']=='record');assert failure['path']==record['path'] and '棋譜' in failure['message'],events;assert events.index(failure)<next(i for i,e in enumerate(events) if e['event']=='game_finished');assert Path(record['path']).stat().st_size==limit
  finally:
   server.close()
   if p.poll() is None:p.kill();p.wait()
print('PASS: incomplete CSA writes and finish failures emit record_error before game completion')
